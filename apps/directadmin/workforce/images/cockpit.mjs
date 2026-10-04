import * as SDK from 'titan-sdk';
import { WorkforceController } from 'workforce-controller';
import { WorkforceApi } from 'workforce-api';
import { boundedText, identityType, position, teamMemberships, workState, receiptState, verifiedOutcome } from 'workforce-presentation';

const root = document.getElementById('titan-workforce');
const role = root.dataset.role;
let controller;
let tab = 'Teams';
let selectedAgent = null;
let selectedTeam = null;
let selectedControl = null;
let workFilter = 'all';
let reconnect = async () => {};
const REASSIGN_CAPABILITY = 'titan.workforce.reassign';
const node = (tag, text, attrs = {}) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = boundedText(text);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
};
const button = (text, action, disabled = false) => {
  const element = node('button', text, { type: 'button' });
  element.disabled = disabled; element.addEventListener('click', action); return element;
};
const panel = title => { const element = node('section', undefined, { class: 'panel' }); element.append(node('h2', title)); return element; };
function fields(parent, values) {
  const dl = node('dl');
  for (const [key, value] of Object.entries(values)) { dl.append(node('dt', key), node('dd', Array.isArray(value) ? value.join(', ') || 'None supplied' : value ?? 'Not supplied')); }
  parent.append(dl);
}
function table(parent, headers, rows) {
  if (!rows.length) { parent.append(node('p', 'No records supplied by the hosted Workforce.', { class: 'muted' })); return; }
  const element = node('table'); const head = node('thead'); const hr = node('tr');
  for (const header of headers) hr.append(node('th', header, { scope: 'col' }));
  head.append(hr); element.append(head); const body = node('tbody');
  for (const row of rows) { const tr = node('tr'); for (const value of row) { const td = node('td'); if (value instanceof Node) td.append(value); else td.textContent = boundedText(value); tr.append(td); } body.append(tr); }
  element.append(body); parent.append(element);
}
function unavailable(parent, facet) { parent.append(node('p', `${facet} is not supplied by the current hosted API. No local substitute is created.`, { class: 'notice' })); }
function reassignPublished(discovery) {
  return (discovery?.controls ?? []).some(item => item?.action === 'reassign' &&
    item.capability_id === REASSIGN_CAPABILITY && item.requires_fresh_approval === true && item.grants_authority === false);
}
function openReassignment(workId) {
  selectedControl = { action: 'reassign', work_id: workId };
  tab = 'Controls';
  render(controller.state);
}
function projectedAssignee(item, workers) {
  if (!item.assignee) return 'Unassigned';
  return workers.find(worker => worker.worker_id === item.assignee)?.worker_id ?? 'Not in current roster';
}
function evidence(parent, refs) {
  const list = node('ul');
  for (const ref of refs ?? []) list.append(node('li', ref));
  if (!list.children.length) parent.append(node('p', 'No evidence references supplied.'));
  else parent.append(list);
}
function receiptLookupNotice(status) {
  const messages = {
    loading: 'Checking the current company-scoped receipt details…',
    pending: 'The hosted owner has not returned receipt details yet. The request acknowledgement is not a verified outcome.',
    unsupported: 'This host or shared SDK does not publish receipt details. The request acknowledgement is not a verified outcome.',
    unavailable: 'Receipt details could not be loaded. The request acknowledgement is not proof of a verified outcome.',
  };
  if (messages[status]) return node('p', messages[status], { class: 'notice', role: 'status' });
  return null;
}
function render(state) {
  root.replaceChildren();
  if (!state.context) { selectedAgent = null; selectedTeam = null; selectedControl = null; }
  if (state.receipt) selectedControl = null;
  const header = node('header'); const identity = node('div');
  identity.append(node('span', 'Cleaning operations · Workforce Manager', { class: 'eyebrow' }), node('h1', 'Titan Workforce'));
  header.append(identity, button('Reconnect / refresh', () => { void reconnect(); }, state.phase === 'submitting'));
  root.append(header);
  const live = node('p', state.phase === 'ready' ? (state.error ?? 'Current hosted projection') : state.phase === 'submitting' ? 'Submitting governed request…' : state.phase === 'loading' ? 'Loading current company context…' : state.error, { role: 'status', 'aria-live': 'polite' });
  root.append(live);
  if (!state.context) return;
  const context = panel('Current company');
  fields(context, { Company: state.context.company_id, Actor: state.context.actor_id, 'DirectAdmin role (presentation only)': role, 'Execution authority': 'Re-evaluated by the canonical host for every request' }); root.append(context);
  const nav = node('nav', undefined, { 'aria-label': 'Workforce views' });
  const views = [
    ['Teams', 'Cleaner teams'], ['Work', 'Cleaning work queue'], ['Roster', 'Roster'],
    ['Organisation', 'Organisation'], ['Controls', 'Governed actions'],
    ['Skills', 'Skills & proof'], ['Evidence', 'Receipts & evidence'], ['Health', 'Host status'],
  ];
  for (const [key, title] of views) {
    const item = button(title, () => { tab = key; render(controller.state); }); item.setAttribute('aria-current', key === tab ? 'page' : 'false'); nav.append(item);
  }
  root.append(nav);
  const workers = state.discovery?.workers ?? [];
  const work = state.status?.work ?? [];
  const viewTitles = { Teams: 'Cleaner teams', Work: 'Cleaning work queue', Roster: 'Company Workforce roster',
    Organisation: 'Team and reporting structure', Controls: 'Governed actions', Skills: 'Skills and proof',
    Evidence: 'Receipts and evidence', Health: 'Host status' };
  const view = panel(viewTitles[tab] ?? tab); root.append(view);
  if (tab === 'Roster') {
    table(view, ['Identity', 'Identity type', 'Position', 'Activity status', 'Team', 'Manager', 'Capabilities'], workers.map(worker => [button(worker.worker_id, () => { selectedAgent = worker.worker_id; render(controller.state); }), identityType(worker), position(worker), worker.active ? 'Active' : 'Inactive', worker.team_id ?? 'Unassigned', worker.manager_id ?? 'Not supplied', (worker.capabilities ?? []).join(', ')]));
    const agent = workers.find(worker => worker.worker_id === selectedAgent);
    if (agent) {
      const detail = panel('Agent / participant detail'); fields(detail, { Identity: agent.worker_id, Company: agent.company_id, Kind: agent.kind, Position: position(agent), Team: agent.team_id, Manager: agent.manager_id, Capabilities: agent.capabilities });
      detail.append(node('p', 'Capability availability does not grant execution authority.', { class: 'notice' }));
      table(detail, ['Current work', 'State', 'Evidence'], work.filter(item => item.assignee === agent.worker_id).map(item => [item.work_id, workState(item.state), (item.evidence_refs ?? []).join(', ')]));
      unavailable(detail, 'Operation-specific trust, approved knowledge references, model/provider bindings and attributable value'); root.append(detail);
    }
  } else if (tab === 'Teams') {
    const groups = teamMemberships(workers);
    table(view, ['Team', 'Human participants', 'AI / digital participants', 'Active', 'Inactive', 'Ready work', 'Members', 'Review'], groups.map(group => {
      const humans = group.members.filter(worker => worker.kind === 'human');
      const digital = group.members.filter(worker => worker.kind === 'digital');
      const memberIds = new Set(group.members.map(worker => worker.worker_id));
      const assignedWork = work.filter(item => memberIds.has(item.assignee));
      const teamKey = group.team_id ?? '__unassigned__';
      return [button(group.team_id ?? 'Unassigned', () => { selectedTeam = teamKey; render(controller.state); }), humans.length, digital.length,
        group.members.filter(worker => worker.active).length,
        group.members.filter(worker => !worker.active).length,
        assignedWork.filter(item => item.state === 'READY').length,
        group.members.map(worker => `${worker.worker_id} (${identityType(worker)})`).join(', '),
        button('Review team work', () => { selectedTeam = teamKey; render(controller.state); })];
    }));
    view.append(node('p', 'Membership is grouped from this company’s hosted roster team_id values. A team label does not prove a cleaner profile binding, verified skill, availability, tool access, or authority.', { class: 'notice' }));
    view.append(node('p', 'Cleaning role and job playbook entries are definitions, not live worker records. Only identities returned by the current company’s hosted Workforce appear here.', { class: 'notice' }));
    const selectedGroup = groups.find(group => (group.team_id ?? '__unassigned__') === selectedTeam);
    if (selectedGroup) {
      const memberIds = new Set(selectedGroup.members.map(worker => worker.worker_id));
      const teamWork = work.filter(item => memberIds.has(item.assignee));
      const detail = panel(`Hosted work for ${selectedGroup.team_id ?? 'unassigned cleaners'}`);
      if (!teamWork.length) detail.append(node('p', 'No hosted work is assigned to these current company roster members.', { class: 'muted' }));
      else table(detail, ['Work ID', 'Run ID', 'State', 'Required capabilities', 'Evidence', 'Next action'], teamWork.map(item => [
        item.work_id, item.run_id ?? 'Not supplied', workState(item.state), (item.required_capabilities ?? []).join(', '),
        (item.evidence_refs ?? []).join(', ') || 'No evidence references supplied',
        item.state === 'READY' && reassignPublished(state.discovery)
          ? button('Review reassignment', () => openReassignment(item.work_id), state.phase !== 'ready')
          : 'No governed reassignment published',
      ]));
      detail.append(node('p', 'The hosted projection does not identify a cleaning service, site, area checklist, supplies, or visit times. These are company-scoped Workforce items, not a locally reconstructed cleaning visit.', { class: 'notice' }));
      view.append(detail);
    }
  } else if (tab === 'Organisation') {
    // Flat relation table cannot recurse forever on malformed/cyclic upstream hierarchy.
    table(view, ['Participant', 'Kind / position', 'Reports to', 'Team'], workers.map(worker => [worker.worker_id, position(worker), worker.manager_id ?? 'Not supplied', worker.team_id ?? 'Not supplied']));
    unavailable(view, 'Mission overlays, delegation paths and staffing recommendations');
  } else if (tab === 'Work') {
    const label = node('label', 'Filter work'); const filter = node('select');
    for (const [value, text] of [['all', 'All work'], ['active', 'Active'], ['waiting', 'Waiting / blocked'], ['approval', 'Approval needed'], ['verified', 'Verified with evidence'], ['failed', 'Failed / uncertain']]) filter.append(node('option', text, { value }));
    filter.value = workFilter; filter.addEventListener('change', () => { workFilter = filter.value; render(controller.state); }); label.append(filter); view.append(label);
    const filtered = work.filter(item => workFilter === 'all' ||
      (workFilter === 'active' && ['CLAIMED', 'IN_PROGRESS', 'RUNNING', 'EXECUTING'].includes(item.state)) ||
      (workFilter === 'waiting' && ['CREATED', 'READY', 'BLOCKED', 'WAITING', 'WAITING_EXTERNAL', 'WAITING_TOOL', 'WAITING_USER', 'SUSPENDED'].includes(item.state)) ||
      (workFilter === 'approval' && item.state === 'WAITING_APPROVAL') ||
      (workFilter === 'verified' && verifiedOutcome(item)) ||
      (workFilter === 'failed' && ['FAILED', 'DENIED', 'UNKNOWN', 'EXPIRED'].includes(item.state)));
    table(view, ['Work / run', 'Current roster assignee', 'Required capabilities', 'State', 'Context / evidence', 'Action'], filtered.map(item => [
      item.work_id + (item.run_id ? ` / ${item.run_id}` : ''), projectedAssignee(item, workers),
      (item.required_capabilities ?? []).join(', ') || 'Not supplied', workState(item.state),
      [...(item.context_refs ?? []), ...(item.evidence_refs ?? [])].join(', ') || 'No references supplied',
      item.state === 'READY' && reassignPublished(state.discovery)
        ? button('Review reassignment', () => openReassignment(item.work_id), state.phase !== 'ready')
        : 'No governed reassignment published',
    ]));
    view.append(node('p', 'The current hosted contract supplies work IDs, state, capability requirements and references. It does not supply cleaning service/site/area/checklist/supply/time detail, so the cockpit does not label a work item as a cleaning visit.', { class: 'notice' }));
    view.append(node('p', 'Run completion and provider acknowledgement remain separate from verified business outcomes.', { class: 'notice' }));
  } else if (tab === 'Controls') {
    renderControls(view, state, workers, work, selectedControl);
  } else if (tab === 'Skills') {
    const skills = state.skills;
    if (!skills) {
      unavailable(view, state.discovery?.skills === undefined ? 'Evidence-backed skill proofs (this compatible host does not publish the skills field)' : 'Evidence-backed skill proofs');
    } else if (skills.status === 'unavailable') {
      view.append(node('p', 'The canonical skill source is unavailable for this company. Capability labels and cleaning role definitions do not establish cleaner eligibility.', { class: 'notice', role: 'status' }));
    } else {
      const projection = skills.projection;
      fields(view, { 'Proof source': skills.source, 'Proof freshness': skills.freshness, 'Workers with proof rows': projection.summary.worker_count,
        'Verified skill proofs': projection.summary.verified_skill_proofs, 'Unverified proofs': projection.summary.unverified_skill_proofs,
        'Expired or invalid proofs': projection.summary.invalid_skill_proofs, 'Requirement gaps': projection.summary.requirement_gaps });
      view.append(node('p', 'Proofs are read-only and scoped to the current company roster. Skill presence, verification and contextual performance do not decide assignment or grant tools, autonomy, or authority.', { class: 'notice' }));
      for (const worker of projection.workers) {
        const section = node('details'); section.append(node('summary', `${worker.worker_id} · ${worker.skills.length} proof rows`));
        if (!worker.skills.length) section.append(node('p', 'No skill proof rows supplied.'));
        else table(section, ['Capability', 'Proof state', 'Proficiency', 'Registry requirement', 'Evidence'], worker.skills.map(proof => [
          proof.capability_id, `${proof.proof_state} · ${proof.verification_state}`,
          `${proof.proficiency_level} (${proof.proficiency}/5)`,
          proof.meets_registry_requirement === null ? 'No registry requirement supplied' : proof.meets_registry_requirement ? 'Meets current requirement' : 'Requirement gap',
          (proof.evidence_refs ?? []).join(', ') || 'No evidence references supplied',
        ]));
        evidence(section, worker.skills.flatMap(proof => proof.evidence_refs ?? []));
        view.append(section);
      }
      unavailable(view, 'Cleaning profile-to-native-worker mapping; canonical profile metadata is not used as a live roster or assignment rule');
    }
  } else if (tab === 'Evidence') {
    if (state.receipt) {
      fields(view, { 'Receipt state': receiptState(state.receipt), 'Receipt ID': state.receipt.receipt_id,
        'Operation ID': state.receipt.operation_id, 'Correlation ID': state.receipt.correlation_id,
        'Work ID': state.receipt.work_id, 'Run ID': state.receipt.run_id, 'Decision ID': state.receipt.decision_id,
        'Verification method': state.receipt.verification?.method });
      view.append(button('Refresh receipt details', () => { void controller.refreshReceipt(); },
        state.phase !== 'ready' || state.receiptLookupStatus === 'loading'));
      const notice = receiptLookupNotice(state.receiptLookupStatus);
      if (notice) view.append(notice);
      evidence(view, state.receipt.evidence_refs);
    } else view.append(node('p', 'Submit a permitted governed request to inspect its receipt.'));
    for (const item of work.filter(item => item.evidence_refs?.length)) { const row = node('details'); row.append(node('summary', item.work_id)); evidence(row, item.evidence_refs); view.append(row); }
  } else if (tab === 'Health') {
    fields(view, { 'Projection source': state.metadata?.source, 'Last successful refresh': state.metadata?.freshness, 'Runtime status': state.status?.runtime_status ?? 'Not supplied' });
    evidence(view, state.metadata?.evidence_refs);
    const route = role === 'admin' ? 'CMD_PLUGINS_ADMIN' : role === 'reseller' ? 'CMD_PLUGINS_RESELLER' : 'CMD_PLUGINS';
    view.append(node('a', 'Open Operations for node / provider diagnostics', { href: `/${route}/titan_operations` }));
    unavailable(view, 'Capacity, provider health and evidence freshness metrics');
  }
  if (state.receipt && tab !== 'Evidence') {
    const receipt = panel('Latest receipt'); receipt.append(node('p', receiptState(state.receipt)), button('Inspect receipt / evidence', () => { tab = 'Evidence'; render(controller.state); })); root.append(receipt);
  }
}
function renderControls(view, state, workers, work, selectedControl) {
  view.append(node('p', 'Requests are proposals to the governed host. Role, capability availability and trust do not authorize execution.'));
  // Only the exact host-published allowlist can expose a control. Never raw shell or generic JSON.
  const supported = new Set(['pause', 'resume', 'cancel', 'reassign', 'escalate', 'revoke']);
  const actions = (state.discovery?.controls ?? []).filter(item => supported.has(item.action) && typeof item.capability_id === 'string' &&
    (item.action !== 'reassign' || (item.capability_id === 'titan.workforce.reassign' &&
      item.requires_fresh_approval === true && item.grants_authority === false))).map(item => item.action);
  if (!actions.length) {
    if (Array.isArray(state.discovery?.controls) && state.discovery.controls.length === 0) {
      view.append(node('p', 'This is a read-only Workforce projection. The canonical owner has not exposed an authorized lifecycle control; no request was sent.', { class: 'notice', role: 'status' }));
    } else unavailable(view, 'Governed lifecycle controls');
    return;
  }
  const form = node('form');
  const select = (label, options) => { const wrapper = node('label', label); const input = node('select'); for (const [value, text] of options) input.append(node('option', text, { value })); wrapper.append(input); form.append(wrapper); return input; };
  const action = select('Operation', actions.map(value => [value, value]));
  if (selectedControl && actions.includes(selectedControl.action)) action.value = selectedControl.action;
  const target = select('Work item', []);
  const worker = select('Target team member', []);
  const label = node('label', 'Reason'); const reason = node('textarea', undefined, { required: '', maxlength: '2000', rows: '3' }); label.append(reason); form.append(label);
  const send = node('button', 'Submit governed request', { type: 'submit', class: 'primary' }); send.disabled = state.phase !== 'ready' || !work.length || Boolean(state.error); form.append(send);
  const hint = node('p', '', { class: 'muted', role: 'status' });
  const replaceOptions = (selectElement, options, emptyLabel) => {
    const selected = selectElement.value;
    selectElement.replaceChildren(node('option', emptyLabel, { value: '' }));
    for (const [value, text] of options) selectElement.append(node('option', text, { value }));
    if (options.some(([value]) => value === selected)) selectElement.value = selected;
    else selectElement.value = options[0]?.[0] ?? '';
  };
  const refreshChoices = () => {
    const reassignment = action.value === 'reassign';
    const workChoices = work.filter(item => !reassignment || item.state === 'READY');
    replaceOptions(target, workChoices.map(item => [item.work_id, item.work_id]),
      reassignment ? 'No READY work available' : 'No work available');
    const selectedWork = workChoices.find(item => item.work_id === target.value);
    const required = selectedWork?.required_capabilities;
    const validRequirements = required === undefined || (Array.isArray(required) &&
      required.every(capability => typeof capability === 'string' && capability.trim()));
    const workerChoices = workers.filter(item => !reassignment ||
      (item.active === true && item.worker_id !== selectedWork?.assignee && validRequirements &&
        (!Array.isArray(required) || required.every(capability => (item.capabilities ?? []).includes(capability)))));
    replaceOptions(worker, workerChoices.map(item => [item.worker_id, item.worker_id]), 'No eligible participant available');
    if (!reassignment) worker.value = '';
    target.required = reassignment;
    worker.required = reassignment;
    hint.textContent = reassignment
      ? 'Reassignment applies to READY work. The request includes the currently projected assignee; the hosted owner rechecks assignment, target eligibility, authority and fresh approval.'
      : '';
    send.disabled = state.phase !== 'ready' || Boolean(state.error) || !workChoices.length ||
      (reassignment && (!selectedWork || !workerChoices.length || !worker.value));
  };
  action.addEventListener('change', refreshChoices);
  target.addEventListener('change', refreshChoices);
  refreshChoices();
  if (selectedControl?.work_id && [...target.options].some(option => option.value === selectedControl.work_id)) {
    target.value = selectedControl.work_id;
    refreshChoices();
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (!reason.value.trim() || (action.value === 'reassign' && (!target.value || !worker.value))) return;
    void controller.submit({ action: action.value, work_id: target.value,
      target_worker_id: worker.value || undefined, reason: reason.value.trim() });
  }); view.append(form, hint);
}

// #1049 owns the real session, CSRF/origin protection, expiry and cross-plugin invalidation.
// #1300 owns the role-local RAW handlers. This browser adapter obtains only their
// opaque one-time nonce; it never reads or forwards DirectAdmin cookies.
async function start() {
  let relayFetch;
  try {
    // #812 owns the DirectAdmin RAW parser and fetch adapter. Keep this fixed,
    // same-origin module path; do not copy its CGI parsing or proxy behavior here.
    const relay = await import('/CMD_PLUGINS/titan-server-node/images/directadmin-relay-client.mjs');
    if (typeof relay.createDirectAdminRelayFetch !== 'function') throw new Error('directadmin-relay-adapter-invalid');
    relayFetch = relay.createDirectAdminRelayFetch();
    if (typeof relayFetch !== 'function') throw new Error('directadmin-relay-fetch-invalid');
  } catch {
    root.replaceChildren(
      node('h1', 'Titan Workforce'),
      node('p', 'DirectAdmin Workforce relay is unavailable. Install or restore the Titan Server Node plugin, then reconnect.', { role: 'status', 'aria-live': 'polite' }),
    );
    return;
  }
  const rolePath = ({ admin: '/CMD_PLUGINS_ADMIN', reseller: '/CMD_PLUGINS_RESELLER', user: '/CMD_PLUGINS' })[role];
  if (!rolePath) {
    root.replaceChildren(node('h1', 'Titan Workforce'), node('p', 'DirectAdmin role is unavailable. Reconnect through an authorized Workforce entrypoint.', { role: 'status', 'aria-live': 'polite' }));
    return;
  }
  const transport = '?headers_to_env=yes&pipe_post=yes';
  const nonceUrl = `${rolePath}/titan_workforce/bootstrap-nonce.raw${transport}`;
  const bootstrapUrl = `${rolePath}/titan_workforce/bootstrap.raw${transport}`;
  const validNonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43,128}$/.test(value);
  let pendingNonce = null;
  let nonceForBootstrap = null;
  let needsBootstrapNonce = true;
  let invalidationGeneration = 0;
  let nonceRequest = null;
  const requestBootstrapNonce = async () => {
    if (nonceRequest) return nonceRequest;
    const requestGeneration = invalidationGeneration;
    const operation = (async () => {
      const response = await window.fetch(nonceUrl, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        referrerPolicy: 'same-origin', signal: AbortSignal.timeout(10_000),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok) throw new Error('directadmin-bootstrap-nonce-unavailable');
      let value;
      try { value = await response.json(); } catch { throw new Error('directadmin-bootstrap-nonce-invalid'); }
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 ||
          !Object.hasOwn(value, 'csrf_nonce') || !validNonce(value.csrf_nonce)) {
        throw new Error('directadmin-bootstrap-nonce-invalid');
      }
      if (requestGeneration !== invalidationGeneration) throw new Error('directadmin-bootstrap-context-changed');
      pendingNonce = value.csrf_nonce;
      needsBootstrapNonce = false;
      return value.csrf_nonce;
    })();
    nonceRequest = operation;
    try { return await operation; }
    finally { if (nonceRequest === operation) nonceRequest = null; }
  };
  const takeBootstrapNonce = () => {
    const value = pendingNonce;
    pendingNonce = null;
    nonceForBootstrap = value;
    if (validNonce(value)) needsBootstrapNonce = false;
    return validNonce(value) ? value : '';
  };
  const workforceFetch = async (input, init = {}) => {
    let requestUrl;
    try {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input?.url;
      requestUrl = new URL(raw, window.location.href);
    } catch { throw new Error('directadmin-route-invalid'); }
    if (requestUrl.origin !== window.location.origin || requestUrl.username || requestUrl.password) {
      throw new Error('directadmin-route-invalid');
    }
    if (requestUrl.pathname === '/v1/directadmin/bootstrap') {
      const method = String(init.method ?? 'GET').toUpperCase();
      const requestGeneration = invalidationGeneration;
      const nonce = nonceForBootstrap;
      nonceForBootstrap = null;
      if (requestUrl.search || requestUrl.hash || method !== 'POST' || init.body !== '' || !validNonce(nonce)) {
        needsBootstrapNonce = true;
        throw new Error('directadmin-bootstrap-request-invalid');
      }
      let response;
      try {
        // Omit body entirely: even body:"" can cause browsers to add a
        // Content-Type header, which the trusted RAW endpoint rejects.
        response = await window.fetch(bootstrapUrl, {
          method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
          referrerPolicy: 'same-origin', signal: init.signal,
          headers: { Accept: 'application/json', 'X-Titan-DA-Bootstrap-CSRF': nonce },
        });
      } catch {
        if (requestGeneration === invalidationGeneration) needsBootstrapNonce = true;
        throw new Error('directadmin-bootstrap-unavailable');
      }
      if (!response.ok) {
        if (requestGeneration === invalidationGeneration) needsBootstrapNonce = true;
        return response;
      }
      let result;
      try { result = await response.clone().json(); } catch {
        if (requestGeneration === invalidationGeneration) needsBootstrapNonce = true;
        return response;
      }
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).length !== 1 ||
          !Object.hasOwn(result, 'csrf_token') || !validNonce(result.csrf_token)) {
        if (requestGeneration === invalidationGeneration) needsBootstrapNonce = true;
      } else if (requestGeneration === invalidationGeneration) needsBootstrapNonce = false;
      return response;
    }
    const requestGeneration = invalidationGeneration;
    const response = await relayFetch(input, init);
    if (requestGeneration === invalidationGeneration && requestUrl.pathname.startsWith('/v1/directadmin/') && [401, 409].includes(response.status)) {
      // The shared SDK consumes its synchronous nonce callback after it sees
      // a cleared session. Fetch the fresh nonce before returning the denial;
      // this also prepares the operator's next explicit reconnect after an
      // expired mutation or projection request.
      needsBootstrapNonce = true;
      try { await requestBootstrapNonce(); } catch { /* SDK and controller render a sanitized unavailable state. */ }
    }
    return response;
  };
  // #1049 owns session, CSRF, expiry and cross-plugin invalidation. The nonce
  // callback stays synchronous because that is the shared SDK's contract; this
  // adapter refreshes it before connect or before returning an expired context.
  const session = new SDK.DirectAdminCockpitSession(
    takeBootstrapNonce,
    workforceFetch,
  );
  controller = new WorkforceController(new WorkforceApi(session), render);
  let preserveReceiptBookmarkOnInvalidation = false;
  session.subscribe(() => {
    // The SDK also invalidates on its local expires_at timer, without an HTTP
    // response to prepare a new nonce. Keep any one already prefetched for a
    // 401/409; otherwise the next explicit reconnect obtains a fresh one.
    invalidationGeneration++;
    needsBootstrapNonce = true;
    // Let a reconnect after invalidation issue its own nonce instead of
    // joining a pre-invalidation request that can no longer be consumed.
    nonceRequest = null;
    const preserveReceiptBookmark = preserveReceiptBookmarkOnInvalidation;
    preserveReceiptBookmarkOnInvalidation = false;
    controller.invalidate({ preserveReceiptBookmark });
  });
  window.addEventListener('pagehide', () => {
    // Keep only the opaque receipt pointer in tab-scoped storage. The full
    // company view and SDK session are still cleared before the page hides;
    // reconnect must validate a fresh company context before re-reading it.
    preserveReceiptBookmarkOnInvalidation = controller.hasReceiptBookmark();
    session.invalidate();
    preserveReceiptBookmarkOnInvalidation = false;
  });
  reconnect = async () => {
    const requestGeneration = invalidationGeneration;
    const mustBootstrap = needsBootstrapNonce;
    if (mustBootstrap && !pendingNonce) {
      try { await requestBootstrapNonce(); }
      catch { /* A failed or stale prefetch does not replace any newer nonce. */ }
      // A logout, company change, pagehide, or expiry can invalidate this
      // reconnect while the RAW nonce request is pending. Do not fall through
      // to the SDK's retained CSRF token after that newer invalidation.
      if (requestGeneration !== invalidationGeneration) return;
    }
    const unusedNonce = pendingNonce;
    // A shared BroadcastChannel invalidation preserves the SDK's CSRF token,
    // which is useful for a company switch but stale after another tab logs
    // out. When this flow has a RAW nonce ready, clear the local SDK token so
    // connect() consumes that nonce and re-establishes the session.
    if (mustBootstrap && pendingNonce) {
      preserveReceiptBookmarkOnInvalidation = controller.hasReceiptBookmark();
      session.invalidate(false, false);
      preserveReceiptBookmarkOnInvalidation = false;
    }
    await controller.connect();
    // A valid existing SDK session can reconnect without consuming the nonce
    // prefetched after an external invalidation. It is single-use server state;
    // discard that local copy rather than reuse it later.
    if (requestGeneration === invalidationGeneration && unusedNonce && pendingNonce === unusedNonce) pendingNonce = null;
  };
  window.addEventListener('pageshow', event => { if (event.persisted) void reconnect(); });
  window.addEventListener('titan-context-changed', () => { session.invalidate(); void reconnect(); });
  void reconnect();
}
void start();
