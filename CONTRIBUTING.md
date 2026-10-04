# Contributing

## Evidence first

Keep implementation claims aligned with what the repository can reproduce.

Use these labels precisely:

- **Implemented** — source is present and wired.
- **Tested** — relevant tests actually ran successfully.
- **Evaluated** — a reproducible dataset/metric/result exists.
- **Experimental** — implementation exists but verification is incomplete.
- **Planned** — no implementation claim is made.

## Before submitting changes

1. Read the root README and repository-specific docs.
2. Keep changes focused on one architectural or product boundary.
3. Run the repository-defined install, lint, test, build, and evaluation commands that apply.
4. Add or update tests for changed behavior.
5. Update documentation when capability, architecture, safety, or limitations change.
6. State exactly what was verified and what could not be verified.

High-impact changes involving authority, tenancy, payments, external side effects, secrets, AI tool execution, approvals, or persistent state should include negative, replay/idempotency, and failure-path coverage where applicable.

Preserve upstream attribution and component-specific license notices.
