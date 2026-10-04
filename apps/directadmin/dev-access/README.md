# Developer Portal for DirectAdmin

The DirectAdmin **Developer Portal** is private/operator tooling for diagnosing and safely inspecting a Titan Business Node. The installed machine/plugin ID remains `titan_dev_access` for compatibility.

Current implemented slice:

- Evolution-aware light/dark UI.
- Runtime diagnostics for SSH, PHP, Composer, Node/npm/pnpm and curl. Git remains reported as unavailable until an immutable repository-configuration execution design is implemented and independently verified.
- Automatic Git workflow readiness is intentionally unknown/null; it does not claim branch, dirty-state, upstream, or repository health. No repository-configured Git command runs in the restricted terminal or readiness path.
- SSH public-key add, fingerprint and revoke. Installed keys are rendered by fingerprint only. Public-key identity is deduplicated by key material despite options and arbitrary free-form comments; blank/comment-only records are ignored as authorizations and preserved during updates. Writes use an account-owned lock and checked atomic replacement. Revoke forms bind their displayed fingerprint and row; stale/reordered rows fail closed, and revoking a current key removes every matching active key-material line.
- HOME-scoped working-directory validation using canonical `realpath` boundaries, followed by a directory device/inode check and a process-cwd pin before child start.
- Fail-closed command classification for READ, VERIFY, WRITE and UNKNOWN operations. Build/test and package-manager scripts are blocked in the account terminal because they execute project code with the DirectAdmin account's HOME access.
- Pathless read/verify terminal allowlist only. No user-entered file or directory operand is accepted: direct file/directory inspection and PHP lint are disabled because a separate path check followed by a child open permits same-account pathname replacement. The child inherits an already pinned and rechecked HOME-contained working directory. Shell chaining, redirection, Git mutation, build/test scripts, package installation, destructive and privileged commands are rejected.
- The previous exact Git read allowlist is retained only as review documentation; all Git terminal commands are currently blocked before child execution. Repository configuration can be replaced after inspection, so per-filter enumeration is not treated as a security boundary.
- Git worktree metadata is still path-checked for diagnostics, but no Git child is started and no repository health is claimed. Command output never exposes repository configuration or URL userinfo.
- 30-second command timeout and a true 512 KiB streaming output ceiling that terminates over-limit processes.
- Copyable diagnostics with token/password/cookie/private-key redaction.
- DirectAdmin CLI request handling for bounded raw POST bodies from the `POST` environment value or stdin selected by `pipe_post=yes`; exploded per-field environment values fail closed. The parser rejects duplicate/array/malformed input and uses the installed `csrf` field name.
- Effective-user-bound HOME validation for DirectAdmin CLI requests, including account-scoped CSRF tokens.
- PHP 7.4.0 minimum from the production argv-form `proc_open` call; the no-setup hosted PHP workflow currently verifies PHP 8.3.6, and the DirectAdmin-selected CLI version still needs host confirmation.
- Guided workstation SSH setup displays the validated DirectAdmin Unix username, a validated configured host or panel-server-name fallback, and a configured port or default 22. The browser can build either the direct `ssh -p PORT USER@HOST` command or `ssh ALIAS` for a saved workstation alias; this lets the user's OpenSSH config select a non-default `IdentityFile` and `IdentitiesOnly` policy. These values remain client-side and are not submitted. Admins see installed public-key fingerprints and a CSRF-protected public-key-only install form; reseller/user views remain read-only. A local-only one-line diagnostic distinguishes Windows key-file access/missing-file errors before server authentication from server `Permission denied (publickey)`; guidance says the expected key may not have been selected. DNS, timeout, refusal and host-key trust errors also have bounded guidance. It never reads a private key or submits diagnostic text.
- Read-only canonical Server Node health projection from the fixed loopback `/v1/status` endpoint; malformed, oversized or unavailable responses fail closed.
- No private-key storage and no automatic sudo/root elevation.

Version 1.3.12 is a review candidate for a pathless terminal allowlist, verified working-directory pinning, and a fixed trusted command PATH, alongside the saved SSH alias and fingerprint-bound key lifecycle. It parses only key options, algorithm and blob; comments remain free-form, and comment-only records do not count as active keys. It does not initiate SSH, read workstation files, mutate Windows ACLs, add privileged commands, or migrate persisted data. Versions 1.3.10 and 1.3.11 are superseded and unsafe to install: v1.3.10 could expose private-key body lines through filtered file reads, and review of v1.3.11 found a same-account path-check/open race in child utilities. No real key was read. The v1.3.12 exact-head PHP/package/archive checks and independent source review must pass before publication; it has not been installed. Compatibility from installed v1.3.6 to this candidate has not been verified. Preserve the v1.3.6 archive until disposable-host update/rollback checks pass.

The configured endpoint environment names are `TITAN_DEV_ACCESS_SSH_HOST` and `TITAN_DEV_ACCESS_SSH_PORT`; supply them only through the host's approved DirectAdmin PHP process configuration. The portal never accepts these values from POST. Hosts must be DNS names or IPv4 addresses, and ports must be decimal values from 1 to 65535. Without a configured host it uses `SERVER_NAME`; without a configured port it uses 22. The user may edit the visible endpoint in their browser to build a local command. Confirm the SSH endpoint with the server administrator.

Installed v1.3.6 carries the bounded DirectAdmin request bridge with exact terminal LF/CRLF normalization and a narrow stdin-only framing compatibility: one terminal raw NUL is removed only when CONTENT_LENGTH is absent or declares the preceding form bytes. It is not removed from environment POST transport, when included in CONTENT_LENGTH, or when repeated/interior; percent-encoded NUL and invalid UTF-8 continue to fail strict value validation. Rejection diagnostics may show only fixed terminal-byte class and byte counts, never form values or body bytes. This behavior reproduces the observed +1-byte stdin shape but remains an inference until the parent verifies it through the installed DirectAdmin form. The parser retains exact CSRF/action/role checks, strict duplicate/array/malformed validation and the existing command policy. PHP integration/security tests run the packaged role executables and use disposable account/repository fixtures only. The user's live smoke on 2026-10-02 passed actual same-page pwd and id forms on installed v1.3.6 only; it does not isolate terminal-NUL causality or certify other forms or roles. Update, uninstall, and rollback behavior remains unverified.

The previously Library-published v1.3.3 archive (SHA-256 `6145b02a9fc0626f31bf7350f881419cf5cfe41036879b724e5abf4c38addbbc`) is **not a safe current candidate**: independent synthetic probes found malformed or multiline SSH key payloads were accepted and Git remote commands were not actually read-only. Keep that historical artifact intact for audit, but do not install it or treat it as a rollback.

The committed v1.3.2 archive (SHA-256 `22b54eabaf2a12a5bba04c9b21d58f798f93b7c1a6845362035edf574c488755`) is historical and checksum-verified. It is not an operational rollback. v1.3.1 is also retained only as an artifact reference. No existing archive has been verified as a working rollback for the previously installed 1.1.3 or observed live 1.3.6 plugin. The retained v1.3.5 archive remains unchanged as a historical package candidate; its hash is recorded on issue #1048. v1.3.7's exact-head candidate hash and PHP gate are recorded on issue #1048. The v1.3.8 review archive (SHA-256 `6e4a1b1de656a494bd193e6b16ff88d707f421581703bd953aa8ccecd015b1dd`) is superseded because its direct SSH command ignored a saved alias's non-default `IdentityFile`; it was not installed. The v1.3.9 review archive (SHA-256 `7842ae6a4d9e9cbd901b2ef25371bbc19837eb7d3d629771ece6ce2529ea2bce`) is superseded because its key parser interpreted free-form comments and its revoke action trusted a mutable row index; it was not installed. The v1.3.10 archive (SHA-256 `90261a3dd1d3bc05fa0425466b15b394d936523abfe1f8499d255d62c1f41c27`) is superseded because terminal commands could expose synthetic or real private-key body lines through relative `.ssh` paths; it must not be installed. The v1.3.11 candidate is superseded because its child file readers reopened validated pathnames and a concurrent same-account rename/symlink swap could change the object opened; it must not be installed. A v1.3.12 archive must be generated from the exact tested head, accompanied by version/hash provenance, and independently reviewed before publication. Live DirectAdmin update, install, remove/reinstall, and rollback behavior still require a matching disposable-host check.

This plugin does **not** grant Titan business authority. Mutating or privileged repair work belongs to canonical governed execution and deployment/runtime owners.

## DirectAdmin install artifact

The install archive **must** be named exactly:

`titan_dev_access.tar.gz`

Do not add version, `-fresh`, `-rebuilt`, or other suffixes to the install filename.

Build and run the security/package verification with:

```bash
bash tools/package.sh
```

The resulting archive is written to `dist/titan_dev_access.tar.gz`.

See `AGENTS.md` for the server-validated DirectAdmin packaging, routing and live-host verification rules.
