import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Field, Modal, Page, Toggle, copyText, useConfirm, useRoute, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as store from '../../lib/store.js';
import { sb } from '../../lib/supabase.js';
import { connectLink, desktop, timezone, SUPPORT_EMAIL } from '../../lib/config.js';
import { useUpdateStatus, AccountSwitcher, restartWaiting } from './Shell.jsx';
import { ago, palette } from '../../lib/format.js';
import { restartDesktop } from '../../lib/autoupdate.js';
import ReportCard from './ReportCard.jsx';
import { dataZip } from '../../lib/zip.js';
import { bytes } from '../../lib/format.js';
import { setTheme, useTheme, setTextSize, useTextSize, setDataSaver, useDataSaver, setLiveMode, useLiveMode, useSavedBytes } from '../../lib/device.js';
import { studentAccess } from '../../lib/students.js';
import { PayOptions } from '../learner/SelfStudy.jsx';
import MobileMoney from './MobileMoney.jsx';
import { SetUpChild, AddWithCode } from '../parent/ChildCodes.jsx';
import site from '../../../website/site.config.json';

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
      {isTutor && <YourOrganisation />}
      {(isTutor || isLearner) && <CalendarLink />}
      {isTutor && <PhoneAlerts />}
      {isTutor && <PhoneApp />}
      {isTutor && app.me.is_studybridge && <ClaudeConnector />}
      {isStudent && <StudentPlan />}
      {(isTutor || isStudent) && <ContactStudyBridge />}
      {isTutor && <AccountHistory />}
      {app.me.role === 'parent' && <MyChildren />}
      {app.me.role === 'parent' && <SetUpChild />}
      {app.me.role === 'parent' && <AddWithCode />}
      {isStudent && <ParentCodes />}
      {isLearner && <LinkedParents />}
      {isLearner && !isStudent && <JoinClass />}
      {isLearner && !isStudent && <ParentReportsSetting />}
      {isLearner && <LearnerNotifications />}
      {isLearner && <StudyReminder />}
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

// A tutor's organisation: their own, or a tuition centre other tutors join with its code. Each tutor keeps their
// own learners, classes and work and approves everything for them; a centre's managers also see everyone in Centre.
// Who pays in a centre: each tutor for their own learners, or the centre for everyone (one bill, paid by a manager
// in Settings → Your plan). Tutors see which it is.
function CentreBilling({ manager }) {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery('org-billing', api.myOrgBilling);
  const [busy, setBusy] = useState(false);
  const b = q.data;
  if (!b) return null;
  const centrePays = b.billing === 'centre';
  async function set(centre, level = null) {
    if (
      !centre &&
      !(await confirm({
        title: 'Stop the centre paying for everyone?',
        body: 'Each tutor then pays for their own learners. Tutors who haven’t paid get a free week to sort it out.',
        ok: 'Each tutor pays',
      }))
    )
      return;
    setBusy(true);
    try {
      await api.orgSetBilling(centre, level);
      invalidate('org-billing', 'my-plan', 'org');
      toast(centre ? { title: 'The centre pays for everyone now', body: 'Pay for it in Settings → Your plan. It starts with a free week.' } : 'Each tutor pays for their own learners now');
    } catch (e) {
      toast({ title: 'Couldn’t change it', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <hr />
      <div className="stack sm">
        <h3>Who pays</h3>
        {manager ? (
          <>
            <div className="seg" role="group" aria-label="Who pays">
              <button type="button" aria-pressed={!centrePays} disabled={busy} onClick={() => centrePays && set(false)}>
                Each tutor pays for their own learners
              </button>
              <button type="button" aria-pressed={centrePays} disabled={busy} onClick={() => !centrePays && set(true, b.level)}>
                The centre pays for everyone
              </button>
            </div>
            {centrePays && (
              <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
                <span className="small">Level for everyone:</span>
                <div className="seg" role="group" aria-label="The centre’s level">
                  {LEVELS.map((l) => (
                    <button key={l.id} type="button" aria-pressed={b.level === l.id} disabled={busy} onClick={() => b.level !== l.id && set(true, l.id)}>
                      {l.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="small muted">
              {centrePays
                ? `One bill for the whole centre: ${b.learners} learner${b.learners === 1 ? '' : 's'} now. Pay for it in Settings → Your plan.`
                : 'Each tutor pays for their own learners in their own Settings → Your plan.'}
            </div>
          </>
        ) : (
          <div className="small muted">
            {centrePays ? 'The centre pays for StudyBridge for everyone (one bill). Your manager looks after it.' : 'Each tutor pays for their own learners (Settings → Your plan).'}
          </div>
        )}
      </div>
    </>
  );
}

function YourOrganisation() {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery('org', api.myOrg);
  const o = q.data;
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (o?.name) setName(o.name);
  }, [o?.name]);
  if (!o) return null;
  const centre = o.kind === 'centre' || o.kind === 'school';
  const manager = o.role === 'manager';
  const members = o.members || [];
  const tutors = `${members.length} tutor${members.length === 1 ? '' : 's'}`;
  const about = {
    tutor: 'Your own organisation: your learners, classes and work are in it.',
    centre: `A tuition centre with ${tutors}. Each tutor marks and approves everything for their own learners.`,
    school: `A school with ${tutors}. Each tutor marks and approves everything for their own learners.`,
    studybridge: 'StudyBridge’s own organisation. Students studying on their own are in it.',
  }[o.kind];
  const shownCode = o.code ? `${o.code.slice(0, 4)} ${o.code.slice(4)}` : '';
  // every change comes back as the organisation as it is now
  async function act(fn, done) {
    setBusy(true);
    try {
      const r = await fn();
      q.mutate(r);
      invalidate('org', 'org-overview'); // the menu shows Centre only to a centre's managers
      toast(typeof done === 'function' ? done(r) : done);
      return true;
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section id="org" icon="users" title="Your organisation">
      <div>
        <div className="strong">{o.name}</div>
        <div className="small muted">{about}</div>
      </div>
      {o.kind !== 'studybridge' && (
        <>
          {manager && (
            <form
              className="row wrap"
              style={{ alignItems: 'flex-end' }}
              onSubmit={(e) => {
                e.preventDefault();
                act(() => api.orgRename(name.trim()), 'Name saved');
              }}
            >
              <div className="grow" style={{ maxWidth: 360 }}>
                <Field label="Name">
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
                </Field>
              </div>
              <button className="btn" disabled={busy || !name.trim() || name.trim() === o.name}>
                Save
              </button>
            </form>
          )}

          {o.kind === 'tutor' && (
            <>
              {manager && (
                <>
                  <hr />
                  <div className="stack sm">
                    <h3>Run a tuition centre?</h3>
                    <div className="small muted">
                      Make this a tuition centre and other tutors can join it with a code. They keep their own learners and work, and still mark and approve everything for them. You see every tutor and learner in a Centre page.
                    </div>
                    <div>
                      <button className="btn" disabled={busy} onClick={() => act(() => api.orgMakeCentre(), (r) => ({ title: `${r.name} is a tuition centre now`, body: 'Send its code to the tutors who’ll join.' }))}>
                        Make it a tuition centre
                      </button>
                    </div>
                  </div>
                </>
              )}
              <hr />
              <div className="stack sm">
                <h3>Join a centre</h3>
                <div className="small muted">Got a code from a tuition centre? Your learners, classes and work come with you, and you still mark and approve everything for your own learners.</div>
                <form
                  className="row wrap"
                  style={{ alignItems: 'flex-end' }}
                  onSubmit={async (e) => {
                    e.preventDefault();
                    if (await act(() => api.orgJoin(code), (r) => `You’re in ${r.name} now`)) setCode('');
                  }}
                >
                  <div style={{ maxWidth: 240 }}>
                    <Field label="Code from the centre">
                      <input className="input code-in" value={code} onChange={(e) => setCode(e.target.value)} placeholder="4829 1375" inputMode="numeric" autoComplete="off" spellCheck={false} />
                    </Field>
                  </div>
                  <button className="btn primary" disabled={busy || !code.trim()}>
                    Join the centre
                  </button>
                </form>
              </div>
            </>
          )}

          {centre && manager && o.code && (
            <div className="code-card">
              <span className="small">Code for tutors to join</span>
              <b className="code-show">{shownCode}</b>
              <span className="small muted">They type it in Settings → Your organisation → Join a centre.</span>
              <span className="row wrap" style={{ gap: 8 }}>
                <button
                  className="btn sm"
                  onClick={() => {
                    copyText(`Join ${o.name} on StudyBridge: open StudyBridge, go to Settings → Your organisation → Join a centre, and type ${shownCode}.`);
                    toast('Message copied');
                  }}
                >
                  <Icon name="copy" size={14} /> Copy message
                </button>
                <button
                  className="btn sm ghost"
                  disabled={busy}
                  onClick={async () => {
                    if (await confirm({ title: 'Make a new code?', body: 'The old one stops working.', ok: 'New code' })) act(() => api.orgNewCode(), 'New code made');
                  }}
                >
                  <Icon name="refresh" size={14} /> New code
                </button>
              </span>
            </div>
          )}

          {centre && <CentreBilling manager={manager} />}

          {centre && (
            <>
              <hr />
              <div className="stack sm">
                <h3>Tutors in the centre</h3>
                <div className="list">
                  {members.map((m) => (
                    <div key={m.id} className="item" style={{ flexWrap: 'wrap' }}>
                      <Avatar person={{ id: m.id, display_name: m.name }} size="sm" />
                      <span className="grow">
                        <span className="name">
                          {m.name}
                          {m.me ? ' (you)' : ''}
                        </span>
                        <span className="meta">
                          <span className={'pill' + (m.role === 'manager' ? ' accent' : '')}>{m.role === 'manager' ? 'Manager' : 'Tutor'}</span>
                          <span>
                            {m.learners} learner{Number(m.learners) === 1 ? '' : 's'}
                          </span>
                        </span>
                      </span>
                      {manager && !m.me && (
                        <span className="row wrap" style={{ gap: 6 }}>
                          <button
                            className="btn sm"
                            disabled={busy}
                            onClick={() =>
                              m.role === 'manager'
                                ? act(() => api.orgSetRole(m.id, 'tutor'), `${m.name} isn’t a manager any more`)
                                : act(() => api.orgSetRole(m.id, 'manager'), `${m.name} is a manager now`)
                            }
                          >
                            {m.role === 'manager' ? 'Make tutor' : 'Make manager'}
                          </button>
                          <button
                            className="btn sm ghost"
                            disabled={busy}
                            onClick={async () => {
                              if (await confirm({ title: `Take ${m.name} out of ${o.name}?`, body: 'They keep their learners, classes and work.', ok: 'Take them out', danger: true }))
                                act(() => api.orgRemove(m.id), `${m.name} is no longer in ${o.name}`);
                            }}
                          >
                            Take out of the centre
                          </button>
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                <div>
                  <button
                    className="btn danger ghost"
                    disabled={busy}
                    onClick={async () => {
                      const alone = members.length === 1;
                      const body = alone ? 'You’re the only tutor in it, so it goes back to being your own organisation and its code stops working.' : 'Your learners, classes and work come with you.';
                      if (await confirm({ title: `Leave ${o.name}?`, body, ok: 'Leave', danger: true })) act(() => api.orgLeave(), alone ? `${o.name} is your own organisation again` : `You left ${o.name}`);
                    }}
                  >
                    Leave the centre
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}
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
    <Section id="children" icon="users" title="Your children" sub="Whose progress you follow. To follow another child, use a parent code from their tutor or from them.">
      <div className="list">
        {kids.map((k) => (
          <div key={k.id} className="item">
            <span className="grow">
              <span className="name">{k.name}</span>
              <span className="meta">{k.self ? 'Studying on their own' : `Tutor: ${k.tutor}`}</span>
            </span>
            {k.set_up_by_me && <CloseChildAccount child={k} />}
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

// A student on their own gives a parent a code to follow their progress (the parent can also pay for them)
function ParentCodes() {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery('my-parents', () => api.learnerParents());
  const [name, setName] = useState('');
  const codes = q.data?.invites || [];
  return (
    <Section id="parent-codes" icon="users" title="Your parents" sub="Give a parent a code so they can follow your plan and progress, and pay for you if they like. They never see your answers or messages.">
      <div className="row wrap">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Their name, e.g. Mum" aria-label="Parent’s name" style={{ maxWidth: 220 }} />
        <button
          className="btn"
          onClick={async () => {
            try {
              await api.selfParentInvite(name.trim());
              invalidate('my-parents');
              setName('');
            } catch (e) {
              toast({ title: 'Couldn’t make a code', body: e.message, tone: 'bad' });
            }
          }}
        >
          Make a parent code
        </button>
      </div>
      {codes.length > 0 && (
        <div className="stack sm">
          {codes.map((c) => (
            <div key={c.id} className="code-card">
              <span className="small">
                Code for <b>{c.name || 'a parent'}</b>
              </span>
              <b className="code-show">{c.code}</b>
              <span className="small muted">They choose “I’m a parent” → “I have a parent code” in StudyBridge</span>
              <span className="row wrap" style={{ gap: 8 }}>
              <button
                className="btn sm"
                onClick={async () => {
                  await copyText(`Follow my progress on StudyBridge: open ${api.WEB_APP}#start=parent, choose “I have a parent code” and type ${c.code}.`);
                  toast('Copied');
                }}
              >
                <Icon name="copy" size={14} /> Copy message
              </button>
              <button
                className="btn sm ghost"
                onClick={async () => {
                  if (!(await confirm({ title: 'Cancel this code?', body: 'It stops working straight away.', ok: 'Cancel code', danger: true }))) return;
                  await api.revokeParentInvite(c.id).catch((e) => toast({ title: 'Couldn’t cancel it', body: e.message, tone: 'bad' }));
                  invalidate('my-parents');
                }}
              >
                Cancel
              </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Section>
  );
}

// Children's privacy: the parent who set up a young child's account can close it (typing DELETE)
function CloseChildAccount({ child }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  return (
    <>
      <button className="btn sm danger" onClick={() => setOpen(true)}>
        Close their account
      </button>
      {open && (
        <Modal
          title={`Close ${child.name}’s account?`}
          onClose={() => setOpen(false)}
          foot={
            <>
              <button className="btn" onClick={() => setOpen(false)}>
                Keep it
              </button>
              <button
                className="btn danger"
                disabled={typed.trim().toUpperCase() !== 'DELETE'}
                onClick={async () => {
                  try {
                    await api.parentDeleteChild(child.id, typed);
                    invalidate('parent-children');
                    toast(`${child.name}’s account is closed`);
                    setOpen(false);
                  } catch (e) {
                    toast({ title: 'Couldn’t close it', body: e.message, tone: 'bad' });
                  }
                }}
              >
                Close the account
              </button>
            </>
          }
        >
          <div className="stack sm">
            <div className="small">Everything in it is deleted for good: their plan, work, marks and progress. This can’t be undone. Type DELETE to confirm.</div>
            <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type DELETE" autoFocus />
          </div>
        </Modal>
      )}
    </>
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

// A class code from a teacher (at a school, a centre or another tutor): the learner joins that class and keeps their
// own tutor too
function JoinClass() {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      const r = await api.joinClass(code);
      setCode('');
      invalidate('assignments', 'lessons', 'files', 'sessions', 'subjects', 'topics', 'learner_subjects', 'my-teachers');
      toast(r.already ? `You’re already in ${r.class}` : `You’re in ${r.class} now`);
    } catch (x) {
      setErr(x.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section id="join-class" icon="users" title="Join a class" sub="Has a teacher given you a class code? Type it here to join their class. You keep your own tutor too.">
      <form className="row wrap" style={{ alignItems: 'flex-end' }} onSubmit={submit}>
        <div style={{ maxWidth: 240 }}>
          <Field label="Class code">
            <input className="input code-in" value={code} onChange={(e) => (setCode(e.target.value), setErr(''))} placeholder="4829 1375" inputMode="numeric" autoComplete="off" spellCheck={false} />
          </Field>
        </div>
        <button className="btn primary" disabled={busy || !code.trim()}>
          Join the class
        </button>
      </form>
      {err && <div className="error">{err}</div>}
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
      ) : perm === 'denied' ? (
        // the browser was told no before: only its own settings can switch them back on
        <div className="note small">
          Notifications are blocked for StudyBridge on this {desktop ? 'computer' : 'browser'}. To turn them on,{' '}
          {desktop
            ? 'open your computer’s notification settings and allow StudyBridge.'
            : 'click the lock (or settings) icon next to the web address, set Notifications to Allow, then reload this page.'}
        </div>
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

// Daily study reminder (learners): at the time they pick, a nudge on days they haven't studied by then.
// In a browser it's the browser's own notification (web push), even with StudyBridge closed. The desktop app
// has no web push, so there it shows while StudyBridge is open (and on the phone through phone alerts).
const onIPhone = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const onHomeScreen = () => navigator.standalone === true || !!window.matchMedia?.('(display-mode: standalone)')?.matches;
function pushKind() {
  if (desktop) return 'desktop';
  if (onIPhone() && !onHomeScreen()) return 'iphone'; // iPhones only allow it from the Home Screen
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || typeof Notification === 'undefined') return 'none';
  return 'push';
}
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const toB64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
// The web app registers its service worker as it starts; give it a moment
async function pushRegistration() {
  const reg = await navigator.serviceWorker.getRegistration();
  return reg || Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 3000))]);
}

function StudyReminder() {
  const toast = useToast();
  const kind = pushKind();
  const [endpoint, setEndpoint] = useState(kind === 'push' ? undefined : null); // this browser's push address (null: none)
  const [perm, setPerm] = useState(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [key, setKey] = useState(null);
  const [time, setTime] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (kind !== 'push') return;
    pushRegistration()
      .then((reg) => reg?.pushManager.getSubscription())
      .then((s) => setEndpoint(s?.endpoint || null))
      .catch(() => setEndpoint(null));
    // ready ahead, so switching on goes straight from "Allow" to subscribing
    api.pushKey().then(setKey).catch(() => {});
  }, [kind]);
  const q = useQuery('study-reminder', () => api.myStudyReminder(endpoint), { enabled: endpoint !== undefined });
  const d = q.data;
  useEffect(() => {
    if (d?.time) setTime(d.time);
  }, [d?.time]);
  if (!d) return null;

  // This browser: notifications allowed, then subscribed with StudyBridge's key and saved
  async function addThisDevice(asking) {
    const p = await (asking || Notification.requestPermission());
    setPerm(p);
    if (p !== 'granted') return null;
    const reg = await pushRegistration();
    if (!reg) throw new Error('Open StudyBridge at gostudybridge.com/app to get reminders in this browser.');
    const k = key || (await api.pushKey());
    if (!k) throw new Error('Reminders aren’t ready yet. Try again in a minute.');
    let s = await reg.pushManager.getSubscription();
    if (s && s.options?.applicationServerKey && toB64url(s.options.applicationServerKey) !== k) {
      await s.unsubscribe(); // made with another key: start again
      s = null;
    }
    s ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(k) });
    await api.savePushSubscription(s.toJSON());
    setEndpoint(s.endpoint);
    return s.endpoint;
  }
  async function deviceOn(asking) {
    try {
      const ep = await addThisDevice(asking);
      if (ep) q.mutate(await api.myStudyReminder(ep));
    } catch (e) {
      toast({ title: 'This device couldn’t be set up', body: e.message, tone: 'bad' });
    }
  }
  async function turn(on) {
    // the tap itself asks for notifications (iPhones insist), before anything else happens
    const asking = on && kind === 'push' && perm === 'default' ? Notification.requestPermission() : null;
    setBusy(true);
    try {
      q.mutate(await api.setStudyReminder(on, time));
      toast(on ? 'Daily reminder is on' : 'Daily reminder is off');
      if (on && kind === 'push' && perm !== 'denied') await deviceOn(asking);
    } catch (e) {
      toast({ title: 'Couldn’t change that', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function saveTime() {
    setBusy(true);
    try {
      q.mutate({ ...(await api.setStudyReminder(d.on, time)), this_device: d.this_device });
      toast('Saved');
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function sendTest() {
    setBusy(true);
    try {
      const r = await api.sendTestReminder();
      toast(r?.devices ? 'Test sent. It should arrive in a few seconds.' : 'Test sent. It shows in your StudyBridge notifications (the bell).');
    } catch (e) {
      toast({ title: 'Couldn’t send a test', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  const here =
    kind === 'desktop' ? (
      <div className="note small">On this computer: shown when StudyBridge is open; also on your phone if phone alerts are on (below).</div>
    ) : kind === 'iphone' ? (
      <div className="note small">On iPhone or iPad, add StudyBridge to your Home Screen first: tap Share, then “Add to Home Screen”. Open it from there and come back to this page.</div>
    ) : kind === 'none' ? (
      <div className="note small">This browser can’t show reminders. You’ll still see them in StudyBridge, and on your phone if phone alerts are on (below).</div>
    ) : perm === 'denied' ? (
      <div className="note small">Notifications are blocked: allow them in your browser’s site settings (the lock or settings icon next to the web address), then reload this page.</div>
    ) : d.this_device && perm === 'granted' ? (
      <div className="okmsg">This device gets the reminder.</div>
    ) : (
      <div className="row wrap">
        <span className="muted small grow">This device doesn’t get it yet.</span>
        <button className="btn sm" disabled={busy} onClick={() => deviceOn(null)}>
          Get it on this device
        </button>
      </div>
    );
  return (
    <Section id="study-reminder" icon="clock" title="Daily study reminder" sub="Pick a time. If you haven’t studied by then, StudyBridge gives you a friendly nudge.">
      <Toggle checked={d.on} disabled={busy} onChange={turn} title="Remind me to study each day" />
      <div className="row wrap" style={{ alignItems: 'flex-end' }}>
        <Field label="Time">
          <input className="input" type="time" value={time} onChange={(e) => setTime(e.target.value)} style={{ maxWidth: 160 }} />
        </Field>
        {time && time !== d.time && (
          <button className="btn" disabled={busy} onClick={saveTime}>
            Save time
          </button>
        )}
      </div>
      {d.on && (
        <>
          <div className="muted small">
            Next one: {d.today_done ? 'tomorrow' : 'today'} at {d.time} ({String(d.timezone || '').replace(/_/g, ' ')} time), only if you haven’t studied by then.
          </div>
          {here}
          <div>
            <button className="btn sm" disabled={busy} onClick={sendTest}>
              Send me a test
            </button>
          </div>
        </>
      )}
    </Section>
  );
}

// The tutor's plan: Essentials or Plus (website/site.config.json → tutorLevels), whether Plus is on now, what each
// level would cost for their learners, and asking StudyBridge to switch (payment is arranged by hand for now)
const LEVELS = site.tutorLevels;
const usd = (n) => '$' + n.toLocaleString('en-US');
const planDay = (d) => new Date(String(d).length === 10 ? d + 'T12:00' : d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
// A month for n learners, step by step: 12 learners on Plus = 10 × $8 + 2 × $6 = $92
function levelCost(level, n) {
  const parts = [];
  let from = 0;
  for (const s of level.steps) {
    const to = s.upTo ?? Infinity;
    if (n > from) parts.push({ n: Math.min(n, to) - from, price: s.price });
    from = to;
  }
  return { total: parts.reduce((t, x) => t + x.n * x.price, 0), parts };
}
// "$8 each for learners 1–10, $6 for 11–30, $4 after that"
const stepsText = (level) =>
  level.steps
    .map((s, i) => {
      const from = i ? level.steps[i - 1].upTo + 1 : 1;
      if (s.upTo == null) return i ? `${usd(s.price)} after that` : `${usd(s.price)} each`;
      return i ? `${usd(s.price)} for ${from}–${s.upTo}` : `${usd(s.price)} each for learners ${from}–${s.upTo}`;
    })
    .join(', ');
// Whole months from today to a paid-up date (a part month counts as one), as the server works out added places
function monthsLeft(until) {
  const a = new Date();
  const b = new Date(String(until).slice(0, 10) + 'T12:00');
  const m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) + (b.getDate() > a.getDate() ? 1 : 0);
  return Math.max(1, m);
}
const ess = (n) => (n === 1 ? '' : 's');
// A tutor's plan: their level, where it stands (free week, paid by card, paid up to a date for a number of learners,
// or not paid), and paying. When their centre pays for everyone, it's the centre's plan, and only its manager pays.
function YourPlan() {
  const toast = useToast();
  const q = useQuery('my-plan', api.myPlan);
  const pub = useQuery('public-settings', api.publicSettings).data || {};
  const [period, setPeriod] = useState('month');
  const [busy, setBusy] = useState('');
  const [asked, setAsked] = useState([]);
  const p = q.data;
  if (!p) return null;
  const level = LEVELS.find((l) => l.id === p.level) || LEVELS.at(-1);
  const centre = p.centre; // the centre pays for every tutor in it
  const payer = !centre || centre.manager;
  const seats = typeof p.seats === 'number' ? p.seats : null;
  const byHand = ['custom', 'starter', 'pro'].includes(p.plan);
  const status = {
    free: p.until ? `Complimentary until ${planDay(p.until)}` : 'Complimentary',
    trial: p.trial_until ? `Free week until ${planDay(p.trial_until)}` : 'Free week',
    card: `Paid by card${p.renews_at ? `, renews ${planDay(p.renews_at)}` : ''}`,
    paid: `${p.paid_until ? `Paid up to ${planDay(p.paid_until)}` : 'Paid'}${seats ? ` for ${seats} learner${ess(seats)}` : ''}`,
    unpaid: p.enforced ? 'Not paid' : null,
  }[p.state];
  // Plus is settled once it's paid for (or given by StudyBridge); until then, asking for it sets up paying
  const plusSettled = p.state === 'free' || (level.id === 'plus' && ['card', 'paid'].includes(p.state));
  const canAsk = (id) => payer && p.state !== 'free' && (id === 'plus' ? !plusSettled : level.id !== id);
  const months = period === 'year' ? 12 - site.yearlyMonthsFree : 1;
  // paying online: by card (a subscription that follows the number of learners) or mobile money (months at a time);
  // not while a card plan is running (change or cancel that first) or a plan StudyBridge set up by hand
  const cards = pub.card_prices || [];
  const canPay = payer && p.state !== 'free' && p.state !== 'card' && !byHand;
  const payOpen = canPay && (cards.length > 0 || !!pub.mobile_on);
  async function card(id) {
    setBusy('card-' + id);
    try {
      const r = await api.checkout(id, period);
      if (r?.url) window.open(r.url, '_blank'); // the desktop app opens this in the browser
    } catch (e) {
      toast({ title: 'Couldn’t open the card page', body: e.message, tone: 'bad' });
    } finally {
      setBusy('');
    }
  }
  async function ask(id) {
    setBusy(id);
    try {
      await api.askLevel(id);
      setAsked((xs) => [...xs, id]);
      toast('StudyBridge will be in touch to set it up');
    } catch (e) {
      toast({ title: 'Couldn’t ask', body: e.message, tone: 'bad' });
    } finally {
      setBusy('');
    }
  }
  async function billing(own = false) {
    setBusy(own ? 'own' : 'billing');
    try {
      const r = await api.billingPortal(own);
      if (r?.url) window.open(r.url, '_blank'); // the desktop app opens this in the browser
    } catch (e) {
      toast({ title: 'Couldn’t open payments', body: e.message, tone: 'bad' });
    } finally {
      setBusy('');
    }
  }
  const who = centre
    ? `${centre.name} pays for StudyBridge for all its tutors: ${p.learners} learner${ess(p.learners)} in the centre, ${p.own_learners} of them yours.`
    : `You have ${p.learners} learner${ess(p.learners)}.`;
  return (
    <Section id="plan" icon="star" title="Your plan" sub={`${who}${p.paused ? ` ${p.paused} paused (they don’t count).` : ''}`}>
      <div className="row wrap" style={{ gap: 8 }}>
        <span className="strong">
          {centre ? `${centre.name}: ` : ''}
          {level.name}
        </span>
        <span className={'pill ' + (p.plus ? 'good' : level.id === 'plus' ? 'warn' : '')}>{p.plus ? 'Plus is on' : 'Plus is off'}</span>
        {status && <span className={'small' + (p.state === 'unpaid' ? ' strong' : '')}>{status}</span>}
      </div>
      {seats && (
        <div className="stack sm">
          <div className="plan-meter" aria-label={`${p.learners} of ${seats} places used`}>
            <span style={{ width: `${Math.min(100, (p.learners / Math.max(1, seats)) * 100)}%` }} />
          </div>
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="small">
              {p.learners} of {seats} place{ess(seats)} used{p.learners >= seats && p.enforced ? ': new learners can’t join until you add a place.' : '.'}
            </span>
            {payer && p.state === 'paid' && p.paid_until && (
              <MobileMoney
                what="seats"
                label="Add places"
                className="btn sm"
                months={monthsLeft(p.paid_until)}
                usdFor={(m, n) => (levelCost(level, seats + n).total - levelCost(level, seats).total) * m}
              />
            )}
          </div>
        </div>
      )}
      {!p.enforced ? (
        <div className="small muted">Plan limits aren’t switched on yet, so you have everything for now.</div>
      ) : p.state === 'unpaid' ? (
        <div className="note warn small">
          {centre && !centre.manager
            ? `${centre.name}’s plan isn’t paid, so new learners can’t join. Ask your centre’s manager to pay in Settings → Your plan. Everything you have stays.`
            : 'Your free week has ended and nothing is paid yet, so new learners can’t join. Everything you have stays: pay below to carry on.'}
        </div>
      ) : (
        !p.plus && (
          <div className="small muted">
            {level.id === 'plus' ? 'Your free week of Plus has ended. ' : ''}Prof, mocks with grades, the exam camera and StudyBridge’s practice papers come with Plus. Everything you’ve made stays.
          </div>
        )
      )}
      {(p.state === 'free' || byHand) && !centre && <div className="small muted">Your plan was set up for you by StudyBridge. Contact StudyBridge from Settings to change it.</div>}
      {p.own_card && (
        <div className="note warn small row wrap" style={{ gap: 8 }}>
          <span className="grow">You still pay by card for your own plan. Your centre pays for you now, so cancel yours.</span>
          <button className="btn sm" disabled={!!busy} onClick={() => billing(true)}>
            {busy === 'own' ? 'Opening…' : 'Cancel my own plan'}
          </button>
        </div>
      )}
      {payer ? (
        <>
          <div className="seg" role="group" aria-label="Prices">
            <button type="button" aria-pressed={period === 'month'} onClick={() => setPeriod('month')}>
              Monthly
            </button>
            <button type="button" aria-pressed={period === 'year'} onClick={() => setPeriod('year')}>
              Yearly (1 month free)
            </button>
          </div>
          <div className="level-cards">
            {LEVELS.map((l) => {
              const c = levelCost(l, p.learners);
              const mine = l.id === level.id;
              return (
                <div key={l.id} className={'level-card' + (mine ? ' mine' : '')}>
                  <div className="row wrap between" style={{ gap: 6 }}>
                    <h3 className="row" style={{ gap: 8, margin: 0 }}>
                      {l.name} {l.tag && <span className="pill claude">{l.tag}</span>}
                    </h3>
                    {mine && <span className="pill accent">{centre ? 'The centre’s level' : 'Your level'}</span>}
                  </div>
                  <div className="small muted">{l.blurb}</div>
                  <div className="level-price">
                    <b>{usd(c.total * months)}</b> {period === 'year' ? 'a year' : 'a month'}
                  </div>
                  <div className="tiny muted">
                    {p.learners
                      ? `For ${centre ? 'the centre’s' : 'your'} ${p.learners} learner${ess(p.learners)}: ${c.parts.map((x) => `${x.n} × ${usd(x.price)}`).join(' + ')}${months > 1 ? `, for ${months} months` : ''}. `
                      : 'No learners yet, so nothing to pay. '}
                    {stepsText(l)}.
                  </div>
                  <ul className="level-includes">
                    {l.includes.map((x) => (
                      <li key={x}>
                        <Icon name="check" size={14} /> {x}
                      </li>
                    ))}
                  </ul>
                  {payOpen && (
                    <div className="level-ask row wrap" style={{ gap: 8 }}>
                      {cards.includes(`${l.id}_${period}`) && (
                        <button className={'btn' + (l.id === 'plus' ? ' primary' : '')} disabled={!!busy} onClick={() => card(l.id)}>
                          {busy === 'card-' + l.id ? 'Opening…' : `Pay by card${period === 'year' ? ' for a year' : ''}`}
                        </button>
                      )}
                      <MobileMoney
                        what={l.id}
                        label="Mobile money"
                        minPlaces={Math.max(1, p.learners)}
                        usdFor={(m, n) => levelCost(l, n).total * (m === 12 ? 12 - site.yearlyMonthsFree : m)}
                      />
                    </div>
                  )}
                  {!payOpen && canAsk(l.id) && (
                    <div className="level-ask">
                      <button className={'btn' + (l.id === 'plus' ? ' primary' : '')} disabled={!!busy || asked.includes(l.id)} onClick={() => ask(l.id)}>
                        {busy === l.id ? 'Asking…' : asked.includes(l.id) ? `Asked for ${l.name}` : `Ask for ${l.name}`}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {pub.payments_on && p.has_billing && (
            <div className="row wrap" style={{ gap: 8 }}>
              <button className="btn" disabled={!!busy} onClick={() => billing()}>
                {busy === 'billing' ? 'Opening…' : 'Manage or cancel'}
              </button>
              {p.card && (
                <span className="small muted">
                  {centre ? 'The centre pays' : 'You pay'} by card. It follows the number of learners: Stripe adds or takes off the difference on the next bill.
                </span>
              )}
            </div>
          )}
          <div className="small muted">
            Essentials from $5 and Plus from $8 per learner a month, and less per learner as you grow. Paused learners don’t count. New tutors get Plus free for 7 days.{' '}
            {payOpen ? 'Pay by card (it renews by itself) or with mobile money (1 to 12 months at a time).' : p.card ? '' : 'For now, StudyBridge arranges payment with you directly.'}
          </div>
        </>
      ) : (
        <div className="small muted">Your centre’s manager chooses the level and pays for everyone in Settings → Your plan.</div>
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
                    ? `You have the latest version${st.checkedAt ? ` (checked ${ago(st.checkedAt)})` : ''}. It looks again every 15 minutes.`
                    : 'Updates install by themselves.'}
          </span>
          {restartWaiting(st) && (
            <button className="linkbtn small" onClick={() => restartDesktop()}>
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
