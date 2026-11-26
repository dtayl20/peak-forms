-- Peak Forms — D1 schema
-- Apply: wrangler d1 execute peak-forms-db --remote --file schema.sql

CREATE TABLE IF NOT EXISTS sites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS forms (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id     INTEGER NOT NULL REFERENCES sites(id),
  slug        TEXT NOT NULL UNIQUE,
  title       TEXT NOT NULL,
  -- JSON: { fields: [...], settings: {...}, notifications: [{label, url}], pages: [{id, title, description}] }
  -- pages[] ordered = multi-page (step) forms; fields carry a 0-based `page` index. Omit/empty = single long form.
  config      TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'draft', -- draft | published
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id     INTEGER NOT NULL REFERENCES forms(id),
  form_slug   TEXT NOT NULL,
  -- JSON object: field name -> value
  data        TEXT NOT NULL,
  page_url    TEXT NOT NULL DEFAULT '',
  referrer    TEXT NOT NULL DEFAULT '',
  utm         TEXT NOT NULL DEFAULT '{}',
  ip          TEXT NOT NULL DEFAULT '',
  ua          TEXT NOT NULL DEFAULT '',
  -- Consent capture (shown wording + when accepted). Additive; see migrations/0001_consent_and_webhook.sql
  consent_text   TEXT NOT NULL DEFAULT '',
  consent_at     TEXT NOT NULL DEFAULT '',
  -- Outbound submit-webhook delivery outcome (fire-and-forget, never blocks the visitor)
  webhook_status TEXT NOT NULL DEFAULT '',
  webhook_at     TEXT NOT NULL DEFAULT '',
  -- 1 when the submission carried a valid email-OTP token (migrations/0003)
  email_verified INTEGER NOT NULL DEFAULT 0,
  -- 1 when the submission carried a valid SMS-OTP token (migrations/0004)
  phone_verified INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Email OTP codes: hashed at rest, single-use, 10-minute expiry, 5-attempt cap.
CREATE TABLE IF NOT EXISTS email_otps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id    INTEGER NOT NULL,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0,
  ip         TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_email_otps_lookup ON email_otps (form_id, email, created_at DESC);

-- SMS OTP requests (Twilio Verify owns the code itself; this table is for rate
-- limits and single-use tracking).
CREATE TABLE IF NOT EXISTS sms_otps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id    INTEGER NOT NULL,
  phone      TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0,
  ip         TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sms_otps_lookup ON sms_otps (form_id, phone, created_at DESC);

-- Uploaded files: bytes live in R2 under object_key; this row is the metadata
-- and the single-use link between an upload and a submission.
CREATE TABLE IF NOT EXISTS form_files (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id        INTEGER NOT NULL,
  field_name     TEXT NOT NULL,
  object_key     TEXT NOT NULL UNIQUE,
  original_name  TEXT NOT NULL,
  content_type   TEXT NOT NULL,
  size           INTEGER NOT NULL,
  ip             TEXT NOT NULL DEFAULT '',
  token_hash     TEXT NOT NULL,
  submission_id  INTEGER,
  used           INTEGER NOT NULL DEFAULT 0,
  expires_at     INTEGER NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_form_files_lookup ON form_files (form_id, field_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_files_submission ON form_files (submission_id);

-- Global app settings (consent default wording + submit-webhook URL/token). Key/value.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_forms_site ON forms(site_id);
CREATE INDEX IF NOT EXISTS idx_submissions_form_created ON submissions(form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_submissions_ip_hour ON submissions(form_id, ip, created_at);
