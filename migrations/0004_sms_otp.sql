-- Additive migration: SMS OTP requests (Twilio Verify) + phone-verified flag.
-- Apply BEFORE deploying code that reads these:
--   npx wrangler d1 execute peak-forms-db --remote --file migrations/0004_sms_otp.sql
--
-- Twilio Verify stores the code and enforces its own expiry/attempts. These rows
-- exist for our own rate limits and to mark a verification as consumed.
-- SQLite has no "ADD COLUMN IF NOT EXISTS" -- run this file exactly once.

CREATE TABLE IF NOT EXISTS sms_otps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id    INTEGER NOT NULL,
  phone      TEXT NOT NULL,                  -- E.164, e.g. +61412345678
  expires_at INTEGER NOT NULL,               -- epoch ms
  attempts   INTEGER NOT NULL DEFAULT 0,
  used       INTEGER NOT NULL DEFAULT 0,
  ip         TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sms_otps_lookup
  ON sms_otps (form_id, phone, created_at DESC);

ALTER TABLE submissions ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0;
