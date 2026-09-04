import { useState } from 'react';
import { api } from '../api';

export function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('demo@radar.dev');
  const [password, setPassword] = useState('radar123');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      if (mode === 'signup') await api.signup(email, password);
      else await api.login(email, password);
      onDone();
    } catch (e: any) {
      setErr(e.message ?? 'Something went wrong');
    } finally { setBusy(false); }
  }

  return (
    <div className="min-h-full grid place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-slate-100 tracking-tight">Radar</h1>
          <p className="mt-2 text-sm text-slate-400">A watchlist with memory.</p>
        </div>

        <form onSubmit={submit} className="card p-5 space-y-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Email</label>
            <input value={email} onChange={(e) => setEmail(e.target.value)} type="email" required
              className="w-full bg-ink-950 border border-ink-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">Password</label>
            <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" required minLength={6}
              className="w-full bg-ink-950 border border-ink-700 rounded-lg px-3 py-2 text-sm outline-none focus:border-accent" />
          </div>
          {err && <p className="text-sm text-down">{err}</p>}
          <button type="submit" disabled={busy} className="btn-primary w-full">
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
          <button type="button" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setErr(null); }}
            className="w-full text-xs text-slate-400 hover:text-slate-200 pt-1">
            {mode === 'login' ? 'No account? Create one' : 'Already have an account? Sign in'}
          </button>
        </form>
      </div>
    </div>
  );
}
