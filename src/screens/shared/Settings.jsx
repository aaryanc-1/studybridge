import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Field, Page, Toggle, copyText, useConfirm, useRoute, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as store from '../../lib/store.js';
import { sb } from '../../lib/supabase.js';
import { connectLink, desktop, timezone, SUPPORT_EMAIL } from '../../lib/config.js';
import { useUpdateStatus, AccountSwitcher, restartWaiting } from './Shell.jsx';
import { palette } from '../../lib/format.js';
import ReportCard from './ReportCard.jsx';
import { dataZip } from '../../lib/zip.js';
import { bytes } from '../../lib/format.js';
import { setTheme, useTheme, setTextSize, useTextSize, setDataSaver, useDataSaver, setLiveMode, useLiveMode, useSavedBytes } from '../../lib/device.js';
import { studentAccess } from '../../lib/students.js';
import { PayOptions } from '../learner/SelfStudy.jsx';

export default function Settings() {
  const app = useApp();
  const route = useRoute();
  const isTutor = app.me.role === 'tutor';
  const isLearner = app.me.role === 'learner';
  const isStudent = isLearner && !!app.me.self_learner; // studying on their own: no tutor, StudyBridge is who they talk to
  const focus = route.query.get('s');
  useEffect(() => {
    if (focus) document.getElementById('set-' + focus)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [focus]);
  return (
    <Page title="Settings" size="narrow">
      <Account />
      {(isTutor || isLearner) && <CalendarLink />}
      {isTutor && <PhoneAlerts />}
      {isTutor && <PhoneApp />}
      {isTutor && app.me.is_studybridge && <ClaudeConnector />}
      {isStudent && <StudentPlan />}
      {(isTutor || isStudent) && <ContactStudyBridge />}
      {isTutor && <AccountHistory />}
      {app.me.role === 'parent' && <MyChildren />}
      {isLearner && !isStudent && <LinkedParents />}
      {isLearner && !isStudent && <ParentReportsSetting />}
      {isLearner && <LearnerNotifications />}
      {isLearner && <LearnerPhoneAlerts />}
      {isTutor && <YourPlan />}
      {!isTutor && !isStudent && app.me.role !== 'admin' && <Help learner={isLearner} />}
      <Device />
      <YourData />
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
          <div className="muted small">{{ tutor: 'Tutor', learner: 'Learner', admin: 'StudyBridge admin', parent: 'Parent (read-only)' }[app.me.role]}</div>
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
      <AccountSwitcher full />
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
  // an address saved before the move to gostudybridge.com (7 Oct 2026) is ignored
  const [web, setWeb] = useState(() => (localStorage.getItem('sb.webUrl') || '').replace(/^.*github\.io.*$/, '') || import.meta.env.VITE_WEB_URL || (!desktop && location.protocol.startsWith('http') ? location.origin + location.pathname : ''));
  const [qr, setQr] = useState('');
  const link = web && /^https?:\/\//.test(web) ? connectLink(web, app.server) : '';
  useEffect(() => {
    if (!link) return setQr('');
    QRCode.toDataURL(link, { margin: 1, width: 400, errorCorrectionLevel: 'M' }).then(setQr).catch(() => setQr(''));
  }, [link]);
  return (
    <Section id="phone" icon="phone" title="Use StudyBridge on your phone" sub="The phone version is the same app in your phone’s browser. Add it to your home screen and it works like an app, including offline.">
      <Field label="Your StudyBridge web address" hint="Each update publishes the phone version here automatically. Change it only if you host it somewhere else (e.g. your own domain).">
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

function ClaudeConnector() {
  const app = useApp();
  const toast = useToast();
  const [showKey, setShowKey] = useState(false);
  return (
    <Section
      id="claude"
      icon="spark"
      title="Claude Desktop (StudyBridge content)"
      sub="This account holds StudyBridge’s own content. Connect Claude Desktop here to make lessons, practice questions, flashcards and papers for students. Every question is checked again before students see it. Only this account can use the connector."
    >
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
            <div>When Claude asks for settings, paste these (and this account’s email and password):</div>
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
            Try it: in Claude, use the prompt <i>“Make StudyBridge content for a subject”</i>. Then check the questions in a new chat with <i>“Check waiting questions”</i>.
          </div>
        </li>
      </ol>
    </Section>
  );
}

// A private link that puts lessons and due dates in the person's own calendar app
function CalendarLink() {
  const toast = useToast();
  const confirm = useConfirm();
  const [link, setLink] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.calendarLink().then(setLink).catch((e) => setErr(e.message));
  }, []);
  const webcal = link ? link.replace(/^https?:/, 'webcal:') : '';
  return (
    <Section id="calendar" icon="calendar" title="Your calendar" sub="Live lessons and due dates in Google, Apple or Outlook calendar, in your own time zone. It updates by itself (calendar apps check every few hours).">
      {err && <div className="error">{err}</div>}
      {link && (
        <>
          <div className="row wrap">
            <a className="btn primary" href={`https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`} target="_blank" rel="noreferrer">
              <Icon name="calendar" size={16} /> Add to Google Calendar
            </a>
            <a className="btn" href={webcal}>
              Apple / Outlook calendar
            </a>
            <button className="btn" onClick={() => (copyText(link), toast('Calendar link copied'))}>
              <Icon name="copy" size={16} /> Copy link
            </button>
          </div>
          <div className="small muted">
            Keep the link to yourself: anyone with it can see your lessons and due dates.{' '}
            <button
              className="linkbtn"
              onClick={async () => {
                if (!(await confirm({ title: 'Make a new link?', body: 'The old link stops working. Add the new one to your calendar again.', ok: 'New link' }))) return;
                try {
                  setLink(await api.calendarLink(true));
                  toast('New calendar link made');
                } catch (e) {
                  toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
                }
              }}
            >
              Make a new link
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

// A parent's children: stop following one (their tutor is told)
function MyChildren() {
  const toast = useToast();
  const confirm = useConfirm();
  const kids = useQuery('parent-children', api.parentChildren).data || [];
  if (!kids.length) return null;
  return (
    <Section id="children" icon="users" title="Your children" sub="Whose progress you follow. To follow another child, ask their tutor for a parent code.">
      <div className="list">
        {kids.map((k) => (
          <div key={k.id} className="item">
            <span className="grow">
              <span className="name">{k.name}</span>
              <span className="meta">Tutor: {k.tutor}</span>
            </span>
            <button
              className="btn sm ghost"
              onClick={async () => {
                if (!(await confirm({ title: `Stop following ${k.name}?`, body: 'You won’t see their reports or progress any more. Their tutor can give you a new code if you change your mind.', ok: 'Stop following', danger: true }))) return;
                try {
                  await api.parentUnlink(k.id);
                  invalidate('parent-children');
                  toast(`You no longer follow ${k.name}`);
                } catch (e) {
                  toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
                }
              }}
            >
              Stop following
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

// A student on their own: their free week or what they've paid, and how to pay
function StudentPlan() {
  const app = useApp();
  useEffect(() => {
    app.refreshMe(); // a payment the Owner just recorded shows straight away
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const a = studentAccess(app.me);
  const day = (d) => new Date(String(d).slice(0, 10) + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });
  return (
    <Section id="plan" icon="star" title="Your plan">
      <div className="strong">
        {a.paid
          ? `${a.plan === 'pass' ? 'Exam pass' : 'Monthly'}: paid until ${day(a.until)}`
          : a.trial
            ? `Free trial: ${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'} left`
            : 'Your free week is over'}
      </div>
      <div className="small muted">Everything you do is kept, whatever happens with paying.</div>
      <PayOptions />
    </Section>
  );
}

// Write to StudyBridge (the admin): a problem, an idea or a question. Replies come back here.
function ContactStudyBridge() {
  const toast = useToast();
  const q = useQuery('my-feedback', api.myFeedback);
  const [kind, setKind] = useState('question');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const list = q.data || [];
  return (
    <Section id="contact" icon="message" title="Contact StudyBridge" sub={<>A problem, an idea or a question. StudyBridge replies here and you get a notification. Or email <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.</>}>
      <div className="row wrap" style={{ gap: 6 }}>
        {[
          ['question', 'Question'],
          ['problem', 'Something’s wrong'],
          ['idea', 'Idea'],
        ].map(([k, l]) => (
          <button key={k} type="button" className={'pill click' + (kind === k ? ' accent' : '')} onClick={() => setKind(k)}>
            {l}
          </button>
        ))}
      </div>
      <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} placeholder="Write it here…" aria-label="Your message" />
      <div>
        <button
          className="btn primary"
          disabled={busy || body.trim().length < 2}
          onClick={async () => {
            setBusy(true);
            try {
              await api.sendFeedback(kind, body.trim());
              setBody('');
              invalidate('my-feedback');
              toast('Sent. StudyBridge will reply here.');
            } catch (e) {
              toast({ title: 'Couldn’t send', body: e.message, tone: 'bad' });
            } finally {
              setBusy(false);
            }
          }}
        >
          Send
        </button>
      </div>
      {list.length > 0 && (
        <div className="list small">
          {list.map((f) => (
            <div key={f.id} className="item" style={{ alignItems: 'flex-start' }}>
              <span className="grow">
                <span className="pre-wrap">{f.body}</span>
                <span className="meta">
                  {new Date(f.created_at).toLocaleDateString()} · {f.reply ? 'Answered' : f.closed_at ? 'Closed' : 'Waiting for a reply'}
                </span>
                {f.reply && (
                  <span className="note small" style={{ display: 'block', marginTop: 6 }}>
                    <b>StudyBridge:</b> {f.reply}
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// What the StudyBridge admin has done to this account (approvals, password resets…)
function AccountHistory() {
  const q = useQuery('my-admin-log', api.adminLog);
  const app = useApp();
  const list = (q.data || []).filter((x) => x.user_id === app.me.id || x.tutor_id === app.me.id);
  if (!list.length) return null;
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

// Parent accounts that can see this learner's progress (read-only); the learner can take any of them off
function LinkedParents() {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery('my-parents', () => api.learnerParents());
  const list = q.data?.parents || [];
  if (!list.length) return null;
  return (
    <Section id="parents" icon="users" title="Parents who can see your progress" sub="They see your weekly reports, lessons, due dates and marks once they’re given back. Never your messages, your working or anything you write.">
      <div className="list">
        {list.map((p) => (
          <div key={p.id} className="item">
            <Icon name="user" style={{ color: 'var(--accent)' }} />
            <span className="grow">
              <span className="name">{p.name}</span>
              <span className="meta">Since {new Date(p.since).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</span>
            </span>
            <button
              className="btn sm ghost"
              onClick={async () => {
                if (!(await confirm({ title: `Remove ${p.name}?`, body: 'They stop seeing your progress straight away. Your tutor can give them a new parent invite later.', ok: 'Remove', danger: true }))) return;
                try {
                  await api.removeParent(p.id);
                  invalidate('my-parents');
                  toast(`${p.name} removed`);
                } catch (e) {
                  toast({ title: 'Couldn’t remove them', body: e.message, tone: 'bad' });
                }
              }}
            >
              Remove
            </button>
          </div>
        ))}
      </div>
    </Section>
  );
}

// The learner decides whether a parent gets a weekly report, and who
function ParentReportsSetting() {
  const toast = useToast();
  const app = useApp();
  const mine = useQuery('learner-reports', api.listLearnerReports);
  const sent = useQuery('parent-reports', api.listParentReports);
  const cur = (mine.data || []).find((r) => r.learner_id === app.me.id);
  const [v, setV] = useState(null);
  useEffect(() => {
    if (mine.data && !v) setV({ on: !!cur?.enabled, name: cur?.parent_name || '', phone: cur?.parent_phone || '', email: cur?.parent_email || '' });
  }, [mine.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return null;
  async function saveIt(next) {
    try {
      await api.setParentReports(next.on, next.name, next.phone, next.email);
      invalidate('learner-reports');
      toast(next.on ? 'Weekly reports are on' : 'Weekly reports are off');
      setV(next);
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    }
  }
  return (
    <Section id="reports" icon="send" title="Weekly report for a parent" sub="If you switch this on, your tutor sends a parent a short weekly report: lessons, work handed in, marks, what you’re strong at and what to work on. Your tutor checks each one, and you can read every report that was sent.">
      <Toggle checked={v.on} onChange={(on) => (on ? setV({ ...v, on }) : saveIt({ ...v, on: false }))} title="Send my parent a weekly report" />
      {v.on && (
        <div className="stack sm">
          <div className="grid g2">
            <Field label="Their name">
              <input className="input" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="e.g. Mum" />
            </Field>
            <Field label="WhatsApp number" hint="With the country code, e.g. +260 97…">
              <input className="input" inputMode="tel" value={v.phone} onChange={(e) => setV({ ...v, phone: e.target.value })} placeholder="+260…" />
            </Field>
          </div>
          <Field label="Email (optional)">
            <input className="input" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} />
          </Field>
          <div>
            <button className="btn primary" onClick={() => saveIt(v)}>
              Save
            </button>
          </div>
        </div>
      )}
      {(sent.data || []).length > 0 && (
        <details>
          <summary className="small strong">Reports sent so far ({sent.data.length})</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            {sent.data.map((r) => (
              <ReportCard key={r.id} report={r} compact />
            ))}
          </div>
        </details>
      )}
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

// Lesson reminders (and other alerts) on a learner's phone through the free ntfy app
function LearnerPhoneAlerts() {
  const toast = useToast();
  const q = useQuery('phone-alerts', () => api.myPhoneAlerts());
  const d = q.data;
  if (!d) return null;
  return (
    <Section id="phone-alerts" icon="bell" title="Reminders on your phone" sub="Lesson reminders and other StudyBridge alerts as phone notifications, even when the app is closed.">
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
            <div>Tap + and subscribe to this topic (keep it private, like a password):</div>
            <div className="row">
              <span className="code-box" style={{ flex: 1 }}>{d.topic}</span>
              <button className="btn sm" onClick={() => (copyText(d.topic), toast('Topic copied'))}>
                <Icon name="copy" size={14} /> Copy
              </button>
            </div>
          </div>
        </li>
      </ol>
      <Toggle
        checked={d.enabled}
        onChange={async (v) => {
          q.mutate({ ...d, enabled: v });
          try {
            await api.myPhoneAlerts(v);
          } catch (e) {
            q.mutate(d);
            toast({ title: 'Couldn’t change that', body: e.message, tone: 'bad' });
          }
        }}
        title="Send reminders to my phone"
      />
    </Section>
  );
}

// The tutor's plan: how full it is, and (once StudyBridge takes payments) upgrading or managing it
const PLAN = {
  free: { name: 'Free', learners: 1 },
  starter: { name: 'Starter', learners: 5, month: '$15 a month', year: '$150 a year (2 months free)' },
  pro: { name: 'Pro', learners: 25, month: '$29 a month', year: '$290 a year (2 months free)' },
};
function YourPlan() {
  const toast = useToast();
  const q = useQuery('my-plan', api.myPlan);
  const pub = useQuery('public-settings', api.publicSettings).data || {};
  const [period, setPeriod] = useState('month');
  const [busy, setBusy] = useState('');
  const p = q.data;
  if (!p) return null;
  const cur =
    p.plan === 'custom'
      ? { name: 'Custom', learners: p.limit }
      : p.plan === 'complimentary'
        ? { name: p.until ? `Complimentary (free until ${new Date(p.until + 'T12:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })})` : 'Complimentary (free)', learners: p.limit }
        : PLAN[p.plan] || { name: p.plan, learners: p.limit };
  const setByUs = p.plan === 'custom' || p.plan === 'complimentary';
  async function open(fn, what) {
    setBusy(what);
    try {
      const r = await fn();
      if (r?.url) window.open(r.url, '_blank'); // the desktop app opens this in the browser
    } catch (e) {
      toast({ title: 'Couldn’t open payments', body: e.message, tone: 'bad' });
    } finally {
      setBusy('');
    }
  }
  return (
    <Section id="plan" icon="star" title="Your plan" sub={`${cur.name}: up to ${cur.learners} learner${cur.learners === 1 ? '' : 's'}. You have ${p.learners}.${p.renews_at ? ` Renews ${new Date(p.renews_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.` : ''}`}>
      <div className="plan-meter" aria-label={`${p.learners} of ${p.limit} learners`}>
        <span style={{ width: `${Math.min(100, (p.learners / Math.max(1, p.limit)) * 100)}%` }} />
      </div>
      {!p.enforced && <div className="small muted">Plan limits aren’t switched on yet, so you can add as many learners as you like for now.</div>}
      {setByUs ? (
        <div className="small muted">Your plan was set up for you by StudyBridge. Contact StudyBridge from Settings to change it.</div>
      ) : pub.payments_on ? (
        <div className="stack sm">
          <div className="seg" role="group" aria-label="Pay">
            <button type="button" aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>
              Monthly
            </button>
            <button type="button" aria-pressed={period === 'year'} onClick={() => setPeriod('year')}>
              Yearly (1 month free)
            </button>
          </div>
          <div className="row wrap">
            {['starter', 'pro']
              .filter((k) => k !== p.plan)
              .map((k) => (
                <button key={k} className="btn primary" disabled={!!busy} onClick={() => open(() => api.checkout(k, period), k)}>
                  {busy === k ? 'Opening…' : `${PLAN[k].name}: ${PLAN[k][period]}`}
                </button>
              ))}
            {p.has_billing && (
              <button className="btn" disabled={!!busy} onClick={() => open(api.billingPortal, 'billing')}>
                Manage or cancel
              </button>
            )}
          </div>
          <div className="tiny muted">Payment opens in your browser (Stripe). Your plan changes here as soon as it’s paid.</div>
        </div>
      ) : (
        <div className="small muted">
          Plans are priced per learner: Essentials from $5 and Plus from $8 per learner a month (Plus adds Prof). Try everything free for 7 days. During early access, StudyBridge arranges payment with you directly.
        </div>
      )}
    </Section>
  );
}

// Download everything that's yours, or delete your account
function YourData() {
  const app = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [typed, setTyped] = useState('');
  if (app.me.role === 'admin') return null;
  return (
    <Section id="data" icon="download" title="Your data" sub="Download a copy of everything that’s yours, or delete your account.">
      <div className="row wrap">
        <button
          className="btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const zip = dataZip(await api.exportMyData());
              const name = `studybridge-data-${new Date().toISOString().slice(0, 10)}.zip`;
              if (desktop?.saveFile) await desktop.saveFile(name, new Uint8Array(await zip.arrayBuffer()));
              else {
                const a = document.createElement('a');
                a.href = URL.createObjectURL(zip);
                a.download = name;
                a.click();
                setTimeout(() => URL.revokeObjectURL(a.href), 5000);
              }
              toast('Your data is downloaded');
            } catch (e) {
              toast({ title: 'Couldn’t download it', body: e.message, tone: 'bad' });
            } finally {
              setBusy(false);
            }
          }}
        >
          <Icon name="download" size={16} /> {busy ? 'Getting it ready…' : 'Download my data'}
        </button>
        <button className="btn danger ghost" onClick={() => setDeleting((x) => !x)} aria-expanded={deleting}>
          <Icon name="trash" size={16} /> Delete my account
        </button>
      </div>
      {deleting && (
        <div className="note small stack sm">
          <div className="strong">This can’t be undone.</div>
          <div>
            {app.me.role === 'tutor'
              ? 'Your subjects, work, marks, reports and files are deleted. Your learners keep their accounts and can join another tutor with a new invite; their work with you is deleted.'
              : app.me.role === 'learner'
                ? 'Your work, marks and messages are deleted, and your tutor is told.'
                : 'Your parent account and its links are deleted.'}{' '}
            Download your data first if you want a copy.
          </div>
          <div className="row wrap">
            <input className="input" style={{ maxWidth: 200 }} value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type DELETE" aria-label="Type DELETE to confirm" />
            <button
              className="btn danger solid"
              disabled={typed.trim().toUpperCase() !== 'DELETE'}
              onClick={async () => {
                try {
                  await api.deleteMyAccount(typed);
                  toast('Your account has been deleted');
                  app.signOut();
                } catch (e) {
                  toast({ title: 'Couldn’t delete it', body: e.message, tone: 'bad' });
                }
              }}
            >
              Delete my account
            </button>
          </div>
        </div>
      )}
    </Section>
  );
}

function Appearance() {
  const theme = useTheme();
  const size = useTextSize();
  return (
    <div className="stack sm">
      <div className="small strong">Appearance</div>
      <div className="seg" role="group" aria-label="Appearance">
        {[
          ['light', 'Light'],
          ['dark', 'Dark'],
          ['auto', 'Same as this device'],
        ].map(([v, l]) => (
          <button key={v} type="button" aria-pressed={theme === v} onClick={() => setTheme(v)}>
            {l}
          </button>
        ))}
      </div>
      <div className="small strong" style={{ marginTop: 6 }}>
        Text size
      </div>
      <div className="seg" role="group" aria-label="Text size">
        {[
          ['normal', 'Normal'],
          ['large', 'Large'],
          ['xl', 'Extra large'],
        ].map(([v, l]) => (
          <button key={v} type="button" aria-pressed={size === v} onClick={() => setTextSize(v)}>
            {l}
          </button>
        ))}
      </div>
    </div>
  );
}

// Learners and parents: where to get help
function Help({ learner }) {
  return (
    <Section id="help" icon="info" title="Help" sub={learner ? 'Stuck on your work? Ask your tutor in Messages.' : 'Questions about your child’s work? Ask their tutor.'}>
      <div className="small">
        A problem with the app itself? Email <a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Help with StudyBridge')}`}>{SUPPORT_EMAIL}</a> and we’ll help.
      </div>
    </Section>
  );
}

// For learners on phone data: smaller photos, PDFs a page at a time, pictures on tap, lighter live lessons
function DataSaver() {
  const on = useDataSaver();
  const live = useLiveMode();
  const saved = useSavedBytes();
  return (
    <div className="stack sm">
      <Toggle
        checked={on}
        onChange={setDataSaver}
        icon="wifiOff"
        title="Data saver"
        sub="Uses less mobile data on this device: photos of your work are made smaller, PDFs load a page at a time, pictures load when you tap them, and live lessons use less video."
      />
      {on && (
        <div className="stack sm" style={{ paddingLeft: 8 }}>
          <div className="small strong">In live lessons</div>
          <div className="seg" role="group" aria-label="Live lessons on data saver">
            <button type="button" aria-pressed={live === 'low'} onClick={() => setLiveMode('low')}>
              Low-quality video
            </button>
            <button type="button" aria-pressed={live === 'audio'} onClick={() => setLiveMode('audio')}>
              Audio only
            </button>
          </div>
          <div className="tiny muted">{live === 'audio' ? 'No cameras, so it uses the least data. The whiteboard and shared screens still show.' : 'Smaller, smoother video that uses much less data.'}</div>
        </div>
      )}
      {saved > 0 && <div className="small muted">Data saver has saved about {bytes(saved)} on this device so far.</div>}
    </div>
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
      <Appearance />
      <DataSaver />
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
            if (!(await confirm({ title: 'Remove offline copies?', body: 'Files download again next time you open them. Anything waiting to send is kept, and so are past papers kept only on this computer.', ok: 'Remove' }))) return;
            // past papers imported to this computer only live here: never remove them
            for (const k of await store.blobs.keys()) if (!String(k).startsWith('library/local/')) await store.blobs.del(k);
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
            {restartWaiting(st)
              ? `Version ${st.version} is downloaded. Restart StudyBridge to use it.`
              : st.state === 'ready'
              ? `Version ${st.version} is ready (see the banner at the top).`
              : st.state === 'downloading'
                ? `Downloading version ${st.version}…`
                : st.state === 'error'
                  ? 'Couldn’t update just now. Try again, or get it from gostudybridge.com/download.'
                  : st.state === 'up-to-date'
                    ? 'You have the latest version.'
                    : 'Updates install by themselves.'}
          </span>
          {restartWaiting(st) && (
            <button className="linkbtn small" onClick={() => desktop.restart()}>
              Restart now
            </button>
          )}
          {st.state !== 'downloading' && !restartWaiting(st) && (
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
