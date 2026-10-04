/** Provider-neutral channel projections. This module owns no credentials, provider
 * registry, communications semantics, authority, or persistence. */
export type ChannelDirection = 'inbound' | 'outbound' | 'bidirectional';
export type ChannelLifecycle = 'DISCOVER' | 'CONNECT' | 'AUTHORIZE' | 'CONFIGURE' | 'TEST' | 'VERIFY' | 'ACTIVE' | 'DEGRADED' | 'PAUSED' | 'REAUTH_REQUIRED' | 'ROTATE' | 'REBIND' | 'DISCONNECT' | 'RETIRE';
export type ChannelHealth = 'healthy' | 'degraded' | 'unreachable' | 'revoked' | 'unknown';
export type ChannelEndpointDescriptor = Readonly<{
  endpoint_id: string;
  company_id: string;
  channel_type: string;
  provider_id: string;
  account_ref: string;
  direction: ChannelDirection;
  capabilities: readonly string[];
  credential_ref: string | null;
  lifecycle: ChannelLifecycle;
  health: ChannelHealth;
  last_checked_at: string | null;
  webhook: Readonly<{ configured: boolean; signature_required: boolean; replay_protection: boolean }>;
  quota: Readonly<{ remaining: number | null; reset_at: string | null }>;
  locality: string | null;
  provenance: string;
}>;
export type ChannelsProjection = Readonly<{
  schema: 'titan.directadmin.channels.projection/v1';
  company_id: string;
  endpoints: readonly ChannelEndpointDescriptor[];
  topology: readonly Readonly<{ endpoint_id: string; consumers: readonly string[] }>[];
  authority_granted: false;
  credentials_exposed: false;
}>;

const text = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > 512) throw new Error(`invalid-channel-${field}`);
  return value;
};
export function assertChannelsProjection(value: unknown, companyId: string): asserts value is ChannelsProjection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-channels-projection');
  const projection = value as ChannelsProjection;
  if (projection.schema !== 'titan.directadmin.channels.projection/v1' || projection.company_id !== companyId ||
      projection.authority_granted !== false || projection.credentials_exposed !== false || !Array.isArray(projection.endpoints) ||
      !Array.isArray(projection.topology)) throw new Error('invalid-channels-projection');
  const ids = new Set<string>();
  for (const endpoint of projection.endpoints) {
    if (endpoint.company_id !== companyId || ids.has(endpoint.endpoint_id)) throw new Error('invalid-channel-company-or-duplicate');
    ids.add(text(endpoint.endpoint_id, 'endpoint-id')); text(endpoint.channel_type, 'type'); text(endpoint.provider_id, 'provider'); text(endpoint.account_ref, 'account-ref');
    if (!['inbound', 'outbound', 'bidirectional'].includes(endpoint.direction) || !Array.isArray(endpoint.capabilities) ||
        endpoint.capabilities.some((capability: unknown) => typeof capability !== 'string' || !capability.trim() || capability.length > 128) ||
        (endpoint.credential_ref !== null && (typeof endpoint.credential_ref !== 'string' || !endpoint.credential_ref.trim() || endpoint.credential_ref.length > 512)) ||
        !['DISCOVER', 'CONNECT', 'AUTHORIZE', 'CONFIGURE', 'TEST', 'VERIFY', 'ACTIVE', 'DEGRADED', 'PAUSED', 'REAUTH_REQUIRED', 'ROTATE', 'REBIND', 'DISCONNECT', 'RETIRE'].includes(endpoint.lifecycle) ||
        !['healthy', 'degraded', 'unreachable', 'revoked', 'unknown'].includes(endpoint.health) ||
        (endpoint.last_checked_at !== null && (typeof endpoint.last_checked_at !== 'string' || Number.isNaN(Date.parse(endpoint.last_checked_at)))) ||
        typeof endpoint.webhook?.configured !== 'boolean' || endpoint.webhook?.signature_required !== true ||
        endpoint.webhook?.replay_protection !== true || endpoint.health === 'revoked' && endpoint.lifecycle === 'ACTIVE') {
      throw new Error('invalid-channel-endpoint');
    }
  }
  for (const item of projection.topology) if (!ids.has(item.endpoint_id) || !Array.isArray(item.consumers)) throw new Error('invalid-channel-topology');
}
