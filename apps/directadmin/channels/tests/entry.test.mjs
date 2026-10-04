import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { renderEntry } from '../lib/entry.mjs';\n\ntest('renders all DirectAdmin role entry documents with an SDK slot', () => {
  for (const role of ['admin', 'reseller', 'user']) {\n    const html = renderEntry(role, { sdkModule: 'export const fixture = true;' });\n    assert.match(html, /titan-channels/);\n    assert.match(html, /titan-sdk/);\n    assert.match(html, /data:text\/javascript;base64,/);\n  }\n  assert.throws(() => renderEntry('root'), /unsupported DirectAdmin role/);\n});

test('renders the established host CSRF contract without inventing a browser nonce', () => {
  const html = renderEntry('admin', { sdkModule: 'export const fixture = true;' });
  assert.match(html, /meta name="titan-directadmin-csrf" content=""/);
  assert.doesNotMatch(html, /bootstrap-nonce/);
});
