-- Identity and multi-trip foundation.
-- This migration is additive: it does not alter Google Sheets, KV OAuth tokens,
-- TRIP EXPENSES, FINAL EXPENSES, or existing itinerary tabs.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  google_sub TEXT PRIMARY KEY,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  preferred_chat_name TEXT NOT NULL DEFAULT '',
  photo_url TEXT NOT NULL DEFAULT '',
  contact_phone TEXT NOT NULL DEFAULT '',
  notification_preferences_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trips (
  trip_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  destination TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  end_date TEXT,
  spreadsheet_id TEXT NOT NULL,
  itinerary_tab TEXT NOT NULL DEFAULT 'FINAL ITINERARY',
  drive_folder_id TEXT NOT NULL DEFAULT '',
  created_by_google_sub TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'ARCHIVED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (created_by_google_sub) REFERENCES users(google_sub)
);

CREATE TABLE IF NOT EXISTS trip_memberships (
  trip_id TEXT NOT NULL,
  google_sub TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADMIN', 'EDITOR', 'VIEWER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REMOVED')),
  invited_by_google_sub TEXT,
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (trip_id, google_sub),
  FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE,
  FOREIGN KEY (google_sub) REFERENCES users(google_sub),
  FOREIGN KEY (invited_by_google_sub) REFERENCES users(google_sub)
);

CREATE INDEX IF NOT EXISTS idx_trip_memberships_user_status
  ON trip_memberships(google_sub, status);
CREATE INDEX IF NOT EXISTS idx_trip_memberships_trip_status
  ON trip_memberships(trip_id, status);
CREATE INDEX IF NOT EXISTS idx_trips_status_updated
  ON trips(status, updated_at);
