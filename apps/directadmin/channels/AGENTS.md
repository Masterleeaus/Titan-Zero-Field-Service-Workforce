# Channels plugin contract

- Preserve `company_id` isolation and use the shared DirectAdmin session bridge.
- Credential fields are references only; never render or log secret material.
- Do not add communications, commerce, authority, evidence, or provider-store logic.
- Role entrypoints are executable CGI-compatible Node scripts and must remain thin.
