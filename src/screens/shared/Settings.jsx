import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Field, Page, Toggle, copyText, useConfirm, useRoute, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as store from '../../lib/store.js';
import { sb } from '../../lib/supabase.js';
import { connectLink, desktop, timezone } from '../../lib/config.js';
import { useUpdateStatus } from './Shell.jsx';
import { palette } from '../../lib/format.js';

export default function Settings() {
  const app = useApp();
  const route = useRoute();
  const isTutor = app.me.role === 'tutor';
  const focus = route.query.get('s');
  useEffect(() => {
    if (focus) document.getElementById('set-' + focus)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focus]);
  return (
    <Page title="Settings" size="narrow">
      <Account />
      {isTutor && <PhoneAlerts />}
      {isTutor && <PhoneApp />}
      {isTutor && <LiveKeys />}
      {isTutor && <ClaudeConnector />}
      {isTutor && <AccountHistory />}
      {!isTutor && <LearnerNotifications />}
      <Device />
      <About />
    </Page>
  );
}

function Section({ id, icon, title, children, sub }) {
  return (
    <div className="card" id={'set-' + id}>
      <div className="row">
        <Icon name={icon} style={{ color: 'var(--accent)' }} />
        <h2>{title}</h2>
      </div>
      {sub && <div className="muted small" style={{ marginTop: -6 }}>{sub}</div>}
      {children}
    </div>
  );
}

function Account() {
  const app = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [name, setName] = useState(app.me.display_name);
  const [tz, setTz] = useState(app.me.timezone || timezone());
  const [color, setColor] = useState(app.me.avatar_color || null);
  const [pw, setPw] = useState('');
  async function save() {
    try {
      await api.updateProfile({ display_name: name.trim() || app.me.display_name, timezone: tz, avatar_color: color });
      await app.refreshMe();
      toast('Saved');
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    }
  }
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [tz];
  return (
    <Section id="account" icon="user" title="Your account">
      <div className="row">
        <Avatar person={{ ...app.me, display_name: name, avatar_color: color }} size="lg" />
        <div>
          <div className="strong">{app.me.email}</div>
          <div className="muted small">{app.me.role === 'tutor' ? 'Tutor' : 'Learner'}</div>
        </div>
      </div>
      <div className="grid g2" style={{ gap: 12 }}>
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Time zone">
          <select className="select" value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Colour">
        <div className="row wrap">
          {palette.map((c) => (
            <button key={c} type="button" onClick={() => setColor(c)} aria-label={`Colour ${c}`} aria-pressed={color === c} style={{ width: 28, height: 28, borderRadius: 14, background: c, border: color === c ? '3px solid var(--ink)' : '3px solid #fff', boxShadow: '0 0 0 1px var(--line)', cursor: 'pointer' }} />
          ))}
        </div>
      </Field>
      <div>
        <button className="btn primary" onClick={save}>
          Save
        </button>
      </div>
      <hr />
      <form
        className="row wrap"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pw.length < 6) return toast({ title: 'Use at least 6 characters', tone: 'bad' });
          try {
            await api.changePassword(pw);
            setPw('');
            toast('Password changed');
          } catch (x) {
            toast({ title: 'Couldn’t change password', body: x.message, tone: 'bad' });
          }
        }}
      >
        <input className="input" style={{ maxWidth: 260 }} type="password" placeholder="New password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" aria-label="New password" />
        <button className="btn">Change password</button>
        <span className="grow" />
        <button
          type="button"
          className="btn danger"
          onClick={async () => {
            if (await confirm({ title: 'Sign out?', body: 'Anything waiting to send is kept and sends next time you sign in here.', ok: 'Sign out' })) app.signOut();
          }}
        >
          <Icon name="logout" size={18} /> Sign out
        </button>
      </form>
    </Section>
  );
}

function PhoneAlerts() {
  const toast = useToast();
  const s = useQuery('settings', api.getSettings);
  const d = s.data;
  if (!d) return null;
  return (
    <Section id="alerts" icon="bell" title="Phone alerts" sub="Get a push notification on your phone the moment a learner submits work, leaves a note, or leaves an exam window.">
      <ol className="steps-guide">
        <li>
          <div>
            Install the free <b>ntfy</b> app (
            <a href="https://apps.apple.com/app/ntfy/id1625396347" target="_blank" rel="noreferrer">
              iPhone
            </a>{' '}
            ·{' '}
            <a href="https://play.google.com/store/apps/details?id=io.heckel.ntfy" target="_blank" rel="noreferrer">
              Android
            </a>
            ).
          </div>
        </li>
        <li>
          <div className="stack sm">
            <div>Tap + and subscribe to this topic (it’s private to you, like a password):</div>
            <div className="row">
              <span className="code-box" style={{ flex: 1 }}>{d.ntfy_topic}</span>
              <button className="btn sm" onClick={() => (copyText(d.ntfy_topic), toast('Topic copied'))}>
                <Icon name="copy" size={14} /> Copy
              </button>
            </div>
          </div>
        </li>
        <li>
          <div>
            In Supabase, open <b>Database → Extensions</b> and turn on <b>pg_net</b> (it lets StudyBridge send the alerts).
          </div>
        </li>
      </ol>
      <Toggle
        checked={d.notify_phone}
        onChange={async (v) => {
          s.mutate({ ...d, notify_phone: v });
          await api.saveSettings({ notify_phone: v });
        }}
        title="Send alerts to my phone"
      />
      <div>
        <button
          className="btn"
          onClick={async () => {
            try {
              const ok = await sb().rpc('test_phone_alert');
              if (ok.error) throw ok.error;
              invalidate('notifications');
              toast(ok.data ? { title: 'Test sent', body: 'It should arrive on your phone in a few seconds.' } : { title: 'pg_net isn’t on yet', body: 'Turn it on in Supabase → Database → Extensions, then try again.', tone: 'bad' });
            } catch (e) {
              toast({ title: 'Couldn’t send a test', body: e.message, tone: 'bad' });
            }
          }}
        >
          Send a test alert
        </button>
      </div>
    </Section>
  );
}

function PhoneApp() {
  const app = useApp();
  const toast = useToast();
  const [web, setWeb] = useState(() => localStorage.getItem('sb.webUrl') || (!desktop && location.protocol.startsWith('http') ? location.origin + location.pathname : ''));
  const [qr, setQr] = useState('');
  const link = web && /^https?:\/\//.test(web) ? connectLink(web, app.server) : '';
  useEffect(() => {
    if (!link) return setQr('');
    QRCode.toDataURL(link, { margin: 1, width: 400, errorCorrectionLevel: 'M' }).then(setQr).catch(() => setQr(''));
  }, [link]);
  return (
    <Section id="phone" icon="phone" title="Use StudyBridge on your phone" sub="The phone version is the same app in your phone’s browser. Add it to your home screen and it works like an app, including offline.">
      <Field label="Your StudyBridge web address" hint="Where you put the web version (see the setup guide: drag the “web” folder onto Netlify Drop). Only needed once.">
        <input
          className="input"
          value={web}
          placeholder="https://your-studybridge.netlify.app"
          onChange={(e) => {
            setWeb(e.target.value);
            localStorage.setItem('sb.webUrl', e.target.value.trim());
          }}
        />
      </Field>
      {qr && (
        <div className="row top wrap" style={{ gap: 20 }}>
          <div className="qr">
            <img src={qr} alt="QR code to open StudyBridge on your phone" />
          </div>
          <ol className="steps-guide" style={{ flex: 1, minWidth: 220 }}>
            <li>Scan this with your phone’s camera.</li>
            <li>Sign in with your email and password.</li>
            <li>
              Add to home screen: Share → <b>Add to Home Screen</b> (iPhone) or ⋮ → <b>Install app</b> (Android).
            </li>
            <li>
              <button className="linkbtn" onClick={() => (copyText(link), toast('Link copied'))}>
                Or copy the link
              </button>
            </li>
          </ol>
        </div>
      )}
    </Section>
  );
}

function LiveKeys() {
  const toast = useToast();
  const s = useQuery('settings', api.getSettings);
  const status = useQuery('live-status', api.liveStatus);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [secret, setSecret] = useState('');
  useEffect(() => {
    if (s.data?.livekit_url && !url) setUrl(s.data.livekit_url);
  }, [s.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const ok = status.data?.configured;
  const shared = status.data?.shared && !status.data?.own;
  return (
    <Section id="live" icon="video" title="Live video" sub="Powers live lessons and exam cameras.">
      <div className="row">
        <span className={'dot ' + (ok ? '' : 'warn')} />
        <span className="strong">{shared ? 'Ready: StudyBridge provides it' : ok ? 'Switched on (your own LiveKit)' : 'Not set up yet'}</span>
      </div>
      {shared && <div className="small muted">Nothing to do. If you’d rather use your own LiveKit Cloud project, add its keys below.</div>}
      <ol className="steps-guide">
        <li>
          <div>
            Sign in at{' '}
            <a href="https://cloud.livekit.io" target="_blank" rel="noreferrer">
              cloud.livekit.io
            </a>{' '}
            (GitHub works) and open your project.
          </div>
        </li>
        <li>
          <div>
            Go to <b>Settings → API keys</b> and create a key. Copy the <b>WebSocket URL</b>, <b>API key</b> and <b>API secret</b> into the boxes below.
          </div>
        </li>
      </ol>
      <div className="note small">These go straight into your own database, where only StudyBridge’s sign-in function can read the secret. Never paste them into a chat.</div>
      <Field label="WebSocket URL">
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="wss://your-project.livekit.cloud" spellCheck={false} />
      </Field>
      <div className="grid g2" style={{ gap: 12 }}>
        <Field label="API key">
          <input className="input" value={key} onChange={(e) => setKey(e.target.value)} placeholder={ok ? 'Saved (enter to replace)' : 'APIxxxxxxxx'} spellCheck={false} autoComplete="off" />
        </Field>
        <Field label="API secret">
          <input className="input" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={ok ? 'Saved (enter to replace)' : ''} autoComplete="off" />
        </Field>
      </div>
      <div>
        <button
          className="btn primary"
          onClick={async () => {
            if (!/^wss:\/\//.test(url.trim())) return toast({ title: 'The URL should start with wss://', tone: 'bad' });
            if (!key.trim() || (!ok && !secret.trim())) return toast({ title: 'Add the API key and secret', tone: 'bad' });
            try {
              await api.setLiveKeys(url.trim(), key.trim(), secret.trim());
              setKey('');
              setSecret('');
              invalidate('settings', 'live-status');
              toast('Live video switched on');
            } catch (e) {
              toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
            }
          }}
        >
          Save
        </button>
      </div>
    </Section>
  );
}

function ClaudeConnector() {
  const app = useApp();
  const toast = useToast();
  const [showKey, setShowKey] = useState(false);
  return (
    <Section id="claude" icon="spark" title="Claude Desktop (optional)" sub="Prof is built in. If you also use Claude Desktop, connect it here so Claude can read your StudyBridge and draft work too. Everything it makes waits in Prof for your approval. Learners never use it.">
      <ol className="steps-guide">
        <li>
          <div className="stack sm">
            <div>Get the StudyBridge connector.</div>
            {desktop ? (
              <div className="row wrap">
                <button
                  className="btn claude"
                  onClick={async () => {
                    const r = await desktop.openConnector();
                    toast(r.error ? { title: 'Saved to Downloads', body: 'Double-click “StudyBridge for Claude.mcpb” to install it.', tone: '' } : { title: 'Opening in Claude Desktop', body: 'Press Install when Claude asks.' });
                  }}
                >
                  <Icon name="spark" size={16} /> Install in Claude Desktop
                </button>
                <button className="btn sm" onClick={() => desktop.saveConnector()}>
                  Save the file instead
                </button>
              </div>
            ) : (
              <div className="small muted">Open StudyBridge on your laptop (desktop app) to install it.</div>
            )}
          </div>
        </li>
        <li>
          <div className="stack sm">
            <div>When Claude asks for settings, paste these (and your StudyBridge email and password):</div>
            <div className="stack sm small">
              <div className="row">
                <span className="muted" style={{ width: 110 }}>Server URL</span>
                <span className="code-box" style={{ flex: 1, padding: '6px 10px' }}>{app.server.url}</span>
                <button className="btn sm" onClick={() => (copyText(app.server.url), toast('Copied'))}>
                  <Icon name="copy" size={14} />
                </button>
              </div>
              <div className="row">
                <span className="muted" style={{ width: 110 }}>Anon key</span>
                <span className="code-box" style={{ flex: 1, padding: '6px 10px', maxHeight: 60, overflow: 'hidden' }}>{showKey ? app.server.key : app.server.key.slice(0, 18) + '…'}</span>
                <button className="btn sm" onClick={() => (copyText(app.server.key), toast('Copied'))}>
                  <Icon name="copy" size={14} />
                </button>
                <button className="btn sm ghost" onClick={() => setShowKey((s) => !s)} aria-label="Show key">
                  <Icon name={showKey ? 'eyeOff' : 'eye'} size={14} />
                </button>
              </div>
            </div>
          </div>
        </li>
        <li>
          <div>
            Try it: in Claude, ask <i>“Using StudyBridge, what have my learners handed in this week?”</i>
          </div>
        </li>
      </ol>
    </Section>
  );
}

// What the StudyBridge admin has done to this account (approvals, password resets…)
function AccountHistory() {
  const q = useQuery('my-admin-log', api.adminLog);
  const app = useApp();
  const list = (q.data || []).filter((x) => x.user_id === app.me.id || x.tutor_id === app.me.id);
  if (!list.length || app.me.is_admin) return null;
  const label = { approved: 'Your account was approved', paused: 'Your account was paused', switched_on: 'Your account was switched back on', password_reset: 'Password reset by StudyBridge', deleted: 'Account deleted by StudyBridge', plan: 'Plan changed' };
  return (
    <Section id="history" icon="shield" title="Changes StudyBridge made to your account" sub="StudyBridge can manage accounts (approvals, passwords) but never sees your work. Every change is listed here.">
      <div className="list small">
        {list.map((x) => (
          <div key={x.id} className="item" style={{ padding: '6px 0' }}>
            <span className="muted" style={{ width: 150, flexShrink: 0 }}>{new Date(x.at).toLocaleString()}</span>
            <span className="grow">
              {label[x.action] || x.action}
              {x.user_id !== app.me.id && x.detail?.name ? ` (${x.detail.name})` : x.user_id !== app.me.id && x.email ? ` (${x.email})` : ''}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function LearnerNotifications() {
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  if (perm === 'unsupported') return null;
  return (
    <Section id="notify" icon="bell" title="Notifications" sub="Get a notification when new work arrives, marks come back, or your tutor messages you.">
      {perm === 'granted' ? (
        <div className="okmsg">Notifications are on.</div>
      ) : (
        <div>
          <button className="btn" onClick={() => Notification.requestPermission().then(setPerm)}>
            Turn on notifications
          </button>
        </div>
      )}
    </Section>
  );
}

function Device() {
  const app = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [bg, setBg] = useState(() => localStorage.getItem('sb.background') === '1');
  const [count, setCount] = useState(null);
  useEffect(() => {
    store.blobs.keys().then((k) => setCount(k.length));
  }, []);
  return (
    <Section id="device" icon="download" title="This device">
      {desktop && app.me.role === 'tutor' && (
        <Toggle
          checked={bg}
          onChange={(v) => {
            setBg(v);
            localStorage.setItem('sb.background', v ? '1' : '0');
            desktop.keepInBackground(v);
          }}
          title="Keep running when I close the window"
          sub="StudyBridge stays in the tray so notifications still reach you."
        />
      )}
      <div className="small">
        Files and work you’ve opened are saved on this device so they work offline{count != null ? ` (${count} saved)` : ''}.
      </div>
      <div>
        <button
          className="btn sm"
          onClick={async () => {
            if (!(await confirm({ title: 'Remove offline copies?', body: 'Files download again next time you open them. Anything waiting to send is kept.', ok: 'Remove' }))) return;
            for (const k of await store.blobs.keys()) await store.blobs.del(k);
            setCount(0);
            toast('Offline copies removed');
          }}
        >
          Remove offline copies
        </button>
      </div>
      <div className="muted tiny">Connected to {new URL(app.server.url).host}</div>
    </Section>
  );
}

function About() {
  const st = useUpdateStatus();
  const [busy, setBusy] = useState(false);
  const appV = st?.current || import.meta.env.VITE_APP_VERSION || desktop?.version || 'dev';
  return (
    <div className="stack sm" style={{ alignItems: 'center' }}>
      <div className="muted small" style={{ textAlign: 'center' }}>
        StudyBridge {appV} · {desktop ? (desktop.platform === 'darwin' ? 'Mac' : desktop.platform === 'win32' ? 'Windows' : desktop.platform) : 'browser'}
        {desktop && desktop.version !== appV ? ` (desktop ${desktop.version})` : ''}
      </div>
      {desktop?.updatesOn && st && (
        <div className="row small">
          <span className="muted">
            {st.state === 'ready'
              ? `Version ${st.version} is ready (see the banner at the top).`
              : st.state === 'downloading'
                ? `Downloading version ${st.version}…`
                : st.state === 'error'
                  ? 'Couldn’t check for updates just now.'
                  : st.state === 'up-to-date'
                    ? 'You have the latest version.'
                    : 'Updates install by themselves.'}
          </span>
          {st.state !== 'downloading' && (
            <button
              className="linkbtn small"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await desktop.updates.check().catch(() => {});
                setBusy(false);
              }}
            >
              {busy ? 'Checking…' : 'Check now'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
