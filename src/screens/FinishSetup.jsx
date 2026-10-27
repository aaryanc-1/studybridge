import { useEffect, useState } from 'react';
import { useApp } from '../App.jsx';
import Icon, { Wordmark } from '../ui/Icon.jsx';
import { Field } from '../ui/kit.jsx';
import { decodeInvite } from '../lib/config.js';
import * as api from '../lib/api.js';
import { GRADES } from '../lib/students.js';

// Signed in, but not yet a tutor or a learner (or the profile couldn't load)
export default function FinishSetup() {
  const app = useApp();
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const name = app.me?.display_name || app.user?.user_metadata?.name || '';
  const [adminInvite, setAdminInvite] = useState(false);
  const [studentsOpen, setStudentsOpen] = useState(false);
  const [student, setStudent] = useState({ grade: '', country: '', code: '' });
  useEffect(() => {
    if (!app.bootError) api.adminInvited().then((v) => setAdminInvite(!!v)).catch(() => {});
    api.publicSettings().then((s) => setStudentsOpen(!!s?.students_open));
    // something went wrong finishing the account after Google (e.g. a mistyped code): say what, so they can try again
    const e = sessionStorage.getItem('sb.setupError');
    if (e) {
      sessionStorage.removeItem('sb.setupError');
      setErr(e);
    }
  }, [app.bootError]);
  const india = /^(india|bharat|in)$/i.test(student.country.trim());
  const young = student.grade !== '' && (Number(student.grade) < 8 || (india && Number(student.grade) < 13));

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
          <p className="lead">{app.bootError ? 'StudyBridge couldn’t load your account.' : 'One last step: tell us who this account is for.'}</p>
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
                act(() => api.joinWithCode(inv.code, name));
              }}
            >
              <h2>I have a code</h2>
              <p className="muted small">The 8-digit code from your tutor, or a parent code (from your child’s tutor or your child).</p>
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
            {studentsOpen && (
              <form
                className="card"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!student.grade) return setErr('Choose your grade.');
                  if (young && student.code.replace(/\D/g, '').length !== 8) return setErr('Below grade 8 (and in India under 18), a parent sets up your account: type the 8-digit code from them.');
                  act(() => api.startSelfLearner(name, Number(student.grade), student.country.trim(), young ? student.code : null));
                }}
              >
                <h2>I’m studying on my own</h2>
                <p className="muted small">A plan to your exams, lessons, practice papers and mocks. Your first week is free.</p>
                <div className="grid g2" style={{ gap: 12 }}>
                  <Field label="Your grade">
                    <select className="select" value={student.grade} onChange={(e) => setStudent({ ...student, grade: e.target.value })}>
                      <option value="">Choose…</option>
                      {GRADES.map(([g, label]) => (
                        <option key={g} value={g}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Country">
                    <input className="input" value={student.country} onChange={(e) => setStudent({ ...student, country: e.target.value })} autoComplete="country-name" />
                  </Field>
                </div>
                {young && (
                  <Field label="Code from your parent" hint="A parent sets up your account with you: they choose “I’m a parent” in StudyBridge and get this 8-digit code.">
                    <input className="input code-in" value={student.code} onChange={(e) => setStudent({ ...student, code: e.target.value })} placeholder="4829 1375" inputMode="numeric" />
                  </Field>
                )}
                <button className="btn primary" disabled={busy}>
                  Start my free week
                </button>
              </form>
            )}
            <div className="card">
              <h2>I’m a parent</h2>
              <p className="muted small">A free parent account: set up a child who studies on their own, or follow a child with a parent code (above).</p>
              <button className="btn" disabled={busy} onClick={() => act(() => api.startParent(name))}>
                Set up a parent account
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
  // signed up with a school's email: that school's manager approves them, not StudyBridge
  const [school, setSchool] = useState(null);
  useEffect(() => {
    if (app.me.school_id) api.mySchool().then(setSchool, () => {});
  }, [app.me.school_id]);
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
              : school
                ? `Your teacher account is waiting for ${school.name}’s manager to approve it. This page opens StudyBridge for you as soon as they do.`
                : 'Your tutor account is waiting for approval. This page opens StudyBridge for you as soon as you’re approved.'}
          </p>
        </div>
        <div className="card">
          <div className="row">
            <Icon name={paused ? 'pause' : 'clock'} style={{ color: 'var(--accent)' }} />
            <div className="grow">
              <div className="strong">{app.me.email}</div>
              <div className="small muted">{paused ? 'Paused' : school ? `Waiting for ${school.name}` : 'Waiting for approval'}</div>
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
