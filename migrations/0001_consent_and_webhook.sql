-- Peak Forms - additive migration: consent capture + outbound submit webhook.
--
-- Apply ONCE per database:
--   remote: npx wrangler d1 execute peak-forms-db --remote --file migrations/0001_consent_and_webhook.sql
--   local:  npx wrangler d1 execute peak-forms-db --local  --file migrations/0001_consent_and_webhook.sql
--
-- Purely additive: existing submissions rows keep working (new columns default to '').
-- SQLite has no "ADD COLUMN IF NOT EXISTS" -- re-running this file fails on the first
-- duplicate column, so run it exactly once per database.

ALTER TABLE submissions ADD COLUMN consent_text   TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN consent_at     TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN webhook_status TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN webhook_at     TEXT NOT NULL DEFAULT '';

-- Global defaults (consent wording, submit-webhook URL/token). Key/value so future
-- global settings need no further migration.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO app_settings (key, value) VALUES
  ('consent.default_text', 'By submitting your details you consent to being contacted.');
