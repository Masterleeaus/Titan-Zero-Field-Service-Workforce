# Titan Channels

DirectAdmin transport/provider cockpit for company-scoped endpoint projections.
It consumes canonical provider/connector owners through the authenticated
`titan_channels` projection.
It never stores credentials, creates a provider registry, or grants authority.

The UI is deliberately safe: refresh the validated projection and inspect
health/topology. Provider sends, connection tests, and credential entry are
out of scope for this package.
