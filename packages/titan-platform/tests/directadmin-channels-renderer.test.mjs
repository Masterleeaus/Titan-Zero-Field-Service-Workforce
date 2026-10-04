import test from 'node:test';
import assert from 'node:assert/strict';

const sdk = await import(process.env.TITAN_DIRECTADMIN_SDK);
const { assertChannelsProjection, mountDirectAdminProjection } = sdk;

function root() {
  const doc = { createElement: tag => ({ tag, textContent: '', children: [], attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
    replaceChildren(...children) { this.children = children; },
    addEventListener() {}, removeEventListener() {}, ownerDocument: doc }) };
  return doc.createElement('section');
}

function projection() {
  const endpoint = { endpoint_id: 'email-1', company_id: 'company-a', channel_type: 'email', provider_id: 'provider.mail',
    account_ref: 'acct-ref', direction: 'bidirectional', capabilities: ['text'], credential_ref: null,
    lifecycle: 'ACTIVE', health: 'healthy', last_checked_at: new Date().toISOString(),
    webhook: { configured: true, signature_required: true, replay_protection: true },
    quota: { remaining: 10, reset_at: null }, locality: 'AU', provenance: 'canonical-connectors' };
  return { schema: 'titan.directadmin.channels.projection/v1', company_id: 'company-a',
    endpoints: [endpoint], topology: [{ endpoint_id: 'email-1', consumers: ['communications'] }],
    authority_granted: false, credentials_exposed: false };
}

test('Channels renderer validates one fresh response and clears stale or invalid content', async () => {
  let listener; let requests = 0; let current = { company_id: 'company-a', data: projection(),
    source: 'canonical', freshness: new Date().toISOString(), evidence_refs: [] };
  const session = { subscribe(fn) { listener = fn; return () => { listener = null; }; },
    projection: async () => { requests++; if (current === 'outage') throw new Error('offline'); return current; } };
  const r = root();
  const mount = mountDirectAdminProjection(session, { plugin_id: 'titan_channels', title: 'Channels', root: r,
    expected_schema: 'titan.directadmin.channels.projection/v1',
    summarize: ({ company_id, data }) => { assertChannelsProjection(data, company_id); return 'ready'; },
    render: (_value, target) => { const item = target.ownerDocument.createElement('p'); item.textContent = 'endpoint'; target.replaceChildren(item); } });
  await mount.refresh(); assert.equal(r.children[3].children.length, 1); assert.equal(requests, 1);
  const base = projection();
  for (const value of [
    { ...current, freshness: null },
    { ...current, freshness: new Date(Date.now() - 600_000).toISOString() },
    { ...current, data: { ...base, endpoints: [{ ...base.endpoints[0], company_id: 'company-b' }] } },
    { ...current, data: { ...base, endpoints: [{ ...base.endpoints[0], health: 'revoked' }] } },
    { ...current, data: { ...base, schema: 'wrong' } },
    'outage',
  ]) { current = value; await mount.refresh(); assert.equal(r.children[3].children.length, 0); }
  current = { company_id: 'company-a', data: base, source: 'canonical', freshness: new Date().toISOString(), evidence_refs: [] };
  await mount.refresh(); assert.equal(r.children[3].children.length, 1); assert.equal(requests, 8);
  listener(); assert.equal(r.children[3].children.length, 0);
  mount.dispose();
});
