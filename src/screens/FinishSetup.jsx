import { useState } from 'react';
import { useApp } from '../App.jsx';
import { Logo } from '../ui/Icon.jsx';
import { Field } from '../ui/kit.jsx';
import { decodeInvite } from '../lib/config.js';
import * as api from '../lib/api.js';

// Signed in, but not yet a tutor or a learner (or the profile couldn't load)
export default function FinishSetup() {
  const app = useApp();
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const name = app.me?.display_name || app.user?.user_metadata?.name || '';

  async function act(fn) {
    setBusy(true);
    setErr('');
    try {
      await fn();
      await app.refreshMe();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="welcome">
      <div className="box">
        <div className="hero">
          <Logo size={52} />
          <h1>Almost there</h1>
          <p className="lead">{app.bootError ? 'StudyBridge couldn’t load your account.' : 'Join your tutor with your invite, or set this account up as the tutor.'}</p>
        </div>
        {app.bootError ? (
          <div className="card">
            <div className="error">{app.bootError}</div>
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={() => act(async () => {})}>
                Try again
              </button>
              <button className="btn" onClick={app.signOut}>
                Sign out
              </button>
            </div>
          </div>
        ) : (
          <>
            <form
              className="card"
              onSubmit={(e) => {
                e.preventDefault();
                const inv = decodeInvite(text);
                if (!inv) return setErr('Paste the whole invite your tutor sent.');
                act(() => api.acceptInvite(inv.code, name));
              }}
            >
              <h2>I’m a learner</h2>
              <Field label="Invite">
                <textarea className="textarea code" value={text} onChange={(e) => setText(e.target.value)} placeholder="SB1.…" />
              </Field>
              <button className="btn primary" disabled={busy}>
                Join
              </button>
            </form>
            <div className="card">
              <h2>I’m the tutor</h2>
              <p className="muted small">Only the owner of this StudyBridge can be a tutor.</p>
              <button className="btn" disabled={busy} onClick={() => act(() => api.becomeTutor(name))}>
                Set up as tutor
              </button>
            </div>
            {err && <div className="error">{err}</div>}
            <button className="btn ghost" onClick={app.signOut}>
              Sign out
            </button>
          </>
        )}
      </div>
    </div>
  );
}
