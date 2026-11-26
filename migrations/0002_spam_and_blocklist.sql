-- Additive migration: spam flag on submissions + a persistent blocklist.
-- Apply BEFORE deploying code that reads these, per the peak-forms deploy rule:
--   npx wrangler d1 execute peak-forms-db --remote --file migrations/0002_spam_and_blocklist.sql

ALTER TABLE submissions ADD COLUMN spam INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS spam_blocklist (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,              -- 'email' | 'ip'
  value      TEXT NOT NULL,              -- lowercased email or IP as seen by Cloudflare
  created_at TEXT NOT NULL,
  UNIQUE (kind, value)
);

CREATE INDEX IF NOT EXISTS idx_spam_blocklist_lookup ON spam_blocklist (kind, value);
