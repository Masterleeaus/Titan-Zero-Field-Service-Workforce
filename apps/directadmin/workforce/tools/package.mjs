#!/usr/bin/env node
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

export const packageFiles = Object.freeze([
  'AGENTS.md', 'README.md', 'plugin.conf',
  'admin/index.html', 'admin/bootstrap-nonce.raw', 'admin/bootstrap.raw',
  'reseller/index.html', 'reseller/bootstrap-nonce.raw', 'reseller/bootstrap.raw',
  'user/index.html', 'user/bootstrap-nonce.raw', 'user/bootstrap.raw',
  'hooks/admin_txt.html', 'hooks/reseller_txt.html', 'hooks/user_txt.html',
  'scripts/install.sh', 'scripts/update.sh', 'scripts/uninstall.sh',
  'lib/entry.mjs', 'lib/directadmin-bootstrap-raw.mjs', 'images/cockpit.mjs', 'images/controller.mjs', 'images/api.mjs', 'images/presentation.mjs', 'images/sdk.mjs', 'images/style.css',
].sort());
const executable = (file) => /^(admin|reseller|user)\/(?:index\.html|bootstrap(?:-nonce)?\.raw)$/.test(file) || file.startsWith('scripts/');

async function rejectSymlinks(path) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink()) throw new Error(`Symlinks are forbidden: ${path}`);
  if (stat.isDirectory()) for (const entry of await readdir(path)) await rejectSymlinks(join(path, entry));
}

export async function buildPackage({ sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'), outputDir, sdkModulePath } = {}) {
  if (!sdkModulePath) throw new Error('A compiled canonical Cockpit SDK module is required (--sdk-module).');
  sourceDir = resolve(sourceDir);
  outputDir = resolve(outputDir ?? join(sourceDir, 'dist'));
  sdkModulePath = resolve(sdkModulePath);
  await rejectSymlinks(sourceDir);
  if (!(await lstat(sdkModulePath)).isFile()) throw new Error('SDK module must be a regular file, not a symlink.');
  const SDK = await import(pathToFileURL(sdkModulePath).href);
  if (typeof SDK.DirectAdminCockpitSession !== 'function' || typeof SDK.validateDirectAdminPluginPackage !== 'function' || typeof SDK.assertPluginCanBeInstalled !== 'function') {
    throw new Error('SDK must export the canonical browser session and package validators.');
  }
  const temporary = await mkdtemp(join(tmpdir(), 'titan-workforce-package-'));
  try {
    const manifest = await readFile(join(sourceDir, 'plugin.conf'), 'utf8');
    const versionMatch = manifest.match(/^version=(\d+\.\d+\.\d+)$/m);
    if (!versionMatch) throw new Error('plugin.conf must declare a semantic version.');
    const version = versionMatch[1];
    const stage = join(temporary, 'stage');
    const verify = join(temporary, 'verify');
    await mkdir(stage); await mkdir(verify);
    for (const file of packageFiles) {
      const source = file === 'images/sdk.mjs' ? sdkModulePath : join(sourceDir, file);
      if (!(await lstat(source)).isFile()) throw new Error(`Required file is not regular: ${file}`);
      const destination = join(stage, file);
      await mkdir(dirname(destination), { recursive: true, mode: 0o755 });
      await copyFile(source, destination);
      await chmod(destination, executable(file) ? 0o755 : 0o644);
    }
    const tar = execFileSync('tar', ['--format=ustar', '--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '-cf', '-', '-C', stage, ...packageFiles], { maxBuffer: 32 * 1024 * 1024 });
    const bytes = gzipSync(tar, { level: 9 });
    const candidate = join(temporary, 'titan_workforce.tar.gz');
    await writeFile(candidate, bytes);
    const listing = execFileSync('tar', ['-tzf', candidate], { encoding: 'utf8' }).trim().split('\n');
    if (JSON.stringify(listing) !== JSON.stringify(packageFiles)) throw new Error('Archive allowlist mismatch.');
    execFileSync('tar', ['--same-permissions', '-xzf', candidate, '-C', verify]);
    for (const file of packageFiles) {
      const stat = await lstat(join(verify, file));
      if (!stat.isFile() || (stat.mode & 0o777) !== (executable(file) ? 0o755 : 0o644)) throw new Error(`Archive mode/type mismatch: ${file}`);
      if (!(await readFile(join(verify, file))).equals(await readFile(join(stage, file)))) throw new Error(`Archive content mismatch: ${file}`);
    }
    SDK.assertPluginCanBeInstalled(SDK.validateDirectAdminPluginPackage({
      plugin_id: 'titan_workforce', version, archive_filename: 'titan_workforce.tar.gz',
      manifest_content: await readFile(join(verify, 'plugin.conf'), 'utf8'), files: listing,
      executable_files: listing.filter(executable),
      role_entrypoints: { admin: 'admin/index.html', reseller: 'reseller/index.html', user: 'user/index.html' },
      hooks: listing.filter(file => file.startsWith('hooks/')),
    }));
    execFileSync('sh', [join(verify, 'scripts/install.sh')], { stdio: 'pipe' });
    await mkdir(outputDir, { recursive: true });
    const archivePath = join(outputDir, 'titan_workforce.tar.gz');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await copyFile(candidate, archivePath);
    await writeFile(`${archivePath}.sha256`, `${sha256}  titan_workforce.tar.gz\n`);
    return { archivePath, sha256, files: packageFiles.length };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = { '--sdk-module': 'sdkModulePath', '--output-dir': 'outputDir', '--source-dir': 'sourceDir' }[process.argv[i]];
    if (!key || !process.argv[i + 1]) throw new Error('Usage: package.mjs --sdk-module <compiled SDK module> [--output-dir <directory>]');
    options[key] = process.argv[i + 1];
  }
  console.log(JSON.stringify(await buildPackage(options)));
}
