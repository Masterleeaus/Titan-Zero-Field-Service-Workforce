# Security Policy

## Reporting

Please report security vulnerabilities privately through GitHub Security Advisories / Private Vulnerability Reporting when available. Do not publish exploitable details, real credentials, customer data, or destructive proof-of-concept material in a public issue.

Include the affected component, impact, reproduction conditions, and a minimal non-destructive proof.

## Security expectations

Changes involving authentication, authorization, tenant/company isolation, secrets, external providers, webhooks, payments, files, AI/tool actions, approvals, or persistent state should include targeted negative and boundary tests.

Never commit production credentials, API keys, OAuth secrets, database passwords, private certificates, real session tokens, or customer exports.

## Verification boundary

Security claims must follow repository evidence. Source-level controls, focused tests, evaluations, and production certification are different evidence levels.

## Responsible disclosure

Good-faith testing should use synthetic/test data, avoid service disruption, minimize access to data not owned by the researcher, and allow reasonable time for remediation before public disclosure.
