# Titan Channels\n\nDirectAdmin transport/provider cockpit for company-scoped endpoint projections.\nIt consumes canonical provider/connector owners through the authenticated\n`titan_channels` projection and submits only governed connection-test intents.\nIt never stores credentials, creates a provider registry, or grants authority.\n\nThe UI is deliberately safe: refresh the validated projection and inspect
health/topology. Provider sends, connection tests, and credential entry are
out of scope for this package.
