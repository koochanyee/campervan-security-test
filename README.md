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


## Integrated collaboration foundation (Phase 2B)

This checkpoint extends the additive D1 design. It keeps the existing South Island workbook, the `TRIP EXPENSES` A:P schema, the `FINAL EXPENSES` planning tab, Google OAuth refresh tokens in KV, and the `m3-google-auth` deployment branch unchanged.

### D1 migrations

Apply both migrations in order:

```bash
npx wrangler d1 migrations apply campervan-trip-companion-db --remote
```

- `0001_identity_trip_membership.sql`: users, trips and role-based membership.
- `0002_trip_collaboration.sql`: invitations, guest requests, per-upload ACLs, group/private chat, media metadata and audit-log structure.

On first verified sign-in with D1 enabled, `koochanyee@gmail.com` (Ralph) is created as the initial **Admin** of `nz-south-island`. No role is assigned implicitly to June or other approved emails. Ralph can invite a user as Admin, Editor or Viewer from the Members screen. Pending email invitations activate when that same verified Google email signs in. The last active Admin cannot be removed or demoted.

With D1 active, trip access is checked against active trip membership. Viewers can read trip content; write operations for expenses, expense settings, checklist, memories, itinerary location changes and highlight photos require Admin or Editor. Members can use group chat and private messages.

### Collaboration APIs and UI

- `/api/profile`: read/update profile fields; verified Google email and Google subject are server-controlled.
- `/api/trip-members`: list, invite/update role, and remove members (Admin only for changes).
- `/api/chat`: group messages by default; a recipient makes the message private to that member pair.
- `/api/guest-requests`: public request submission; Admin approval/rejection/revocation.
- `/api/upload-permissions`: uploader-controlled approve/revoke per memory/document upload.
- `/api/media`: R2 upload, list, retrieve and delete endpoints, protected by uploader ACLs.

The Members screen now includes profile editing, member invitations, guest-request review, upload-permission review and group/private chat. The Documents and Memories views expose a request-access action for protected legacy items. A guest must sign in with the same verified Google email after approval. Guest sessions are restricted server-side to the approved trip's GET itinerary endpoint; the trip Admin must also share the underlying Google Sheet with the guest, and the guest must connect their own Google Sheets OAuth account. Guest approval expires after 30 days and revocation is checked on every request.

Legacy Google Sheets memories are attributed to the `author_email` in `TRIP_MEMORIES`; each memory is hidden until its uploader approves access. Legacy links in the `Link` tab do not contain uploader metadata, so this checkpoint treats them as trip-creator-owned and requires that creator's approval. This does not silently grant a new member access to another member's private memory/document.

### D1 and R2 Cloudflare resources

The code does not invent resource IDs or add placeholder bindings. Create the resources in the intended Cloudflare account/environment:

```bash
npx wrangler d1 create campervan-trip-companion-db
npx wrangler r2 bucket create campervan-trip-companion-media
```

Then add the returned D1 database ID and R2 bucket name to the correct deployment/preview bindings in `wrangler.jsonc` (or the Cloudflare dashboard):

```jsonc
{
  "d1_databases": [
    { "binding": "APP_DB", "database_name": "campervan-trip-companion-db", "database_id": "<ID RETURNED BY WRANGLER>" }
  ],
  "r2_buckets": [
    { "binding": "MEDIA_BUCKET", "bucket_name": "campervan-trip-companion-media" }
  ]
}
```

Apply both migrations remotely only after the D1 binding points to the intended database. Configure both bindings for the same preview environment that contains the existing `OAUTH_TOKEN_STORE`. Do not overwrite existing KV IDs or OAuth/session secrets.

### Deliberate limits of this checkpoint

- Existing memories/documents remain in Google Sheets/Drive; they are not bulk-migrated to R2. The R2 endpoint is ready for new app-managed uploads but the existing memory photo picker/document links are not yet switched to R2.
- Guest access is itinerary-only; guest spreadsheet sharing and the guest's own Sheets OAuth connection are required.
- The existing Add Trip workflow still registers an existing Google Sheet. Automatic spreadsheet/Drive-folder provisioning, full itinerary day/activity CRUD, and guest invitation email delivery are not implemented in this checkpoint.
- Chat is stored in D1 and refreshes when the collaboration view is loaded or a message is sent; realtime WebSocket delivery, attachments and read receipts are not wired into the UI.
- The audit-log table is created but not yet populated by every mutation.
- Cloudflare D1/R2 resources are not created or bound by this ZIP, and no deployment is performed.

### Verification status

- TypeScript syntax transpilation: checked for `worker/index.ts` and `src/App.tsx`.
- SQL migration execution: checked locally against SQLite for migrations 0001 and 0002.
- Full npm build / semantic project type-check: not verified because project dependencies are not installed in this runtime.
- Live Google Sheets, D1, R2, OAuth, browser and multi-user permission tests: not performed.
- Cloudflare deployment: not performed.
