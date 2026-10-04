import * as SDK from 'titan-sdk';

const root = document.getElementById('titan-channels');
const status = root?.querySelector('[role="status"]');

function summarize({ company_id, data }) {
  SDK.assertChannelsProjection(data, company_id);
  const attention = data.endpoints.filter((endpoint) => endpoint.health !== 'healthy' || endpoint.lifecycle !== 'ACTIVE').length;
  return `${data.endpoints.length} endpoints · ${attention} need attention · credentials references only · authority not carried`;
}

function render(projection, target) {
  const list = target.ownerDocument.createElement('ul');
  for (const endpoint of projection.data.endpoints) {
    const item = document.createElement('li');
    item.textContent = `${endpoint.channel_type} / ${endpoint.provider_id} — ${endpoint.health} — ${endpoint.lifecycle}`;
    list.append(item);
  }
  target.replaceChildren(list);
}

async function start() {
  if (!root || !status) return;
  try {
    const relay = await import('/CMD_PLUGINS/titan-server-node/images/directadmin-relay-client.mjs');
    const session = new SDK.DirectAdminCockpitSession(
      () => document.querySelector('meta[name="titan-directadmin-csrf"]')?.getAttribute('content') ?? '', relay.createDirectAdminRelayFetch());
    const mounted = SDK.mountDirectAdminProjection(session, {
      plugin_id: 'titan_channels', title: 'Channels', root,
      expected_schema: 'titan.directadmin.channels.projection/v1', summarize, render,
    });
    window.addEventListener('pagehide', () => { mounted.dispose(); session.dispose(); }, { once: true });
    window.addEventListener('titan-context-changed', () => { session.invalidate(); void mounted.refresh(); });
    await session.connect();
    await mounted.refresh();
  } catch { status.textContent = 'Read-only - authenticated DirectAdmin session or Channels projection unavailable.'; }
}
void start();
