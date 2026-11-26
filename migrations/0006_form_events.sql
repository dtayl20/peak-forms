-- Form analytics events: one row per funnel step, written by the public widget
-- beacon. No field values and no PII beyond what a normal request carries.
-- Apply once: wrangler d1 execute peak-forms-db --remote --file migrations/0006_form_events.sql

CREATE TABLE IF NOT EXISTS form_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id     INTEGER NOT NULL,
  form_slug   TEXT NOT NULL DEFAULT '',
  -- Anonymous per-tab session id from sessionStorage; never a person.
  session_id  TEXT NOT NULL DEFAULT '',
  -- view | start | page | submit | abandon
  event       TEXT NOT NULL,
  -- 1-based step the visitor reached (single-page forms are always 1).
  step        INTEGER NOT NULL DEFAULT 1,
  page_url    TEXT NOT NULL DEFAULT '',
  referrer    TEXT NOT NULL DEFAULT '',
  utm         TEXT NOT NULL DEFAULT '{}',
  ip          TEXT NOT NULL DEFAULT '',
  ua          TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_form_events_form_created ON form_events (form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_events_form_session ON form_events (form_id, session_id, event);
CREATE INDEX IF NOT EXISTS idx_form_events_ip_created ON form_events (ip, created_at);
