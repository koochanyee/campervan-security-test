-- Collaboration, uploader permissions, guest requests and chat.
-- Additive only: existing Google Sheets tabs and KV OAuth tokens are untouched.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS trip_invitations (
  invitation_id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('ADMIN','EDITOR','VIEWER')),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','ACCEPTED','REVOKED')),
  invited_by_google_sub TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (trip_id, email),
  FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE,
  FOREIGN KEY (invited_by_google_sub) REFERENCES users(google_sub)
);
CREATE INDEX IF NOT EXISTS idx_trip_invites_email ON trip_invitations(email,status);

CREATE TABLE IF NOT EXISTS guest_access_requests (
  request_id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  guest_name TEXT NOT NULL,
  guest_email TEXT NOT NULL COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','REVOKED')),
  requested_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewed_by_google_sub TEXT,
  expires_at TEXT,
  FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_by_google_sub) REFERENCES users(google_sub)
);
CREATE INDEX IF NOT EXISTS idx_guest_requests_trip_status ON guest_access_requests(trip_id,status);

CREATE TABLE IF NOT EXISTS upload_permissions (
  upload_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  uploader_google_sub TEXT NOT NULL,
  upload_type TEXT NOT NULL CHECK (upload_type IN ('MEMORY','DOCUMENT')),
  viewer_google_sub TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REVOKED')),
  requested_at TEXT NOT NULL,
  reviewed_at TEXT,
  PRIMARY KEY (upload_id, viewer_google_sub),
  FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE,
  FOREIGN KEY (uploader_google_sub) REFERENCES users(google_sub),
  FOREIGN KEY (viewer_google_sub) REFERENCES users(google_sub)
);
CREATE INDEX IF NOT EXISTS idx_upload_permissions_viewer ON upload_permissions(trip_id,viewer_google_sub,status);
CREATE INDEX IF NOT EXISTS idx_upload_permissions_uploader ON upload_permissions(trip_id,uploader_google_sub,status);

CREATE TABLE IF NOT EXISTS trip_chat_messages (
  message_id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  sender_google_sub TEXT NOT NULL,
  recipient_google_sub TEXT,
  message_type TEXT NOT NULL CHECK (message_type IN ('GROUP','PRIVATE')),
  body TEXT NOT NULL,
  attachment_key TEXT,
  reply_to_message_id TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE,
  FOREIGN KEY (sender_google_sub) REFERENCES users(google_sub),
  FOREIGN KEY (recipient_google_sub) REFERENCES users(google_sub),
  FOREIGN KEY (reply_to_message_id) REFERENCES trip_chat_messages(message_id)
);
CREATE INDEX IF NOT EXISTS idx_chat_trip_created ON trip_chat_messages(trip_id,created_at);
CREATE INDEX IF NOT EXISTS idx_chat_private_pair ON trip_chat_messages(trip_id,sender_google_sub,recipient_google_sub,created_at);

CREATE TABLE IF NOT EXISTS trip_chat_reads (
  trip_id TEXT NOT NULL,
  google_sub TEXT NOT NULL,
  last_read_at TEXT NOT NULL,
  PRIMARY KEY (trip_id,google_sub),
  FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE,
  FOREIGN KEY (google_sub) REFERENCES users(google_sub)
);

CREATE TABLE IF NOT EXISTS trip_media (
  media_id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  uploader_google_sub TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('MEMORY','DOCUMENT','CHAT_ATTACHMENT','PROFILE_PHOTO')),
  object_key TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE,
  FOREIGN KEY (uploader_google_sub) REFERENCES users(google_sub)
);
CREATE INDEX IF NOT EXISTS idx_trip_media_owner ON trip_media(trip_id,uploader_google_sub,media_type);

CREATE TABLE IF NOT EXISTS trip_audit_log (
  audit_id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL,
  actor_google_sub TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (trip_id) REFERENCES trips(trip_id) ON DELETE CASCADE,
  FOREIGN KEY (actor_google_sub) REFERENCES users(google_sub)
);
CREATE INDEX IF NOT EXISTS idx_trip_audit_created ON trip_audit_log(trip_id,created_at);
