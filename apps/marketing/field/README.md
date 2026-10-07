# Titan Zero Field marketing site

This is a standalone static marketing surface based on the supplied Field v33 site. It is separate from `apps/web` (the operational application) and `apps/marketing/nexjob` (the shared Titan Zero cleaning product hub).

## Review state

- This package is a **noindex review build**. All HTML routes and HTTP responses carry `noindex`; there is no XML sitemap, and `/sitemap.xml` returns HTTP 410.
- Join and Login actions lead to the Contact page's access-status notice. The shared application routes are not verified here, so this package does not imply account availability.
- The intended host in the supplied source is `field.titanzero.io`. DNS, TLS, host routing and production installation have not been verified or changed.
- Marketing content and pricing are carried forward from the supplied v33 source. This package does not certify runtime capability, release status, legal/compliance claims or checkout terms.

## Routes

`/`, `/features`, `/workforce`, `/pricing`, `/titan-go`, `/standards`, `/trades`, `/trades/handyman-property-maintenance`, `/trades/carpentry-joinery`, `/trades/painting-decorating`, `/trades/plastering-repairs`, `/trades/tiling-surface-work`, `/trades/pressure-exterior-cleaning`, `/trades/rental-strata-maintenance`, `/trades/equipment-appliance-repair`, `/suite`, `/integrations`, `/security`, `/onboarding`, `/faq`, `/sovereign`, `/contact`, `/why-field`, `/about`.

## Run and check

No third-party dependency installation is needed.

```sh
npm run check
npm run dev
npm run build
```

`npm run dev` serves the clean routes locally through the built-in Node HTTP server. `npm run build` writes a deployable static tree to `dist/`. Production route rewrites and security headers are provided in `.htaccess`; an equivalent host configuration is needed on non-Apache servers.

## Source layout

- `index.html` and `assets/trades.js` provide the homepage and client-side navigation/rendering.
- `_pages/` contains crawlable route snapshots for direct loads and refresh.
- `assets/` contains site styles and the supplied visual assets.
- `WORKFORCE-ROSTER.md` documents the marketing roster only; it is not runtime authority or capability data.

