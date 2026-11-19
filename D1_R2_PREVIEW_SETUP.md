# Phase 1 + Phase 2A — D1/R2 preview setup

This package is based on the `m3-google-auth` source checkpoint and includes:
- Phase 1 expense settings implementation.
- Phase 2A identity/profile API and additive D1 migration `0001_identity_trip_membership.sql`.
- Preview-only D1 and R2 bindings in `wrangler.jsonc`, scoped under `previews`.
- Automatic frontend profile synchronization after Google sign-in/session restore.

## Important scope and safety notes

- Production-level settings in `wrangler.jsonc` remain unchanged. The feature branch now has its D1 and R2 resources under the `previews` block only.
- `wrangler.d1-r2.template.jsonc` remains a standalone reference template. Do not use it as the deployment config for this feature branch; it places bindings at the top level rather than under `previews`.
- Preview D1 binding: `APP_DB` → `campervan-trip-companion-feature-db` (`bec49875-e47a-4c7e-9f0a-a2c990147d6a`).
- Preview R2 binding: `MEDIA_BUCKET` → `campervan-trip-companion-feature-media`.
- D1 is used by the Phase 2A profile API when `APP_DB` is bound and migration 0001 has been applied. The frontend now calls `GET /api/profile` after Google sign-in or session restoration; failure to sync the profile does not block existing trip access.
- R2 is configured as the preview `MEDIA_BUCKET` binding, but this Phase 1 + 2A checkpoint does not yet implement media upload/download endpoints or use the bucket in application code. R2 is provisioned for a later media phase; this is not a claim that media storage is already functional.
- Existing Google Sheets tabs, `TRIP EXPENSES`, `FINAL EXPENSES`, and KV OAuth records are not migrated or modified by migration 0001.
- Do not change production resources or the existing `m3-google-auth` branch as part of this preview setup.

## Cloudflare resource setup

The preview resources have already been created and their IDs/names are configured in `wrangler.jsonc` under `previews`. Keep these bindings in the feature branch; do not move them to the top-level production configuration.

Create preview-only resources only if rebuilding this environment from scratch:

```bash
npx wrangler d1 create campervan-trip-companion-feature-db
npx wrangler r2 bucket create campervan-trip-companion-feature-media
```

For a rebuilt environment, update the matching preview bindings in `wrangler.jsonc` and keep them under `previews`; do not add preview resources to the top-level production bindings.

The D1 tables were applied manually in the Cloudflare D1 Console and verified there. Do not rerun migrations blindly. The current ZIP includes migration `0001_identity_trip_membership.sql`; it does not include the `0002_trip_collaboration.sql` file even though the database currently contains the seven collaboration tables. Reconcile the migration files and Wrangler migration history before using `wrangler d1 migrations apply` for future changes.

## Secrets and preview variables

Configure the required Google OAuth and session secrets for the preview Worker using Cloudflare secrets/settings. Do not put `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, or `TOKEN_ENCRYPTION_KEY` in this file or commit them to GitHub.

## Recommended Git workflow

Create the feature branch from `m3-google-auth`, then add the contents of this package to that branch. Do not merge or push these changes to `main` or the source branch. Keep the preview deployment isolated until the D1 migration and profile endpoint have been tested.

## Validation status

This ZIP updates the feature-branch Preview configuration and frontend profile-sync call. It does not deploy the Worker or change Cloudflare secrets. A live integration test remains to be done after the branch is committed and its Preview build succeeds.

## Profile synchronization added in this checkpoint

After `/api/auth/session` restores a valid session or `/api/auth/google` completes sign-in, the frontend calls `GET /api/profile`. The Worker derives `google_sub` and email from the signed session and upserts the user row. The frontend shows `Profile synced`, `Syncing profile…`, or `Profile sync unavailable`. This does not change Google Sheets trip data, the KV OAuth token store, or trip authorization.
