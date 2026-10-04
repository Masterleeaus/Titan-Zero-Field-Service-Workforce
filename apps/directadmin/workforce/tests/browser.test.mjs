import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';

// Fixture transport only. No fixture is included in the install archive.
const fixtureSdk = `export class DirectAdminCockpitSession {
 subscribe(listener) {this.listener=listener;} invalidate() {this.listener?.();}
 async connect(){if(globalThis.fixtureWait) await new Promise(resolve=>{globalThis.fixtureRelease=resolve;}); return {company_id:globalThis.fixtureCompany||'fixture-company',actor_id:'fixture-actor',session_revision:1,context_revision:'fixture-context'};}
 async projection(){const company_id=globalThis.fixtureCompany||'fixture-company'; return {company_id,source:'fixture-browser-owner',freshness:'2026-10-02T00:00:00.000Z',evidence_refs:['fixture-projection-evidence'],data:{schema:'titan.workforce-cockpit.v1',company_id,
 discovery:{company_id,controls:globalThis.fixtureControls??[{action:'pause',capability_id:'fixture.pause'},{action:'shell',capability_id:'shell'}],workers:globalThis.fixtureWorkers??[{company_id,worker_id:'<img src=x onerror=alert(1)>',kind:'digital',role:'worker',active:true,capabilities:['work.pause']}],...(globalThis.fixtureSkills!==undefined?{skills:globalThis.fixtureSkills}:{})},
 status:{company_id,work:globalThis.fixtureWork??[{company_id,work_id:'fixture-work',objective:'Fixture job',assignee:'<img src=x onerror=alert(1)>',state:'COMPLETED',evidence_refs:['fixture-evidence']}]}}};}
 async intent(plugin,input){globalThis.fixtureCalls=(globalThis.fixtureCalls||0)+1; globalThis.fixtureIntent={plugin,intent:input}; if(globalThis.fixtureDenied) throw Error(globalThis.fixtureDenied===true?'403 sensitive-error':globalThis.fixtureDenied); if(input.input.action==='reassign'){const evidence='fixture-reassignment-evidence';globalThis.fixtureWork=globalThis.fixtureWork.map(item=>item.work_id===input.input.work_id?{...item,assignee:input.input.target_worker_id,evidence_refs:[...(item.evidence_refs||[]),evidence]}:item);} return {status:'REQUESTED',correlation_id:input.correlation_id,receipt_id:input.input.action==='reassign'?'fixture-reassignment-receipt':'fixture-receipt'};}
}`;
const fixtureRelayClient = `export function createDirectAdminRelayFetch(fetchImpl = globalThis.fetch) { return fetchImpl; }`;
function fixtureAvailableSkills(company_id, worker_id, evidence_ref) {
  const skill = { worker_id, capability_id: 'general_cleaning', proficiency: 4,
    proficiency_level: 'PROFICIENT', verification_state: 'VERIFIED', proof_state: 'verified', proof_strength: 0.9,
    evidence_count: 1, evidence_refs: [evidence_ref], contextual_performance_support: null,
    contextual_performance_is_not_capability_verification: true, meets_registry_requirement: true,
    required_min_proficiency: 3, require_verified: true, expired_or_revoked: false,
    capability_presence_confers_authority: false, verification_confers_authority: false,
    performance_confers_authority: false, grants_authority: false };
  return { schema: 'titan.directadmin.workforce-skills.v1', company_id, context_revision: 'fixture-context',
    status: 'available', source: 'canonical-workforce-skill-capability-registry', freshness: '2026-10-02T00:00:00.000Z',
    source_revision: 1, evidence_refs: [evidence_ref], read_only: true, capability_presence_confers_authority: false,
    verification_confers_authority: false, assignment_decision: false, routing_decision: false,
    entitlement_decision: false, execution_permitted: false, grants_authority: false,
    projection: { schema: 'titan.workforce.evidence-backed-skill-proof.v1', company_id,
      workers: [{ worker_id, skills: [skill], summary: { skill_count: 1, verified: 1, evidenced: 0,
        unverified: 0, expired_or_revoked: 0, requirement_gaps: 0 },
        worker_identity_confers_authority: false, grants_authority: false }], skill_proofs: [skill],
      summary: { worker_count: 1, skill_proof_count: 1, verified_skill_proofs: 1, evidenced_skill_proofs: 0,
        unverified_skill_proofs: 0, invalid_skill_proofs: 0, requirement_gaps: 0, workers_with_contextual_performance: 0 },
      read_only: true, derived: true, performance_is_context_only: true, routing_decision: false,
      entitlement_decision: false, assignment_decision: false, automatic_execution: false,
      execution_permitted: false, grants_authority: false } };
}
async function serveFixtureRelayClient(page) {
  await page.route('https://workforce.test/CMD_PLUGINS/titan-server-node/images/directadmin-relay-client.mjs', route =>
    route.fulfill({ contentType: 'text/javascript', body: fixtureRelayClient }));
  for (const rolePath of ['/CMD_PLUGINS_ADMIN', '/CMD_PLUGINS_RESELLER', '/CMD_PLUGINS']) {
    const nonceUrl = `https://workforce.test${rolePath}/titan_workforce/bootstrap-nonce.raw?headers_to_env=yes&pipe_post=yes`;
    const bootstrapUrl = `https://workforce.test${rolePath}/titan_workforce/bootstrap.raw?headers_to_env=yes&pipe_post=yes`;
    await page.route(url => url.href === nonceUrl, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ csrf_nonce: 'B'.repeat(43) }) }));
    await page.route(url => url.href === bootstrapUrl, route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ csrf_token: 'C'.repeat(43) }) }));
  }
}

test('role entrypoints request only their own same-origin bootstrap nonce RAW path', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workforce-bootstrap-role-paths-'));
  let browser;
  try {
    await cp(new URL('../', import.meta.url), folder, { recursive: true });
    await writeFile(join(folder, 'images/sdk.mjs'), fixtureSdk);
    const { renderEntry } = await import(pathToFileURL(join(folder, 'lib/entry.mjs')));
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    const nonceRequests = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/titan_workforce/bootstrap-nonce.raw')) nonceRequests.push({ method: request.method(), url: request.url(), headers: request.headers(), body: request.postData() });
    });
    await serveFixtureRelayClient(page);
    const expected = { admin: '/CMD_PLUGINS_ADMIN', reseller: '/CMD_PLUGINS_RESELLER', user: '/CMD_PLUGINS' };
    let activeRole = 'admin';
    await page.route('https://workforce.test/', route => route.fulfill({ contentType: 'text/html', body: renderEntry(activeRole) }));
    for (const role of Object.keys(expected)) {
      activeRole = role;
      await page.goto('https://workforce.test/');
      await page.getByText('Current hosted projection', { exact: true }).waitFor();
      const request = nonceRequests.at(-1);
      assert.equal(request.method, 'POST');
      assert.equal(new URL(request.url).pathname, `${expected[role]}/titan_workforce/bootstrap-nonce.raw`);
      assert.equal(new URL(request.url).search, '?headers_to_env=yes&pipe_post=yes');
      assert.equal(request.body, null, 'nonce RAW request has no body');
      assert.equal(request.headers['content-type'], undefined, 'nonce RAW request has no content type');
      assert.equal(request.headers.origin, 'https://workforce.test');
    }
    assert.equal(nonceRequests.length, 3);
    await context.close();
  } finally { await browser?.close(); await rm(folder, { recursive: true, force: true }); }
});

test('executable cockpit renders safely, submits bounded controls, and clears on denial', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workforce-browser-'));
  let browser;
  try {
    await cp(new URL('../', import.meta.url), folder, { recursive: true });
    await writeFile(join(folder, 'images/sdk.mjs'), fixtureSdk);
    const { renderEntry } = await import(pathToFileURL(join(folder, 'lib/entry.mjs')));
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await serveFixtureRelayClient(page);
    await page.route('https://workforce.test/', route => route.fulfill({ contentType: 'text/html', body: renderEntry('user') }));
    await page.goto('https://workforce.test/');
    await page.getByText('Current hosted projection', { exact: true }).waitFor();
    assert.equal(await page.locator('#titan-workforce img').count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Cleaner teams', exact: true }).count(), 1,
      'cleaning crew operations are the default company-scoped view');
    await page.getByRole('button', { name: 'Roster', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '<img src=x onerror=alert(1)>' }).count(), 1);
    await page.getByRole('button', { name: 'Cleaning work queue', exact: true }).click();
    await page.getByLabel('Filter work').selectOption('verified');
    assert.equal(await page.getByText('Fixture job', { exact: true }).count(), 0);
    await page.getByLabel('Filter work').selectOption('all');
    assert.equal(await page.getByText('fixture-work', { exact: true }).count(), 1);
    await page.getByRole('button', { name: 'Governed actions', exact: true }).click();
    assert.equal(await page.locator('option[value="shell"]').count(), 0);
    await page.getByLabel('Reason', { exact: true }).fill('Fixture pause request');
    await page.getByRole('button', { name: 'Submit governed request' }).click();
    await page.getByText('Request accepted — verified outcome not yet available', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => globalThis.fixtureCalls), 1);
    await page.evaluate(() => { globalThis.fixtureDenied = true; });
    await page.getByLabel('Reason', { exact: true }).fill('Fixture denied request');
    await page.getByRole('button', { name: 'Submit governed request' }).click();
    await page.getByText('Access or company context changed. Reconnect to revalidate.').waitFor();
    assert.equal(await page.getByText('fixture-company', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Submit governed request' }).count(), 0);
    assert.equal(await page.getByText('sensitive-error').count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(folder, { recursive: true, force: true }); }
});

test('roster distinguishes human and AI identities and derives company team membership, including empty state', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workforce-roster-teams-browser-'));
  let browser;
  try {
    await cp(new URL('../', import.meta.url), folder, { recursive: true });
    await writeFile(join(folder, 'images/sdk.mjs'), fixtureSdk);
    const { renderEntry } = await import(pathToFileURL(join(folder, 'lib/entry.mjs')));
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    await page.addInitScript(() => {
      globalThis.fixtureWorkers = [
        { company_id: 'fixture-company', worker_id: 'human-member', kind: 'human', active: true,
          team_id: 'crew-a', capabilities: ['work.dispatch'] },
        { company_id: 'fixture-company', worker_id: 'ai-member', kind: 'digital', active: false,
          team_id: 'crew-a', capabilities: ['work.schedule'] },
        { company_id: 'fixture-company', worker_id: 'unassigned-member', kind: 'human', active: true, capabilities: [] },
      ];
      globalThis.fixtureWork = [];
    });
    await serveFixtureRelayClient(page);
    await page.route('https://workforce.test/', route => route.fulfill({ contentType: 'text/html', body: renderEntry('user') }));
    await page.goto('https://workforce.test/');
    await page.getByText('Current hosted projection', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Roster', exact: true }).click();
    await page.getByRole('columnheader', { name: 'Identity type' }).waitFor();
    const roster = page.locator('#titan-workforce table tbody tr');
    assert.equal(await roster.count(), 3);
    assert.equal(await roster.filter({ hasText: 'Human' }).count(), 2);
    assert.equal(await roster.filter({ hasText: 'AI / digital' }).count(), 1);
    const activityStatuses = [];
    for (let index = 0; index < await roster.count(); index++) activityStatuses.push(await roster.nth(index).locator('td').nth(3).innerText());
    assert.deepEqual(activityStatuses.sort(), ['Active', 'Active', 'Inactive']);

    await page.getByRole('button', { name: 'Cleaner teams', exact: true }).click();
    await page.getByText('crew-a', { exact: true }).waitFor();
    await page.getByText('Unassigned', { exact: true }).waitFor();
    const teamRows = page.locator('#titan-workforce table tbody tr');
    assert.equal(await teamRows.count(), 2);
    assert.match(await teamRows.nth(0).innerText(), /crew-a\s+1\s+1\s+1\s+1/);
    assert.match(await teamRows.nth(1).innerText(), /Unassigned\s+1\s+0\s+1\s+0/);
    assert.match(await page.locator('#titan-workforce').innerText(), /Membership is grouped from this company’s hosted roster team_id values/);

    await page.evaluate(() => { globalThis.fixtureWorkers = []; globalThis.fixtureWork = []; });
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await page.getByText('Current hosted projection', { exact: true }).waitFor();
    assert.equal(await page.getByText('fixture-company', { exact: true }).count(), 1);
    assert.equal(await page.locator('#titan-workforce table tbody tr').count(), 0);
    await page.getByText('No records supplied by the hosted Workforce.', { exact: true }).waitFor();
    assert.equal(await page.getByText('crew-a', { exact: true }).count(), 0);
    assert.equal(await page.getByText('Unassigned', { exact: true }).count(), 0);
  } finally { await browser?.close(); await rm(folder, { recursive: true, force: true }); }
});

test('company switch while Teams is open clears old memberships before loading the new company', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workforce-team-company-switch-'));
  let browser;
  try {
    await cp(new URL('../', import.meta.url), folder, { recursive: true });
    await writeFile(join(folder, 'images/sdk.mjs'), fixtureSdk);
    const { renderEntry } = await import(pathToFileURL(join(folder, 'lib/entry.mjs')));
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(({ skillsA, skillsB }) => {
      globalThis.fixtureSkillsByCompany = { a: skillsA, b: skillsB };
      globalThis.fixtureSkills = skillsA;
      globalThis.fixtureWorkers = [
        { company_id: 'fixture-company', worker_id: 'company-a-member', kind: 'human', active: true,
          team_id: 'company-a-team', capabilities: [] },
      ];
      globalThis.fixtureWork = [];
    }, { skillsA: fixtureAvailableSkills('fixture-company', 'company-a-member', 'company-a-skill-proof'),
      skillsB: fixtureAvailableSkills('company-b', 'company-b-member', 'company-b-skill-proof') });
    await serveFixtureRelayClient(page);
    await page.route('https://workforce.test/', route => route.fulfill({ contentType: 'text/html', body: renderEntry('user') }));
    await page.goto('https://workforce.test/');
    await page.getByText('Current hosted projection', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Cleaner teams', exact: true }).click();
    await page.getByText('company-a-team', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Skills & proof', exact: true }).click();
    await page.getByText('company-a-member · 1 proof rows', { exact: true }).click();
    await page.locator('#titan-workforce').getByText('company-a-skill-proof', { exact: true }).first().waitFor();

    await page.evaluate(() => {
      globalThis.fixtureCompany = 'company-b';
      globalThis.fixtureSkills = globalThis.fixtureSkillsByCompany.b;
      globalThis.fixtureWorkers = [{ company_id: 'company-b', worker_id: 'company-b-member', kind: 'digital',
        active: true, team_id: 'company-b-team', capabilities: [] }];
      globalThis.fixtureWait = true;
      window.dispatchEvent(new Event('titan-context-changed'));
    });
    await page.getByText('Loading current company context…', { exact: true }).waitFor();
    assert.match(await page.locator('#titan-workforce').innerText(), /Loading current company context/);
    assert.equal(await page.getByText('fixture-company', { exact: true }).count(), 0);
    assert.equal(await page.getByText('company-a-team', { exact: true }).count(), 0);
    assert.equal(await page.getByText('company-a-skill-proof', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('navigation').count(), 0);

    await page.evaluate(() => { globalThis.fixtureWait = false; globalThis.fixtureRelease(); });
    await page.getByText('company-b', { exact: true }).waitFor();
    await page.getByText('company-b-member · 1 proof rows', { exact: true }).click();
    await page.locator('#titan-workforce').getByText('company-b-skill-proof', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('company-a-skill-proof', { exact: true }).count(), 0);
    await page.getByRole('button', { name: 'Cleaner teams', exact: true }).click();
    await page.getByText('company-b-team', { exact: true }).waitFor();
    assert.equal(await page.getByText('company-a-team', { exact: true }).count(), 0);
    assert.equal(await page.getByText('company-b-member (AI / digital)', { exact: true }).count(), 1);
    assert.equal(await page.locator('#titan-workforce table tbody tr').count(), 1);
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(folder, { recursive: true, force: true }); }
});

test('existing cockpit consumes the typed READY reassignment contract and displays the receipt/evidence', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workforce-reassignment-browser-'));
  let browser;
  try {
    await cp(new URL('../', import.meta.url), folder, { recursive: true });
    await writeFile(join(folder, 'images/sdk.mjs'), fixtureSdk);
    const { renderEntry } = await import(pathToFileURL(join(folder, 'lib/entry.mjs')));
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    await page.addInitScript(() => {
      globalThis.fixtureControls = [{ action: 'reassign', capability_id: 'titan.workforce.reassign',
        requires_fresh_approval: true, grants_authority: false }];
      globalThis.fixtureWorkers = [
        { company_id: 'fixture-company', worker_id: 'cleaner-current', kind: 'human', active: true, team_id: 'cleaning-crew', capabilities: [] },
        { company_id: 'fixture-company', worker_id: 'cleaner-target', kind: 'human', active: true, team_id: 'cleaning-crew', capabilities: ['cleaning.standard'] },
        { company_id: 'fixture-company', worker_id: 'cleaner-unqualified', kind: 'human', active: true, team_id: 'cleaning-crew', capabilities: [] },
        { company_id: 'fixture-company', worker_id: 'cleaner-inactive', kind: 'human', active: false, team_id: 'cleaning-crew', capabilities: ['cleaning.standard'] },
      ];
      globalThis.fixtureWork = [
        { company_id: 'fixture-company', work_id: 'regular-clean-ready-work', state: 'READY', assignee: 'cleaner-current',
          required_capabilities: ['cleaning.standard'], evidence_refs: [], context_refs: [] },
        { company_id: 'fixture-company', work_id: 'regular-clean-active-work', state: 'IN_PROGRESS', assignee: 'cleaner-current', evidence_refs: [], context_refs: [] },
      ];
    });
    await serveFixtureRelayClient(page);
    await page.route('https://workforce.test/', route => route.fulfill({ contentType: 'text/html', body: renderEntry('user') }));
    await page.goto('https://workforce.test/');
    await page.getByText('Current hosted projection', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'cleaning-crew', exact: true }).click();
    await page.getByRole('button', { name: 'Review reassignment', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Review reassignment', exact: true }).click();
    const workSelect = page.getByLabel('Work item');
    assert.equal(await page.getByLabel('Operation').inputValue(), 'reassign', 'team review opens only the published governed action');
    assert.equal(await workSelect.inputValue(), 'regular-clean-ready-work', 'the selected READY cleaning work is preselected for review');
    assert.equal(await workSelect.locator('option[value="regular-clean-active-work"]').count(), 0);
    const targetSelect = page.getByLabel('Target team member');
    assert.equal(await targetSelect.locator('option[value="cleaner-current"]').count(), 0);
    assert.equal(await targetSelect.locator('option[value="cleaner-inactive"]').count(), 0);
    assert.equal(await targetSelect.locator('option[value="cleaner-unqualified"]').count(), 0);
    assert.equal(await targetSelect.locator('option[value="cleaner-target"]').count(), 1);
    await targetSelect.selectOption('cleaner-target');
    await page.getByLabel('Reason', { exact: true }).fill('Balance the ready cleaning work');
    await page.getByRole('button', { name: 'Submit governed request' }).click();
    await page.getByText('Request accepted — verified outcome not yet available', { exact: true }).waitFor();
    const sent = await page.evaluate(() => globalThis.fixtureIntent);
    assert.equal(sent.plugin, 'titan_workforce');
    assert.equal(sent.intent.capability_id, 'titan.workforce.reassign');
    assert.deepEqual(sent.intent.input, {
      action: 'reassign', work_id: 'regular-clean-ready-work', reason: 'Balance the ready cleaning work',
      expected_assignee_id: 'cleaner-current', target_worker_id: 'cleaner-target',
    });
    await page.getByRole('button', { name: 'Receipts & evidence', exact: true }).click();
    await page.getByText('fixture-reassignment-receipt', { exact: true }).waitFor();
    await page.getByText('This host or shared SDK does not publish receipt details. The request acknowledgement is not a verified outcome.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Refresh receipt details', exact: true }).click();
    await page.getByText('This host or shared SDK does not publish receipt details. The request acknowledgement is not a verified outcome.', { exact: true }).waitFor();
    assert.equal(await page.getByText('Request accepted — verified outcome not yet available', { exact: true }).count(), 1,
      'refreshing an unsupported host preserves the correlated REQUESTED acknowledgement');
    await page.locator('details > summary').filter({ hasText: 'regular-clean-ready-work' }).click();
    await page.getByText('fixture-reassignment-evidence', { exact: true }).waitFor();
    assert.equal(await page.getByText('Verified outcome with evidence', { exact: true }).count(), 0,
      'the REQUESTED gateway receipt is never promoted to verified outcome');
  } finally { await browser?.close(); await rm(folder, { recursive: true, force: true }); }
});

test('cleaning skill proof view consumes the host projection without treating proof as assignment authority', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workforce-cleaning-skills-browser-'));
  let browser;
  try {
    await cp(new URL('../', import.meta.url), folder, { recursive: true });
    await writeFile(join(folder, 'images/sdk.mjs'), fixtureSdk);
    const { renderEntry } = await import(pathToFileURL(join(folder, 'lib/entry.mjs')));
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    await page.addInitScript(skills => {
      globalThis.fixtureSkills = skills;
      globalThis.fixtureWorkers = [{ company_id: 'fixture-company', worker_id: 'cleaner-a', kind: 'human', active: true, team_id: 'crew-a', capabilities: ['general_cleaning'] }];
    }, fixtureAvailableSkills('fixture-company', 'cleaner-a', 'cleaning-proof-evidence'));
    await serveFixtureRelayClient(page);
    await page.route('https://workforce.test/', route => route.fulfill({ contentType: 'text/html', body: renderEntry('user') }));
    await page.goto('https://workforce.test/');
    await page.getByText('Current hosted projection', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Skills & proof', exact: true }).click();
    await page.getByText('cleaner-a · 1 proof rows', { exact: true }).click();
    await page.getByText('general_cleaning', { exact: true }).waitFor();
    await page.locator('#titan-workforce').getByText('cleaning-proof-evidence', { exact: true }).first().waitFor();
    await page.getByText(/do not decide assignment or grant tools, autonomy, or authority/).waitFor();
    await page.getByText(/Cleaning profile-to-native-worker mapping/).waitFor();
  } finally { await browser?.close(); await rm(folder, { recursive: true, force: true }); }
});

test('cleaning skills view distinguishes unavailable and older-host projections', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workforce-cleaning-skills-unavailable-'));
  let browser;
  try {
    await cp(new URL('../', import.meta.url), folder, { recursive: true });
    await writeFile(join(folder, 'images/sdk.mjs'), fixtureSdk);
    const { renderEntry } = await import(pathToFileURL(join(folder, 'lib/entry.mjs')));
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    await serveFixtureRelayClient(page);
    await page.route('https://workforce.test/', route => route.fulfill({ contentType: 'text/html', body: renderEntry('user') }));
    await page.goto('https://workforce.test/');
    await page.getByText('Current hosted projection', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Skills & proof', exact: true }).click();
    await page.getByText(/compatible host does not publish the skills field/).waitFor();
    await page.evaluate(() => {
      const company_id = 'fixture-company';
      globalThis.fixtureSkills = { schema: 'titan.directadmin.workforce-skills.v1', company_id, context_revision: 'fixture-context',
        status: 'unavailable', reason: 'canonical-skill-projection-unavailable', source: null, freshness: null,
        source_revision: null, evidence_refs: [], read_only: true, capability_presence_confers_authority: false,
        verification_confers_authority: false, assignment_decision: false, routing_decision: false,
        entitlement_decision: false, execution_permitted: false, grants_authority: false };
    });
    await page.getByRole('button', { name: 'Reconnect / refresh' }).click();
    await page.getByText(/canonical skill source is unavailable for this company/).waitFor();
    assert.equal(await page.getByText(/does not publish the skills field/).count(), 0);
  } finally { await browser?.close(); await rm(folder, { recursive: true, force: true }); }
});

test('context change and page lifecycle erase the prior company before reconnect settles', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workforce-lifecycle-'));
  let browser;
  try {
    await cp(new URL('../', import.meta.url), folder, { recursive: true });
    await writeFile(join(folder, 'images/sdk.mjs'), fixtureSdk);
    const { renderEntry } = await import(pathToFileURL(join(folder, 'lib/entry.mjs')));
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await serveFixtureRelayClient(page);
    await page.route('https://workforce.test/', route => route.fulfill({ contentType: 'text/html', body: renderEntry('user') }));
    await page.goto('https://workforce.test/');
    await page.getByText('Current hosted projection', { exact: true }).waitFor();
    await page.evaluate(() => {
      globalThis.fixtureCompany = 'new-company'; globalThis.fixtureWait = true;
      window.dispatchEvent(new Event('titan-context-changed'));
    });
    await page.getByText('Loading current company context…', { exact: true }).waitFor();
    assert.match(await page.locator('#titan-workforce').innerText(), /Loading current company context/);
    assert.equal(await page.getByText('fixture-company', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('navigation').count(), 0);
    await page.evaluate(() => { globalThis.fixtureWait = false; globalThis.fixtureRelease(); });
    await page.getByText('new-company', { exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    assert.equal(await page.getByText('new-company', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('navigation').count(), 0);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await page.getByText('new-company', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await rm(folder, { recursive: true, force: true }); }
});

test('an explicitly empty hosted controls list renders read-only and sends no intent', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workforce-readonly-browser-'));
  let browser;
  try {
    await cp(new URL('../', import.meta.url), folder, { recursive: true });
    await writeFile(join(folder, 'images/sdk.mjs'), fixtureSdk);
    const { renderEntry } = await import(pathToFileURL(join(folder, 'lib/entry.mjs')));
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    await serveFixtureRelayClient(page);
    await page.addInitScript(() => { globalThis.fixtureControls = []; });
    await page.route('https://workforce.test/', route => route.fulfill({ contentType: 'text/html', body: renderEntry('user') }));
    await page.goto('https://workforce.test/');
    await page.getByText('Current hosted projection', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Governed actions', exact: true }).click();
    await page.getByText('This is a read-only Workforce projection. The canonical owner has not exposed an authorized lifecycle control; no request was sent.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Submit governed request' }).count(), 0);
    assert.equal(await page.evaluate(() => globalThis.fixtureCalls || 0), 0);
  } finally { await browser?.close(); await rm(folder, { recursive: true, force: true }); }
});

test('missing Server Node relay module renders an explicit unavailable state', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workforce-no-relay-'));
  let browser;
  try {
    await cp(new URL('../', import.meta.url), folder, { recursive: true });
    await writeFile(join(folder, 'images/sdk.mjs'), fixtureSdk);
    const { renderEntry } = await import(pathToFileURL(join(folder, 'lib/entry.mjs')));
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    await page.route('https://workforce.test/CMD_PLUGINS/titan-server-node/images/directadmin-relay-client.mjs', route =>
      route.fulfill({ status: 404, contentType: 'text/plain', body: 'not installed' }));
    await page.route('https://workforce.test/', route => route.fulfill({ contentType: 'text/html', body: renderEntry('user') }));
    await page.goto('https://workforce.test/');
    await page.getByText('DirectAdmin Workforce relay is unavailable. Install or restore the Titan Server Node plugin, then reconnect.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Submit governed request' }).count(), 0);
    assert.equal(await page.getByRole('navigation').count(), 0);
  } finally { await browser?.close(); await rm(folder, { recursive: true, force: true }); }
});

test('invalid relay factory result cannot fall back to direct API fetch', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'workforce-invalid-relay-'));
  let browser;
  try {
    await cp(new URL('../', import.meta.url), folder, { recursive: true });
    await writeFile(join(folder, 'images/sdk.mjs'), fixtureSdk);
    const { renderEntry } = await import(pathToFileURL(join(folder, 'lib/entry.mjs')));
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const page = await browser.newPage();
    const apiRequests = [];
    await page.route('https://workforce.test/CMD_PLUGINS/titan-server-node/images/directadmin-relay-client.mjs', route =>
      route.fulfill({ contentType: 'text/javascript', body: 'export function createDirectAdminRelayFetch() { return undefined; }' }));
    await page.route('https://workforce.test/v1/directadmin/**', async route => {
      apiRequests.push(route.request().url());
      await route.fulfill({ status: 500, body: 'unexpected direct request' });
    });
    await page.route('https://workforce.test/', route => route.fulfill({ contentType: 'text/html', body: renderEntry('user') }));
    await page.goto('https://workforce.test/');
    await page.getByText('DirectAdmin Workforce relay is unavailable. Install or restore the Titan Server Node plugin, then reconnect.', { exact: true }).waitFor();
    assert.equal(apiRequests.length, 0);
    assert.equal(await page.getByRole('button', { name: 'Submit governed request' }).count(), 0);
  } finally { await browser?.close(); await rm(folder, { recursive: true, force: true }); }
});
