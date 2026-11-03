#!/usr/bin/env python3
"""Controller-owned data helper. Run with system Python -I -S, never the project interpreter."""
import json
import os
import re
import stat
import sys
from email.parser import Parser

MAX_BYTES = 180000
NAME = r"[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?"
PIN = r"(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){1,2}(?:\.post(?:0|[1-9]\d*))?"
LINE = re.compile(r"^([ \t]*)(" + NAME + r")(\[(?:" + NAME + r")(?:," + NAME + r")*\])?([ \t]*==[ \t]*)(" + PIN + r")([ \t]*(?:#.*)?)$")
SAFE_VERSION = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.!+_-]{0,99}$")

def normalized(name):
    return re.sub(r"[-_.]+", "-", name.lower())

def opened(root, parts, flags=os.O_RDONLY):
    if os.path.realpath(root) != os.path.abspath(root):
        raise ValueError("unsafe root")
    fd = os.open(root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        result = os.open(parts[-1], flags | os.O_NOFOLLOW, dir_fd=fd)
    finally:
        os.close(fd)
    info = os.fstat(result)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > MAX_BYTES:
        os.close(result)
        raise ValueError("unsafe file")
    return result

def read(root, parts):
    fd = opened(root, parts)
    with os.fdopen(fd, "rb") as file:
        data = file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES or b"\0" in data:
        raise ValueError("invalid file")
    return data.decode("utf-8", errors="strict")

def requirements(content):
    result = []
    for i, text in enumerate(content.splitlines()):
        if not text.strip() or text.lstrip().startswith("#"):
            continue
        match = LINE.fullmatch(text)
        if not match or len(match[2]) > 214 or len(match[5]) > 50:
            raise ValueError("unsupported requirement")
        result.append((normalized(match[2]), match[5], i))
    if not 0 < len(result) <= 40 or len({r[0] for r in result}) != len(result):
        raise ValueError("unsupported requirements")
    return result

def inspect_content(root):
    for other in ("pyproject.toml", "Pipfile", "Pipfile.lock", "poetry.lock", "uv.lock", "requirements.in"):
        if os.path.lexists(os.path.join(root, other)):
            raise ValueError("mixed dependency layout")
    content = read(root, ["requirements.txt"])
    requirements(content)
    return content

def inventory(root):
    lib = os.path.join(root, ".venv", "lib")
    versions = [v for v in os.listdir(lib) if re.fullmatch(r"python3\.\d+", v)]
    if len(versions) != 1:
        raise ValueError("ambiguous python environment")
    parts = [".venv", "lib", versions[0], "site-packages"]
    packages = [p for p in os.listdir(os.path.join(root, *parts)) if p.endswith(".dist-info")]
    if not 0 < len(packages) <= 500:
        raise ValueError("unsupported python environment")
    result = {}
    for package in packages:
        metadata = Parser().parsestr(read(root, parts + [package, "METADATA"]), headersonly=True)
        names, versions = metadata.get_all("Name", []), metadata.get_all("Version", [])
        if len(names) != 1 or len(versions) != 1 or not re.fullmatch(NAME, names[0]) or not SAFE_VERSION.fullmatch(versions[0]):
            raise ValueError("invalid installed metadata")
        name = normalized(names[0])
        if name in result:
            raise ValueError("duplicate installed metadata")
        result[name] = versions[0]
    return result

def inspect(root, installed=False):
    content = inspect_content(root)
    versions = inventory(root) if installed else {}
    direct = {name: versions[name] for name, _, _ in requirements(content) if name in versions}
    if installed and len(direct) != len(requirements(content)):
        raise ValueError("missing installed distribution")
    return {"files": [{"path": "requirements.txt", "content": content}], "installed": direct}

def update(root, candidate):
    content = inspect_content(root)
    name = candidate.get("name", "")
    version = candidate.get("toVersion", "")
    if candidate.get("section") != "requirements" or name != normalized(name) or not re.fullmatch(r"(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)", version):
        raise ValueError("invalid candidate")
    row = next((r for r in requirements(content) if r[0] == name), None)
    if not row or candidate.get("fromRange") != "==" + row[1] or candidate.get("fromVersion") != row[1] or candidate.get("toRange") != "==" + version:
        raise ValueError("base mismatch")
    lines = content.splitlines(keepends=True)
    line = lines[row[2]]
    end = "\r\n" if line.endswith("\r\n") else "\n" if line.endswith("\n") else ""
    match = LINE.fullmatch(line.rstrip("\r\n"))
    lines[row[2]] = "".join((match[1], match[2], match[3] or "", match[4], version, match[6], end))
    write(root, "".join(lines))

def write(root, content):
    if len(content.encode("utf-8")) > MAX_BYTES:
        raise ValueError("oversized write")
    requirements(content)
    fd = opened(root, ["requirements.txt"], os.O_WRONLY)
    with os.fdopen(fd, "wb") as file:
        file.truncate(0)
        file.write(content.encode("utf-8"))

def apply(root, artifact):
    files = artifact.get("files")
    if not isinstance(files, list) or len(files) != 1 or files[0].get("path") != "requirements.txt":
        raise ValueError("invalid artifact paths")
    current = inspect_content(root)
    if files[0].get("before") != current or not isinstance(files[0].get("after"), str):
        raise ValueError("base mismatch")
    write(root, files[0]["after"])

def output(path, data):
    raw = json.dumps(data).encode("utf-8")
    if len(raw) > 512000:
        raise ValueError("oversized output")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        os.close(fd)
        raise ValueError("unsafe output")
    with os.fdopen(fd, "wb") as file:
        file.truncate(0)
        file.write(raw)

if __name__ == "__main__":
    try:
        mode, root, argument, destination = sys.argv[1:]
        if mode == "inspect":
            output(destination, inspect(root, argument == "installed"))
        elif mode == "inventory":
            output(destination, inventory(root))
        elif mode in ("update", "apply"):
            with open(argument, encoding="utf-8") as file:
                data = json.load(file)
            (update if mode == "update" else apply)(root, data)
        else:
            raise ValueError("unsupported mode")
    except Exception:
        print("Python dependency files rejected", file=sys.stderr)
        sys.exit(1)
