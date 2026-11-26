-- Additive migration: per-field email OTP verification.
-- Apply BEFORE deploying code that reads these, per the peak-forms deploy rule:
--   npx wrangler d1 execute peak-forms-db --remote --file migrations/0003_email_otp.sql
--
-- Codes are stored only as SHA-256 hashes (form id + email + code are the hash
-- input). Rows are single-use, expire after 10 minutes, and cap attempts.
-- SQLite has no "ADD COLUMN IF NOT EXISTS" -- run this file exactly once.

CREATE TABLE IF NOT EXISTS email_otps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id    INTEGER NOT NULL,
  email      TEXT NOT NULL,
  code_hash  TEXT NOT NULL,
  expires_at INTEGER NOT NULL,               -- epoch ms
  attempts   INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0,
  ip         TEXT NOT NULL DEFAULT '',       -- for the per-IP hourly send limit
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_otps_lookup
  ON email_otps (form_id, email, created_at DESC);

ALTER TABLE submissions ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
