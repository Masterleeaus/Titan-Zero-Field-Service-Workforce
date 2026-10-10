# DirectAdmin installer candidates — 2026-10-03

> **DO NOT INSTALL OR RUN Developer Portal 1.3.10.** Its archive is retained for audit only after a potential private-key disclosure path was found in its pinned source. No actual key was read. The warning and exact historical hash are in [`developer-portal/DO-NOT-INSTALL.txt`](developer-portal/DO-NOT-INSTALL.txt). Publish a replacement only after the source fix, role-executable negative regression, and independent review clear; retain the 1.3.10 archive and hash for audit.

This artifact-only bundle is published under **proprietary, all-rights-reserved** terms. It does not license the source repository, grant open-source reuse, or grant rights to Titan/Titan Zero names or marks. See each artifact's `LICENSE.txt` and generated `THIRD_PARTY_NOTICES.txt` before use. These are companion files outside the TARs so the validated archive bytes remain unchanged.

This branch contains all three exact Titan Server Node, Titan Workforce, and Developer Portal candidate archives. Each archive has companion license, component-notice, third-party-notice, checksum, source-manifest, and provenance records outside the TAR, preserving its verified hash. The repository-wide license decision remains unresolved.

| Plugin | Version | Archive | SHA-256 |
|---|---:|---|---|
| Titan Server Node | 0.3.0 | [`titan-server-node.tar.gz`](server-node/titan-server-node.tar.gz) | `580676074d64c431f9d635908f1f71f05aae110b6882f8ace3c2aea0c06f975d` |
| Titan Workforce | 0.1.6 | [`titan_workforce.tar.gz`](workforce/titan_workforce.tar.gz) | `100ecd5c58d6de7f0cfb02636d58440ae05751293047d5cdce6bd61bcf556b26` |
| Developer Portal **DO NOT INSTALL** | 1.3.10 | [`titan_dev_access.tar.gz`](developer-portal/titan_dev_access.tar.gz) | `90261a3dd1d3bc05fa0425466b15b394d936523abfe1f8499d255d62c1f41c27` |

Verify checksums and retain companion license/notices. Install Server Node before Workforce; Portal is independent. Server Node and Workforce require Node.js 22+; Server Node additionally requires systemd and `flock`. Portal requires PHP 7.4+.

## Review state

All three archives and companion records, including Developer Portal 1.3.10, are published here; the Portal archive is not awaiting publication. An earlier scoped review cleared source commit `10f5ee96626663abea770132de6397063b5b688c` in [PR #1391](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/pull/1391#issuecomment-5963160873), but a later independent review found a potential private-key disclosure path in that same source commit ([security finding](https://github.com/Masterleeaus/Titan-Zero-Field-Service-Workforce/pull/1438#issuecomment-5969796119)). Treat the Portal candidate as security-blocked: do not merge or install it until the source is repaired, a role-executable negative regression passes, and a replacement package is independently reviewed. Product-owner verification also remains outstanding. The Portal build-time provenance snapshot is preserved as historical evidence; aggregate [`provenance.json`](provenance.json) records the later finding separately from the earlier clearance. This security hold is separate from live DirectAdmin certification.

No live DirectAdmin Manager install, update, rollback, uninstall, CGI/cookie boundary, SSH flow, or reboot recovery was certified. Server Node's production RAW relay is disabled; Workforce's production session path is not commissioned. See [`INSTALLATION-NOTES.md`](INSTALLATION-NOTES.md) and [`provenance.json`](provenance.json).
