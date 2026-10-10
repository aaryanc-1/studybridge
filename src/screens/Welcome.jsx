import { useEffect, useState } from 'react';
import { useApp } from '../App.jsx';
import Icon, { Wordmark } from '../ui/Icon.jsx';
import { Field, useToast, copyText } from '../ui/kit.jsx';
import { decodeInvite, validateServer, normaliseUrl, getServer, desktop, builtInServer } from '../lib/config.js';
import { sb, friendly } from '../lib/supabase.js';
import * as api from '../lib/api.js';
import { GRADES } from '../lib/students.js';
import site from '../../website/site.config.json';
import setupSql from '../../supabase/setup.sql?raw';

export default function Welcome() {
  const app = useApp();
  // From the website: #start=tutor (sign up), #start=invite / parent (I have an invite), #start=signin;
  // from a tutor's message: #join=48291375 (the code is filled in)
  const [linked] = useState(() => {
    const h = location.hash || '';
    const m = h.match(/start=(tutor|invite|parent|signin|student)/);
    const j = h.match(/join=(\d{8})/);
    if (m || j) history.replaceState(null, '', location.pathname + location.search);
    if (j) sessionStorage.setItem('sb.joinCode', j[1]);
    return j ? 'invite' : m?.[1] || null;
  });
  // First time on this device: choose tutor / learner / sign in. After that: straight to sign in.
  const [step, setStep] = useState(() => {
    if (linked === 'tutor') return app.server ? 'account' : 'server';
    if (linked === 'student' && app.server) return 'account';
    if (linked === 'invite' || linked === 'parent') return 'invite';
    if (linked === 'signin' && app.server) return 'signin';
    return app.server && (localStorage.getItem('sb.seen') || localStorage.getItem('sb.server')) ? 'signin' : 'start';
  });
  const [role, setRole] = useState(linked === 'tutor' ? 'tutor' : linked === 'parent' ? 'parent' : linked === 'invite' ? 'learner' : linked === 'student' ? 'student' : null);
  // Students on their own can sign up once a subject is open to them (and the Owner hasn't paused sign-ups)
  const [studentsOpen, setStudentsOpen] = useState(false);
  useEffect(() => {
    if (app.server) api.publicSettings().then((s) => setStudentsOpen(!!s?.students_open));
  }, [app.server]);

  return (
    <div className="welcome">
      <a className="back-site" href={api.WEB_APP.replace(/app\/?$/, '')}>
        <Icon name="left" size={16} /> gostudybridge.com
      </a>
      <div className="box">
        <div className="hero">
          <Wordmark />
          {step === 'start' && (
            <>
              <h1>
                Welcome to <em>StudyBridge.</em>
              </h1>
              <p className="lead">Plans, lessons, practice papers, mocks and marking, for students, tutors and parents.</p>
            </>
          )}
        </div>
        {step === 'start' && (
          <div className="stack">
            {studentsOpen && (
              <button className="choice" onClick={() => (setRole('student'), setStep('account'))}>
                <span className="ic">
                  <Icon name="target" size={24} />
                </span>
                <span className="grow">
                  <div className="t">I’m studying on my own</div>
                  <div className="s">A plan to my exams, lessons, practice papers and mocks. {site.trialDays} days free.</div>
                </span>
                <Icon name="right" />
              </button>
            )}
            <button className="choice" onClick={() => (setRole('learner'), setStep('invite'))}>
              <span className="ic">
                <Icon name="book" size={24} />
              </span>
              <span className="grow">
                <div className="t">I have a code from my tutor</div>
                <div className="s">Join your tutor with the 8-digit code or link they sent you.</div>
              </span>
              <Icon name="right" />
            </button>
            <button className="choice" onClick={() => (setRole('tutor'), setStep(app.server ? 'account' : 'server'))}>
              <span className="ic">
                <Icon name="pen" size={24} />
              </span>
              <span className="grow">
                <div className="t">I’m a tutor</div>
                <div className="s">Teach on StudyBridge: add your subjects and invite your learners.</div>
              </span>
              <Icon name="right" />
            </button>
            <button className="choice" onClick={() => (setRole('parent'), setStep('invite'))}>
              <span className="ic">
                <Icon name="users" size={24} />
              </span>
              <span className="grow">
                <div className="t">I’m a parent</div>
                <div className="s">Follow your child’s progress with the parent invite their tutor sent you.</div>
              </span>
              <Icon name="right" />
            </button>
            {app.server && (
              <button className="linkbtn" style={{ alignSelf: 'center', marginTop: 6 }} onClick={() => setStep('signin')}>
                I already have an account: sign in
              </button>
            )}
          </div>
        )}
        {step === 'server' && <ServerSetup onBack={() => setStep('start')} onDone={() => setStep('account')} />}
        {step === 'invite' && <InviteStep parent={role === 'parent'} onBack={() => setStep('start')} onDone={() => setStep('account')} />}
        {step === 'account' && <Account role={role} onBack={() => setStep(role === 'tutor' ? (builtInServer ? 'start' : 'server') : role === 'student' ? 'start' : 'invite')} />}
        {step === 'signin' && (
          <SignIn
            onNewLearner={() => (setRole('learner'), setStep('invite'))}
            onNewTutor={() => (setRole('tutor'), setStep('account'))}
            onChangeServer={() => {
              app.setServer(null);
              setStep('start');
            }}
            onStart={() => setStep('start')}
          />
        )}
      </div>
    </div>
  );
}

function ServerSetup({ onBack, onDone }) {
  const app = useApp();
  const toast = useToast();
  const existing = getServer();
  const [url, setUrl] = useState(existing?.url || '');
  const [key, setKey] = useState(existing?.key || '');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function connect(e) {
    e.preventDefault();
    const v = validateServer({ url, key });
    if (v) return setErr(v);
    setBusy(true);
    setErr('');
    app.setServer({ url: normaliseUrl(url), key });
    try {
      const { error } = await sb().rpc('live_status');
      if (error && /Could not find|does not exist|schema cache/i.test(error.message)) {
        setErr('Connected, but the database isn’t set up yet. Do step 2 (run setup.sql), then try again.');
      } else if (error && /Invalid API key|No API key|JWT/i.test(error.message)) {
        setErr('Supabase didn’t accept that key. Copy the anon / publishable key again.');
      } else if (error) {
        setErr(friendly(error));
      } else {
        onDone();
      }
    } catch (x) {
      setErr(friendly(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={connect}>
      <div>
        <h2 style={{ fontFamily: 'var(--serif)', fontSize: 24 }}>Set up your StudyBridge</h2>
        <p className="muted small" style={{ marginTop: 4 }}>
          Your work, your learners’ answers and files live in your own free Supabase project. This takes about five minutes, once.
        </p>
      </div>
      <ol className="steps-guide">
        <li>
          <div>
            Go to{' '}
            <a href="https://supabase.com/dashboard" target="_blank" rel="noreferrer">
              supabase.com
            </a>
            , sign in with GitHub and create a new project (any name, pick the region closest to you).
          </div>
        </li>
        <li>
          <div className="stack sm">
            <div>
              Open <b>SQL Editor</b>, paste the StudyBridge setup and press <b>Run</b>.
            </div>
            <div>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  copyText(setupSql);
                  toast({ title: 'Setup copied', body: 'Paste it into the Supabase SQL Editor and press Run.' });
                }}
              >
                <Icon name="copy" size={16} /> Copy setup.sql
              </button>
            </div>
          </div>
        </li>
        <li>
          <div>
            In <b>Authentication → Sign In / Providers → Email</b>, turn off <b>Confirm email</b> and save.
          </div>
        </li>
        <li>
          <div>
            In <b>Project Settings → Data API</b> (or the <b>Connect</b> button), copy the <b>Project URL</b> and the <b>anon / publishable</b> key into the boxes below.
          </div>
        </li>
      </ol>
      <Field label="Project URL">
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://abcdefgh.supabase.co" autoComplete="off" spellCheck={false} />
      </Field>
      <Field label="Anon / publishable key" hint="Never paste the secret / service_role key.">
        <textarea className="textarea code" style={{ minHeight: 70 }} value={key} onChange={(e) => setKey(e.target.value)} placeholder="eyJhbGciOi… or sb_publishable_…" spellCheck={false} />
      </Field>
      {err && <div className="error">{err}</div>}
      <div className="row between">
        <button type="button" className="btn ghost" onClick={onBack}>
          <Icon name="left" size={18} /> Back
        </button>
        <button className="btn primary" disabled={busy}>
          {busy ? 'Checking…' : 'Connect'}
        </button>
      </div>
    </form>
  );
}

function InviteStep({ parent = false, onBack, onDone }) {
  const app = useApp();
  const [text, setText] = useState(() => {
    const c = parent ? '' : sessionStorage.getItem('sb.joinCode') || '';
    sessionStorage.removeItem('sb.joinCode');
    return c ? `${c.slice(0, 4)} ${c.slice(4)}` : '';
  });
  const [err, setErr] = useState('');

  function next(e) {
    e.preventDefault();
    const inv = decodeInvite(text);
    if (!inv) return setErr(parent ? 'That doesn’t look like a parent invite. Paste the whole message the tutor sent.' : 'That doesn’t look like a code from your tutor. It’s 8 digits, like 4829 1375.');
    if (!inv.url && !app.server) return setErr('Paste the whole message your tutor sent (it starts with SB1-).');
    if (inv.url) app.setServer({ url: inv.url, key: inv.key });
    sessionStorage.setItem('sb.pendingInvite', text.trim());
    onDone();
  }

  return (
    <form className="card" onSubmit={next}>
      <h2 style={{ fontFamily: 'var(--serif)', fontSize: 24 }}>{parent ? 'Follow your child’s progress' : 'Join your tutor'}</h2>
      {parent && <div className="note small">A parent account is read-only: you see your child’s weekly reports, lessons, due dates and marks once they’re given back. Never their messages or working.</div>}
      {parent ? (
        <Field label="Your parent invite" hint="Paste the whole invite your child’s tutor sent you.">
          <textarea className="textarea code" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="SB1-eyJ1Ijoi…" spellCheck={false} />
        </Field>
      ) : (
        <Field label="Your code" hint="The 8-digit code from your tutor, like 4829 1375. You can also paste their whole message.">
          <input className="input code-in" autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="4829 1375" inputMode="numeric" autoComplete="one-time-code" spellCheck={false} />
        </Field>
      )}
      {err && <div className="error">{err}</div>}
      <div className="row between">
        <button type="button" className="btn ghost" onClick={onBack}>
          <Icon name="left" size={18} /> Back
        </button>
        <button className="btn primary">Next</button>
      </div>
    </form>
  );
}

function Account({ role, onBack }) {
  const app = useApp();
  const [mode, setMode] = useState('new');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [about, setAbout] = useState({ subjects: '', country: '', learners: '' });
  const [student, setStudent] = useState({ grade: '', country: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function go(e) {
    e.preventDefault();
    setErr('');
    if (mode === 'new' && !name.trim()) return setErr('Add your name.');
    if (pw.length < 6) return setErr('Use a password of at least 6 characters.');
    if (role === 'student' && mode === 'new' && !student.grade) return setErr('Choose your grade.');
    if (role === 'student' && mode === 'new' && Number(student.grade) < 8) return setErr('Below grade 8, a parent needs to set up your account with you. Ask a parent to contact us at hello@gostudybridge.com.');
    setBusy(true);
    try {
      const d = mode === 'new' ? await api.signUp(email, pw, name.trim()) : await api.signIn(email, pw);
      const user = d.user || d.session?.user;
      if (role === 'tutor') {
        await api.becomeTutor(name.trim() || user.user_metadata?.name || email.split('@')[0], mode === 'new' ? about : null);
      } else if (role === 'student') {
        if (mode === 'new') await api.startSelfLearner(name.trim(), Number(student.grade), student.country.trim());
      } else {
        const inv = decodeInvite(sessionStorage.getItem('sb.pendingInvite'));
        if (inv) await api.joinWithCode(inv.code, name.trim());
        sessionStorage.removeItem('sb.pendingInvite');
      }
      localStorage.setItem('sb.seen', '1');
      await app.signedIn(user);
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={go}>
      <h2 style={{ fontFamily: 'var(--serif)', fontSize: 24 }}>{role === 'tutor' ? 'Your tutor account' : role === 'student' ? 'Your student account' : 'Your account'}</h2>
      {role === 'student' && mode === 'new' && (
        <div className="note small">
          Everything is free for {site.trialDays} days. Then it’s ${site.selfLearner.month} a month, or an exam pass at ${site.selfLearner.passMonth} a month that lasts until your exams.
        </div>
      )}
      {role === 'tutor' && mode === 'new' && <div className="note small">New tutor accounts are checked and approved by StudyBridge. You can set up your subjects straight away; you can invite learners once you’re approved.</div>}
      <div className="seg">
        <button type="button" aria-pressed={mode === 'new'} onClick={() => setMode('new')}>
          New account
        </button>
        <button type="button" aria-pressed={mode === 'existing'} onClick={() => setMode('existing')}>
          I already have one
        </button>
      </div>
      {mode === 'new' && (
        <Field label="Your name" hint={role === 'tutor' ? 'Learners see this name.' : role === 'parent' ? 'Your child and their tutor see this name.' : role === 'student' ? 'Your first name is enough.' : 'Your tutor sees this name.'}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" autoFocus />
        </Field>
      )}
      <Field label="Email">
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required />
      </Field>
      <Field label="Password" hint={mode === 'new' ? 'At least 6 characters.' : null}>
        <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete={mode === 'new' ? 'new-password' : 'current-password'} required />
      </Field>
      {role === 'student' && mode === 'new' && (
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
      )}
      {role === 'tutor' && mode === 'new' && (
        <>
          <Field label="What do you teach?" hint="Optional. Helps StudyBridge approve you quickly.">
            <input className="input" value={about.subjects} onChange={(e) => setAbout({ ...about, subjects: e.target.value })} placeholder="e.g. IGCSE Maths and Physics" />
          </Field>
          <div className="grid g2" style={{ gap: 12 }}>
            <Field label="Country">
              <input className="input" value={about.country} onChange={(e) => setAbout({ ...about, country: e.target.value })} autoComplete="country-name" />
            </Field>
            <Field label="How many learners?">
              <select className="select" value={about.learners} onChange={(e) => setAbout({ ...about, learners: e.target.value })}>
                <option value="">—</option>
                {['1–5', '6–15', '16–40', 'More than 40'].map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        </>
      )}
      {err && <div className="error">{err}</div>}
      <div className="row between">
        <button type="button" className="btn ghost" onClick={onBack}>
          <Icon name="left" size={18} /> Back
        </button>
        <button className="btn primary" disabled={busy}>
          {busy ? 'One moment…' : mode === 'new' ? 'Create account' : 'Sign in'}
        </button>
      </div>
    </form>
  );
}

// A link to set a new password, by email (Supabase sends it; it opens StudyBridge)
function ForgotPassword({ email: start }) {
  const [email, setEmail] = useState(start || '');
  const [state, setState] = useState('');
  return (
    <div className="note small stack sm">
      <div>Type your email and we’ll send you a link to set a new password. Learners can also ask their tutor.</div>
      <div className="row wrap">
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-label="Email for the reset link" style={{ maxWidth: 260 }} />
        <button
          type="button"
          className="btn sm"
          disabled={!/@/.test(email) || state === 'sending'}
          onClick={async () => {
            setState('sending');
            try {
              await api.sendPasswordReset(email);
              setState('sent');
            } catch (e) {
              setState(e.message);
            }
          }}
        >
          Send the link
        </button>
      </div>
      {state === 'sent' && <div className="okmsg">Sent. Open the email and follow the link (check spam too).</div>}
      {state && state !== 'sent' && state !== 'sending' && <div className="error">{state}</div>}
    </div>
  );
}

// "Continue with Google": only once the StudyBridge admin has switched it on, and not in the desktop app
// (the sign-in opens in the browser there, so the phone/web version is the place for it)
function GoogleButton() {
  const [on, setOn] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!desktop) api.publicSettings().then((s) => setOn(!!s?.google_on));
  }, []);
  if (!on) return null;
  return (
    <>
      <button type="button" className="btn big google" onClick={() => api.signInWithGoogle().catch((e) => setErr(e.message))}>
        <span className="g">G</span> Continue with Google
      </button>
      {err && <div className="error">{err}</div>}
    </>
  );
}

function SignIn({ onNewLearner, onNewTutor, onChangeServer, onStart }) {
  const app = useApp();
  const [forgot, setForgot] = useState(false);
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  async function go(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const d = await api.signIn(email, pw);
      localStorage.setItem('sb.seen', '1');
      await app.signedIn(d.user);
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div>
        <h1>Sign in</h1>
        <p className="lead" style={{ marginTop: 6 }}>
          Welcome back to StudyBridge.
        </p>
      </div>
      <form className="card" onSubmit={go}>
        <Field label="Email">
          <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" autoFocus required />
        </Field>
        <Field label="Password">
          <input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required />
        </Field>
        {err && <div className="error">{err}</div>}
        <button className="btn primary big" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <button type="button" className="linkbtn small" onClick={() => setForgot((f) => !f)} aria-expanded={forgot}>
          Forgot your password?
        </button>
        {forgot && <ForgotPassword email={email} />}
        <GoogleButton />
        <hr />
        <div className="stack sm small">
          <div>
            New learner? <button type="button" className="linkbtn" onClick={onNewLearner}>Join with an invite</button>
          </div>
          <div>
            Teaching on StudyBridge? <button type="button" className="linkbtn" onClick={onNewTutor}>Create a tutor account</button>
          </div>
          {!builtInServer && (
            <div className="muted tiny" style={{ marginTop: 6 }}>
              Connected to {new URL(app.server.url).host}.{' '}
              <button type="button" className="linkbtn" onClick={onChangeServer}>
                Change
              </button>
            </div>
          )}
          {!desktop && <div className="muted tiny">Tip: add this page to your home screen to use StudyBridge like an app.</div>}
        </div>
      </form>
    </>
  );
}
