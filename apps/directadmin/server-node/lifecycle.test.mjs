import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import net from "node:net";

const root = path.dirname(fileURLToPath(import.meta.url));
function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [script, ...args]);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function installFixture(t, { failAt = "", stopFails = false, startFails = false, existingTokenMode, existingTokenSymlink = false, unexpectedUnit = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titan-node-install-"));
  const installed = path.join(dir, "usr/local/titan/server-node");
  const unit = path.join(dir, "etc/systemd/system/titan-server-node.service");
  const state = path.join(dir, "var/lib/titan/server-node");
  const config = path.join(dir, "etc/titan/server-node.env");
  const events = path.join(dir, "install-events.log");
  fs.mkdirSync(path.dirname(unit), { recursive: true });
  if (unexpectedUnit) fs.writeFileSync(unit, "operator-owned unrelated unit\n", { mode: 0o640 });
  if (existingTokenMode !== undefined) {
    fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o750 });
    fs.writeFileSync(config, "TITAN_NODE_AUTH_TOKEN=fixture-only-secret\n", { mode: existingTokenMode });
    fs.chmodSync(config, existingTokenMode);
  }
  if (existingTokenSymlink) {
    fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o750 });
    const target = path.join(dir, "external-token-target");
    fs.writeFileSync(target, "TITAN_NODE_AUTH_TOKEN=fixture-only-secret\n", { mode: 0o600 });
    fs.symlinkSync(target, config);
  }
  const harness = path.join(dir, "run-install.sh");
  fs.writeFileSync(harness, `#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_SCRIPT="$1"; SOURCE_DIR="$2"; INSTALLED="$3"; UNIT="$4"; STATE_DIR="$5"; CONFIG="$6"; EXPECTED_UID="$7"; NODE_BIN="$8"; FAIL_AT="$9"; EVENT_LOG="${events}"; STOP_FAILS="${stopFails}"; START_FAILS="${startFails}"
FAKE_USER_EXISTS=false; FAKE_ACTIVE=inactive; FAKE_ENABLED=disabled
id() {
  if [ "$#" -eq 1 ] && [ "$1" = "-u" ]; then command id -u; return; fi
  if [ "$#" -eq 1 ] && [ "$1" = "titan-node" ]; then [ "$FAKE_USER_EXISTS" = true ]; return; fi
  if [ "$#" -eq 2 ] && [ "$1" = "-u" ] && [ "$2" = "titan-node" ]; then [ "$FAKE_USER_EXISTS" = true ] && command id -u; return; fi
  command id "$@"
}
useradd() { printf 'useradd\\n' >> "$EVENT_LOG"; FAKE_USER_EXISTS=true; }
userdel() { printf 'userdel\\n' >> "$EVENT_LOG"; FAKE_USER_EXISTS=false; }
install() {
  local -a args=()
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "-o" ] || [ "$1" = "-g" ]; then shift 2; else args+=("$1"); shift; fi
  done
  /usr/bin/install "\${args[@]}"
}
systemctl() {
  printf '%s\\n' "$*" >> "$EVENT_LOG"
  case "$1" in
    daemon-reload) return 0 ;;
    enable) [ "$START_FAILS" = false ] || return 1; FAKE_ACTIVE=active; FAKE_ENABLED=enabled; return 0 ;;
    disable) [ "$STOP_FAILS" = false ] || return 1; FAKE_ACTIVE=inactive; FAKE_ENABLED=disabled; return 0 ;;
    is-active) [ "$FAKE_ACTIVE" = active ] ;;
    show)
      case "$2" in
        --property) [ "$3" = MainPID ] && echo 4242 ;;
        --property=ActiveState) echo "$FAKE_ACTIVE" ;;
        --property=LoadState) echo loaded ;;
        --property=UnitFileState) echo "$FAKE_ENABLED" ;;
        *) return 2 ;;
      esac
      ;;
    *) return 2 ;;
  esac
}
curl() { printf '{"ok":true,"service":"titan-server-node","pid":4242}'; }
sleep() { :; }
source "$ROOT_SCRIPT"
server_node_install_checkpoint() { printf '%s\\n' "$1" >> "$EVENT_LOG"; [ "$FAIL_AT" != "$1" ]; }
install_server_node "$SOURCE_DIR" "$INSTALLED" "$UNIT" "$STATE_DIR" "$CONFIG" "$EXPECTED_UID" titan-node titan-node "$NODE_BIN"
`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await run(harness, [
    path.join(root, "install.sh"), root, installed, unit, state, config, String(process.getuid()), process.execPath, failAt,
  ]);
  return { dir, installed, unit, state, config, events, result };
}

async function uninstallFixture(t, { stopFails = false, noUnit = false, retainedArtifacts = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titan-node-uninstall-"));
  const unit = path.join(dir, "titan-server-node.service");
  const runtime = path.join(dir, "usr/local/titan/server-node");
  const token = path.join(dir, "etc/titan/server-node.env");
  const controlState = path.join(dir, "var/lib/titan/server-node");
  const events = path.join(dir, "systemctl-events.log");
  if (!noUnit) fs.copyFileSync(path.join(root, "titan-server-node.service"), unit);
  if (retainedArtifacts) {
    fs.mkdirSync(runtime, { recursive: true });
    fs.writeFileSync(path.join(runtime, "runtime.mjs"), "fixture runtime\n");
    fs.mkdirSync(path.dirname(token), { recursive: true });
    fs.writeFileSync(token, "TITAN_NODE_AUTH_TOKEN=fixture-only-secret\n", { mode: 0o600 });
    fs.mkdirSync(controlState, { recursive: true });
    fs.writeFileSync(path.join(controlState, "control.json"), "{}\n");
  }
  const harness = path.join(dir, "run-uninstall.sh");
  fs.writeFileSync(harness, `#!/usr/bin/env bash
set -Eeuo pipefail
ROOT_SCRIPT="$1"; UNIT="$2"; EXPECTED_UID="$3"; EVENT_LOG="${events}"; STOP_FAILS="${stopFails}"; FAKE_ACTIVE=active; FAKE_ENABLED=enabled
id() { if [ "$#" -eq 1 ] && [ "$1" = "-u" ]; then command id -u; else command id "$@"; fi; }
systemctl() {
  printf '%s\\n' "$*" >> "$EVENT_LOG"
  case "$1" in
    show)
      case "$2" in
        --property=LoadState) echo "${noUnit ? "not-found" : "loaded"}" ;;
        --property=ActiveState) echo "$FAKE_ACTIVE" ;;
        --property=UnitFileState) echo "$FAKE_ENABLED" ;;
        *) return 2 ;;
      esac
      ;;
    disable) [ "$STOP_FAILS" = false ] || return 1; FAKE_ACTIVE=inactive; FAKE_ENABLED=disabled ;;
    *) return 2 ;;
  esac
}
source "$ROOT_SCRIPT"
uninstall_server_node "$UNIT" "$EXPECTED_UID" "${runtime}" "${token}" "${controlState}"
`);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = await run(harness, [path.join(root, "uninstall.sh"), unit, String(process.getuid())]);
  return { dir, unit, runtime, token, controlState, events, result };
}

// The fixture supervisor starts real Node processes. The production updater
// performs real file operations and HTTP probes; only systemd is substituted.
async function fixture(t, behavior = "healthy") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titan-node-lifecycle-"));
  const source = path.join(dir, "source");
  const installed = path.join(dir, "usr/local/titan/server-node");
  const unit = path.join(dir, "etc/systemd/system/titan-server-node.service");
  const backups = path.join(dir, "usr/local/titan/server-node-backups");
  const config = path.join(dir, "etc/titan/server-node.env");
  const store = path.join(dir, "var/lib/titan/server-node/control.json");
  const pidFile = path.join(dir, "service.pid");
  const stopCountFile = path.join(dir, "stop-count");
  const log = path.join(dir, "supervisor.log");
  const port = await unusedPort();
  for (const target of [source, installed, path.dirname(unit), path.dirname(config), path.dirname(store)]) fs.mkdirSync(target, { recursive: true });
  const runtime = (version, good) => `import http from "node:http";
${version === "new" ? 'import { FILE_ROOT_DOMAIN } from "./file-bridge.mjs";' : ""}
const version = ${JSON.stringify(version)};
const fileRoot = ${version === "new" ? "FILE_ROOT_DOMAIN" : "null"};
const server = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ok: ${good}, service: "titan-server-node", pid: process.pid + ${version === "new" && behavior === "wrong-pid" ? 1 : 0}, version, fileRoot })); });
server.listen(Number(process.env.TITAN_NODE_PORT), "127.0.0.1");
process.once("SIGTERM", () => server.close(() => process.exit(0)));
`;
  const oldRuntime = runtime("old", true);
  const newRuntime = runtime("new", !["unready", "rollback-stop-fails"].includes(behavior));
  const packageFiles = [
    "plugin.conf", "package.json", "health.sh", "titan-server-node.service", "directadmin-relay.mjs", "file-bridge.mjs",
    "scripts/install.sh", "scripts/update.sh", "scripts/uninstall.sh",
    "user/index.html", "user/directadmin-gateway.raw", "images/directadmin-relay-client.mjs",
  ];
  for (const name of packageFiles) {
    const sourceFile = path.join(source, name);
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.copyFileSync(path.join(root, name), sourceFile);
    if (["scripts/install.sh", "scripts/update.sh", "scripts/uninstall.sh", "user/index.html", "user/directadmin-gateway.raw"].includes(name)) fs.chmodSync(sourceFile, 0o755);
  }
  fs.writeFileSync(path.join(source, "runtime.mjs"), newRuntime);
  const oldRelay = "export const relayRelease = 'previous';\n";
  const newRelay = fs.readFileSync(path.join(root, "directadmin-relay.mjs"), "utf8");
  const newFileBridge = fs.readFileSync(path.join(root, "file-bridge.mjs"), "utf8");
  fs.writeFileSync(path.join(installed, "runtime.mjs"), oldRuntime);
  fs.writeFileSync(path.join(installed, "directadmin-relay.mjs"), oldRelay);
  // Pre-bridge installations did not contain this imported runtime module.
  fs.writeFileSync(path.join(installed, "package.json"), '{"type":"module","name":"previous"}\n');
  fs.writeFileSync(path.join(installed, "prior-only.txt"), "keep in rollback artifact\n");
  fs.writeFileSync(unit, "previous service unit\n");
  fs.writeFileSync(config, `TITAN_NODE_PORT=${port}\nTITAN_NODE_AUTH_TOKEN=fixture-only\n`, { mode: 0o600 });
  fs.writeFileSync(store, '{"fixture":"durable control metadata"}\n');
  const supervisor = path.join(dir, "supervisor.mjs");
  fs.writeFileSync(supervisor, `import fs from "node:fs";
import { spawn } from "node:child_process";
const [command, ...args] = process.argv.slice(2);
const pidFile = ${JSON.stringify(pidFile)}, stopCountFile = ${JSON.stringify(stopCountFile)}, log = ${JSON.stringify(log)};
fs.appendFileSync(log, [command, ...args].join(" ") + "\\n");
const readPid = () => { try { return Number(fs.readFileSync(pidFile, "utf8")); } catch { return 0; } };
const stop = async () => { const pid = readPid(); if (pid) { try { process.kill(pid, "SIGTERM"); } catch {} } fs.rmSync(pidFile, { force:true }); for (let i=0;i<100;i++) { try { await fetch("http://127.0.0.1:${port}/live"); await new Promise(r=>setTimeout(r,10)); } catch { break; } } };
if (command === "daemon-reload") process.exit(0);
if (command === "stop") {
  let count=0; try { count=Number(fs.readFileSync(stopCountFile, "utf8")); } catch {}
  count++; fs.writeFileSync(stopCountFile, String(count));
  if (${JSON.stringify(behavior)} === "rollback-stop-fails" && count === 2) process.exit(1);
  if (${JSON.stringify(behavior)} === "rollback-stop-fails-before-promotion" && count <= 2) process.exit(1);
  await stop(); process.exit(0);
}
if (command === "show") {
  const propertyFlag=args.find(a=>a.startsWith("--property="));
  const property=propertyFlag ? propertyFlag.slice("--property=".length) : args[args.indexOf("--property") + 1];
  const pid=readPid(); let alive=false;
  try { if (pid) { process.kill(pid, 0); alive=true; } } catch {}
  if (property === "MainPID") console.log(alive ? pid : 0);
  else if (property === "ActiveState") console.log(alive ? "active" : "inactive");
  else process.exit(2);
  process.exit(0);
}
if (command === "is-active") { const pid = readPid(); try { if (!pid) throw Error(); process.kill(pid,0); process.exit(0); } catch { process.exit(1); } }
if (command === "restart" || command === "start" || command === "try-restart") {
  await stop();
  if (${JSON.stringify(behavior)} === "rollback-fails") process.exit(1);
  if (${JSON.stringify(behavior)} === "restart-fails" && fs.readFileSync(${JSON.stringify(path.join(installed, "runtime.mjs"))}, "utf8").includes('"new"')) process.exit(1);
  const child=spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(path.join(installed, "runtime.mjs"))}], { detached:true, stdio:"ignore", env:{...process.env,TITAN_NODE_PORT:"${port}"} });
  child.unref(); fs.writeFileSync(pidFile,String(child.pid));
  for (let i=0;i<100;i++) { try { await fetch("http://127.0.0.1:${port}/live"); process.exit(0); } catch { await new Promise(r=>setTimeout(r,10)); } }
  process.exit(1);
}
throw new Error("unexpected systemctl command: " + command);
`);
  const harness = path.join(dir, "update-fixture.sh");
  fs.writeFileSync(harness, `#!/usr/bin/env bash\nset -euo pipefail\nid() { echo 1000; }\nsystemctl() { "${process.execPath}" "${supervisor}" "$@"; }\nsleep() { :; }\nsource "$1"\nshift\nupdate_server_node "$@"\n`);
  t.after(() => {
    try { process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGTERM"); } catch {}
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, source, installed, unit, backups, store, config, log, oldRuntime, newRuntime, oldRelay, newRelay, newFileBridge, port,
    startInstalledRuntime: async () => {
      const child = spawn(process.execPath, [path.join(installed, "runtime.mjs")], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env, TITAN_NODE_PORT: String(port) },
      });
      child.unref();
      fs.writeFileSync(pidFile, String(child.pid));
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await fetch(`http://127.0.0.1:${port}/live`); return; }
        catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
      }
      throw new Error("fixture runtime did not start");
    },
    update: () => run(harness, [path.join(root, "update.sh"), source, installed, unit, backups, config]),
  };
}

test("systemd uses the durable store inside its writable state directory", () => {
  const unit = fs.readFileSync(path.join(root, "titan-server-node.service"), "utf8");
  assert.match(unit, /^Environment=TITAN_NODE_STORE_PATH=\/var\/lib\/titan\/server-node\/control.json$/m);
  assert.match(unit, /^ProtectSystem=strict$/m);
  assert.match(unit, /^ReadWritePaths=\/var\/lib\/titan\/server-node$/m);
});

test("update promotes staged runtime and unit and retains the previous artifact", async (t) => {
  const f = await fixture(t);
  const result = await f.update();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(f.installed, "runtime.mjs"), "utf8"), f.newRuntime);
  assert.equal(fs.readFileSync(path.join(f.installed, "directadmin-relay.mjs"), "utf8"), f.newRelay);
  assert.equal(fs.readFileSync(path.join(f.installed, "file-bridge.mjs"), "utf8"), f.newFileBridge);
  assert.equal(fs.readFileSync(f.unit, "utf8"), fs.readFileSync(path.join(f.source, "titan-server-node.service"), "utf8"));
  assert.equal(fs.existsSync(path.join(f.installed, "prior-only.txt")), false);
  const report = JSON.parse(result.stdout);
  assert.equal(report.lifecycle, "updated");
  assert.equal(report.status, "live");
  assert.equal(fs.readFileSync(path.join(report.rollback_artifact, "runtime/runtime.mjs"), "utf8"), f.oldRuntime);
  assert.equal(fs.readFileSync(path.join(report.rollback_artifact, "runtime/directadmin-relay.mjs"), "utf8"), f.oldRelay);
  assert.equal(fs.existsSync(path.join(report.rollback_artifact, "runtime/file-bridge.mjs")), false);
  assert.equal(fs.readFileSync(path.join(report.rollback_artifact, "titan-server-node.service"), "utf8"), "previous service unit\n");
  const live = await (await fetch(`http://127.0.0.1:${f.port}/live`)).json();
  assert.equal(live.version, "new");
  assert.equal(live.fileRoot, "titanzero.io");
  assert.equal(fs.readFileSync(f.store, "utf8"), '{"fixture":"durable control metadata"}\n');
});

for (const behavior of ["restart-fails", "unready", "wrong-pid"]) {
  test(`update restores previous runtime and service after ${behavior}`, async (t) => {
    const f = await fixture(t, behavior);
    fs.chmodSync(f.unit, 0o600);
    const result = await f.update();
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(path.join(f.installed, "runtime.mjs"), "utf8"), f.oldRuntime);
    assert.equal(fs.readFileSync(path.join(f.installed, "directadmin-relay.mjs"), "utf8"), f.oldRelay);
    assert.equal(fs.existsSync(path.join(f.installed, "file-bridge.mjs")), false);
    assert.equal(fs.readFileSync(f.unit, "utf8"), "previous service unit\n");
    assert.equal(fs.statSync(f.unit).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(f.installed, "prior-only.txt"), "utf8"), "keep in rollback artifact\n");
    const report = JSON.parse(result.stdout);
    assert.equal(report.lifecycle, "update-failed");
    assert.equal(report.rollback, "restored");
    assert.equal((await (await fetch(`http://127.0.0.1:${f.port}/live`)).json()).version, "old");
    assert.equal(fs.readFileSync(f.store, "utf8"), '{"fixture":"durable control metadata"}\n');
  });
}

test("invalid staged runtime leaves the installation untouched and never restarts", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.source, "runtime.mjs"), "this is not javascript!\n");
  const result = await f.update();
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(f.installed, "runtime.mjs"), "utf8"), f.oldRuntime);
  assert.equal(fs.readFileSync(path.join(f.installed, "directadmin-relay.mjs"), "utf8"), f.oldRelay);
  assert.equal(fs.existsSync(path.join(f.installed, "file-bridge.mjs")), false);
  assert.equal(fs.readFileSync(f.unit, "utf8"), "previous service unit\n");
  assert.equal(fs.existsSync(f.log), false);
  assert.match(result.stderr, /SyntaxError/);
});

test("symlink package input fails closed before changing installed files", async (t) => {
  const f = await fixture(t);
  fs.unlinkSync(path.join(f.source, "runtime.mjs"));
  fs.symlinkSync(path.join(f.installed, "runtime.mjs"), path.join(f.source, "runtime.mjs"));
  const result = await f.update();
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(f.log), false);
  assert.match(result.stderr, /package input must be a regular file/);
});

test("package update requires the runtime's imported file bridge before changing installed files", async (t) => {
  const f = await fixture(t);
  fs.unlinkSync(path.join(f.source, "file-bridge.mjs"));
  const result = await f.update();
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(f.log), false);
  assert.equal(fs.readFileSync(path.join(f.installed, "runtime.mjs"), "utf8"), f.oldRuntime);
  assert.match(result.stderr, /package input must be a regular file: file-bridge\.mjs/);
});

test("package test command includes safe lifecycle regression coverage", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(pkg.scripts.test, /lifecycle\.test\.mjs/);
  assert.match(pkg.scripts.test, /runtime\.security\.test\.mjs/);
});

test("non-root lifecycle validation never invokes a host supervisor", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titan-node-validation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Shell functions protect even root-run CI, without production test modes.
  for (const script of ["install.sh", "update.sh"]) {
    const harness = path.join(dir, script);
    fs.writeFileSync(harness, `set -euo pipefail\nid() { echo 1000; }\nsystemctl() { echo 'HOST SUPERVISOR MUST NOT RUN' >&2; return 97; }\nexport -f id systemctl\nbash "$@"\n`);
    const result = await run(harness, [path.join(root, script), "--validate-only"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).lifecycle, "validated");
    assert.equal(JSON.parse(result.stdout).installed, null);
    assert.equal(JSON.parse(result.stdout).installation_attempted, false);
  }
});

test("ordinary non-root install, update and uninstall fail instead of claiming validation", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titan-node-privileged-hooks-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const script of ["install.sh", "update.sh", "uninstall.sh"]) {
    const harness = path.join(dir, script);
    fs.writeFileSync(harness, `set -euo pipefail\nid() { echo 1000; }\nsystemctl() { echo 'HOST SUPERVISOR MUST NOT RUN' >&2; return 97; }\nexport -f id systemctl\nbash "$@"\n`);
    const result = await run(harness, [path.join(root, script)]);
    assert.notEqual(result.status, 0, script);
    assert.doesNotMatch(result.stdout, /"lifecycle":"validated"/);
    assert.doesNotMatch(result.stderr, /HOST SUPERVISOR MUST NOT RUN/);
  }
});

// These are deployment configuration assertions, not substituted OS ownership.
test("install keeps executable code root-owned and state owned by titan-node", () => {
  const script = fs.readFileSync(path.join(root, "install.sh"), "utf8");
  assert.match(script, /install -d -o "\$service_user" -g "\$service_group" -m 0750 "\$state_dir"/);
  assert.match(script, /validate_server_node_directory "\$install_parent" "\$token_owner"/);
  assert.match(script, /mv -Tn -- "\$runtime_stage" "\$installed"/);
  assert.match(script, /verify_server_node_process/);
});


test("rollback verification failure is reported without claiming recovery", async (t) => {
  const f = await fixture(t, "rollback-fails");
  const result = await f.update();
  assert.notEqual(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.lifecycle, "update-failed");
  assert.equal(report.rollback, "failed");
  assert.equal(fs.readFileSync(path.join(f.installed, "runtime.mjs"), "utf8"), f.oldRuntime);
  assert.equal(fs.readFileSync(f.unit, "utf8"), "previous service unit\n");
});

test("rollback leaves active runtime and all artifacts in place when stop cannot be confirmed", async (t) => {
  const f = await fixture(t, "rollback-stop-fails");
  const result = await f.update();
  assert.notEqual(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.lifecycle, "update-failed");
  assert.equal(report.rollback, "failed");
  assert.deepEqual(report.preserved_staging_artifacts ?? [], []);
  assert.equal(fs.readFileSync(path.join(f.installed, "runtime.mjs"), "utf8"), f.newRuntime);
  assert.equal(fs.readFileSync(f.unit, "utf8"), fs.readFileSync(path.join(f.source, "titan-server-node.service"), "utf8"));
  assert.equal(fs.readFileSync(path.join(report.rollback_artifact, "displaced-runtime/runtime.mjs"), "utf8"), f.oldRuntime);
  assert.equal(fs.existsSync(path.join(report.rollback_artifact, "failed-runtime")), false);
  const actions = fs.readFileSync(f.log, "utf8").trim().split("\n");
  assert.equal(actions.filter((line) => line.startsWith("restart ")).length, 1);
  assert.equal((await (await fetch(`http://127.0.0.1:${f.port}/live`)).json()).version, "new");
  assert.equal(fs.readFileSync(f.store, "utf8"), '{"fixture":"durable control metadata"}\n');
});

test("rollback preserves staged artifacts when the active service cannot be stopped before promotion", async (t) => {
  const f = await fixture(t, "rollback-stop-fails-before-promotion");
  await f.startInstalledRuntime();
  const result = await f.update();
  assert.notEqual(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.lifecycle, "update-failed");
  assert.equal(report.rollback, "failed");
  assert.equal(report.preserved_staging_artifacts.length, 2);
  const [runtimeStage, unitStage] = report.preserved_staging_artifacts;
  assert.equal(fs.readFileSync(path.join(f.installed, "runtime.mjs"), "utf8"), f.oldRuntime);
  assert.equal(fs.readFileSync(f.unit, "utf8"), "previous service unit\n");
  assert.equal(fs.readFileSync(path.join(runtimeStage, "runtime.mjs"), "utf8"), f.newRuntime);
  assert.equal(fs.readFileSync(unitStage, "utf8"), fs.readFileSync(path.join(f.source, "titan-server-node.service"), "utf8"));
  assert.equal(fs.readFileSync(path.join(report.rollback_artifact, "runtime/runtime.mjs"), "utf8"), f.oldRuntime);
  const actions = fs.readFileSync(f.log, "utf8").trim().split("\n");
  assert.equal(actions.filter((line) => line.startsWith("restart ")).length, 0);
  assert.equal((await (await fetch(`http://127.0.0.1:${f.port}/live`)).json()).version, "old");
});

test("invalid configured port fails closed without restarting or touching the installation", async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(f.config, "TITAN_NODE_PORT=$(touch should-not-execute)\n");
  const result = await f.update();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid TITAN_NODE_PORT/);
  assert.equal(fs.existsSync(f.log), false);
  assert.equal(fs.readFileSync(path.join(f.installed, "runtime.mjs"), "utf8"), f.oldRuntime);
});


test("package validation fails before installation when flock is unavailable", async (t) => {
  const f = await fixture(t);
  const harness = path.join(f.dir, "without-flock.sh");
  fs.writeFileSync(harness, `set -euo pipefail\nsource "$1"\ncommand() { if [[ "$1" == "-v" && "$2" == "flock" ]]; then return 1; fi; builtin command "$@"; }\nvalidate_server_node_package "$2"\n`);
  const result = await run(harness, [path.join(root, "update.sh"), f.source]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /flock is required/);
  assert.equal(fs.existsSync(f.log), false);
});

test('root supervisor prerequisite checks the actual unit Node executable', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'titan-supervisor-node-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const harness=path.join(dir,'validate.sh');
  fs.writeFileSync(harness,'set -euo pipefail\nsource "$1"\nvalidate_server_node_supervisor_runtime "$2"\n');
  const absent=await run(harness,[path.join(root,'update.sh'),path.join(dir,'absent-node')]);
  assert.notEqual(absent.status,0);assert.match(absent.stderr,/supervisor Node executable/);
  const real=await run(harness,[path.join(root,'update.sh'),process.execPath]);assert.equal(real.status,0,real.stderr);
  const oldNode=path.join(dir,'old-node');fs.writeFileSync(oldNode,'#!/usr/bin/env bash\nexit 1\n',{mode:0o755});
  const outdated=await run(harness,[path.join(root,'update.sh'),oldNode]);assert.notEqual(outdated.status,0);assert.match(outdated.stderr,/Node.js 20/);
});

test("initial install succeeds on disposable paths and reports an active installation", async (t) => {
  const f = await installFixture(t);
  assert.equal(f.result.status, 0, f.result.stderr);
  const report = JSON.parse(f.result.stdout);
  assert.equal(report.lifecycle, "installed");
  assert.equal(report.installed, true);
  assert.equal(fs.statSync(f.config).mode & 0o777, 0o600);
  assert.equal(/^TITAN_NODE_AUTH_TOKEN=[a-f0-9]{64}\n$/.test(fs.readFileSync(f.config, "utf8")), true);
  assert.equal(fs.statSync(f.unit).mode & 0o777, 0o644);
  assert.equal(fs.existsSync(path.join(f.installed, "directadmin-relay.mjs")), true);
  assert.equal(fs.existsSync(path.join(f.installed, "file-bridge.mjs")), true);
  assert.equal(fs.existsSync(path.join(f.installed, "SHA256SUMS")), true);
  assert.match(fs.readFileSync(path.join(f.installed, "SHA256SUMS"), "utf8"), /file-bridge\.mjs/);
  assert.equal(f.result.stdout.includes("fixture-only-secret"), false);
});

for (const failAt of [
  "preflight-complete", "runtime-staged", "unit-staged", "service-user-ready",
  "state-directory-ready", "token-ready", "runtime-promoted", "unit-promoted",
  "systemd-reloaded", "service-started", "service-live",
]) {
  test(`initial install rolls back safely after ${failAt}`, async (t) => {
    const f = await installFixture(t, { failAt });
    assert.notEqual(f.result.status, 0);
    const report = JSON.parse(f.result.stdout);
    assert.equal(report.lifecycle, "install-failed");
    assert.equal(report.installed, false);
    assert.equal(report.rollback, "complete", f.result.stderr);
    assert.equal(fs.existsSync(f.installed), false);
    assert.equal(fs.existsSync(f.unit), false);
    const tokenExpected = ["token-ready", "runtime-promoted", "unit-promoted", "systemd-reloaded", "service-started", "service-live"].includes(failAt);
    assert.equal(fs.existsSync(f.config), tokenExpected);
    if (tokenExpected) assert.equal(fs.statSync(f.config).mode & 0o777, 0o600);
    assert.equal(f.result.stdout.includes("fixture-only-secret"), false);
  });
}

test("failed service stop retains newly promoted files for recovery", async (t) => {
  const f = await installFixture(t, { failAt: "service-started", stopFails: true });
  assert.notEqual(f.result.status, 0);
  const report = JSON.parse(f.result.stdout);
  assert.equal(report.rollback, "incomplete");
  assert.equal(report.installed, null);
  assert.equal(fs.existsSync(f.installed), true);
  assert.equal(fs.existsSync(f.unit), true);
  assert.equal(fs.existsSync(f.config), true);
});

test("a failed enable/start command is stopped, disabled and rolled back", async (t) => {
  const f = await installFixture(t, { startFails: true });
  assert.notEqual(f.result.status, 0);
  const report = JSON.parse(f.result.stdout);
  assert.equal(report.rollback, "complete");
  assert.equal(report.installed, false);
  assert.equal(fs.existsSync(f.installed), false);
  assert.equal(fs.existsSync(f.unit), false);
  assert.equal(fs.existsSync(f.config), true);
  const events = fs.readFileSync(f.events, "utf8");
  assert.match(events, /enable --now/);
  assert.match(events, /disable --now/);
});

test("initial install refuses an unexpected unit without changing it", async (t) => {
  const f = await installFixture(t, { unexpectedUnit: true });
  assert.notEqual(f.result.status, 0);
  assert.equal(fs.readFileSync(f.unit, "utf8"), "operator-owned unrelated unit\n");
  assert.equal(fs.existsSync(f.installed), false);
  assert.equal(fs.existsSync(f.config), false);
  assert.match(f.result.stderr, /unexpected existing titan-server-node\.service/);
  assert.equal(JSON.parse(f.result.stdout).installed, null);
});

test("initial install rejects insecure token files before creating host artifacts", async (t) => {
  const f = await installFixture(t, { existingTokenMode: 0o640 });
  assert.notEqual(f.result.status, 0, `stdout=${f.result.stdout} stderr=${f.result.stderr}`);
  assert.match(f.result.stderr, /must have mode 0600/);
  assert.equal(fs.existsSync(f.installed), false);
  assert.equal(fs.existsSync(f.unit), false);
  assert.equal(fs.readFileSync(f.config, "utf8"), "TITAN_NODE_AUTH_TOKEN=fixture-only-secret\n");
  assert.equal(f.result.stdout.includes("fixture-only-secret"), false);
});

test("initial install rejects symlink token paths without reading or printing the target", async (t) => {
  const f = await installFixture(t, { existingTokenSymlink: true });
  assert.notEqual(f.result.status, 0);
  assert.equal(fs.lstatSync(f.config).isSymbolicLink(), true);
  assert.equal(fs.existsSync(f.installed), false);
  assert.equal(fs.existsSync(f.unit), false);
  assert.equal(f.result.stdout.includes("fixture-only-secret"), false);
  assert.equal(f.result.stderr.includes("fixture-only-secret"), false);
});

test("token metadata validation rejects an untrusted owner without exposing its contents", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titan-node-token-owner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const token = path.join(dir, "server-node.env");
  fs.writeFileSync(token, "TITAN_NODE_AUTH_TOKEN=fixture-only-secret\n", { mode: 0o600 });
  fs.chmodSync(token, 0o600);
  const harness = path.join(dir, "validate-token.sh");
  fs.writeFileSync(harness, `#!/usr/bin/env bash\nset -euo pipefail\nsource "$1"\nvalidate_server_node_token_file "$2" "$3"\n`);
  const result = await run(harness, [path.join(root, "update.sh"), token, String(process.getuid() + 1)]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /untrusted owner/);
  assert.equal(result.stdout.includes("fixture-only-secret"), false);
  assert.equal(result.stderr.includes("fixture-only-secret"), false);
});

test("initial install and update wrappers pass explicit validation-only requests", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "titan-node-wrapper-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const action of ["install", "update", "uninstall"]) {
    const result = await run(path.join(root, "scripts", action + ".sh"), ["--validate-only"]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).mode, "validation-only");
  }
});

test("uninstall reports service-stop failures and retains recovery state", async (t) => {
  const f = await uninstallFixture(t, { stopFails: true });
  assert.notEqual(f.result.status, 0);
  const report = JSON.parse(f.result.stdout);
  assert.equal(report.lifecycle, "uninstall-failed");
  assert.equal(report.uninstalled, false);
  assert.equal(report.service, "unknown");
  assert.equal(fs.existsSync(f.unit), true);
  assert.match(fs.readFileSync(f.events, "utf8"), /disable --now/);
});

test("uninstall verifies inactive and disabled while preserving runtime artifacts", async (t) => {
  const f = await uninstallFixture(t, { retainedArtifacts: true });
  assert.equal(f.result.status, 0, f.result.stderr);
  const report = JSON.parse(f.result.stdout);
  assert.equal(report.lifecycle, "uninstalled");
  assert.equal(report.uninstalled, true);
  assert.equal(report.service, "inactive");
  assert.equal(report.enabled, false);
  assert.deepEqual(report.retained, ["unit", "runtime", "token", "control_state"]);
  assert.equal(fs.readFileSync(f.unit, "utf8"), fs.readFileSync(path.join(root, "titan-server-node.service"), "utf8"));
});

test("uninstall is idempotent when systemd no longer knows the unit", async (t) => {
  const f = await uninstallFixture(t, { noUnit: true });
  assert.equal(f.result.status, 0, f.result.stderr);
  const report = JSON.parse(f.result.stdout);
  assert.equal(report.lifecycle, "uninstalled");
  assert.equal(report.service, "absent");
  assert.deepEqual(report.retained, []);
  assert.equal(report.retained_status, "complete");
});

test("uninstall inventories retained runtime, token, and control state when unit is missing", async (t) => {
  const f = await uninstallFixture(t, { noUnit: true, retainedArtifacts: true });
  assert.equal(f.result.status, 0, f.result.stderr);
  const report = JSON.parse(f.result.stdout);
  assert.equal(report.lifecycle, "uninstalled");
  assert.equal(report.service, "absent");
  assert.deepEqual(report.retained, ["runtime", "token", "control_state"]);
  assert.equal(report.retained_status, "complete");
  assert.equal(fs.existsSync(path.join(f.runtime, "runtime.mjs")), true);
  assert.equal(fs.existsSync(f.token), true);
  assert.equal(fs.existsSync(path.join(f.controlState, "control.json")), true);
  assert.equal(f.result.stdout.includes("fixture-only-secret"), false);
  assert.equal(f.result.stderr.includes("fixture-only-secret"), false);
});
