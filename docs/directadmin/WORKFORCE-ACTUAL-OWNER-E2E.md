# Workforce consumer to hosted-owner integration — #1050

This evidence records a bounded consumer integration against exact source
commits. The former #1253 and #1252 PRs have since merged; this test updates its
pins to the committed cancellation classification and SDK control-signal
forwarding. It does not certify the full hosted runtime or complete #1050.

## Pinned source and artifact

| Component | Source |
|---|---|
| Workforce cockpit and package source, #1260 / `agent/issue-1050` | `de61ce6362e308cf4eee9d10dabcac1bcae83610` |
| Workforce SQLite owner, #1253 / `agent/issue-640` | `b969acfe6758b26c4ea78c8b3309e8caad9f297d` |
| Extracted owner source tree digest (sorted path, type, content; dependencies excluded) | `de67bb229fd3300bca95c66867516fadf3025d23aa33d27c02119becdf4551e2` |
| Shared DirectAdmin SDK and gateway, #1252 / `agent/issue-1049` | `31e57e11e9f1bbeccf6c527229a4ba018768b9f0` |
| Compiled, minified SDK bundle used by the test | SHA256 `f1c46346e5ee755c663d22c26a5bb61f8659c366ba3fb15b02723134a15e544e` |

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
DirectAdmin host, modify security settings, or deploy a server. For the
post-commit cancellation case, the owner preserves the committed mutation and
event, records `UNCERTAIN` with `final_outcome: null`, adds no accepted evidence,
and returns HTTP 503. The consumer clears potentially stale company data and
reports that the outcome is unknown. Replaying the same operation returns 503
and adds no event or evidence. These assertions distinguish a known authority
denial from a committed operation whose result still needs recovery.

## Reproduction

Run from a checkout with the repository's Node dependencies installed and Node
22.23.3. The source commits are immutable pins; the PRs may be merged or their
heads may later advance.

```sh
owner_head=b969acfe6758b26c4ea78c8b3309e8caad9f297d
sdk_head=31e57e11e9f1bbeccf6c527229a4ba018768b9f0
consumer_head=de61ce6362e308cf4eee9d10dabcac1bcae83610
git cat-file -e "$owner_head^{commit}"
git cat-file -e "$sdk_head^{commit}"
git cat-file -e "$consumer_head^{commit}"

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
  f1c46346e5ee755c663d22c26a5bb61f8659c366ba3fb15b02723134a15e544e
node "$consumer_root/apps/directadmin/workforce/tools/package.mjs" \
  --source-dir "$consumer_root/apps/directadmin/workforce" \
  --sdk-module "$sdk_module" --output-dir "$work_area/package-build"
test "$(sha256sum "$work_area/package-build/titan_workforce.tar.gz" | cut -d' ' -f1)" = \
  289d749f1bfc77637afb1002c76b6baf3702a8176af17f84358b2fddfde989a3
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
19 files, its manifest version is `0.1.5`, and its SHA256 is
`289d749f1bfc77637afb1002c76b6baf3702a8176af17f84358b2fddfde989a3`.
The sidecar checksum and extracted package/staging preflight passed. This is
package contract evidence; it does not replace installation and recovery tests
on an authorized DirectAdmin host.

## Results and boundaries

- Actual-owner integration: pending exact-pin rerun after the consumer
  expectation update. The owner, SDK and package digest checks pass, then local
  execution stops before fixtures because the Node 22 `better-sqlite3` native
  binding is absent from this workspace.
- API, controller and compiled shared-SDK contract suite:
  **31/31 non-browser tests passed** with the updated SDK, including the
  sanitized denial/unknown-outcome distinction. The two browser cases were not
  run because the Playwright Chromium executable is absent.
  `sdk-contract.integration.mjs` uses explicit controlled owner/bridge
  fixtures and is not a substitute for the actual-owner test.
- Source-tree hashes and the compiled SDK/package digests were regenerated for
  the exact owner and SDK commits. This disposable test composition does not
  establish live runtime certification.
- Live identity provisioning, protected credential storage, #812's
  authenticated cookie-proof transport, commissioned company mappings,
  DirectAdmin host installation, and the remaining #1050/#811 acceptance
  scope are still outstanding. Keep both issues open until those criteria are
  independently proved.
