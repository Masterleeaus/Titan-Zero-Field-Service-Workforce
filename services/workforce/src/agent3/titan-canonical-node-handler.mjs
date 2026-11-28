/** Minimal Node.js HTTP integration wrapper for the existing Titan Control API.
 * Mount the handler under the established authenticated control-plane/router.
 * This code intentionally does not start or own an HTTP server.
 */
export function createNodeBridgeHandler(receiver, { maxBytes = 16_384 } = {}) {
  if (typeof receiver !== 'function') throw new TypeError('receiver required');
  return async function handle(req, res) {
    let size = 0;
    const chunks = [];
    try {
      if (req.method !== 'POST') { res.writeHead(405).end(); return; }
      for await (const part of req) {
        size += part.length;
        if (size > maxBytes) { res.writeHead(413).end(); return; }
        chunks.push(part);
      }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch { res.writeHead(400, {'cache-control':'no-store'}).end(); return; }
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      // HMAC and effective authorization are enforced by the receiver.
      const reply = await receiver({ method: req.method, path, headers: req.headers, body });
      const data = JSON.stringify(reply.body);
      res.writeHead(reply.status, { ...reply.headers, 'content-length': Buffer.byteLength(data) });
      res.end(data);
    } catch {
      if (!res.headersSent) res.writeHead(503, {'cache-control':'no-store'}).end();
      else res.end();
    }
  };
}
