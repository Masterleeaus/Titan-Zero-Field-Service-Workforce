import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { tsImport } from 'tsx/esm/api';
import * as security from '../.test-dist/security-boundary.js';
const { createSqliteStorage, openExistingSqliteStorage } = await tsImport('@titan-zero/storage', { parentURL: import.meta.url, tsconfig: false });
const NOW = '2026-10-02T00:00:00Z';
const EXPIRY = '2026-10-02T01:00:00Z';
const principal = { provider: 'directadmin:node-1', subject: 'host-account-17' };
const proof = (session_revision = 1) => ({ ...principal, session_id: 'session-1', device_id: 'device-1', session_revision });
const expected = { audience: 'titan-workforce', company_id: 'company-a' };

async function fixture(t, path = ':memory:', storageOverride, now) {
  const storage = storageOverride ?? createSqliteStorage(path);
  let closed = false;
  const close = async () => { if (!closed) { await storage.close(); closed = true; } };
  t.after(close);
  const registry = await security.createIdentitySessionRegistry({ storage, storage_role: 'GLOBAL_REGISTRY', ...(now ? { now } : {}) });
  await registry.putActor({ actor_id: 'stable-user-17', status: 'active' }, null);
  await registry.putCompany({ company_id: 'company-a', status: 'active' }, null);
  await registry.putCompany({ company_id: 'company-b', status: 'active' }, null);
  await registry.putMembership({ actor_id: 'stable-user-17', company_id: 'company-a', role: 'owner', status: 'active' }, null);
  await registry.putMembership({ actor_id: 'stable-user-17', company_id: 'company-b', role: 'tech', status: 'active' }, null);
  await registry.putDevice({ device_id: 'device-1', actor_id: 'stable-user-17', status: 'active' }, null);
  await registry.putExternalBinding({ ...principal, binding_id: 'mapping-a', actor_id: 'stable-user-17', company_id: 'company-a', status: 'active' }, null);
  await registry.putExternalBinding({ ...principal, binding_id: 'mapping-b', actor_id: 'stable-user-17', company_id: 'company-b', status: 'active' }, null);
  const session = await registry.issueSession({ ...principal, session_id: 'session-1', device_id: 'device-1', company_id: 'company-a', audience: 'titan-workforce', issued_at: NOW, expires_at: EXPIRY }, NOW);
  return { registry, storage, session, close };
}

test('persists and resolves current global identity without opening a business database', async t => {
  const { registry, storage, session } = await fixture(t);
  const current = await registry.resolveCurrentSession(proof(), expected, NOW);
  assert.equal(current.actor_id, 'stable-user-17');
  assert.equal(current.company_id, 'company-a');
  assert.equal(current.company_role, 'owner');
  assert.equal(current.device_id, 'device-1');
  assert.equal(current.session_id, 'session-1');
  assert.equal(current.session_revision, 1);
  assert.equal(current.context_revision, session.context_revision);
  assert.equal(current.authority_neutral, true);
  assert.deepEqual(current.allowed_company_ids, ['company-a', 'company-b']);
  assert.equal('entitlements' in current, false);
  assert.equal('authority_revision' in current, false);
  const names = (await storage.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")).rows.map(r => r.name);
  assert.ok(names.every(name => name.startsWith('titan_security_')));
  assert.equal(Object.isFrozen(current), true);
  assert.equal(Object.isFrozen(current.allowed_company_ids), true);
});

for (const [label, alteredProof, alteredExpected, now] of [
  ['unknown session', { session_id: 'missing' }],
  ['untrusted external identity', { subject: 'someone-else' }],
  ['wrong provider', { provider: 'other-provider' }],
  ['wrong device', { device_id: 'device-2' }],
  ['stale session revision', { session_revision: 2 }],
  ['zero revision', { session_revision: 0 }],
  ['wrong company', {}, { company_id: 'company-b' }],
  ['wrong audience', {}, { audience: 'different-service' }],
  ['wrong actor assertion', {}, { actor_id: 'somebody-else' }],
  ['stale context revision', {}, { context_revision: 'stale' }],
  ['invalid clock', {}, {}, 'invalid'],
  ['future issuance', {}, {}, '2026-10-01T23:59:59Z'],
  ['expiry boundary', {}, {}, EXPIRY],
]) {
  test(`current resolver rejects ${label}`, async t => {
    const { registry } = await fixture(t);
    await assert.rejects(registry.resolveCurrentSession({ ...proof(), ...alteredProof }, { ...expected, ...alteredExpected }, now ?? NOW));
  });
}

for (const [kind, change] of [
  ['actor', r => r.putActor({ actor_id: 'stable-user-17', status: 'suspended' }, 1)],
  ['company', r => r.putCompany({ company_id: 'company-a', status: 'deleted' }, 1)],
  ['membership', r => r.putMembership({ actor_id: 'stable-user-17', company_id: 'company-a', role: 'owner', status: 'revoked' }, 1)],
  ['device', r => r.putDevice({ actor_id: 'stable-user-17', device_id: 'device-1', status: 'revoked' }, 1)],
  ['external binding', r => r.putExternalBinding({ ...principal, binding_id: 'mapping-a', actor_id: 'stable-user-17', company_id: 'company-a', status: 'revoked' }, 1)],
]) {
  test(`current resolver immediately denies a revoked ${kind}`, async t => {
    const { registry } = await fixture(t);
    await change(registry);
    await assert.rejects(registry.resolveCurrentSession(proof(), expected, NOW));
  });
}

test('role changes and revoke/reactivate cannot revive an old session generation', async t => {
  const { registry } = await fixture(t);
  await registry.putMembership({ actor_id: 'stable-user-17', company_id: 'company-a', role: 'tech', status: 'active' }, 1);
  await assert.rejects(registry.resolveCurrentSession(proof(), expected, NOW), /context-stale/);
  await registry.putMembership({ actor_id: 'stable-user-17', company_id: 'company-a', role: 'owner', status: 'active' }, 2);
  await assert.rejects(registry.resolveCurrentSession(proof(), expected, NOW), /context-stale/);
});

test('company switching atomically rotates the session and rebinds the current role', async t => {
  const { registry } = await fixture(t);
  const next = await registry.switchCompany(proof(), expected, 'company-b', NOW);
  assert.equal(next.company_id, 'company-b');
  assert.equal(next.company_role, 'tech');
  assert.equal(next.session_revision, 2);
  assert.equal(next.actor_id, 'stable-user-17');
  await assert.rejects(registry.resolveCurrentSession(proof(), { ...expected, company_id: 'company-b' }, NOW), /revision/);
  await assert.rejects(registry.resolveCurrentSession(proof(2), expected, NOW), /company/);
  assert.equal((await registry.resolveCurrentSession(proof(2), { ...expected, company_id: 'company-b', context_revision: next.context_revision }, NOW)).company_role, 'tech');
});

test('switch to an unmapped or revoked company rolls back without rotating the original session', async t => {
  const { registry, session } = await fixture(t);
  await registry.putMembership({ actor_id: 'stable-user-17', company_id: 'company-b', role: 'tech', status: 'revoked' }, 1);
  await assert.rejects(registry.switchCompany(proof(), expected, 'company-b', NOW));
  await assert.rejects(registry.switchCompany(proof(), expected, 'unmapped', NOW));
  const unchanged = await registry.resolveCurrentSession(proof(), expected, NOW);
  assert.equal(unchanged.context_revision, session.context_revision);
  assert.deepEqual(unchanged.allowed_company_ids, ['company-a']);
});

test('two concurrent switches cannot both rotate the same session revision', async t => {
  const { registry } = await fixture(t);
  const result = await Promise.allSettled([
    registry.switchCompany(proof(), expected, 'company-b', NOW),
    registry.switchCompany(proof(), expected, 'company-b', NOW),
  ]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(result.filter(r => r.status === 'rejected').length, 1);
});

test('revoked session is terminal and its ID cannot be reissued', async t => {
  const { registry } = await fixture(t);
  await registry.revokeSession('session-1', 1);
  await assert.rejects(registry.resolveCurrentSession(proof(), expected, NOW));
  await assert.rejects(registry.resolveCurrentSession(proof(2), expected, NOW), /revoked/);
  await assert.rejects(registry.issueSession({ ...principal, session_id: 'session-1', device_id: 'device-1', company_id: 'company-a', audience: 'titan-workforce', issued_at: NOW, expires_at: EXPIRY }, NOW));
});

test('an external subject ambiguously mapped to distinct actors fails closed', async t => {
  const { registry } = await fixture(t);
  await registry.putActor({ actor_id: 'different-user', status: 'active' }, null);
  await registry.putCompany({ company_id: 'company-c', status: 'active' }, null);
  await registry.putExternalBinding({ ...principal, binding_id: 'ambiguous', actor_id: 'different-user', company_id: 'company-c', status: 'active' }, null);
  await assert.rejects(registry.resolveCurrentSession(proof(), expected, NOW), /ambiguous/);
});

test('missing mapping is never inferred from matching account, company or user IDs', async t => {
  const { registry } = await fixture(t);
  await assert.rejects(registry.issueSession({ provider: 'directadmin:node-1', subject: 'company-a', session_id: 'unmapped-session', device_id: 'device-1', company_id: 'company-a', audience: 'titan-workforce', issued_at: NOW, expires_at: EXPIRY }, NOW), /binding/);
});

test('optimistic revisions reject stale writes and protect stable device and binding identity', async t => {
  const { registry } = await fixture(t);
  await assert.rejects(registry.putActor({ actor_id: 'stable-user-17', status: 'active' }, null), /revision/);
  await assert.rejects(registry.putActor({ actor_id: 'stable-user-17', status: 'active' }, 2), /revision/);
  await registry.putActor({ actor_id: 'other', status: 'active' }, null);
  await assert.rejects(registry.putDevice({ actor_id: 'other', device_id: 'device-1', status: 'active' }, 1), /immutable/);
  await assert.rejects(registry.putExternalBinding({ ...principal, binding_id: 'mapping-a', actor_id: 'stable-user-17', company_id: 'company-b', status: 'active' }, 1), /immutable/);
  assert.equal((await registry.resolveCurrentSession(proof(), expected, NOW)).actor_id, 'stable-user-17');
});

test('registry initialization is versioned, idempotent, and does not backfill legacy users', async t => {
  const storage = createSqliteStorage(':memory:');
  t.after(() => storage.close());
  await storage.query('CREATE TABLE users (id TEXT PRIMARY KEY, account_id TEXT, role TEXT)');
  await storage.query("INSERT INTO users VALUES ('legacy', 'company-a', 'owner')");
  await security.createIdentitySessionRegistry({ storage, storage_role: 'GLOBAL_REGISTRY' });
  const registry = await security.createIdentitySessionRegistry({ storage, storage_role: 'GLOBAL_REGISTRY' });
  assert.equal((await storage.query('SELECT COUNT(*) AS count FROM titan_security_actors')).rows[0].count, 0);
  assert.equal((await storage.query('SELECT COUNT(*) AS count FROM titan_security_migrations')).rows[0].count, 1);
  await assert.rejects(registry.resolveCurrentSession(proof(), expected, NOW));
  await storage.query('UPDATE titan_security_migrations SET version=99');
  await assert.rejects(security.createIdentitySessionRegistry({ storage, storage_role: 'GLOBAL_REGISTRY' }), /schema-version/);
});

test('production registry opener rejects an uncommissioned store without creating schema', async t => {
  const storage = createSqliteStorage(':memory:');
  t.after(() => storage.close());
  await assert.rejects(security.openIdentitySessionRegistry({ storage, storage_role: 'GLOBAL_REGISTRY' }), /schema-version-required/);
  assert.deepEqual((await storage.query("SELECT name FROM sqlite_master WHERE type='table'")).rows, []);
});

test('production registry opener reuses existing identity state without migration or backfill', async t => {
  const storage = createSqliteStorage(':memory:');
  t.after(() => storage.close());
  const provisioned = await security.createIdentitySessionRegistry({ storage, storage_role: 'GLOBAL_REGISTRY' });
  await provisioned.putActor({ actor_id: 'stable-user-17', status: 'active' }, null);
  await provisioned.putCompany({ company_id: 'company-a', status: 'active' }, null);
  await provisioned.putMembership({ actor_id: 'stable-user-17', company_id: 'company-a', role: 'owner', status: 'active' }, null);
  await provisioned.putDevice({ device_id: 'device-1', actor_id: 'stable-user-17', status: 'active' }, null);
  await provisioned.putExternalBinding({ ...principal, binding_id: 'mapping-a', actor_id: 'stable-user-17', company_id: 'company-a', status: 'active' }, null);
  const before = (await storage.query('SELECT version FROM titan_security_migrations')).rows;
  const registry = await security.openIdentitySessionRegistry({ storage, storage_role: 'GLOBAL_REGISTRY' });
  assert.deepEqual((await storage.query('SELECT version FROM titan_security_migrations')).rows, before);
  assert.equal((await storage.query('SELECT COUNT(*) AS count FROM titan_security_actors')).rows[0].count, 1);
  const issued = await registry.issueSession({ ...principal, session_id: 'session-1', device_id: 'device-1', company_id: 'company-a', audience: 'titan-workforce', issued_at: NOW, expires_at: EXPIRY }, NOW);
  assert.equal((await registry.resolveCurrentSession({ ...proof(), session_revision: issued.session_revision }, expected, NOW)).actor_id, 'stable-user-17');
});

test('company-business storage roles and unsupported SQL dialects are rejected', async t => {
  const storage = createSqliteStorage(':memory:');
  t.after(() => storage.close());
  await assert.rejects(security.createIdentitySessionRegistry({ storage, storage_role: 'COMPANY_NATIVE_FSM' }), /storage-role/);
  await assert.rejects(security.createIdentitySessionRegistry({ storage: { ...storage, dialect: 'postgres' }, storage_role: 'GLOBAL_REGISTRY' }), /dialect/);
  await assert.rejects(security.openIdentitySessionRegistry({ storage: { ...storage, dialect: 'postgres' }, storage_role: 'GLOBAL_REGISTRY' }), /dialect/);
});

test('current membership and session revocation survive independent connection restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'titan-security-registry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'identity.sqlite');
  const { close } = await fixture(t, path);
  await close();
  const restartedStorage = createSqliteStorage(path);
  t.after(() => restartedStorage.close());
  const restarted = await security.createIdentitySessionRegistry({ storage: restartedStorage, storage_role: 'GLOBAL_REGISTRY' });
  assert.equal((await restarted.resolveCurrentSession(proof(), expected, NOW)).actor_id, 'stable-user-17');
  await restarted.putMembership({ actor_id: 'stable-user-17', company_id: 'company-a', role: 'owner', status: 'revoked' }, 1);
  await assert.rejects(restarted.resolveCurrentSession(proof(), expected, NOW));
  await restarted.revokeSession('session-1', 1);
  const afterRevocation = await security.createIdentitySessionRegistry({ storage: restartedStorage, storage_role: 'GLOBAL_REGISTRY' });
  await assert.rejects(afterRevocation.resolveCurrentSession(proof(2), expected, NOW), /revoked/);
});

test('deleting membership cannot fall back to an actor or host role', async t => {
  const { registry, storage } = await fixture(t);
  await storage.query('DELETE FROM titan_security_memberships WHERE company_id=$1 AND actor_id=$2', ['company-a', 'stable-user-17']);
  await assert.rejects(registry.resolveCurrentSession({ ...proof(), role: 'admin', account_id: 'company-a' }, expected, NOW), /membership/);
});

test('source-session fence propagates one absolute acquisition deadline to storage and its callback', async t => {
  const underlying = createSqliteStorage(':memory:');
  let observeTransactions = false;
  const transactions = [];
  const storage = {
    dialect: underlying.dialect,
    query: (sql, params) => underlying.query(sql, params),
    transaction: (operation, options) => {
      if (observeTransactions) transactions.push(options);
      return underlying.transaction(operation, options);
    },
    close: () => underlying.close(),
  };
  const { registry, session } = await fixture(t, ':memory:', storage, () => new Date(NOW));
  const source = {
    schema: 'titan.session-source/v1', provider: principal.provider, subject: principal.subject,
    issuer: 'titan:directadmin', audience: expected.audience,
    session_id: session.session_id, session_revision: session.session_revision,
    context_revision: session.context_revision, company_id: session.company_id,
    actor_id: session.actor_id, device_id: session.device_id, expires_at: session.expires_at,
    node_id: 'node-1', csrf_sha256: 'a'.repeat(43),
  };
  const derived = await registry.issueWorkforceZeroSession(proof(), {
    ...expected, actor_id: session.actor_id, context_revision: session.context_revision,
  }, source, 300, NOW);
  const derivedProof = {
    ...proof(), session_id: derived.session_id, session_revision: derived.session_revision,
    source_session: source, credential_expires_at: derived.expires_at,
  };
  const derivedExpected = {
    audience: 'workforce', company_id: derived.company_id,
    actor_id: derived.actor_id, context_revision: derived.context_revision,
  };
  observeTransactions = true;
  let callbackDeadline;
  await registry.withCurrentSessionFence(derivedProof, derivedExpected, {}, (_current, _signal, deadline) => {
    callbackDeadline = deadline;
    return 'admitted';
  });

  assert.equal(transactions.length, 1);
  assert.equal(typeof transactions[0].acquireDeadlineMs, 'number');
  assert.ok(Number.isFinite(transactions[0].acquireDeadlineMs));
  assert.ok(transactions[0].acquireDeadlineMs > 0);
  assert.equal(transactions[0].acquireDeadlineMs, callbackDeadline);
});

test('failed additive migration rolls back and leaves legacy data untouched', async t => {
  const storage = createSqliteStorage(':memory:');
  t.after(() => storage.close());
  await storage.query('CREATE TABLE titan_security_sessions (legacy_marker TEXT)');
  await storage.query("INSERT INTO titan_security_sessions VALUES ('preserve-me')");
  await assert.rejects(security.createIdentitySessionRegistry({ storage, storage_role: 'GLOBAL_REGISTRY' }));
  const tables = (await storage.query("SELECT name FROM sqlite_master WHERE type='table'")).rows.map(r => r.name);
  assert.deepEqual(tables, ['titan_security_sessions']);
  assert.equal((await storage.query('SELECT legacy_marker FROM titan_security_sessions')).rows[0].legacy_marker, 'preserve-me');
});

test('credential-shaped extra input and host roles do not enter persisted or returned identity', async t => {
  const { registry, storage } = await fixture(t);
  const created = await registry.issueSession({ ...principal, session_id: 'safe-session', device_id: 'device-1', company_id: 'company-b', audience: 'titan-workforce', issued_at: NOW, expires_at: EXPIRY, role: 'admin', password: 'do-not-store', access_token: 'do-not-store' }, NOW);
  assert.equal(created.company_role, 'tech');
  assert.equal(JSON.stringify(created).includes('do-not-store'), false);
  const rows = (await storage.query('SELECT * FROM titan_security_sessions')).rows;
  assert.equal(JSON.stringify(rows).includes('do-not-store'), false);
});

test('recovered registry remains company-bound after switching and reopening', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'titan-security-switch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'identity.sqlite');
  const { registry, close } = await fixture(t, path);
  await registry.switchCompany(proof(), expected, 'company-b', NOW);
  await close();
  const storage = createSqliteStorage(path);
  t.after(() => storage.close());
  const recovered = await security.createIdentitySessionRegistry({ storage, storage_role: 'GLOBAL_REGISTRY' });
  await assert.rejects(recovered.resolveCurrentSession(proof(2), expected, NOW), /company/);
  await assert.rejects(recovered.resolveCurrentSession(proof(), { ...expected, company_id: 'company-b' }, NOW), /revision/);
  assert.equal((await recovered.resolveCurrentSession(proof(2), { ...expected, company_id: 'company-b' }, NOW)).actor_id, 'stable-user-17');
});

for (const [kind, update] of [
  ['actor', (r, status, revision) => r.putActor({ actor_id: 'stable-user-17', status }, revision)],
  ['company', (r, status, revision) => r.putCompany({ company_id: 'company-a', status }, revision)],
  ['device', (r, status, revision) => r.putDevice({ device_id: 'device-1', actor_id: 'stable-user-17', status }, revision)],
  ['external binding', (r, status, revision) => r.putExternalBinding({ ...principal, binding_id: 'mapping-a', actor_id: 'stable-user-17', company_id: 'company-a', status }, revision)],
]) {
  test(`reactivating ${kind} cannot restore an old generation`, async t => {
    const { registry } = await fixture(t);
    await update(registry, 'revoked', 1);
    await update(registry, 'active', 2);
    await assert.rejects(registry.resolveCurrentSession(proof(), expected, NOW), /context-stale/);
  });
}

test('switching A to B to A does not revive either old context', async t => {
  const { registry } = await fixture(t);
  await registry.switchCompany(proof(), expected, 'company-b', NOW);
  const latest = await registry.switchCompany(proof(2), { ...expected, company_id: 'company-b' }, 'company-a', NOW);
  assert.equal(latest.session_revision, 3);
  for (const revision of [1, 2]) await assert.rejects(registry.resolveCurrentSession(proof(revision), expected, NOW), /revision/);
  assert.equal((await registry.resolveCurrentSession(proof(3), expected, NOW)).company_role, 'owner');
});

test('concurrent revoke and switch cannot leave the original proof valid', async t => {
  const { registry } = await fixture(t);
  const results = await Promise.allSettled([
    registry.revokeSession('session-1', 1), registry.switchCompany(proof(), expected, 'company-b', NOW),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  await assert.rejects(registry.resolveCurrentSession(proof(), expected, NOW));
});

test('forged role, actor, company list and authority claims cannot enlarge the selected session', async t => {
  const { registry } = await fixture(t);
  const current = await registry.resolveCurrentSession({ ...proof(), actor_id: 'root', company_id: 'company-b', company_role: 'admin', allowed_company_ids: ['evil'], authority: { approved: true } }, expected, NOW);
  assert.equal(current.company_id, 'company-a');
  assert.equal(current.actor_id, 'stable-user-17');
  assert.equal(current.company_role, 'owner');
  assert.deepEqual(current.allowed_company_ids, ['company-a', 'company-b']);
  assert.equal('authority' in current, false);
});

test('same external username on another issuer and SQL-shaped IDs fail exact lookup', async t => {
  const { registry } = await fixture(t);
  await assert.rejects(registry.resolveCurrentSession({ ...proof(), provider: 'directadmin:node-2' }, expected, NOW), /binding/);
  await assert.rejects(registry.resolveCurrentSession({ ...proof(), subject: "host-account-17' OR '1'='1" }, expected, NOW));
  await assert.rejects(registry.resolveCurrentSession({ ...proof(), session_id: "session-1' OR '1'='1" }, expected, NOW));
});

for (const mode of ['committed', 'uncommitted']) {
  test(`process death after ${mode} revocation recovers an atomic session state`, { timeout: 15_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'titan-security-crash-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'identity.sqlite');
    const { close } = await fixture(t, path);
    await close();
    const child = fork(new URL('./fixtures/security-session-crash-child.mjs', import.meta.url), [path, mode], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    const [ready] = await once(child, 'message', { signal: AbortSignal.timeout(5_000) });
    assert.equal(ready, 'ready');
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    const [, signal] = await exited;
    assert.equal(signal, 'SIGKILL');
    const storage = createSqliteStorage(path);
    t.after(() => storage.close());
    const recovered = await security.createIdentitySessionRegistry({ storage, storage_role: 'GLOBAL_REGISTRY' });
    if (mode === 'committed') await assert.rejects(recovered.resolveCurrentSession(proof(2), expected, NOW), /revoked/);
    else assert.equal((await recovered.resolveCurrentSession(proof(), expected, NOW)).session_revision, 1);
  });
}
