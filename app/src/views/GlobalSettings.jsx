import React, { useEffect, useState } from 'react';
import { api } from '../api.js';

const FALLBACK = 'By submitting your details you consent to being contacted.';

export default function GlobalSettings() {
  const [consentText, setConsentText] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookToken, setWebhookToken] = useState('');
  const [builtin, setBuiltin] = useState(FALLBACK);
  const [busy, setBusy] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState('');
  const [error, setError] = useState('');
  const [test, setTest] = useState(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await api.getSettings();
        if (cancelled) return;
        setConsentText(res.settings?.consentText || '');
        setWebhookUrl(res.settings?.webhookUrl || '');
        setWebhookToken(res.settings?.webhookToken || '');
        if (res.builtinConsentText) setBuiltin(res.builtinConsentText);
      } catch (e) {
        if (!cancelled) setError(e.message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function save() {
    setSaving(true);
    setError('');
    try {
      const res = await api.saveSettings({ consentText, webhookUrl, webhookToken });
      setConsentText(res.settings?.consentText || '');
      setWebhookUrl(res.settings?.webhookUrl || '');
      setWebhookToken(res.settings?.webhookToken || '');
      setSavedAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const res = await api.testWebhook({ url: webhookUrl, token: webhookToken, form_slug: 'webhook-test' });
      setTest(res);
    } catch (e) {
      setTest({ ok: false, status: 0, error: e.message });
    } finally {
      setTesting(false);
    }
  }

  if (busy) return <div className="p-10 text-sm text-slate-500 text-center">Loading settings…</div>;

  return (
    <div className="max-w-3xl">
      <div className="mb-4">
        <h1 className="text-xl font-bold">Settings</h1>
        <p className="text-sm text-slate-500">
          Global defaults for every form. A form can override the consent wording and the submit webhook
          in its own <b>Settings</b> tab; anything left blank there falls back to what is set here.
        </p>
      </div>

      {error && <p className="mb-3 text-sm text-red-600">{error}</p>}

      <div className="space-y-4">
        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-bold">Consent notice (global default)</h2>
          <p className="text-xs text-slate-500">
            Shown beneath the submit button on every form that has no per-form override. Clearing this
            resets it to the built-in wording.
          </p>
          <textarea
            value={consentText}
            onChange={(e) => setConsentText(e.target.value)}
            rows={3}
            placeholder={builtin}
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
          />
          <p className="text-[11px] text-slate-400">
            Current effective default if this is blank: <span className="italic">{builtin}</span>
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
          <h2 className="text-sm font-bold">Submit webhook (global default)</h2>
          <p className="text-xs text-slate-500">
            On a successful submission the form POSTs a fixed JSON payload here, fire-and-forget — a
            failure never affects the visitor. Per-form override lives on the form&apos;s Settings tab.
          </p>
          <label className="block">
            <span className="block text-xs font-semibold text-slate-600 mb-1">Webhook URL</span>
            <input
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder="https://…"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </label>
          <label className="block">
            <span className="block text-xs font-semibold text-slate-600 mb-1">Webhook token</span>
            <input
              value={webhookToken}
              onChange={(e) => setWebhookToken(e.target.value)}
              placeholder="Optional — sent as Authorization: Bearer <token>"
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm font-mono"
            />
          </label>
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={runTest}
              disabled={testing || !webhookUrl}
              className="text-xs font-semibold text-teal-700 hover:text-teal-900 disabled:opacity-40"
            >
              {testing ? 'Sending…' : 'Send test payload'}
            </button>
            {test && (
              <span className={`text-xs ${test.ok ? 'text-emerald-700' : 'text-red-600'}`}>
                {test.ok
                  ? `OK — receiver answered ${test.status}`
                  : `Failed — ${test.error || ('status ' + test.status)}`}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={save}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-sm font-semibold disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save settings'}
          </button>
          {savedAt && <span className="text-xs text-slate-400">Saved {savedAt}</span>}
        </div>
      </div>
    </div>
  );
}
