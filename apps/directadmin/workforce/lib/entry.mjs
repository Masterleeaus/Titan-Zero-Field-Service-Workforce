import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/** A DA executable renders an authority-neutral shell. No environment identity is trusted. */
export function renderEntry(role) {
  if (!['admin', 'reseller', 'user'].includes(role)) throw new Error('invalid-role');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const asset = name => readFileSync(join(root, 'images', name), 'utf8');
  const escapeScript = source => source.replace(/<\/script/gi, '<\\/script');
  // Import maps use data modules from the signed/installed package only. No remote code.
  const moduleUrl = name => `data:text/javascript;base64,${Buffer.from(asset(name)).toString('base64')}`;
  const imports = { 'titan-sdk': moduleUrl('sdk.mjs'), 'workforce-presentation': moduleUrl('presentation.mjs'),
    'workforce-controller': moduleUrl('controller.mjs'), 'workforce-api': moduleUrl('api.mjs') };
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Titan Workforce</title>
<style>${asset('style.css')}</style><script type="importmap">${JSON.stringify({ imports })}</script></head><body>
<main id="titan-workforce" data-role="${role}" aria-label="Titan Workforce"><h1>Titan Workforce</h1><p role="status">Loading current company context…</p></main>
<script type="module">${escapeScript(asset('cockpit.mjs'))}</script></body></html>`;
}
