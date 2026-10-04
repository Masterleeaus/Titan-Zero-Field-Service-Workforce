# Titan Channels

DirectAdmin transport/provider cockpit for company-scoped endpoint projections.
It consumes canonical provider/connector owners through the authenticated
`titan_channels` projection and submits only governed connection-test intents.
It never stores credentials, creates a provider registry, or grants authority.

The UI is deliberately safe: refresh projection, inspect health/topology, and
request a synthetic connection test. Real provider sends and credential entry
are out of scope for this package.
