import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageFiles = Object.freeze([
  'AGENTS.md', 'README.md', 'plugin.conf', 'admin/index.html', 'reseller/index.html', 'user/index.html',
  'hooks/admin_txt.html', 'hooks/reseller_txt.html', 'hooks/user_txt.html', 'scripts/install.sh',
  'scripts/update.sh', 'scripts/uninstall.sh', 'lib/entry.mjs', 'images/cockpit.mjs', 'images/sdk.mjs', 'images/style.css',
].sort());
const executable = (path) => /^(admin|reseller|user)\/index\.html$/.test(path) || path.startsWith('scripts/');
function octal(header, offset, length, value) { header.write(`${value.toString(8).padStart(length - 1, '0')}\0`, offset, length, 'ascii'); }
function tar(entries) {
  const out = [];
  for (const { path, bytes } of entries) {
    const header = Buffer.alloc(512); header.write(path, 0, 100, 'utf8'); octal(header, 100, 8, executable(path) ? 0o755 : 0o644); octal(header, 124, 12, bytes.length); header.fill(0x20, 148, 156); header[156] = 0x30; header.write('ustar\0', 257, 6, 'ascii'); header.write('00', 263, 2, 'ascii');
    let sum = 0; for (const byte of header) sum += byte; header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii'); out.push(header, bytes); const padding = (512 - bytes.length % 512) % 512; if (padding) out.push(Buffer.alloc(padding));
  }
  out.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(out), { level: 9 });
}
export async function buildPackage({ sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), '..'), outputDir = join(sourceDir, 'dist'), sdkModulePath } = {}) {
  if (!sdkModulePath) throw new Error('compiled canonical SDK module is required');
  const entries = [];
  for (const path of packageFiles) { const bytes = await readFile(path === 'images/sdk.mjs' ? sdkModulePath : join(sourceDir, path)); entries.push({ path, bytes }); }
  const bytes = tar(entries); await mkdir(outputDir, { recursive: true }); const archivePath = join(outputDir, 'titan_channels.tar.gz'); await writeFile(archivePath, bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex'); await writeFile(`${archivePath}.sha256`, `${sha256}  titan_channels.tar.gz\n`); return { archivePath, sha256, files: entries.length };
}
function cliOptions(argv) {
  const options = {};
  const positional = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--source-dir' || arg === '--sdk-module' || arg === '--output-dir') {
      const key = { '--source-dir': 'sourceDir', '--sdk-module': 'sdkModulePath', '--output-dir': 'outputDir' }[arg];
      options[key] = argv[++index];
    } else if (arg.startsWith('--source-dir=')) options.sourceDir = arg.slice(13);
    else if (arg.startsWith('--sdk-module=')) options.sdkModulePath = arg.slice(13);
    else if (arg.startsWith('--output-dir=')) options.outputDir = arg.slice(13);
    else positional.push(arg);
  }
  if (!options.sdkModulePath && positional[0]) options.sdkModulePath = positional[0];
  if (!options.outputDir && positional[1]) options.outputDir = positional[1];
  return options;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await buildPackage(cliOptions(process.argv.slice(2)))));
}
