// The StudyBridge admin account: its own sign-in, separate from any tutor. Nothing opens until
// this sign-in has passed two-step login (a code from an authenticator app). The database checks
// the same thing, so admin powers don't work without it even outside the app.
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useApp } from '../../App.jsx';
import Icon, { Logo } from '../../ui/Icon.jsx';
import { Field, Loading, copyText, useRoute, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import Shell from '../shared/Shell.jsx';
import { LookupsProvider } from '../shared/lookups.jsx';
import Settings from '../shared/Settings.jsx';
import AdminHome, { SharedBankPage, PlatformPage, LogPage } from './Admin.jsx';
import { useProfJobs } from '../tutor/Prof.jsx';

function notificationTarget(n) {
  const r = n.ref || {};
  if (n.kind === 'prof' && r.bank) return '/bank';
  if (n.kind === 'tutor_signup') return '/';
  return '/';
}

export default function AdminApp() {
  const [state, setState] = useState(null); // null = checking
  const [err, setErr] = useState('');
  const check = () =>
    api
      .twoStepState()
      .then((s) => (setState(s), setErr('')))
      .catch((e) => setErr(e.message));
  useEffect(() => {
    check();
  }, []);
  if (err && !state) return <Gate title="Couldn’t check your sign-in" error={err} onRetry={check} />;
  if (!state) return <Loading label="Opening Admin…" />;
  if (state.level !== 'aal2') return state.factor ? <EnterCode factor={state.factor} onDone={check} /> : <SetUpApp onDone={check} />;
  return <AdminShell />;
}

function AdminShell() {
  const route = useRoute();
  const tutors = useQuery('admin-tutors', api.adminTutors, { poll: 60000 });
  const bank = useQuery('bank', api.listBank, { poll: 120000 });
  useProfJobs(); // keeps Prof's shared-question jobs moving
  const waiting = (tutors.data || []).filter((t) => t.status === 'pending').length;
  const toReview = (bank.data || []).filter((b) => b.owner_id === null && b.status === 'review').length;
  const nav = [
    { to: '/', label: 'Tutors', icon: 'users', count: waiting },
    { to: '/bank', label: 'StudyBridge questions', icon: 'cap', count: toReview, tone: 'claude' },
    { to: '/platform', label: 'StudyBridge settings', icon: 'shield' },
    { to: '/log', label: 'What’s been done', icon: 'clipboard' },
  ];
  const [a] = route.parts;
  let page;
  if (a === 'bank') page = <SharedBankPage />;
  else if (a === 'platform') page = <PlatformPage />;
  else if (a === 'log') page = <LogPage />;
  else if (a === 'settings') page = <Settings />;
  else page = <AdminHome />;
  return (
    <LookupsProvider>
      <Shell nav={nav} tabs={nav} roleLabel="Admin" notificationTarget={notificationTarget} theme="admin">
        {page}
      </Shell>
    </LookupsProvider>
  );
}

function Gate({ title, lead, children, error, onRetry }) {
  const app = useApp();
  return (
    <div className="welcome">
      <div className="box">
        <div className="hero">
          <Logo size={52} />
          <h1>{title}</h1>
          {lead && <p className="lead">{lead}</p>}
        </div>
        <div className="card">
          {children}
          {error && <div className="error">{error}</div>}
          <div className="row">
            {onRetry && (
              <button className="btn" onClick={onRetry}>
                <Icon name="refresh" size={18} /> Try again
              </button>
            )}
            <span className="grow" />
            <button className="btn ghost" onClick={app.signOut}>
              Sign out
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function CodeForm({ onSubmit, label = 'Check code' }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setErr('');
        try {
          await onSubmit(code);
        } catch (x) {
          setErr(x.message);
          setCode('');
          setBusy(false);
        }
      }}
    >
      <Field label="6-digit code from your authenticator app">
        <input
          className="input code-input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={7}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/[^\d ]/g, ''))}
          autoFocus
          aria-label="Code"
        />
      </Field>
      {err && <div className="error">{err}</div>}
      <div>
        <button className="btn primary" disabled={busy || code.replace(/\s/g, '').length !== 6}>
          {label}
        </button>
      </div>
    </form>
  );
}

function EnterCode({ factor, onDone }) {
  return (
    <Gate title="Admin sign-in" lead="Enter the code from your authenticator app to open Admin.">
      <CodeForm
        label="Open Admin"
        onSubmit={async (code) => {
          await api.twoStepVerify(factor.id, code);
          invalidate();
          await onDone();
        }}
      />
    </Gate>
  );
}

function SetUpApp({ onDone }) {
  const toast = useToast();
  const [f, setF] = useState(null);
  const [qr, setQr] = useState('');
  const [err, setErr] = useState('');
  const start = () =>
    api
      .twoStepStart()
      .then(async (x) => {
        setF(x);
        setQr(await QRCode.toDataURL(x.uri, { margin: 1, width: 220 }));
      })
      .catch((e) => setErr(e.message));
  useEffect(() => {
    start();
  }, []);
  return (
    <Gate
      title="Set up two-step sign-in"
      lead="The admin account controls every tutor and StudyBridge’s keys, so it needs a code from your phone as well as your password."
      error={err}
      onRetry={err ? start : null}
    >
      <ol className="small steps">
        <li>
          On your phone, open an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…).
        </li>
        <li>Add an account and scan this code. If you can’t scan, type the key instead.</li>
        <li>Enter the 6-digit code it shows.</li>
      </ol>
      {f ? (
        <div className="twostep-setup">
          {qr && <img src={qr} alt="QR code for your authenticator app" width={220} height={220} />}
          <div className="small">
            <div className="muted">Key</div>
            <div className="row" style={{ gap: 6 }}>
              <code className="twostep-key">{f.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
              <button type="button" className="btn sm" onClick={() => (copyText(f.secret), toast('Key copied'))}>
                <Icon name="copy" size={14} /> Copy
              </button>
            </div>
          </div>
        </div>
      ) : (
        !err && <div className="muted small">Getting your code…</div>
      )}
      {f && (
        <CodeForm
          label="Turn on and open Admin"
          onSubmit={async (code) => {
            await api.twoStepVerify(f.id, code);
            invalidate();
            await onDone();
          }}
        />
      )}
    </Gate>
  );
}
