# Titan Workforce package verification

This checklist verifies a **packaging candidate** in a local workspace or disposable staging directory. The archive is **not live-install-ready** and this checklist does not authorize copying it into DirectAdmin, enabling the plugin, creating credentials or changing a host.

The v0.1.4, v0.1.5 and earlier 19-file v0.1.6 records below are historical
candidates. The latest coordinated v0.1.6 candidate and its 26-file archive
evidence are recorded in the final section. None of these staged checks
certifies a live DirectAdmin/Apache install.

## Build the SDK and package

For the historical v0.1.5 candidate, use the exact canonical SDK source from main
`64561e4d077ec07a3cb40dfb43284b0e7dff4dbf` (including #1243 session replacement
and registry-outage handling). Its DirectAdmin SDK paths are unchanged from
`bfbb06a5`. No shared SDK implementation is copied into the Workforce source.
Node 22.23.3 and the repository's locked dependencies were used.

```sh
work_area=/tmp/1050-sdk-current
source_area=/tmp/1050-workforce-source
rm -rf "$work_area" "$source_area" /tmp/1050-sdk-current.mjs
mkdir -p "$work_area" "$source_area"
source_ref=$(git rev-parse HEAD)
git archive 64561e4d077ec07a3cb40dfb43284b0e7dff4dbf packages/titan-platform \
  | tar -xf - -C "$work_area"
ln -s "$PWD/packages/titan-platform/node_modules" \
  "$work_area/packages/titan-platform/node_modules"
node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/bin/esbuild \
  "$work_area/packages/titan-platform/src/directadmin-plugin.ts" \
  --bundle --format=esm --platform=browser --target=es2022 \
  --outfile=/tmp/1050-sdk-current.mjs

git archive "$source_ref" apps/directadmin/workforce | tar -xf - -C "$source_area"
node apps/directadmin/workforce/tools/package.mjs \
  --source-dir "$source_area/apps/directadmin/workforce" \
  --sdk-module /tmp/1050-sdk-current.mjs \
  --output-dir /tmp/1050-package-candidate

sha256sum /tmp/1050-package-candidate/titan_workforce.tar.gz
cat /tmp/1050-package-candidate/titan_workforce.tar.gz.sha256
```

The builder rejects symlinks, requires canonical browser session and package-validator exports, includes an explicit allowlist (26 files after the #1395 RAW integration), writes normalized ownership/time/modes, extracts and compares the result, invokes the shared SDK package validator and runs the install preflight in a temporary staging copy.

## Historical 19-file candidate — independent archive check

```sh
set -eu
archive=/tmp/1050-package-candidate/titan_workforce.tar.gz
expected=$(awk '{print $1}' "$archive.sha256")
actual=$(sha256sum "$archive" | awk '{print $1}')
test "$actual" = "$expected"
test "$(tar -tzf "$archive" | wc -l)" -eq 19
stage=$(mktemp -d /tmp/titan-workforce-stage.XXXXXX)
tar --same-permissions -xzf "$archive" -C "$stage"
"$stage/scripts/install.sh"
"$stage/scripts/update.sh"
"$stage/scripts/uninstall.sh"
test -x "$stage/admin/index.html"
test -x "$stage/reseller/index.html"
test -x "$stage/user/index.html"
rm -rf "$stage"
```

The package test suite also verifies deterministic bytes, checksum sidecar, exact file list/modes, rejection of missing/symlinked inputs, failure for unsupported Node and asset conditions, install/update preflight, uninstall preserving business state, and rejection of an SDK without the current browser session.

Run the integration suite against the compiled SDK:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
TITAN_COCKPIT_SDK_MODULE=/tmp/1050-sdk-current.mjs \
  node --test apps/directadmin/workforce/tests/*.test.mjs \
    apps/directadmin/workforce/tests/sdk-contract.integration.mjs \
    apps/directadmin/workforce/tests/hosted-sdk.integration.mjs
```

The hosted test exercises the real #302 fixture credential issuer/registry and #1049 bridge through a fixture-only Workforce owner. It proves transport and consumer behavior, not a deployed hosted API. Live DirectAdmin, commissioning, Evolution, production install/update/rollback and credential delivery require their separate owner contracts and approval.

## Previous artifact record — v0.1.4

For this continuation, the package builder consumed the exact #1049 SDK source above and produced a 19-file **verification candidate** for plugin version **0.1.4** at:

`/tmp/1050-package-candidate/titan_workforce.tar.gz`

SHA256: `0ef7ce0d5b4d0a732d1869ec067ce117aae81879bf7fa123abc0fef6c23c0d8b`
The same archive is recorded as Library item `libfile_72615f7136108191a0a2eada84474dba`, version 3, with candidate-only/not-live-install-ready metadata.


Bundled SDK module SHA256: `c45d611fbdee263cd248e4c7f9736bbe64fa80d1b7cadb19c022e27fa970db95`.
That previous candidate was rebuilt twice byte-for-byte from the canonical #1050 branch source and its exact #1049 source. It is not certified for a live DirectAdmin install.

The `.sha256` sidecar records the same value; rebuild and refresh this record after any source change.

## Approved host update and rollback procedure

This is a procedure for a later, separately approved deployment; it has not been run.

1. Retain the currently installed package archive and its verified SHA256 outside the plugin directory.
2. Verify the candidate version in `plugin.conf` and compare the archive against its `.sha256` sidecar. Stage and run the checks above.
3. After host authorization and live owner APIs are ready, update through DirectAdmin Plugin Manager and verify each role route in read-only/uncommissioned mode.
4. If the package fails, restore the retained archive through DirectAdmin Plugin Manager and repeat read-only checks.
5. Keep runtime state, company storage, credentials, revocations and evidence under their canonical owners throughout. Never use plugin rollback to restore or delete them.

The role executable does not read DirectAdmin CGI stdin/environment values. The package test supplies hostile POST stdin and DA request environment values and verifies they do not appear in the rendered page; this is an isolation test, not proof of a working DirectAdmin transport. Installed Dev Access 1.1.3 has a reported POST CSRF failure; #1048 must certify its own Developer Portal form path, while Workforce separately needs #812/#1049 route wiring and live DirectAdmin transport/session tests.

## Candidate validation (not live-install readiness)

The owner-state paragraph immediately below is historical evidence from the
`ccf8010a` snapshot; its PR statuses are not current. The 2026-10-02 record at
the end reflects merged PR #1143, #1204 and #1211, main snapshot `468d42b1`
(the source tip at build time), and the latest extracted test. Live main is now
`23300c79`; its intervening changes do not touch the tested DirectAdmin Workforce,
Server Node, hosted-owner or SDK paths.

**Can execute now:** package build, deterministic archive/checksum validation, staged install/update/uninstall preflight, and each role script as a CLI renderer. DirectAdmin's documented `pipe_post=yes` mode supplies `POST=stdin=true` and POST bytes on stdin; the packaged role process has been exercised with these values and ignores request data safely. Install/update scripts only preflight and do not mutate a host. None of this makes the archive live-install-ready.

**Historical owner state at `ccf8010a` (not current):** #811/#1201 was in that main snapshot with the company-filtered read-only projection owner and optional `/v1/directadmin/*` Fetch mount. The current projection has `controls: []`; proposed lifecycle intents are denied without state, event or receipt writes. That snapshot also includes #1183 credential/current-company session work, #1240 company-placement contracts, and #1048/#1209 Developer Portal hardening, but no verified upstream credentials or protected Workforce provisioning have been commissioned. #1050 imports #812's helper path and sends through the RAW endpoint. The extracted-package → RAW → #811 host run used the `c883304a` host snapshot, #812 `8cae7034` and #1049 SDK source `e428b67b`; it passed `ctx1_` validation, projection reads, company switch, isolated invalid-CSRF denial and cookie clearing, typed action 403 while preserving the valid session, and expiry handling without work/event writes. The Workforce controller revalidates after an intent-route denial; post-acceptance read failures remain cleared and direct the operator to inspect canonical history. This is disposable integration evidence, not commissioning. That historical snapshot contains #812 commit `89ff2427` with experimental relay config v2 and an Apache `:443` cookie-boundary marker/template; this run predates that contract and does not test or attest the marker. Independent contract review and real disposable Apache/DirectAdmin testing are required before adoption. Do not treat the marker as proof of cookie isolation. #1049 was then an open draft; PR #1204 later merged at `75cc7f02`. #812/PR #1211 is merged but its live-host commissioning remains unverified. No private token belongs in a URL.

### Disposable extracted relay-to-host integration

This test packages the exact pinned owner sources, extracts all three owner packages, and uses only temporary SQLite files, a generated localhost TLS certificate, and the actual #1049 signed identity test fixture. It is not live-host or production-session certification. The owner snapshots used for the original extracted v0.1.4 run were #1049 SDK source `e428b67b34779e49f4dbc8d3e80b193e8737eb13`, #811 host/runtime/storage snapshot `c883304a662738fe480ec1e5d044fdeb0c4c879e` (projection owner reviewed at `25005f4f4d860e2ec1dddb9f0a2c4aa152fd0488`; snapshot includes #1183/#1240 storage/session changes), and pre-v2 #812 head `8cae7034f6d2ec7c9063ac0c3aba40c6f41b3d89`. PR #1204 later merged the SDK implementation to main at `75cc7f02`. After that historical run, main advanced through `ccf8010a`, #1197 portfolio packaging, and #1048/#1209 Developer Portal hardening; these commits do not change the tested Workforce host route paths. Current main also contains merged #812 commit `89ff2427` with experimental config v2 and an Apache cookie-boundary marker/template; this test does not validate that new contract.

```sh
work_area=/tmp/1050-extracted-integration
rm -rf "$work_area"
mkdir -p "$work_area/host" "$work_area/server-node" "$work_area/sdk"
git archive c883304a662738fe480ec1e5d044fdeb0c4c879e \
  package.json services/workforce packages/storage packages/titan-platform \
  packages/runtime packages/tools db/sqlite | tar -xf - -C "$work_area/host"
git archive 8cae7034f6d2ec7c9063ac0c3aba40c6f41b3d89 \
  apps/directadmin/server-node scripts/package-directadmin-plugin.mjs \
  | tar -xf - -C "$work_area/server-node"
git archive e428b67b34779e49f4dbc8d3e80b193e8737eb13 packages/titan-platform \
  | tar -xf - -C "$work_area/sdk"
ln -s "$PWD/packages/titan-platform/node_modules" \
  "$work_area/sdk/packages/titan-platform/node_modules"

node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/bin/esbuild \
  "$work_area/sdk/packages/titan-platform/src/directadmin-plugin.ts" \
  --bundle --format=esm --platform=browser --target=es2022 \
  --outfile=/tmp/1050-sdk-e428.mjs

TITAN_WORKFORCE_HOST_ROOT="$work_area/host" \
TITAN_SERVER_NODE_SOURCE_ROOT="$work_area/server-node" \
TITAN_COCKPIT_SDK_MODULE=/tmp/1050-sdk-e428.mjs \
TITAN_HOST_SDK_MODULE=/tmp/1050-sdk-e428.mjs \
TITAN_BRIDGE_FIXTURE_MODULE="$work_area/sdk/packages/titan-platform/tests/fixtures/directadmin-bridge-fixture.mjs" \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
node --import ./node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs \
  apps/directadmin/workforce/tests/relay-host.integration.mjs
```

The extracted integration test passed using host/runtime/storage sources archived from main snapshot `c883304a` and the relay pinned to #812 `8cae7034`: missing relay config returned sanitized 503 before reaching #811; actual Workforce package/helper/RAW route read company A's canonical workers, work and evidence with controls empty; invalid CSRF was denied and cleared only the isolated test cookie; company switch exposed only company B; expiry cleared the client projection. A governed pause proposal passed #812's `ctx1_` validation, reached the actual #811 owner and returned #1049's sanitized 403 denial while preserving the valid browser session. SQLite work/events remained unchanged. Result: 14 RAW requests and 15 hosted routes. The test uses the #1049 signed identity/nonce fixture and inserts its CSRF meta value into disposable panel HTML only to exercise transport; the run includes #1183/#1240 host source but does not prove production issuer credentials, protected provisioning, the commissioned HTML bootstrap, cookie-port sharing or live DirectAdmin `HEADERS` path. Main later advanced to `ccf8010a`; the host integration was not rerun on that head. It predates merged #812 commit `89ff2427` and does not test that commit's config-v2/Apache cookie-boundary contract. The exact runtime setup used the official Node v22.23.3 tarball SHA256 `df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de`, the published `better-sqlite3@12.11.1` Node ABI 127 prebuild via `prebuild-install@7.1.3`, and a successful targeted `npm rebuild` reusing that prebuild; no node-gyp compile or supply-chain policy change was made.

**Unavailable until owners commission and verify it:** the #302-backed #1049 production actor/company/CSRF bridge and trusted nonce bootstrap, approved audience-bound Workforce handoff, and real DirectAdmin admin/reseller/user installation, POST, Evolution theme, update, rollback and session tests. The package never injects caller identity or CSRF data. The CGI CLI parser in #1048 Developer Portal is specific to that plugin and does not supply Workforce identity or routes.

## Previous candidate from main snapshot 468d42b1 — superseded

The exact main source snapshot was
`468d42b1a93401a2357f2da253f639694cb4a937`; live main now advances to
`23300c79185f6dc7f8c4b6ab3ae11ac8aa114906`, with only mobile and the generic
Titan CI workflow changed since the tested snapshot. The package builder consumed
the shared #1049 SDK compiled from `468d42b1`; bundled `images/sdk.mjs`
SHA256 is
`57d4776fdaee9359aa669d0b756392614772051cb023cce71d05c9bafc269077`.
The **candidate-only** v0.1.5 archive contains 19 files at
`/tmp/1050-package-candidate-015/titan_workforce.tar.gz`, SHA256
`0e7cdf5fae1bcb0b459c0aab2c557b442cbf6eb14ff6e9b1edbf70529e09ce31`.
Two independent builds produced byte-identical archives. Its manifest and
package report version 0.1.5. Independent extraction verified the checksum,
included SDK hash, executable role entrypoints and staged install/update/
uninstall preflight. Package source is not production data, and uninstall
preserves canonical Workforce state.

Against the SDK bundle from the tested main snapshot, the consumer/browser/
hosted/package test command in the integration record passed **39/39**, including
503 recovery without SDK
session invalidation versus revoked-session 401 invalidation, and the exact
read-only explanation/no-intent behavior for `controls: []`.

The extracted relay-to-host run used exact #811, #812 and #1049 source archives
from the tested main snapshot. It extracted Server Node **0.3.0**, configured its v2 parser
using a temporary synthetic test-only `cookie_boundary` marker, and passed the
company switch, projection/evidence, 401/403, expiry and no-write scenarios
(14 RAW requests, 15 hosted routes). The marker does not install or prove an
Apache filter and this run does not exercise a real Apache/DirectAdmin host.
The parent-confirmed duplicate physical `Cookie` header fail-open in #812's
experimental Apache `:443` filter remains a release blocker; `:2222` RAW parser
checks are a different boundary. Do not install or commission until #812 fixes
the fail-open and a disposable authorized Apache/DirectAdmin host verifies the
cookie-name-only isolation behavior.

Still unavailable are verified #302 production issuer credentials/protected
provisioning, trusted HTML CSRF bootstrap and the approved audience-bound
Workforce exchange; configured #811 production dependencies/private origin;
actual DirectAdmin CGI `HEADERS`, POST-stdin and `Set-Cookie` behavior; and a
supported host Node runtime. No credentials, live package, service, firewall,
DNS, or security setting was changed. This remains a package verification
candidate, not a commissioned plugin or mission completion claim.

## Pre-#1245-merge candidate — main 8c1161f2 (historical)

The canonical `agent/issue-1050` branch normally merged current main
`8c1161f291d07ecf344ae062b2349c2a13280410` at
`a1d364828991289254b04cdc1e16e0f92a5c1458` after #1242/#1244. The shared SDK
source remains unchanged from `d508a269`; #1242's production host composition
now requires canonical company-placement registry and store-opener ports. The
exact #1049 SDK source from main was bundled using Node v22.23.3. The official
Node archive SHA256 is
`df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de`; bundled
`images/sdk.mjs` SHA256 is
`9d94cb80dbb0e7df15388efb1de2262e6c26af041f66a1c5d4944045fc491c9a`.

Two builds of the 19-file v0.1.5 verification candidate from the then-current
claim-branch source and this SDK were byte-identical. Candidate:
`/tmp/1050-package-current-final-a/titan_workforce.tar.gz`. Archive SHA256:
`618072346eb3b80b38010ed0a6a13f1a9b13d16d48ca87b30469334b7f8ae5da`; the
sidecar matches. Independent extraction verified the 19-file count, bundled
SDK hash, executable role/lifecycle entrypoints, and staged install/update/
uninstall preflight. Uninstall preserves hosted business state. No DirectAdmin
server is modified by these checks.

On this exact 8c main SDK bundle, the Node 22.23.3 Workforce consumer/browser/
hosted-session/package suite passed **39/39** and the shared bridge suite passed
**83/83**. The extracted relay-to-host harness passed **14 requests / 15 routes**
against main `8c1161f2` and the then-unmerged #812 PR #1245 source. The former
production default returned sanitized 503 `relay_not_configured`; the PR draft's
returned sanitized 503 `cookie_boundary_unverified`. The fixture supplied #1242
placement ports through canonical SQLite adapters and disposable test records.
Forwarding was enabled only by in-process test injection; no configuration file,
CGI override, production RAW process, Apache boundary, or DirectAdmin commissioning
was involved. This run predates the #1245 merge and is historical evidence.

The 39/39 cockpit result was local evidence. The separate secretless Node 22
hosted CI job remains with #1157 and was not changed here. #1050 remains open.

## Prior current-source v0.1.5 record — main bfbb06a5

At this run, main was `bfbb06a5a22591100e2c0101e6598bee9c6f4589`, which merges #1246;
#1245 merged earlier at `faab3c5c9bdfd90179d5d3bfee21c479dceb3613`. The #1049
SDK source tree is unchanged from main `8c1161f2`; its bundle compiled from
exact `bfbb06a5` source using Node v22.23.3 has SHA256
`540f2cef873dd51bcdf7bea75c3ac519630cdc3345128f38f0f396957d31a448`. Two builds
of the 19-file v0.1.5 package from the finalized app source and this bundle were
byte-identical at `/tmp/1050-package-current-bfbb-a/titan_workforce.tar.gz` and
`/tmp/1050-package-current-bfbb-b/titan_workforce.tar.gz`. Archive SHA256:
`9a7f1223b66fe3f475764344abae8f14d9d19635155627770bbe153fb6e9f2ba`.
Independent extraction verified the matching sidecar, file allowlist/count,
SDK hash, role/lifecycle modes and staged install/update/uninstall preflight.
Uninstall preserves hosted business state. No DirectAdmin server was modified.

Against the exact current-main SDK bundle, the Workforce consumer/browser/hosted-session/
package suite passed **39/39**, shared bridge **83/83**, and package-script tests
**3/3**. The extracted relay-to-host test used exact main `bfbb06a5` source and
passed **14 requests / 15 hosted routes**. Its production RAW default returned
sanitized 503 `cookie_boundary_unverified` without upstream requests; the test
then injected its fixture loader directly into the extracted module. Current
main includes the merged #1245 change that removed the experimental Apache
`:443` filter but intentionally leaves production forwarding disabled. The
fixture also supplied #1242's required company-placement registry and store
opener using canonical SQLite adapters and disposable records. These are local
compatibility checks, not Apache, DirectAdmin CGI, or commissioning evidence.
No dedicated hosted Workforce CI ran these entrypoints; that work remains with
#1157. #1050 remains open.

## Latest current-source v0.1.5 candidate — main 64561e4d (2026-10-02)

Main `64561e4d077ec07a3cb40dfb43284b0e7dff4dbf` merges #1247. Its changed
authority/runtime files do not touch the DirectAdmin SDK, hosted Workforce owner,
Server Node relay, Workforce app or their tests. The SDK was rebuilt from the
exact main archive using Node v22.23.3 and has SHA256
`5d266ad5233d3a816d1c4fd839ea901a7ee632591872558813834d2d791c989d`.

Two builds of the 19-file v0.1.5 candidate from the current claim-branch app
source and that exact-main SDK were byte-identical at
`/tmp/1050-package-current-main645-a/titan_workforce.tar.gz` and
`/tmp/1050-package-current-main645-b/titan_workforce.tar.gz`. Archive SHA256:
`022be439598b90fb433b6138efefd70bc226d9c479384464186342e5b758b176`.
The matching sidecar, file count, SDK inclusion, executable role/lifecycle
modes and staged install/update/uninstall preflight passed. Uninstall preserved
hosted business state; no DirectAdmin server was modified.

On this SDK bundle, the consumer/browser/hosted-session/package suite passed
**39/39**, shared bridge **83/83**, and DirectAdmin package-script tests **3/3**.
The extracted relay-to-host test used a full source archive from exact main
`64561e4d` and passed **14 requests / 15 hosted routes**. Production RAW returned
sanitized `503 cookie_boundary_unverified` with no upstream request. Fixture
forwarding used an in-process injected loader and canonical SQLite placement
adapters with disposable records; no production RAW process, CGI config, Apache,
DirectAdmin host or real cookie boundary was exercised. The host still publishes
`controls: []`, and typed governed-action denial produced no business DB/event
writes. These are local compatibility checks, not commissioning evidence.

The independent security reviewer found no issue in the fixture seam or package
provenance; the final documentation-only baseline update does not change those
boundaries. Hosted Workforce CI remains with #1157. #1050 is partial and open.

Exact bounded commands on Node v22.23.3:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
TITAN_COCKPIT_SDK_MODULE=/tmp/1050-sdk-main645.mjs \
  /tmp/1050-node22-dist/bin/node --test \
  apps/directadmin/workforce/tests/*.test.mjs \
  apps/directadmin/workforce/tests/sdk-contract.integration.mjs \
  apps/directadmin/workforce/tests/hosted-sdk.integration.mjs

/tmp/1050-node22-dist/bin/node --test packages/titan-platform/tests/directadmin-bridge.test.mjs
/tmp/1050-node22-dist/bin/node --test scripts/package-directadmin-plugin.test.mjs

TITAN_WORKFORCE_HOST_ROOT=/tmp/1050-extracted-main645/host \
TITAN_SERVER_NODE_SOURCE_ROOT=/tmp/1050-extracted-main645/host \
TITAN_COCKPIT_SDK_MODULE=/tmp/1050-sdk-main645.mjs \
TITAN_HOST_SDK_MODULE=/tmp/1050-sdk-main645.mjs \
TITAN_BRIDGE_FIXTURE_MODULE=/tmp/1050-extracted-main645/host/packages/titan-platform/tests/fixtures/directadmin-bridge-fixture.mjs \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
  /tmp/1050-node22-dist/bin/node \
  --import /workspace/Titan-Zero-Field-Service-Workforce/node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs \
  apps/directadmin/workforce/tests/relay-host.integration.mjs
```

## Latest current-source v0.1.6 candidate — main 9fd2e4e8 (2026-10-02)

The canonical `agent/issue-1050` branch normally merged main `9fd2e4e8` in
`732832e0`. The package source commit is
`6b4658457973f2260b22c77f1f6e365966920802`. The shared SDK was compiled from
that exact main source with Node v22.23.3 and esbuild 0.27.3; its bundled module
SHA256 is `29a69a397692d142f25e47ba41e8c97de7eb193d6ea1ace0c24ca970cfb6d5db`.

Two builds of the 19-file v0.1.6 candidate were byte-identical. Archive SHA256:
`0587796777946fac81e63ed79cbecc32ffc19c1dfa454cf39149d10f5e6da51e`. Its
sidecar matched. Independent extraction verified the 19-file count and v0.1.6
manifest; staged install/update/uninstall scripts passed, with uninstall
preserving hosted Workforce and business state. These are disposable staging
checks and do not modify a DirectAdmin host.

On the current-main SDK bundle, the bounded app/browser/package suite passed
**50/50**, and `sdk-contract.integration.mjs` plus
`hosted-sdk.integration.mjs` passed **6/6**. The latter uses the actual #302
signed fixture issuer/registry and session bridge with controlled projection
and action owners; it does not certify a hosted production endpoint.

The direct SQLite owner integration passed **8/8** against this consumer source
and the exact source-compatible older pair: #1253 owner `f6710e9d`, #1252 SDK
`aff11521`. It emitted a separate 19-file v0.1.6 archive with that older SDK,
SHA256 `e3dcfac8a16dfb4d2d30c53d10aaf8523c6fecdffae761b9d27debd1555aa201`.
That run covers real SQLite authority, reassign CAS, evidence lineage, replay,
revocation, cancellation and company switching, while recording the owner's
post-commit cancellation misclassification as a defect. The currently published
#1252 head `31e57e11` requires the current #302 browser-bootstrap method that is
absent from current #1253 head `b969acfe`; do not describe the older direct-owner
run as proof of those latest PR heads working together. The direct owner source
must be reconciled with the bootstrap contract.

No production identity, protected credential, relay configuration, host
security setting or server was changed. Main's hosted owner currently publishes
`controls: []` absent a grant, and #812's RAW production default remains disabled
until a cookie boundary is verified on a real disposable DirectAdmin/Apache
host. #1050 remains partial and open.

Exact current-main SDK/package rebuild commands:

```sh
node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/bin/esbuild \
  packages/titan-platform/src/directadmin-plugin.ts \
  --bundle --format=esm --platform=browser --target=es2022 --minify \
  --outfile=/tmp/1050-sdk-main-9fd.mjs

node apps/directadmin/workforce/tools/package.mjs \
  --sdk-module /tmp/1050-sdk-main-9fd.mjs \
  --output-dir /tmp/1050-package-v0.1.6

PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
TITAN_COCKPIT_SDK_MODULE=/tmp/1050-sdk-main-9fd.mjs \
  node --test apps/directadmin/workforce/tests/*.test.mjs \
  apps/directadmin/workforce/tests/sdk-contract.integration.mjs \
  apps/directadmin/workforce/tests/hosted-sdk.integration.mjs
```

## Historical consumer candidate — main 99271ea4 (2026-10-03)

The consumer source is on the existing `agent/issue-1050` continuation after
merge `91ffb77a`. The #1049 SDK source in main `99271ea4` is unchanged in this
slice. Built with Node v22.23.3 and esbuild 0.27.3 from the checkout root, its
bundle SHA256 is
`9f28ab5ea84aaa6015f8cbf0a5fe399a791924c52edb2689d7eeb824f2a2d408`.

The v0.1.6 candidate archive is available in the task workspace at
`/workspace/.tmp-1050-workforce/package-v0.1.6-main992-final/titan_workforce.tar.gz`.
It contains 19 allowlisted files and has SHA256
`89c2e2cffa5e58a98d1e51244dbd10ea1883e551aadddb52a41b1221a0e04974`; two
fresh builds were byte-identical and the sidecar matched. Independent
extraction verified the file count, manifest, executable role indexes, and
staged install/update/uninstall preflight. Uninstall preserves hosted Workforce
and company business state. A separate archive listing check confirmed the
candidate does not include `bootstrap-nonce.raw`, `bootstrap.raw`, or the
#1300 RAW adapter module, which are still owned by draft PR #1395.

The app/browser/package, current-main SDK contract and controlled identity
fixture suite passed **57/57** on this bundle. The extracted current-main relay
run passed **14 relay requests / 15 hosted routes**, covering the disabled
production default, two-company read-only projection/evidence, invalid-CSRF
and hosted authority denials without work/event effects, and expiry clearing.
The fixtures do not simulate production identity or prove live cookie isolation.

Rebuild from a clean checkout of this branch:

```sh
node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/bin/esbuild \
  packages/titan-platform/src/directadmin-plugin.ts \
  --bundle --format=esm --platform=browser --target=es2022 \
  --outfile=/tmp/1050-sdk-main-99271ea4.mjs

node apps/directadmin/workforce/tools/package.mjs \
  --source-dir apps/directadmin/workforce \
  --sdk-module /tmp/1050-sdk-main-99271ea4.mjs \
  --output-dir /tmp/1050-package-v0.1.6-main-99271ea4
```

For this historical 99271ea4 candidate, the consumer expected the role RAW
routes but that archive did not contain them; #1395's contract was integrated
later in the coordinated continuation below.
Do not install the archive on DirectAdmin. #812's production relay remains
disabled with `503 cookie_boundary_unverified`; live DirectAdmin/Apache cookie
isolation, #1395's blocked native database suites, protected identity
provisioning, and positive hosted controls remain outstanding.

## Coordinated packaged RAW and cockpit continuation — current main ee3e61da (2026-10-03)

This remains on the existing `agent/issue-1050` branch and open draft PR #1405.
The branch includes normal merges of exact current #1395 head
`914c0e1b0ec19277ea7f965b0ef31f6426f6646b` and current main `ee3e61da`; the
#1395 source-owned RAW/package files were preserved. Main's advance from
`d2d76ce6` touched marketing paths only; the DirectAdmin SDK source used below
is unchanged. No deployment, production credential, or security-setting change
was made.

Two builds of the current v0.1.6 candidate were byte-identical. The archive is
available at
`/workspace/.tmp-1050-workforce/package-v0.1.6-integrated-a/titan_workforce.tar.gz`,
contains 26 files, and has SHA256
`100ecd5c58d6de7f0cfb02636d58440ae05751293047d5cdce6bd61bcf556b26`. Its
sidecar matched. Independent extraction confirmed `plugin.conf` version 0.1.6,
the three role pages, all six executable RAW scripts at mode 0755, the shared
RAW adapter and successful staged install/update/uninstall preflight. The
portfolio's strict manifest/archive-version test now pins 0.1.6 and compares the
version embedded in the actual archive; it no longer incorrectly expects
0.1.5.

The browser integration builds and extracts the real package, serves its User
page and invokes the extracted `user/bootstrap-nonce.raw` and
`user/bootstrap.raw` through the packaged adapter. It covers initial bootstrap,
late-response invalidation, retry, company-context change, page lifecycle,
reload, logout, expiry, read-only controls and receipt correlation restoration.
On `pagehide`, the controller drops rendered company and receipt data while
retaining only the opaque tab-scoped receipt pointer. A resumed or reloaded page
must fetch a new host context, match its company and actor, then ask the shared
receipt reader again. Normal logout, expiry, revocation and company/actor changes
still clear the pointer. Assertions now
require each tested renewal to forward the previous host cookie, issue a unique
replacement, and update the browser cookie jar. The nonce route is required to
strip that browser-managed Titan cookie before private forwarding. The company
switch itself is a controlled identity/context fixture event; it does not prove
the real #302 selected-company assertion or #811 hosted authorization flow. The
child process runs the extracted script with Node, so it does not certify the
DirectAdmin OS shebang/CGI invocation.

Verification on Node v22.23.3, Chromium and the current-main SDK bundle
(`7c08d37f6ea274760f8e52092b2e86a07a93ae175fe4a6216df9156d1fc39681`):

- Workforce unit/browser/package and packaged cockpit consumer suite: **60/60**.
- Portfolio/package/role RAW exact archive contracts: **20/20**.
- Packaged RAW to the #302 assertion fixture and #1049 session bridge: **3/3**.
- #1395 hosted CI on exact head `914c0e1b`: package, source-index,
  sqlite-compose-and-build, workforce, canonical-environment, mission evidence
  and slice checks passed; unrelated/conditional jobs were skipped.

The browser host, selected company and governed action responses are controlled
fixtures, not production data. This run proves packaged consumer protocol and
lifecycle behavior, not real identity binding, owner authorization, protected
provisioning, or a production positive control. #812's production relay remains
disabled pending verified cookie isolation on an authorized disposable host;
upstream credentials/protected provisioning and a real DirectAdmin install are
still uncommissioned. #1395 and #1405 remain drafts, and #1050 stays open for
its remaining acceptance criteria.

### Canonical company and revocation regression — 2026-10-03

The focused packaged RAW session-chain test now uses the shared
`directadmin-bridge-fixture.mjs` SQLite identity registry and the canonical
session credential service. It no longer creates a plugin-specific cleaning
company or chooses a company from a DirectAdmin role/session response. That
response remains a controlled `/api/session` identity projection fixture
(subject and role only); the company/device tuple, binding, membership and
revocation are all resolved through the canonical registry.

The Admin, Reseller and User packaged nonce/bootstrap route pairs each reject
the initially ambiguous two-company context. After the fixture revokes the
second membership in the canonical store, all three pairs can issue only for
`company-a` / `device-1`. The test also revokes that membership between nonce
and bootstrap (no cookie or call to session issuance), verifies that the
resulting credential cannot authenticate for another company, and revokes the
membership again after issuance to prove both bridge context and nonce requests
fail closed. Replaying that stale nonce after membership restoration remains
denied, and changing the authenticated DirectAdmin role between nonce and
bootstrap is also rejected. Host, Origin, injected role/company headers, cookie
forwarding, `redirect: error`, `cache: no-store`, `credentials: omit`, and the
absence of a company selector in the host session projection remain asserted.
The bridge context explicitly carries `authority: not-carried`.

Focused verification on Node v22.23.3:

```sh
TMPDIR=/workspace/.tmp-1050-workforce \
  /tmp/1050-node22/node-v22.23.3-linux-x64/bin/node --test \
  apps/directadmin/workforce/tests/bootstrap-session-chain.integration.mjs
```

Result: **3/3 passed**, including all three role routes. This is canonical-store
integration coverage with a controlled DirectAdmin HTTP identity response; it
does not certify protected production identity provisioning, a live DirectAdmin
cookie boundary, or an installed production host.

The complete Workforce consumer/browser/package/SDK/hosted suite was rerun after
these additional assertions and passed **61/61** on the same Node/Chromium/SDK
configuration.

### Packaged RAW to canonical company-scoped hosted Workforce — 2026-10-03

The updated `relay-host.integration.mjs` now drives the browser through the
extracted package's actual User nonce and bootstrap RAW scripts. It removes the
former test-only `panel.selectedCompany` bootstrap and uses the #302 bootstrap
flow, the shared SQLite identity registry, the canonical session credential
service, the #1049 session bridge and company-switch gateway, and the current
#811 `createWorkforceServer`/Workforce owners with A/B company rows in one
disposable SQLite Workforce store. This proves logical company filtering, not
separate physical company database isolation. The `/api/session` endpoint is
still a controlled DirectAdmin HTTP fixture. It accepts only the exact fixture
DirectAdmin cookie pair, returns host user/role identity without a company
selector, and asserts `redirect: error`, `cache: no-store`, omitted fetch
credentials and no Authorization header. It does not validate real DirectAdmin
credentials, upstream revocation or host-session expiry; the renewal scenario
expires the Titan session while this host fixture remains valid.

The canonical registry starts with only company A active, so the real packaged
nonce route can issue the first session without an injected company. Activating
B and switching through `/v1/directadmin/company` rotates the canonical
session; the actual Workforce owner then returns only B's worker/work/evidence.
That route is called through the extracted relay, then the host's
`titan-context-changed` event is dispatched by the test; this does not exercise
`DirectAdminCockpitSession.switchCompany()` or certify a user-visible company
picker. This end-to-end browser journey executes the User role only; Admin and
Reseller nonce/bootstrap, renewal, revocation and hostile-input paths are
covered separately by the 4-case session-chain suite.
With A and B active, a fresh packaged User nonce request from that browser page
is denied as ambiguous while its existing canonical B session remains intact.
After the fixture canonically revokes A, B is the unique binding and a full
packaged reload/expiry-renewal succeeds. Revoking B clears the rendered company data and
governed controls. The projection's controls remain empty; its governed action
is denied by the actual #811 owner, and the test verifies no business/event
writes. The production relay default remains an explicit `503
cookie_boundary_unverified`; the test-only relay configuration is injected
in-process and does not certify Apache/CGI cookie isolation.
The extracted RAW child receives only its CGI inputs, `NODE_ENV`, the matching
`TMPDIR`, and the private test port-file path; it does not inherit ambient
developer or CI environment variables.

Focused verification on Node v22.23.3 and Chromium:

- `node --test apps/directadmin/workforce/tests/*.test.mjs apps/directadmin/workforce/tests/sdk-contract.integration.mjs apps/directadmin/workforce/tests/hosted-sdk.integration.mjs`: **61/61 passed**.
- `node --test apps/directadmin/workforce/tests/bootstrap-session-chain.integration.mjs`: **4/4 passed** for Admin, Reseller, User, role/session renewal, canonical membership, revocation and hostile request rejection.
- `node --import tsx --test apps/directadmin/workforce/tests/relay-host.integration.mjs`: **1/1 passed**, 15 relay requests and 21 hosted routes.
- Shared DirectAdmin SDK/browser suite: **123/123 passed**.
- Two fresh 26-file v0.1.6 package builds are byte-identical; SHA256 and sidecar: `100ecd5c58d6de7f0cfb02636d58440ae05751293047d5cdce6bd61bcf556b26`.

These disposable tests prove the current local package-to-canonical-owner path,
not production DirectAdmin `/api/session` provisioning, protected upstream
credentials, multi-company selection during bootstrap, authorized hosted
controls, or live install/update/rollback. Active A+B bootstrap intentionally
fails closed because no trusted selected-company binding is provided to the
nonce route. Real selection requires a canonical #302/#1049 host contract; this
plugin does not invent one. #1050 remains open for the rest of its acceptance
criteria and approved live-host commissioning.

### Governed receipt consumer contract — 2026-10-03

The #811 owner has a real governed reassignment intent: its positive owner
tests run through current authority, the ExecutionGateway, observed
company-scoped reread, durable idempotency and accepted evidence. The open
draft #1440 implements and tests the read-only accepted-receipt projection, but
its PR description confirms that the browser HTTP route is not mounted yet.
Current main's DirectAdmin gateway returns only `202 REQUESTED` plus the receipt
ID, and the company-scoped projection exposes only evidence references. It does
not expose receipt verification details. The shared #1049 SDK also has no
receipt read method on current main.

The Workforce consumer accepts receipt detail only from the shared SDK method
`session.receipt('titan_workforce', receipt_id)` with the `{context, receipt}`
envelope. It validates the agreed typed receipt schema, company, actor, opaque
session/context revisions, receipt and operation correlation, and rechecks the
current session before and after the read. For the #1398/#1440 contract, the
consumer requires `state: VERIFIED`, `verification_status: verified`, the fixed
company-scoped reread method and exactly the receipt ID as evidence; only then
does it map that owner shape into the cockpit's verified display model. An older
SDK or host leaves the result at `REQUESTED`; work evidence references alone do
not promote it. A generic host denial without a receipt is reported as unverified
even after a canonical projection refresh, because #811 has demonstrated a
post-commit 403 while execution evidence remains uncertain.

The cockpit provides a receipt refresh action and a tab-scoped
`sessionStorage` bookmark containing only company/actor IDs and receipt,
operation, correlation and work IDs. Owner IDs retain the #811 printable-string
bound; only the `receipt_id` used in the fixed SDK route uses the narrower
route-safe character set. Reconnect rereads the host receipt under
the newly authenticated context; it does not persist receipt payloads, evidence,
credentials, or authority. Pagehide clears in-memory data but retains this
pointer for a later same-tab reconnect/reload; a fresh host context must match
its company and actor before the receipt is read. Other session invalidation,
logout, expiry, revocation and company/actor changes clear the bookmark.
Receipt polling or read failure preserves only
the original `REQUESTED` acknowledgement and never replays the governed action.

The #811 owner has adopted the exact missing host route and bounded response
proposal recorded at [issue #811](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/issues/811#issuecomment-5969454043);
its endpoint implementation remains an assigned upstream task. The typed
`session.receipt()` SDK read is coordinated with the active shared-SDK owner on
[PR #1398](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/pull/1398#issuecomment-5969455352)
and is not on current main. Consumer-side detail/envelope tests use typed
fixtures only; they do not claim the current host can return receipt details or
certify a verified UI result end to end.
