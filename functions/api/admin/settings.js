// Admin: global app settings — default consent wording + default submit webhook.
// Gated by Cloudflare Access (/api/admin/*) + the X-Admin-Key header, like the rest of the console.
import { json, readJson } from '../../_lib/http.js';
import { adminGate } from '../../_lib/admin.js';
import { getAppSettings, setAppSetting, SETTING_KEYS, DEFAULT_CONSENT_TEXT } from '../../_lib/settings.js';

export const onRequestGet = async ({ request, env }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;
  const settings = await getAppSettings(env);
  return json({ settings, builtinConsentText: DEFAULT_CONSENT_TEXT });
};

export const onRequestPut = async ({ request, env }) => {
  const gate = adminGate(request, env);
  if (gate) return gate;

  const body = await readJson(request);
  if (!body || typeof body !== 'object') return json({ error: 'bad_request' }, 400);

  const consentText = typeof body.consentText === 'string' ? body.consentText.trim().slice(0, 500) : '';
  const webhookUrl = typeof body.webhookUrl === 'string' ? body.webhookUrl.trim() : '';
  const webhookToken = typeof body.webhookToken === 'string' ? body.webhookToken.slice(0, 500) : '';

  if (webhookUrl && !/^https:\/\//.test(webhookUrl)) {
    return json({ error: 'Webhook URL must start with https://' }, 400);
  }

  // Empty consent text clears the override -> getAppSettings falls back to the built-in wording.
  await setAppSetting(env, SETTING_KEYS.consentText, consentText);
  await setAppSetting(env, SETTING_KEYS.webhookUrl, webhookUrl.slice(0, 1000));
  await setAppSetting(env, SETTING_KEYS.webhookToken, webhookToken);

  const settings = await getAppSettings(env);
  return json({ settings });
};
