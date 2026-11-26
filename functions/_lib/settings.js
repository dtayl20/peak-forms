// Global app settings, stored in D1 `app_settings` (key/value) + the built-in defaults.
// These are the fall-backs a form uses when it has no per-form override.
import { all, run } from './db.js';

/** Built-in consent wording. A form NEVER ends up without a notice — this is the last resort. */
export const DEFAULT_CONSENT_TEXT = 'By submitting your details you consent to being contacted.';

export const SETTING_KEYS = {
  consentText: 'consent.default_text',
  webhookUrl: 'webhook.url',
  webhookToken: 'webhook.token',
};

/**
 * Read the global defaults. Tolerates a missing table/rows (older DB before the
 * migration) by falling back to the built-in defaults, so a public config fetch
 * can never 500 because of settings.
 */
export async function getAppSettings(env) {
  let rows = [];
  try {
    rows = await all(env, 'SELECT key, value FROM app_settings');
  } catch {
    rows = [];
  }
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return {
    consentText: (map[SETTING_KEYS.consentText] || '').trim() || DEFAULT_CONSENT_TEXT,
    webhookUrl: (map[SETTING_KEYS.webhookUrl] || '').trim(),
    webhookToken: map[SETTING_KEYS.webhookToken] || '',
  };
}

/** Upsert one global setting. */
export async function setAppSetting(env, key, value) {
  await run(
    env,
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    key, value
  );
}
