import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEntry } from '../lib/entry.mjs';

test('renders all DirectAdmin role entry documents with an SDK slot', () => {
  for (const role of ['admin', 'reseller', 'user']) {
    const html = renderEntry(role, { sdkModule: 'export const fixture = true;' });
    assert.match(html, /titan-channels/);
    assert.match(html, /titan-sdk/);
    assert.match(html, /data:text\/javascript;base64,/);
  }
  assert.throws(() => renderEntry('root'), /unsupported DirectAdmin role/);
});

test('renders the established host CSRF contract without inventing a browser nonce', () => {
  const html = renderEntry('admin', { sdkModule: 'export const fixture = true;' });
  assert.match(html, /meta name="titan-directadmin-csrf" content=""/);
  assert.doesNotMatch(html, /bootstrap-nonce/);
});
