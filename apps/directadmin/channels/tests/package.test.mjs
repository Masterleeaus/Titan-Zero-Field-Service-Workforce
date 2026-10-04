import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPackage, packageFiles } from '../tools/package.mjs';

test('builds a deterministic plugin archive bound to a compiled SDK', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'titan-channels-')); t.after(() => rm(root, { recursive: true, force: true }));
  const sdk = join(root, 'sdk.mjs'); await writeFile(sdk, 'export const DirectAdminCockpitSession = class {};\n');
  const first = await buildPackage({ sdkModulePath: sdk, outputDir: join(root, 'one') });
  const second = await buildPackage({ sdkModulePath: sdk, outputDir: join(root, 'two') });
  assert.equal(first.files, packageFiles.length); assert.equal(first.sha256, second.sha256); assert.equal((await readFile(first.archivePath)).length > 0, true);
});
