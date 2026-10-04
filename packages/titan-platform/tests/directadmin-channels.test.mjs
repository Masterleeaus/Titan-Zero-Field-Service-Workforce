import test from 'node:test';
import assert from 'node:assert/strict';
import { assertChannelsProjection } from '../.test-dist/directadmin-channels.js';

const endpoint = (company_id = 'company-a') => ({
  endpoint_id: 'email-1', company_id, channel_type: 'email', provider_id: 'provider.mail', account_ref: 'acct-ref',
  direction: 'bidirectional', capabilities: ['text', 'attachments'], credential_ref: 'secret-ref', lifecycle: 'ACTIVE',
  health: 'healthy', last_checked_at: new Date().toISOString(),
  webhook: { configured: true, signature_required: true, replay_protection: true },
  quota: { remaining: 10, reset_at: null }, locality: 'AU', provenance: 'canonical-connectors',
});

test('accepts a company-scoped channel projection without credential material', () => {
  const projection = { schema: 'titan.directadmin.channels.projection/v1', company_id: 'company-a', endpoints: [{ ...endpoint(), credential_ref: null }], topology: [{ endpoint_id: 'email-1', consumers: ['communications'] }], authority_granted: false, credentials_exposed: false };
  assert.doesNotThrow(() => assertChannelsProjection(projection, 'company-a'));
});

test('rejects cross-company projections and unsafe endpoint state', () => {
  const projection = { schema: 'titan.directadmin.channels.projection/v1', company_id: 'company-a', endpoints: [endpoint('company-b')], topology: [], authority_granted: false, credentials_exposed: false };
  assert.throws(() => assertChannelsProjection(projection, 'company-a'), /company|projection/);
  const revoked = { ...projection, endpoints: [{ ...endpoint(), health: 'revoked', lifecycle: 'ACTIVE' }] };
  assert.throws(() => assertChannelsProjection(revoked, 'company-a'), /endpoint/);
  const invalidEnum = { ...projection, endpoints: [{ ...endpoint(), lifecycle: 'NOT_A_STATE' }] };
  assert.throws(() => assertChannelsProjection(invalidEnum, 'company-a'), /endpoint/);
});
