import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
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
  assert.equal(first.files, packageFiles.length); assert.equal(first.sha256, second.sha256); assert.equal((await readFile(first.archivePath)).length > 0, true);
});

test('packaged role entrypoints resolve the package-root renderer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'titan-channels-role-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = join(root, 'sdk.mjs'); await writeFile(sdk, 'export const DirectAdminCockpitSession = class {};\n');
  const packageRoot = join(root, 'package'); await mkdir(packageRoot, { recursive: true });
  const sourceDir = fileURLToPath(new URL('..', import.meta.url));
  for (const path of packageFiles) {
    const destination = join(packageRoot, path);
    if (path === 'images/sdk.mjs') await writeFile(destination, await readFile(sdk));
    else { await mkdir(join(destination, '..'), { recursive: true }); await cp(join(sourceDir, path), destination); }
  }
  for (const role of ['admin', 'reseller', 'user']) {
    const { stdout } = await exec(process.execPath, [join(packageRoot, role, 'index.html')], { cwd: packageRoot });
    assert.match(stdout, /Titan Channels/);
  }
});
