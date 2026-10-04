# Workforce consumer to hosted-owner integration — #1050

This evidence records a bounded consumer integration run against pinned
source-compatible owner and SDK commits. It is not a claim that those PRs are
merged, that the full hosted runtime is certified on `main`, or that #1050 is
complete. These owner/SDK pins are older than the currently published PR heads;
the latest SDK and owner branches require a bridge/API reconciliation before they
can be exercised together by this harness.

## Pinned source and artifact

| Component | Source |
|---|---|
| Workforce cockpit and package source, `agent/issue-1050` | `6b4658457973f2260b22c77f1f6e365966920802` |
| Workforce SQLite owner, #1253 / `agent/issue-640` | `f6710e9d723e47d5dbda035309f9b8cd1de0cf4e` |
| Extracted owner source tree digest (sorted path, type, content; dependencies excluded) | `a998aa751d059de466b2dcefeb11e2282d19b67e4432e73b890f858da3fd67d1` |
| Shared DirectAdmin SDK and gateway, #1252 / `agent/issue-1049` | `aff115212281fb555d0c7bc804635e88713f2ec5` |
| Compiled, minified SDK bundle used by the test | SHA256 `f8ac44484b2285293cffe74903053d607414e12d3e6b428045ac42092ec84961` |
| Extracted 19-file v0.1.6 package tree digest | `caa5c3f6b35294ed8c6304e4a5f20788041bccda01ea1286057edae5a2eb5ee1` |

`tests/actual-owner.integration.mjs` requires all recorded source commits and
checks the extracted package tree, owner tree, and compiled SDK bundle hashes
before it runs. It imports the consumer API, controller, presentation, and SDK
from the extracted package. It composes the actual
`createWorkforceServer`, SQLite workforce store, company placement/store
adapters, #302 identity registry and signed session credential APIs, #1049
gateway, and this cockpit's API/controller. The SQLite files, signing keys,
identities, workers, work, scoped grant, approval, and evidence are generated
only inside a disposable temporary directory for the test.

Normal consumer traffic traverses the host's HTTP server route. For the two
cancellation cases, the harness sends the packaged SDK's actual `Request.signal`
to the exact SDK gateway composed by that hosted runtime, while context and
projection still use the host route. This lets the test abort synchronously at
SQLite commit without substituting the #1253 owner or its store.

The test exercises:

- current company context and the actual owner projection's
  `required_capabilities` field;
- a governed reassignment submitted through the compiled shared SDK and actual
  server route, with a signed #302-derived Workforce child session;
- distinct `REQUESTED` ingress receipt and refreshed canonical `VERIFIED`
  evidence read from the SQLite ledger, including company, actor, work, and
  child-session lineage;
- replay of the same operation without a second event or evidence record;
- access revocation after projection but before submission, mapped by the
  shared SDK to a sanitized 403 with no effect;
- an actual SQLite stale-assignee compare-and-set race with no overwrite or
  accepted evidence;
- an already-aborted packaged request with a sanitized unknown result and no
  owner effect;
- request cancellation synchronously triggered by the actual SQLite connection
  immediately after the reassignment transaction commits, followed by effect,
  event, `UNCERTAIN` evidence, missing final outcome, missing accepted evidence,
  consumer report, and same-operation recovery checks;
- company switching that clears company A state and reads only company B data,
  with no inherited control or authority.

It does not provision production identities or credentials, call a live
DirectAdmin host, modify security settings, or deploy a server. The test
records a live contract defect at the #1253 owner boundary: the in-flight
cancelled operation has already changed the assignee and emitted one event;
the gateway persists `UNCERTAIN` evidence with no `final_outcome` and does not
append accepted evidence. However, the owner turns that result into HTTP 403
`DirectAdminWorkforceAuthorityDenied`, so the packaged UI says “host denied”
and refreshes even though the operation committed. Replaying the same
operation returns sanitized 503 recovery-required and adds no event or
evidence. Fix the uncertainty classification in #1253 before treating
in-flight cancellation as accepted. This test characterizes the defect; it
does not mark the behavior correct.

## Reproduction

Run from a checkout with the repository's Node dependencies installed and Node
22.23.3. Fetch the pinned commit objects directly; do not substitute moving PR
heads.

```sh
owner_head=f6710e9d723e47d5dbda035309f9b8cd1de0cf4e
sdk_head=aff115212281fb555d0c7bc804635e88713f2ec5
consumer_head=6b4658457973f2260b22c77f1f6e365966920802
git fetch origin "$owner_head"
git fetch origin "$sdk_head"
git fetch origin "$consumer_head"

work_area=/tmp/1050-owner-e2e
owner_root="$work_area/owner"
sdk_root="$work_area/sdk"
consumer_root="$work_area/consumer"
package_root="$work_area/package"
mkdir -p "$owner_root" "$sdk_root" "$consumer_root" "$package_root"
git archive "$owner_head" package.json packages/titan-platform packages/storage \
  pnpm-workspace.yaml packages/runtime packages/tools db/sqlite services/workforce \
  | tar -xf - -C "$owner_root"
git archive "$sdk_head" packages/titan-platform | tar -xf - -C "$sdk_root"
ln -s "$PWD/packages/titan-platform/node_modules" \
  "$owner_root/packages/titan-platform/node_modules"
ln -s "$PWD/packages/storage/node_modules" "$owner_root/packages/storage/node_modules"
ln -s "$PWD/services/workforce/node_modules" "$owner_root/services/workforce/node_modules"
ln -s "$PWD/packages/titan-platform/node_modules" \
  "$sdk_root/packages/titan-platform/node_modules"
git archive "$consumer_head" apps/directadmin/workforce \
  | tar -xf - -C "$consumer_root"

sdk_module="$work_area/directadmin-sdk.mjs"
node_modules/.pnpm/esbuild@0.27.3/node_modules/esbuild/bin/esbuild \
  "$sdk_root/packages/titan-platform/src/directadmin-plugin.ts" \
  --bundle --format=esm --platform=browser --target=es2022 --minify --outfile="$sdk_module"
test "$(sha256sum "$sdk_module" | cut -d' ' -f1)" = \
  f8ac44484b2285293cffe74903053d607414e12d3e6b428045ac42092ec84961
node "$consumer_root/apps/directadmin/workforce/tools/package.mjs" \
  --source-dir "$consumer_root/apps/directadmin/workforce" \
  --sdk-module "$sdk_module" --output-dir "$work_area/package-build"
test "$(sha256sum "$work_area/package-build/titan_workforce.tar.gz" | cut -d' ' -f1)" = \
  e3dcfac8a16dfb4d2d30c53d10aaf8523c6fecdffae761b9d27debd1555aa201
tar --same-permissions -xzf "$work_area/package-build/titan_workforce.tar.gz" -C "$package_root"

TITAN_WORKFORCE_OWNER_ROOT="$owner_root" \
TITAN_WORKFORCE_OWNER_COMMIT="$owner_head" \
TITAN_WORKFORCE_PACKAGE_ROOT="$package_root" \
TITAN_WORKFORCE_PACKAGE_SOURCE_COMMIT="$consumer_head" \
TITAN_COCKPIT_SDK_COMMIT="$sdk_head" \
node --import ./node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/loader.mjs \
  --test apps/directadmin/workforce/tests/actual-owner.integration.mjs
```

The focused consumer and browser regression command uses the same compiled SDK
bundle:

```sh
TITAN_COCKPIT_SDK_MODULE="$sdk_module" \
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium \
node --test apps/directadmin/workforce/tests/api.test.mjs \
  apps/directadmin/workforce/tests/controller.test.mjs \
  apps/directadmin/workforce/tests/browser.test.mjs \
  apps/directadmin/workforce/tests/sdk-contract.integration.mjs
```

The package candidate was also built with this SDK bundle. The archive contains
19 files, its manifest version is `0.1.6`, and its SHA256 is
`e3dcfac8a16dfb4d2d30c53d10aaf8523c6fecdffae761b9d27debd1555aa201`.
The sidecar checksum and extracted package/staging preflight passed. This is
package contract evidence; it does not replace installation and recovery tests
on an authorized DirectAdmin host.

## Results and boundaries

- Actual-owner integration: **8/8 passed**, including the parent test and
  seven nested scenarios. The post-commit cancellation scenario passes as a
  defect characterization: observed HTTP 403, `UNCERTAIN` evidence, committed
  assignee, one reassignment event, no accepted refs, and replay HTTP 503 with
  event count unchanged at one and per-operation evidence count unchanged at
  four.
- API, controller, browser and compiled shared-SDK contract suite:
  **39/39 passed**. `sdk-contract.integration.mjs` uses explicit controlled
  owner/bridge fixtures and is not a substitute for the actual-owner test.
- The exact #1252 and #1253 sources are separate open draft branches. This
  disposable test composition proves the consumer contract against those
  pinned older source commits; it does not establish a published `main`
  composition or live runtime certification. The currently published #1252
  head `31e57e11` requires the #302 one-time
  `DirectAdminSessionBridge.bootstrapBrowserSession` route, but the current
  #1253 head `b969acfe` does not include that bridge method. Rebase/reconcile the
  owner before claiming the latest SDK and owner are integrated together.
- Live identity provisioning, protected credential storage, commissioning,
  full #811 hosted runtime composition, DirectAdmin host installation, and the
  remaining #1050 acceptance scope are still outstanding. Keep #1050 open and
  this PR draft until those criteria are independently proved.

## Consumer bootstrap follow-up — 2026-10-03

This actual-owner SQLite run remains pinned to the source-compatible older
#1252/#1253 pair documented above; it was not rerun against the latest bootstrap
composition. The latest browser/consumer work and current-main extracted #811
read-only relay results are recorded in
[WORKFORCE-COCKPIT-INTEGRATION.md](WORKFORCE-COCKPIT-INTEGRATION.md). Those
current-main tests cover delayed nonce/bootstrap invalidation, company switching,
revocation, expiry, denial and empty controls. They do not turn this older owner
pin into proof of the latest SQLite owner, production identity provisioning, a
positive governed action, or a live DirectAdmin install.
