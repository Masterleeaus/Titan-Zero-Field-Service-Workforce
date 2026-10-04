import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../lib/app.php', import.meta.url), 'utf8');
const scriptMatch = source.match(/function directadmin_ssh_access_script\(\)\s*\{\s*return <<<'JS'\n([\s\S]*?)\nJS;\n\}/);
assert.ok(scriptMatch, 'browser-only SSH helper must remain an extractable PHP nowdoc');
const script = scriptMatch[1];

function element(value = '') {
  return {
    value,
    textContent: value,
    disabled: false,
    listeners: new Map(),
    addEventListener(name, callback) {
      this.listeners.set(name, callback);
    },
    dispatch(name) {
      this.listeners.get(name)?.();
    },
  };
}

function createPage({ host = 'ssh.example.test', port = '22', username = 'admin', alias = '' } = {}) {
  const elements = new Map([
    ['tda-ssh-host', element(host)],
    ['tda-ssh-port', element(port)],
    ['tda-ssh-alias', element(alias)],
    ['tda-ssh-username', element(username)],
    ['tda-ssh-command', element()],
    ['tda-ssh-copy', element()],
    ['tda-ssh-copy-status', element()],
    ['tda-ssh-error', element()],
    ['tda-ssh-diagnose', element()],
    ['tda-ssh-guidance', element()],
  ]);
  let fetchCalls = 0;
  runInNewContext(script, {
    document: { getElementById: (id) => elements.get(id) },
    navigator: {},
    window: { isSecureContext: false },
    fetch: () => { fetchCalls += 1; throw new Error('unexpected network request'); },
  });
  return { elements, fetchCalls: () => fetchCalls };
}

test('builds a client-only SSH command from the endpoint and fixed DirectAdmin username', () => {
  const page = createPage({ host: 'ssh.example.test', port: '2222', username: 'da_admin' });
  assert.equal(page.elements.get('tda-ssh-command').textContent, 'ssh -p 2222 da_admin@ssh.example.test');
  assert.equal(page.elements.get('tda-ssh-copy').disabled, false);

  page.elements.get('tda-ssh-host').value = 'ssh.example.test; whoami';
  page.elements.get('tda-ssh-host').dispatch('input');
  assert.equal(page.elements.get('tda-ssh-copy').disabled, true);
  assert.equal(page.elements.get('tda-ssh-command').textContent, 'Enter a valid SSH alias, or a valid SSH host and port, to build the command.');

  page.elements.get('tda-ssh-host').value = 'ssh.example.test';
  page.elements.get('tda-ssh-host').dispatch('input');
  page.elements.get('tda-ssh-port').value = '65536';
  page.elements.get('tda-ssh-port').dispatch('input');
  assert.equal(page.elements.get('tda-ssh-copy').disabled, true);

  const aliasInput = page.elements.get('tda-ssh-alias');
  aliasInput.value = 'titan';
  aliasInput.dispatch('input');
  assert.equal(page.elements.get('tda-ssh-command').textContent, 'ssh titan');
  assert.equal(page.elements.get('tda-ssh-copy').disabled, false);
  aliasInput.value = 'titan; whoami';
  aliasInput.dispatch('input');
  assert.equal(page.elements.get('tda-ssh-copy').disabled, true);
  assert.equal(page.elements.get('tda-ssh-command').textContent, 'Enter a valid SSH alias, or a valid SSH host and port, to build the command.');

  const optionUserPage = createPage({ username: '-oProxyCommand' });
  assert.equal(optionUserPage.elements.get('tda-ssh-copy').disabled, true);
  assert.equal(optionUserPage.elements.get('tda-ssh-command').textContent, 'Enter a valid SSH alias, or a valid SSH host and port, to build the command.');
  assert.equal(page.fetchCalls(), 0);
});

test('distinguishes a local Windows key-file permission error from server key rejection', () => {
  const page = createPage();
  const input = page.elements.get('tda-ssh-error');
  const diagnose = page.elements.get('tda-ssh-diagnose');
  const guidance = page.elements.get('tda-ssh-guidance');

  input.value = 'Load key "C:\\Users\\admin\\.ssh\\titan_ed25519": Permission denied';
  diagnose.dispatch('click');
  assert.match(guidance.textContent, /Local key-file access failed before server authentication/);
  assert.doesNotMatch(guidance.textContent, /C:\\Users/);

  input.value = 'no such identity: C:\\Users\\admin\\.ssh\\wrong_key: No such file or directory';
  diagnose.dispatch('click');
  assert.match(guidance.textContent, /could not find the configured identity file locally/);
  assert.doesNotMatch(guidance.textContent, /C:\\Users/);

  input.value = 'admin@ssh.example.test: Permission denied (publickey).';
  diagnose.dispatch('click');
  assert.match(guidance.textContent, /SSH server was reached/);
  assert.match(guidance.textContent, /expected key may not have been selected/);
  assert.doesNotMatch(guidance.textContent, /Permission denied \(publickey\)/);
  assert.equal(page.fetchCalls(), 0);
});

test('gives bounded local guidance for common connectivity and trust errors', () => {
  const page = createPage();
  const input = page.elements.get('tda-ssh-error');
  const diagnose = page.elements.get('tda-ssh-diagnose');
  const guidance = page.elements.get('tda-ssh-guidance');
  const cases = [
    ['ssh: Could not resolve hostname server: Name or service not known', /did not resolve/],
    ['ssh: connect to host server port 22: Connection timed out', /No SSH response arrived/],
    ['ssh: connect to host server port 22: Connection refused', /refused this port/],
    ['Host key verification failed.', /verify the server fingerprint/],
  ];
  for (const [message, expected] of cases) {
    input.value = message;
    diagnose.dispatch('click');
    assert.match(guidance.textContent, expected);
  }

  input.value = 'first line\nsecond line';
  diagnose.dispatch('click');
  assert.match(guidance.textContent, /one OpenSSH error line/);
  input.value = 'x'.repeat(1001);
  diagnose.dispatch('click');
  assert.match(guidance.textContent, /at most 1000 characters/);
  assert.equal(page.fetchCalls(), 0);
});
