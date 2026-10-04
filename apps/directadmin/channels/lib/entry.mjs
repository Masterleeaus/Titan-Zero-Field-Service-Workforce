import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const roles = new Set(['admin', 'reseller', 'user']);
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const escapeScript = (source) => source.replace(/<\/script/gi, '<\\/script');

export function renderEntry(role, { sdkModule } = {}) {
  if (!roles.has(role)) throw new Error('unsupported DirectAdmin role');
  const heading = role === 'admin' ? 'Channels & integrations' : role === 'reseller' ? 'Company channels' : 'Channel health';
  const asset = (name) => readFileSync(fileURLToPath(new URL(`../images/${name}`, import.meta.url)), 'utf8');
  const moduleUrl = (name) => `data:text/javascript;base64,${Buffer.from(name === 'sdk.mjs' && sdkModule !== undefined ? sdkModule : asset(name)).toString('base64')}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="titan-directadmin-csrf" content=""><title>Titan Channels</title></head><body><main id="titan-channels" data-role="${escapeHtml(role)}" aria-label="Titan Channels"><p class="eyebrow">Titan Channels</p><h1>${heading}</h1><p role="status" aria-live="polite">Loading company channel context.</p></main><style>${asset('style.css')}</style><script type="importmap">${JSON.stringify({ imports: { 'titan-sdk': moduleUrl('sdk.mjs') } })}</script><script type="module">${escapeScript(asset('cockpit.mjs'))}</script></body></html>`;
}
