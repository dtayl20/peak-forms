-- Additive migration: file uploads stored in R2, metadata in D1.
-- Apply BEFORE deploying the file field code:
--   npx wrangler d1 execute peak-forms-db --remote --file migrations/0005_form_files.sql

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

CREATE INDEX IF NOT EXISTS idx_form_files_lookup
  ON form_files (form_id, field_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_files_submission
  ON form_files (submission_id);
