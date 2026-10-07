# Titan Zero Marketing Network

This repository contains separate marketing surfaces with explicit host boundaries. The initial `.io` product launch is Titan Zero Cleaning SaaS. The full vertical catalogue stays internal until each later vertical has release evidence and an approved launch.

## Host plan

| Surface | Host / route | Source / owner | Current state |
|---|---|---|---|
| Cleaning product hub | `titanzero.io` | `marketing/nexjob` | Cleaning-first noindex review build; production publication is not authorized by this source change. |
| Cleaning vertical context | `cleaning.titanzero.io` | Shared `marketing/nexjob` build | Only public vertical host in this launch; DNS, host routing and runtime release remain unverified. |
| Field marketing review | `field.titanzero.io` (intended) | `marketing/field` (issue #1460) | Separate Field v33 static review build; noindex, access actions routed to status notice; host/DNS/TLS/deployment unverified. |
| Managed service | `titanzero.io/fully-managed` | Shared Titan Zero marketing source | Retained as an internal page on the `.io` product site. |
| Cleaning franchise site | `titanzero.pro` | Separate future host/content owner | Planned destination; not rendered by `marketing/nexjob` and not a managed-service site. |
| Canonical business application | `app.titanzero.io` | `apps/web` and its active owners | One shared application/backend. Marketing account actions remain disabled until the app workflow is confirmed. |
| Dedicated PWA | `pwa.titanzero.io` | `apps/pwa`, issue #1171 / PR #1176 owner | Separate Zero/Go/Hub shell; its release readiness belongs to its owner. |
| Future vertical contexts | Hostnames derived from the internal catalogue | Shared `marketing/nexjob` build | Not routed or linked for this launch. |

Hostnames and links in source are planning values, not configured DNS or proof of service availability.

## Source selection

- `marketing/nexjob` is the shared Titan Zero Cleaning marketing source and host-aware build.
- `marketing/field` (issue #1460) is a separate static Field marketing review app based on the user-provided v33 source. It does not modify the `.io` cleaning host or Field runtime.
- The internal catalogue in `marketing/nexjob/src/data/verticalCatalogue.js` retains all 20 profiles. The public host registry exposes Cleaning only for this launch.
- `marketing/tradepilot` remains a layout donor. Its claims, synthetic metrics, forms, external links and unresolved media are not reused.
- The legacy Personal Services donor is excluded from the `.io` launch and is not the `.pro` franchise source.
- `marketing/fieldops` remains retired from the public preview. Its source/history is retained for provenance.
- `marketing/fieldcrew` and other legacy donor pages are not part of this host plan.

## Shared-site boundaries

- Marketing websites remain separate from `apps/web` and never become runtime dependencies.
- All marketing login links target the canonical app host. Do not place bearer credentials in a URL or share cookies indiscriminately between domains.
- Cleaning copy reflects a substantial source model and dedicated tests, while keeping production runtime, company installation, authentication, channel and package release states explicit.
- “Works Everywhere” groups the mobile app, PWA, Chrome extension, WordPress plugin, ChatGPT integration, WhatsApp, Telegram and Facebook Messenger. A source project or roadmap item is not described as an installable or live integration.
- Review builds remain `noindex`. DNS/TLS, host routing, app access, channel providers, package publication and the release plan require separate verification before launch.
