import { readdir, readFile, access, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(packageRoot, process.argv[2] ?? '.');
const errors = [];
const fail = message => errors.push(message);
const htmlFiles = [path.join(root, 'index.html')];
for (const name of await readdir(path.join(root, '_pages'))) {
  if (name.endsWith('.html')) htmlFiles.push(path.join(root, '_pages', name));
}

const htaccess = await readFile(path.join(root, '.htaccess'), 'utf8');
const routes = new Map([['/', 'index.html']]);
for (const line of htaccess.split(/\r?\n/)) {
  const match = line.match(/^\s*RewriteRule\s+\^(.+?)\$\s+(_pages\/[A-Za-z0-9-]+\.html)\s+\[L\]/);
  if (!match) continue;
  const route = '/' + match[1]
    .replaceAll('\\-', '-')
    .replace(/\/\?$/, '');
  routes.set(route, match[2]);
  await access(path.join(root, match[2])).catch(() => fail(`route ${route} targets missing ${match[2]}`));
}

if (!routes.has('/trades/carpentry-joinery')) fail('nested trade route was not parsed');
if (!/RewriteRule\s+\^sitemap\\\.xml\$\s+-\s+\[G,L\]/.test(htaccess)) fail('sitemap must return HTTP 410 in the review build');
if (await access(path.join(root, 'sitemap.xml')).then(() => true).catch(() => false)) fail('indexable sitemap.xml must not be shipped');

const assetPaths = new Set();
for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  const rel = path.relative(root, file);
  const robots = [...html.matchAll(/<meta\s+name="robots"\s+content="([^"]+)"/gi)].map(m => m[1]);
  if (robots.length !== 1 || !/noindex\s*,\s*nofollow/i.test(robots[0] ?? '')) fail(`${rel}: expected one noindex,nofollow robots tag`);
  const canonicals = [...html.matchAll(/<link\s+rel="canonical"\s+href="([^"]+)"/gi)];
  if (rel !== '404.html' && canonicals.length !== 1) fail(`${rel}: expected exactly one canonical link`);
  if (rel !== '404.html' && (html.match(/<h1\b/gi) ?? []).length !== 1) fail(`${rel}: expected exactly one h1`);
  for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"#?]+)"/g)) {
    if (!m[1].includes('${')) assetPaths.add(m[1]);
  }
  if (/https:\/\/app\.titanzero\.io\/app\?mode=(?:signup|login)/i.test(html)) fail(`${rel}: obsolete application action URL remains`);
}

const js = await readFile(path.join(root, 'assets', 'trades.js'), 'utf8');
for (const m of js.matchAll(/(?:src|href)=["'`](\/assets\/[^"'`#?]+)["'`]/g)) {
  if (!m[1].includes('${')) assetPaths.add(m[1]);
}
if (/app\.titanzero\.io\/app\?mode=(?:signup|login)/i.test(js)) fail('client renderer contains obsolete account URL');
for (const m of js.matchAll(/['"`]((?:\/assets\/)[^'"`?#]+)['"`]/g)) {
  if (!m[1].includes('${')) assetPaths.add(m[1]);
}

for (const asset of assetPaths) {
  const target = path.join(root, asset.replace(/^\//, ''));
  try {
    if (!(await stat(target)).isFile()) fail(`asset is not a file: ${asset}`);
  } catch {
    fail(`missing asset: ${asset}`);
  }
}
for (const name of ['field-number-01.webp', 'field-number-02.webp', 'field-number-03.webp', 'field-number-04.webp', 'field-number-05.webp', 'field-number-06.webp', 'field-number-07.webp', 'field-number-08.webp']) {
  await access(path.join(root, 'assets', name)).catch(() => fail(`missing generated workflow image: ${name}`));
}
const staffProfiles = (await readdir(path.join(root, 'assets'))).filter(name => /^staff-.+\.(webp|png|jpe?g)$/i.test(name));
if (staffProfiles.length !== 45) fail(`expected 45 workforce profile images, found ${staffProfiles.length}`);

const syntax = spawnSync(process.execPath, ['--check', path.join(root, 'assets', 'trades.js')], { encoding: 'utf8' });
if (syntax.status !== 0) fail(`trades.js syntax check failed: ${syntax.stderr || syntax.stdout}`);

if (errors.length) {
  for (const error of errors) console.error(`FAIL ${error}`);
  process.exitCode = 1;
} else {
  console.log(`Field marketing checks passed: ${routes.size} route mappings, ${htmlFiles.length} HTML pages, ${assetPaths.size} local assets.`);
}
