-- 0008: track when the console last viewed a form's submissions, so the
-- green "new" chip can be cleared. Additive only; existing rows default to
-- '' (never viewed), which keeps the old 7-day behaviour as the fallback.
ALTER TABLE forms ADD COLUMN last_viewed_at TEXT NOT NULL DEFAULT '';
