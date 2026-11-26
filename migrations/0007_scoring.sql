-- 0007: quiz scoring. Additive only; existing rows default to "no score".
ALTER TABLE submissions ADD COLUMN score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN score_percent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE submissions ADD COLUMN score_band TEXT NOT NULL DEFAULT '';
