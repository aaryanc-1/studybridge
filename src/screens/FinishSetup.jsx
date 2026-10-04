import { useEffect, useState } from 'react';
import { useApp } from '../App.jsx';
import Icon, { Wordmark } from '../ui/Icon.jsx';
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
  const [adminInvite, setAdminInvite] = useState(false);
  useEffect(() => {
    if (!app.bootError) api.adminInvited().then((v) => setAdminInvite(!!v)).catch(() => {});
  }, [app.bootError]);

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
          <Wordmark />
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
        ) : adminInvite ? (
          <div className="card">
            <h2 className="row">
              <Icon name="shield" style={{ color: 'var(--accent)' }} /> Set up as the StudyBridge admin
            </h2>
            <p className="muted small">This email was chosen as StudyBridge’s admin account. It only manages tutors and StudyBridge settings: no learners, no teaching.</p>
            <div className="row">
              <button className="btn primary" disabled={busy} onClick={() => act(() => api.claimAdmin())}>
                Set up admin account
              </button>
              <button className="btn ghost" onClick={app.signOut}>
                Sign out
              </button>
            </div>
            {err && <div className="error">{err}</div>}
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
                <textarea className="textarea code" value={text} onChange={(e) => setText(e.target.value)} placeholder="SB1-…" />
              </Field>
              <button className="btn primary" disabled={busy}>
                Join
              </button>
            </form>
            <div className="card">
              <h2>I’m a tutor</h2>
              <p className="muted small">New tutor accounts are approved by StudyBridge before you can invite learners.</p>
              <button className="btn" disabled={busy} onClick={() => act(() => api.becomeTutor(name))}>
                Sign up as a tutor
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

// A tutor who signed up and is waiting for StudyBridge to approve them (or whose account is paused)
export function WaitingForApproval() {
  const app = useApp();
  const paused = app.me.status === 'suspended';
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => app.refreshMe(), 15000);
    return () => clearInterval(t);
  }, [paused]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="welcome">
      <div className="box">
        <div className="hero">
          <Wordmark />
          <h1>{paused ? 'Your account is paused' : `Thanks, ${app.me.display_name.split(' ')[0]}!`}</h1>
          <p className="lead">
            {paused
              ? 'StudyBridge has paused this tutor account. Your learners’ work is kept safe. Contact StudyBridge to switch it back on.'
              : 'Your tutor account is waiting for approval. This page opens StudyBridge for you as soon as you’re approved.'}
          </p>
        </div>
        <div className="card">
          <div className="row">
            <Icon name={paused ? 'pause' : 'clock'} style={{ color: 'var(--accent)' }} />
            <div className="grow">
              <div className="strong">{app.me.email}</div>
              <div className="small muted">{paused ? 'Paused' : 'Waiting for approval'}</div>
            </div>
          </div>
          <div className="row">
            {!paused && (
              <button className="btn primary" onClick={() => app.refreshMe()}>
                <Icon name="refresh" size={18} /> Check again
              </button>
            )}
            <button className="btn" onClick={app.signOut}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
