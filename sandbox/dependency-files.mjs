// Controller-owned file access. This helper never loads repository modules or executes package scripts.
import { constants } from 'node:fs';
import { lstat, open, realpath, readFile, writeFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_BYTES = 180000;
const packageName = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export async function regularFile(root, relative) {
  const base = await realpath(root);
  const path = resolve(base, relative);
  const actual = await realpath(path);
  if (!actual.startsWith(base + sep) || actual !== path) throw new Error('Symlink or escaping file rejected');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.nlink !== 1) throw new Error('Unsupported file');
    const data = await handle.readFile();
    if (data.length > MAX_BYTES || data.includes(0)) throw new Error('Unsupported content');
    const text = data.toString('utf8');
    if (!Buffer.from(text).equals(data)) throw new Error('Non UTF-8 content');
    return text;
  } finally { await handle.close(); }
}
export async function snapshot(root, manager, installed = false) {
  if (!['npm', 'yarn1'].includes(manager)) throw new Error('Unsupported package manager');
  const lock = manager === 'npm' ? 'package-lock.json' : 'yarn.lock';
  for (const file of ['npm-shrinkwrap.json', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', manager === 'npm' ? 'yarn.lock' : 'package-lock.json']) {
    if (await lstat(resolve(root, file)).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e; })) throw new Error('Ambiguous or unsupported lockfile');
  }
  const files = await Promise.all(['package.json', lock].map(async path => ({ path, content: await regularFile(root, path) })));
  const manifest = JSON.parse(files[0].content);
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || manifest.workspaces !== undefined) throw new Error('Unsupported manifest');
  const versions = {};
  const names = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})];
  if (names.length > 40 || new Set(names).size !== names.length || names.some(n => !packageName.test(n) || n.length > 214)) throw new Error('Unsupported dependency names');
  if (installed) for (const name of names) {
    const pkg = JSON.parse(await regularFile(root, `node_modules/${name}/package.json`));
    if (typeof pkg.version !== 'string') throw new Error('Missing installed version');
    versions[name] = pkg.version;
  }
  return { files, installed: versions };
}
export async function applyFiles(root, files) {
  if (!Array.isArray(files) || files.length !== 2 || files[0].path !== 'package.json' || !['yarn.lock','package-lock.json'].includes(files[1].path)) throw new Error('Invalid artifact paths');
  for (const file of files) {
    if (typeof file.before !== 'string' || typeof file.after !== 'string' || Buffer.byteLength(file.after) > MAX_BYTES || file.after.includes('\0')) throw new Error('Invalid artifact content');
    if (await regularFile(root, file.path) !== file.before) throw new Error('Artifact base mismatch');
  }
  for (const file of files) {
    // The fresh checkout has not executed any repository code yet.
    const handle = await open(resolve(root, file.path), constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    try { await handle.writeFile(file.after); } finally { await handle.close(); }
  }
}
export async function updateManifest(root, candidate) {
  const original = await regularFile(root, 'package.json');
  const manifest = JSON.parse(original);
  if (!['dependencies','devDependencies'].includes(candidate.section) || !packageName.test(candidate.name) || !/^[~^]?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(candidate.toRange)) throw new Error('Invalid update');
  if (!Object.hasOwn(manifest[candidate.section] ?? {}, candidate.name) || manifest[candidate.section][candidate.name] !== candidate.fromRange) throw new Error('Dependency changed');
  manifest[candidate.section][candidate.name] = candidate.toRange;
  const handle = await open(resolve(root, 'package.json'), constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
  try { await handle.writeFile(JSON.stringify(manifest, null, 2) + '\n'); } finally { await handle.close(); }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, root, manager, input, output] = process.argv.slice(2);
  try {
    if (mode === 'inspect') await writeFile(output, JSON.stringify(await snapshot(root, manager, input === 'installed')), { mode: 0o600 });
    else if (mode === 'update') await updateManifest(root, JSON.parse(await readFile(input, 'utf8')));
    else if (mode === 'apply') await applyFiles(root, JSON.parse(await readFile(input, 'utf8')).files);
    else throw new Error('Unknown operation');
  } catch { console.error('Dependency file operation rejected'); process.exitCode = 1; }
}
