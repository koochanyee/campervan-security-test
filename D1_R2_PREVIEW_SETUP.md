# Phase 1 + Phase 2A — D1/R2 preview setup

This package is based on the `m3-google-auth` source checkpoint and includes:
- Phase 1 expense settings implementation.
- Phase 2A identity/profile API and additive D1 migration `0001_identity_trip_membership.sql`.
- A separate Wrangler configuration template for preview D1 and R2 bindings.

## Important scope and safety notes

- The existing `wrangler.jsonc` is intentionally unchanged. It preserves the current Worker/KV/Google configuration.
- `wrangler.d1-r2.template.jsonc` is a **template**, not a ready-to-deploy config. Replace the D1 database name, D1 database ID, and R2 bucket name with resources created in your own Cloudflare account.
- Do not deploy the template until all placeholders have been replaced and the preview environment has been checked.
- D1 is used by the Phase 2A profile API when `APP_DB` is bound and migration 0001 has been applied.
- R2 is configured as the `MEDIA_BUCKET` binding in the template, but this Phase 1 + 2A checkpoint does not yet implement media upload/download endpoints or use the bucket in application code. R2 is provisioned for a later media phase; this is not a claim that media storage is already functional.
- Existing Google Sheets tabs, `TRIP EXPENSES`, `FINAL EXPENSES`, and KV OAuth records are not migrated or modified by migration 0001.
- Do not change production resources or the existing `m3-google-auth` branch as part of this preview setup.

## Cloudflare resource setup

Create preview-only resources in the intended Cloudflare account:

```bash
npx wrangler d1 create campervan-trip-companion-feature-db
npx wrangler r2 bucket create campervan-trip-companion-feature-media
```

Copy the returned D1 database ID into `wrangler.d1-r2.template.jsonc`. Set the matching D1 database name and R2 bucket name. Keep the existing OAuth KV namespace binding as-is for this preview only if that is the intended preview namespace.

Apply the migration to the new D1 database:

```bash
npx wrangler d1 migrations apply campervan-trip-companion-feature-db --remote --config wrangler.d1-r2.template.jsonc
```

Before using this command, confirm that the template points to the newly created preview database and not any production database.

## Secrets and preview variables

Configure the required Google OAuth and session secrets for the preview Worker using Cloudflare secrets/settings. Do not put `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, or `TOKEN_ENCRYPTION_KEY` in this file or commit them to GitHub.

## Recommended Git workflow

Create the feature branch from `m3-google-auth`, then add the contents of this package to that branch. Do not merge or push these changes to `main` or the source branch. Keep the preview deployment isolated until the D1 migration and profile endpoint have been tested.

## Validation status

This ZIP packages the source checkpoint and migration/configuration template. It does not create Cloudflare resources, apply the migration remotely, or deploy the Worker. A full live Cloudflare integration test remains to be done after the account-specific IDs and secrets are configured.
