import React, { useState } from 'react';
import { api, clearKey, getKey } from './api.js';
import Forms from './views/Forms.jsx';
import Sites from './views/Sites.jsx';
import Editor from './views/Editor.jsx';
import GlobalSettings from './views/GlobalSettings.jsx';

function KeyGate({ onAuthed }) {
  const [key, setKeyVal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    sessionStorage.setItem('pf_admin_key', key.trim());
    try {
      await api.listSites();
      onAuthed();
    } catch (err) {
      sessionStorage.removeItem('pf_admin_key');
      setError(err.status === 401 ? 'That key was rejected.' : err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full flex items-center justify-center p-6">
      <div className="w-full max-w-sm bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
        <div className="flex items-center gap-2 mb-1">
          <div className="w-8 h-8 rounded-lg bg-teal-700 text-white grid place-items-center font-bold">P</div>
          <div>
            <h1 className="text-lg font-bold leading-none">Peak Forms</h1>
            <p className="text-xs text-slate-500 mt-0.5">Form builder</p>
          </div>
        </div>
        <p className="text-sm text-slate-600 mt-4">
          Enter your admin key to continue. (This screen is also behind Cloudflare Access on production.)
        </p>
        <form onSubmit={submit} className="mt-4 space-y-3">
          <input
            type="password"
            value={key}
            onChange={(e) => setKeyVal(e.target.value)}
            placeholder="Admin key"
            autoFocus
            className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-600/30 focus:border-teal-600"
          />
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            type="submit"
            disabled={busy || !key.trim()}
            className="w-full bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white rounded-lg py-2 text-sm font-semibold"
          >
            {busy ? 'Checking…' : 'Continue'}
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [authed, setAuthed] = useState(!!getKey());
  const [view, setView] = useState({ name: 'forms' });

  if (!authed) {
    return <KeyGate onAuthed={() => setAuthed(true)} />;
  }

  function nav(name) {
    setView({ name });
  }

  const navBtn = (name, label) => (
    <button
      onClick={() => nav(name)}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium transition ${
        view.name === name ? 'bg-teal-700 text-white' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="min-h-full flex flex-col">
      <header className="bg-white border-b border-slate-200 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => nav('forms')} className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-teal-700 text-white grid place-items-center font-bold text-sm">P</div>
              <span className="font-bold">Peak Forms</span>
            </button>
            <nav className="flex gap-1 ml-4">
              {navBtn('forms', 'Forms')}
              {navBtn('sites', 'Sites')}
              {navBtn('settings', 'Settings')}
            </nav>
          </div>
          <button
            onClick={() => { clearKey(); setAuthed(false); }}
            className="text-xs text-slate-500 hover:text-slate-800"
            title="Forget admin key"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-4 py-6">
        {view.name === 'forms' && <Forms openEditor={(id, tab = 'fields') => setView({ name: 'editor', id, tab })} />}
        {view.name === 'sites' && <Sites />}
        {view.name === 'settings' && <GlobalSettings />}
        {view.name === 'editor' && (
          <Editor
            formId={view.id}
            initialTab={view.tab}
            onBack={() => setView({ name: 'forms' })}
          />
        )}
      </main>
    </div>
  );
}
