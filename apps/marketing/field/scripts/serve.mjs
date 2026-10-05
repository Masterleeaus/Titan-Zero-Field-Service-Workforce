import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const htaccess = await readFile(path.join(root, '.htaccess'), 'utf8');
const routes = new Map([['/', 'index.html']]);
for (const line of htaccess.split(/\r?\n/)) {
  const match = line.match(/^\s*RewriteRule\s+\^(.+?)\$\s+(_pages\/[A-Za-z0-9-]+\.html)\s+\[L\]/);
  if (match) {
    const route = '/' + match[1].replaceAll('\\-', '-').replace(/\/\?$/, '');
    routes.set(route, match[2]);
  }
}
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8' };
const port = Number(process.env.PORT || 4174);
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  if (pathname === '/sitemap.xml') { res.writeHead(410, { 'X-Robots-Tag': 'noindex, nofollow' }).end(); return; }
  let file = routes.get(pathname.replace(/\/$/, '') || '/');
  if (!file && pathname.startsWith('/assets/')) file = pathname.slice(1);
  if (!file && pathname === '/favicon.svg') file = 'favicon.svg';
  if (!file && pathname === '/404.html') file = '404.html';
  if (!file) file = null;
  const target = file && path.resolve(root, file);
  if (!target || !target.startsWith(root + path.sep) || !(await stat(target).then(s => s.isFile()).catch(() => false))) {
    const body = await readFile(path.join(root, '404.html'));
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex, nofollow' }).end(body);
    return;
  }
  const body = await readFile(target);
  res.writeHead(200, { 'content-type': types[path.extname(target)] || 'application/octet-stream', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' }).end(body);
});
server.listen(port, '127.0.0.1', () => console.log(`Titan Zero Field review site: http://127.0.0.1:${port}`));
