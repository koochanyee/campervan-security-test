# Campervan Trip Companion

A React, TypeScript and Cloudflare Worker application for managing trip itineraries, expenses, checklists, memories, maps and documents.

## Requirements

- Node.js compatible with the project toolchain
- npm
- Cloudflare account and Wrangler authentication for deployment
- Google OAuth and Google Sheets/Drive configuration for connected trip features

## Local development

```bash
npm ci
npm run dev
```

## Build

```bash
npm run build
```

## Deployment

Review `wrangler.jsonc` and configure required secrets and bindings in the target Cloudflare environment before deploying. Do not commit OAuth client secrets, session secrets, or token-encryption keys.

```bash
npm run deploy
```

## Existing data compatibility

The current application continues to use its existing Google Sheets trip data and KV OAuth token store. New database and object-storage features must be introduced with explicit migrations and must not overwrite existing trip records.

## Expense settings added in this build

The expense module now creates a per-trip `TRIP EXPENSE SETTINGS` tab on first use. It stores:

- Active/inactive expense categories and their display colours.
- One configurable initial shared-cash record (pre-trip exchange cash).
- Additional shared-cash contributions, including contributor, date, currency and notes.

Cash expense entries continue to use the existing `TRIP EXPENSES` sheet and payment-method field. The cash balance is calculated per currency as initial cash plus contributions less recorded cash expenses. Card spending and the existing card settlement calculation remain separate. Existing `TRIP EXPENSES` columns are not changed.

The first version stores these settings in Google Sheets because the current deployment does not yet have D1 or R2 bindings. D1/R2-backed account, permission, chat and media features remain a separate implementation stage and require explicit Cloudflare resource setup and migrations.

## D1 identity and multi-trip foundation (Phase 2A)

This checkpoint adds the first additive D1 migration and a profile API. It does **not** switch existing trip authorization or trip data from KV/Google Sheets to D1.

### Migration 0001

`migrations/0001_identity_trip_membership.sql` creates:

- `users`: verified Google identity plus editable display name, preferred chat name, photo URL, contact phone and notification preferences.
- `trips`: the future D1 trip registry, including the existing spreadsheet/tab references.
- `trip_memberships`: trip-scoped `ADMIN`, `EDITOR` and `VIEWER` roles with active/suspended/removed states.

The migration is additive. It does not modify or import any existing Google Sheets tabs, the `TRIP EXPENSES` schema, `FINAL EXPENSES`, or the existing KV OAuth token records.

### Profile API

After D1 is created, bound as `APP_DB`, and migration 0001 is applied:

- `GET /api/profile` creates the signed-in user's profile on first access and returns it.
- `POST /api/profile` updates editable profile fields. The verified Google email and Google subject are taken from the server session and cannot be changed by the client.

Until `APP_DB` is configured, the endpoint returns HTTP 503 and the existing login/trip flows continue using their current storage. No D1 database ID or binding has been added to `wrangler.jsonc` in this checkpoint.

### Cloudflare setup (manual, before enabling D1)

1. Create a D1 database in the intended Cloudflare account/environment: `npx wrangler d1 create campervan-trip-companion-db`.
2. Add the returned database ID to `wrangler.jsonc` as a `d1_databases` binding named `APP_DB` (do not use a placeholder ID).
3. Apply the migration to the intended environment: `npx wrangler d1 migrations apply campervan-trip-companion-db --remote`.
4. Only after verifying the migration, deploy the Worker and test `GET /api/profile` while signed in.

Trip membership enforcement and backfilling the existing South Island trip are deliberately not activated yet. Existing users must not be assigned Admin/Editor/Viewer roles by guesswork, and existing access must not be cut over until the initial Admin/member mapping is confirmed and tested.


## Combined Phase 1 + Phase 2A package

This archive combines the Phase 1 expense settings checkpoint with Phase 2A identity/profile support. It includes `migrations/0001_identity_trip_membership.sql` and the optional `wrangler.d1-r2.template.jsonc` for preview D1/R2 resource bindings. See `D1_R2_PREVIEW_SETUP.md` before configuring or deploying. The R2 binding is provisioned as a foundation only; media upload/download functionality is not part of this checkpoint.
