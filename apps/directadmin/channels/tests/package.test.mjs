import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPackage, packageFiles } from '../tools/package.mjs';
const exec = promisify(execFile);

test('builds a deterministic plugin archive bound to a compiled SDK', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'titan-channels-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = join(root, 'sdk.mjs'); await writeFile(sdk, 'export const DirectAdminCockpitSession = class {};\n');
  const first = await buildPackage({ sdkModulePath: sdk, outputDir: join(root, 'one') });
  const second = await buildPackage({ sdkModulePath: sdk, outputDir: join(root, 'two') });
  assert.equal(first.files, packageFiles.length); assert.equal(first.sha256, second.sha256); assert.ok((await readFile(first.archivePath)).length > 0);
});

test('extracts the built archive, preserves executable modes, and executes role shebangs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'titan-channels-archive-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = join(root, 'sdk.mjs'); await writeFile(sdk, 'export const DirectAdminCockpitSession = class {};\n');
  const output = join(root, 'output');
  const packageScript = fileURLToPath(new URL('../tools/package.mjs', import.meta.url));
  await exec(process.execPath, [packageScript, '--source-dir', fileURLToPath(new URL('..', import.meta.url)), '--sdk-module', sdk, '--output-dir', output]);
  const archive = join(output, 'titan_channels.tar.gz');
  assert.ok((await stat(archive)).isFile());
  const extracted = join(root, 'extracted'); await mkdir(extracted);
  await exec('tar', ['-xzf', archive, '-C', extracted]);
  for (const role of ['admin', 'reseller', 'user']) {
    const entry = join(extracted, role, 'index.html');
    assert.equal((await stat(entry)).mode & 0o111, 0o111, role);
    const { stdout } = await exec(entry, [], { cwd: extracted });
    assert.match(stdout, /Titan Channels/);
    assert.match((await readFile(entry, 'utf8')).split('\n', 1)[0], /^#!\/usr\/bin\/env node$/);
  }
  for (const script of ['install.sh', 'update.sh', 'uninstall.sh']) {
    assert.equal((await stat(join(extracted, 'scripts', script))).mode & 0o111, 0o111, script);
  }
});
