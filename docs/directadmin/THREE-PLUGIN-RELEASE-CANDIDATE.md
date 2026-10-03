# Cleaning-first DirectAdmin three-plugin package candidate

**Status:** reproducible local package candidate; not approved for host installation or production release. This is a partial integration record for [#1157](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/issues/1157). The mission remains open.

The launch candidate contains Server Node, Developer Portal, and Workforce, with the existing cleaning bundle recorded as a separate payload input. This record pins the exact source and archive identities, the package dependency, and the checks run. A successful package build does not certify DirectAdmin Manager lifecycle, live identity, cookie isolation, or production execution.

## Pinned inputs and artifacts

| Plugin or payload | Exact source pin | Version | Reproducible portfolio archive SHA-256 |
|---|---|---:|---|
| Server Node | Main commit ee3e61da77debe8d898cefe3b01139c6cec02e0c; source tree ffb2ce077426dfd5400f37ebdba858d989b9db0c | 0.3.0 | 580676074d64c431f9d635908f1f71f05aae110b6882f8ace3c2aea0c06f975d |
| Developer Portal | PR #1391 source 10f5ee96626663abea770132de6397063b5b688c; source tree 832582c602d372d544566f87456f616134848029 | 1.3.10 | 8783a6af31a152be4f18d089db465bfc447d595f10929cffbb59db16f4ad73af |
| Workforce | Current PR #1405 head 097d3eaf480331c78443e89f4f57257b01d5c98c; 26 allowlisted package files | 0.1.6 | 100ecd5c58d6de7f0cfb02636d58440ae05751293047d5cdce6bd61bcf556b26 |

The user-specified #1405 assembled input f1c535d5 has the same Workforce package archive SHA. The PR later advanced to 097d3eaf with updates to the packaged-session integration test and its verification document; the 26 files included in the archive did not change. The 0.1.6 archive rebuilt from current head 097d3eaf is byte-identical to the pinned input.

The Developer Portal 1.3.10 archive published in Library is SHA-256 90261a3dd1d3bc05fa0425466b15b394d936523abfe1f8499d255d62c1f41c27. The table’s 8783a6af… hash is a deterministic portfolio repack of the same pinned source using the portfolio packager. These are distinct archive bytes; verify and use the digest for the exact artifact being installed. Publication completion and hosted PHP/package review are recorded in [PR #1391](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/pull/1391).

The Workforce package embeds the shared SDK built from source blob c4c59c35019716718472f7b9eb01683b8d527852, SHA-256 c4a45025347733e2d4a0735dc6b68c9e6335484da1b54967582bb0e34d561489. It uses esbuild 0.28.1 with --bundle --format=esm --platform=browser --target=es2022; the compiled SDK SHA-256 is 7c08d37f6ea274760f8e52092b2e86a07a93ae175fe4a6216df9156d1fc39681. The generated provenance records the compiled module digest. The source and compiler details are recorded here alongside it.

Workforce declares Server Node as a package dependency. The generated provenance pins that dependency to Server Node 0.3.0 archive SHA-256 580676074d64c431f9d635908f1f71f05aae110b6882f8ace3c2aea0c06f975d.

The adjacent cleaning payload is packages/modules/bundles/cleaning-workforce.bundle.json, main blob 9dd77474f7d94333cb3e691bf7ab9658b77b8a40, SHA-256 fede4f9188cef2423d035ab1681d014222da70298dd49b25d9fce6ad708f65b1. It contains the existing 16 specialists and seven canonical cleaning job types. It is payload-only: Workforce does not yet consume or render it, and #1057’s company-bound pack lifecycle is not wired into this candidate. It does not activate company configuration, supply company pricing, create work orders, or prove those profiles run in the plugin.

## Reproducible package build

The existing scripts/package-directadmin-portfolio.mjs packager built the three archives in dependency order. The build used Server Node from main, Developer Portal from exact PR #1391 source, Workforce from current PR #1405 head 097d3eaf, and the SDK module compiled from that Workforce source. Two independent builds produced byte-identical archives and provenance at:

- /tmp/titan-1157-rebuild/portfolio-current-a
- /tmp/titan-1157-rebuild/portfolio-current-b

All three archive checksum sidecars passed sha256sum --check. The portfolio packager validated each flat archive, required files, executable modes, dependency ordering, and immutable output behavior. The exact Workforce package builder reported 26 files and produced the supplied PR #1405 archive digest. Server Node’s canonical validator reported valid.

## Verification evidence

Local checks used Node v24.19.0 and esbuild 0.28.1.

- node --test scripts/package-directadmin-portfolio.test.mjs apps/directadmin/workforce/tests/package.test.mjs on current PR #1405 head 097d3eaf: **16/16 passed**.
- Canonical SDK archive, authority-neutral contribution, child-context/CAS/evidence/typed-denial/scope-denial tests with the exact compiled SDK: **3/3 passed**.
- node scripts/validate-directadmin-plugin.mjs apps/directadmin/server-node: **valid**.
- Two complete portfolio builds: all three archives and provenance byte-identical; all archive checksum sidecars verified.
- npm --prefix apps/browser run source-manifest: generated 1,065 entries. node apps/browser/tools/verify-browser-node.mjs passed 425/425 regressions, 763/763 active JavaScript syntax checks, and all manifest/security checks. The regenerated manifest and Browser Node console test match current main; the superseded browser assertions from the old #1388 head were not retained.
- git diff --check passed after conflict resolution.

Hosted checks on current #1405 head 097d3eaf include [DirectAdmin plugin portfolio run 37111202944](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/actions/runs/37111202944) and [Canonical Workforce Verification run 37111250669](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/actions/runs/37111250669); both completed successfully. The 26-file archive source is the same as the user-specified f1c535d5 input.

The RAW routes packaged by #1405 came from #1395 head 914c0e1b, whose [DirectAdmin plugin portfolio run 37099971650](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/actions/runs/37099971650) and [Canonical Workforce Verification run 37099971659](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/actions/runs/37099971659) passed. The standalone #1395 branch has since advanced to dae48b321e419b295ac3adbde591c1415d75b0b9; the change since 914c0e1b is confined to the bootstrap-session-chain integration test. Its latest [DirectAdmin plugin portfolio run 37110816901](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/actions/runs/37110816901) and [Canonical Workforce Verification run 37110816894](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/actions/runs/37110816894) passed. These checks exercise package contracts and controlled RAW/session fixtures; they are not live DirectAdmin tests.

The separate nested-import browser fixture change remains in [PR #1406](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/pull/1406), its existing owner. It is not copied into #1388.

## Installation and release blockers

- Server Node 0.3.0 remains marked experimental. Its production RAW relay is disabled and returns 503 before forwarding. The combined candidate is therefore not a working production Workforce session path.
- The previous sandbox-limited host report observed /usr/bin/node v16.20.2, below the combined Node 22 requirement. Current host runtime and DirectAdmin-selected PHP CLI are unverified; no live host status was checked for this candidate.
- No authorized disposable DirectAdmin host was available for Manager install, update, rollback, uninstall, actual CGI role routes, Apache cookie isolation, or reboot/recovery checks.
- The hosted RAW/session and browser tests use controlled fixtures. They do not prove production identity or authority, a live nonce store, or a commissioned DirectAdmin-to-Workforce session path.
- Workforce still requires the canonical #1300/#1049 composition and a production protected dependency module. Do not forward generic DirectAdmin cookies or enable a relay through configuration to bypass this requirement.
- The cleaning bundle still lacks the #1057 company-bound install/configure/upgrade lifecycle and #1050 native consumer integration.
- Developer Portal Library publication is complete, but live DirectAdmin upgrade/rollback and workstation SSH acceptance remain unverified.

No server, plugin, service, firewall, database, DNS, credential, or site was changed. Do not install this candidate until the code and host blockers are resolved and the exact archives are verified on an authorized disposable panel. Keep #1157 open; this evidence is partial and non-closing.
