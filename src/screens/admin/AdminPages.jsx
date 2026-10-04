// More of the admin console: overview, one tutor in detail, problems (crash reports),
// the inbox ("Contact StudyBridge") and announcements. Account details only, never anyone's work.
import { useEffect, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Loading, Page, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, bytes } from '../../lib/format.js';
import { money, RaiseAllowance, PlanModal, PasswordModal, LearnerList } from './Admin.jsx';

const FREE_STORAGE = 1024 ** 3; // Supabase free plan: 1 GB of files

function Stat({ n, l, to, tone }) {
  const body = (
    <>
      <div className={'n ' + (tone || '')}>{n}</div>
      <div className="l">{l}</div>
    </>
  );
  return to ? (
    <a className="stat click" href={to}>
      {body}
    </a>
  ) : (
    <div className="stat">{body}</div>
  );
}

function Bars({ rows, value, label }) {
  const max = Math.max(1, ...rows.map(value));
  return (
    <div className="mini-bars">
      {rows.map((r, i) => (
        <div key={i} className="mini-bar-row">
          <span className="k">{r.month}</span>
          <span className="track">
            <span style={{ width: `${(100 * value(r)) / max}%` }} />
          </span>
          <span className="v">{label(r)}</span>
        </div>
      ))}
    </div>
  );
}

function Light({ ok, warn, children }) {
  return (
    <div className="row small" style={{ gap: 8 }}>
      <span className={'dot ' + (ok ? '' : warn ? 'warn' : 'bad')} />
      <span>{children}</span>
    </div>
  );
}

export function Overview() {
  const q = useQuery('admin-overview', api.adminOverview, { poll: 60000 });
  const o = q.data;
  if (q.error) return <Page title="Overview"><div className="error">{q.error.message}</div></Page>;
  if (!o) return <Loading />;
  const h = o.health || {};
  const fresh = (t, hours) => t && Date.now() - new Date(t) < hours * 3600000;
  const storagePct = o.storage_bytes == null ? null : Math.round((100 * o.storage_bytes) / FREE_STORAGE);
  return (
    <Page title="Overview" subtitle="How StudyBridge is doing. Account details and counts only, never anyone’s work.">
      <div className="admin-stats">
        <Stat n={o.tutors} l="Tutors" to="#/tutors" />
        <Stat n={o.pending} l="Waiting for approval" to="#/tutors" tone={o.pending ? 'warn' : ''} />
        <Stat n={o.learners} l="Learners" />
        <Stat n={o.active_7d} l="Used the app this week" />
      </div>
      <div className="admin-stats">
        <Stat n={o.assignments_30d} l="Work posted (30 days)" />
        <Stat n={o.handins_30d} l="Hand-ins (30 days)" />
        <Stat n={o.problems_open} l="Problems to look at" to="#/problems" tone={o.problems_open ? 'warn' : ''} />
        <Stat n={o.feedback_open} l="Messages to answer" to="#/inbox" tone={o.feedback_open ? 'warn' : ''} />
        <Stat n={o.prof_credit_left_cents != null ? money(Math.max(0, o.prof_credit_left_cents)) : '—'} l="Prof credit left" to="#/prof" tone={o.prof_credit_left_cents != null && o.prof_credit_left_cents < 500 ? 'warn' : ''} />
      </div>
      <div className="grid g2" style={{ gap: 16 }}>
        <div className="card">
          <h2>
            <a href="#/prof">Prof spend</a>
          </h2>
          <div className="small muted">
            What Prof cost on your Claude key, by month. This month so far: {money(o.prof_month_cents)}.{' '}
            {o.prof_credit_left_cents != null ? (
              <>
                Credit left: about <b>{money(Math.max(0, o.prof_credit_left_cents))}</b>.
              </>
            ) : (
              <a href="#/prof">Enter your Claude credit</a>
            )}
          </div>
          <Bars rows={o.prof_by_month || []} value={(r) => Number(r.cents)} label={(r) => money(r.cents)} />
        </div>
        <div className="card">
          <h2>System health</h2>
          <Light ok={h.prof_key && fresh(h.prof_seen_at, 24 * 7)} warn={h.prof_key}>
            Prof server: {h.prof_key ? (h.prof_seen_at ? `answered ${ago(h.prof_seen_at)}` : 'not seen yet') : 'no Claude key yet'}
          </Light>
          <Light ok={!h.jobs_failed_24h && !h.jobs_stuck} warn={!h.jobs_stuck}>
            Prof jobs: {h.jobs_failed_24h || 0} failed in the last day{h.jobs_stuck ? `, ${h.jobs_stuck} stuck` : ''}
          </Light>
          <Light ok={h.pg_cron && fresh(h.reports_at, 3)} warn={h.pg_cron}>
            Scheduled work (reports, weekly Prof): {h.pg_cron ? (h.reports_at ? `last ran ${ago(h.reports_at)}` : 'not run yet') : 'pg_cron is off'}
          </Light>
          <Light ok={fresh(h.backup_at, 36)} warn={!!h.backup_at}>
            Nightly backup: {h.backup_at ? `last one ${ago(h.backup_at)}` : 'no backup recorded yet (needs the backup secrets in GitHub)'}
          </Light>
          <Light ok={storagePct != null && storagePct < 70} warn={storagePct != null && storagePct < 90}>
            Files: {o.storage_bytes == null ? 'unknown' : `${bytes(o.storage_bytes)} of the free 1 GB (${storagePct}%)`}
          </Light>
        </div>
      </div>
      <Versions o={o} />
    </Page>
  );
}

function Versions({ o }) {
  const toast = useToast();
  const [min, setMin] = useState(o.min_version || '');
  return (
    <div className="card">
      <h2>App versions</h2>
      <div className="small muted">What people opened StudyBridge with in the last 30 days.</div>
      <div className="row wrap" style={{ gap: 6 }}>
        {(o.versions || []).map((v) => (
          <span key={v.version} className="pill">
            {v.version}: {v.people}
          </span>
        ))}
        {!(o.versions || []).length && <span className="small muted">Nobody yet.</span>}
      </div>
      <Field label="Minimum version" hint="Older apps show “Please update StudyBridge” and can’t be used until they update. Leave empty to allow any version.">
        <div className="row">
          <input className="input" style={{ maxWidth: 180 }} value={min} onChange={(e) => setMin(e.target.value.trim())} placeholder="e.g. 1.1.25" />
          <button
            className="btn"
            onClick={async () => {
              try {
                await api.adminSetMinVersion(min);
                invalidate('admin-overview');
                toast(min ? `Apps older than ${min} must update` : 'Any version allowed');
              } catch (e) {
                toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
              }
            }}
          >
            Save
          </button>
        </div>
      </Field>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function TutorPage({ id }) {
  const q = useQuery(`admin-tutor:${id}`, () => api.adminTutor(id));
  const t = q.data;
  const toast = useToast();
  const [note, setNote] = useState(null);
  const [modal, setModal] = useState(null);
  useEffect(() => {
    if (t && note === null) setNote(t.note || '');
  }, [t]); // eslint-disable-line react-hooks/exhaustive-deps
  if (q.error) return <Page title="Tutor"><div className="error">{q.error.message}</div></Page>;
  if (!q.data) return q.data === null ? <Page title="Tutor">Not found.</Page> : <Loading />;
  const s = t.signup || {};
  return (
    <Page title={t.name} subtitle={t.email} eyebrow={<a href="#/tutors">Tutors</a>}>
      <div className="grid g2" style={{ gap: 16 }}>
        <div className="card">
          <h2>Account</h2>
          <div className="facts col">
            <span>
              Status <b>{t.status === 'suspended' ? 'Paused' : t.status === 'pending' ? 'Waiting for approval' : 'Active'}</b>
            </span>
            <span>
              Plan <b>{t.plan}</b>
            </span>
            <span>Joined {ago(t.joined_at)}</span>
            <span>{t.last_sign_in_at ? `Last signed in ${ago(t.last_sign_in_at)}` : 'Never signed in'}</span>
            <span>{t.last_seen_at ? `Last used the app ${ago(t.last_seen_at)}` : 'Hasn’t opened the app since 1.4'}</span>
            <span>
              App {t.app_version || 'unknown'}
              {t.platform ? ` · ${t.platform}` : ''}
            </span>
            <span>Time zone {t.timezone?.replace(/_/g, ' ')}</span>
            <span>
              {t.learners} learner{t.learners === 1 ? '' : 's'} · files {t.storage_bytes == null ? '—' : bytes(t.storage_bytes)}
            </span>
            {(s.subjects || s.country || s.learners) && (
              <span>
                At sign-up: {[s.subjects, s.country, s.learners && `${s.learners} learners`].filter(Boolean).join(' · ')}
              </span>
            )}
          </div>
          <div className="row wrap">
            <button className="btn sm" onClick={() => setModal('plan')}>
              Plan & Prof
            </button>
            <button className="btn sm" onClick={() => setModal('password')}>
              Password
            </button>
          </div>
        </div>
        <div className="card">
          <h2>Prof</h2>
          <div className="small">
            This month <b>{money(t.ai_cents)}</b> of {money(t.ai_limit_cents)}
            {t.ai_limit_custom ? '' : ' (default allowance)'}
          </div>
          <div className="bar">
            <span style={{ width: `${Math.min(100, (100 * Number(t.ai_cents)) / Math.max(1, Number(t.ai_limit_cents)))}%` }} />
          </div>
          {Number(t.ai_cents) >= 0.8 * Number(t.ai_limit_cents) && <RaiseAllowance t={t} onDone={() => invalidate(`admin-tutor:${id}`)} />}
          <Bars rows={t.ai_by_month || []} value={(r) => Number(r.cents)} label={(r) => money(r.cents)} />
        </div>
      </div>
      <div className="card">
        <h2>Your notes</h2>
        <div className="small muted">Only you see these.</div>
        <textarea className="textarea" value={note || ''} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Met on WhatsApp, teaches 12 learners, wants the Pro plan." />
        <div>
          <button
            className="btn"
            onClick={async () => {
              try {
                await api.adminSetNote(id, note || '');
                toast('Notes saved');
              } catch (e) {
                toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
              }
            }}
          >
            Save notes
          </button>
        </div>
      </div>
      <div className="card">
        <h2>Learners</h2>
        <LearnerList tutor={t} />
      </div>
      {modal === 'plan' && <PlanModal t={t} onClose={() => (setModal(null), invalidate(`admin-tutor:${id}`))} />}
      {modal === 'password' && <PasswordModal person={t} onClose={() => setModal(null)} />}
    </Page>
  );
}

// ---------------------------------------------------------------------------
export function ProblemsPage() {
  const q = useQuery('admin-errors', api.adminErrors, { poll: 60000 });
  const [open, setOpen] = useState(null);
  const [showFixed, setShowFixed] = useState(false);
  const list = (q.data || []).filter((x) => showFixed || !x.resolved_at);
  return (
    <Page title="Problems" subtitle="When something breaks on someone’s device, the app reports it here: the error, the screen, the version and the device. Never their work. The same problem is grouped with a count.">
      <label className="row small" style={{ gap: 6 }}>
        <input type="checkbox" checked={showFixed} onChange={(e) => setShowFixed(e.target.checked)} /> Show ones marked fixed
      </label>
      {q.error && <div className="error">{q.error.message}</div>}
      {q.data && !list.length && <Empty title="No problems">Nothing has gone wrong on anyone’s device.</Empty>}
      <div className="stack">
        {list.map((x) => (
          <div key={x.id} className={'card problem' + (x.resolved_at ? ' fixed' : '')}>
            <div className="row between wrap" style={{ gap: 8 }}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="strong ellipsis">{x.message}</div>
                <div className="small muted">
                  {x.count}× · {x.people} {x.people === 1 ? 'person' : 'people'} · last {ago(x.last_at)} · first {ago(x.first_at)}
                  {x.screen ? ` · ${x.screen}` : ''} · {x.app_version || '?'} · {x.platform || '?'}
                  {x.roles?.length ? ` · ${x.roles.join(', ')}` : ''}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <button className="btn sm" onClick={() => setOpen(open === x.id ? null : x.id)}>
                  {open === x.id ? 'Hide details' : 'Details'}
                </button>
                <button
                  className="btn sm"
                  onClick={async () => {
                    await api.adminResolveError(x.id, !x.resolved_at);
                    invalidate('admin-errors', 'admin-overview');
                  }}
                >
                  {x.resolved_at ? 'Not fixed' : 'Mark fixed'}
                </button>
              </div>
            </div>
            {open === x.id && <pre className="stack-trace">{x.stack || 'No details.'}</pre>}
          </div>
        ))}
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
const KIND = { problem: 'Problem', idea: 'Idea', question: 'Question' };
export function InboxPage() {
  const q = useQuery('admin-feedback', api.adminFeedback, { poll: 60000 });
  const [showClosed, setShowClosed] = useState(false);
  const list = (q.data || []).filter((f) => showClosed || !f.closed_at);
  return (
    <Page title="Inbox" subtitle="Messages tutors send from Settings → Contact StudyBridge. Your reply reaches them as a notification.">
      <label className="row small" style={{ gap: 6 }}>
        <input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} /> Show answered
      </label>
      {q.error && <div className="error">{q.error.message}</div>}
      {q.data && !list.length && <Empty title="Nothing to answer">New messages from tutors show up here.</Empty>}
      <div className="stack">
        {list.map((f) => (
          <FeedbackItem key={f.id} f={f} />
        ))}
      </div>
    </Page>
  );
}

function FeedbackItem({ f }) {
  const toast = useToast();
  const [reply, setReply] = useState('');
  return (
    <div className="card">
      <div className="row between wrap">
        <div>
          <span className="pill">{KIND[f.kind] || f.kind}</span> <b>{f.name}</b> <span className="small muted">{f.email}</span>
        </div>
        <span className="small muted">
          {ago(f.created_at)}
          {f.app_version ? ` · app ${f.app_version}` : ''}
        </span>
      </div>
      <div className="pre-wrap">{f.body}</div>
      {f.reply && (
        <div className="note small">
          <b>You replied {ago(f.replied_at)}:</b> {f.reply}
        </div>
      )}
      {!f.closed_at && (
        <>
          <textarea className="textarea" value={reply} onChange={(e) => setReply(e.target.value)} placeholder="Your reply (optional)" />
          <div className="row">
            <button
              className="btn primary"
              disabled={!reply.trim()}
              onClick={async () => {
                try {
                  await api.adminReplyFeedback(f.id, reply, true);
                  invalidate('admin-feedback', 'admin-overview');
                  toast('Reply sent');
                } catch (e) {
                  toast({ title: 'Couldn’t send', body: e.message, tone: 'bad' });
                }
              }}
            >
              Send reply
            </button>
            <button
              className="btn"
              onClick={async () => {
                await api.adminReplyFeedback(f.id, '', true);
                invalidate('admin-feedback', 'admin-overview');
              }}
            >
              Close without replying
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function AnnouncementsPage() {
  const q = useQuery('announcements', api.listAnnouncements);
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [audience, setAudience] = useState('tutors');
  const [days, setDays] = useState('7');
  const list = q.data || [];
  const live = (a) => !a.ended_at && (!a.until || new Date(a.until) > new Date());
  return (
    <Page title="Announcements" subtitle="A message at the top of everyone’s app, e.g. “New update tonight” or “Prof is down for an hour”. They can close it.">
      <div className="card">
        <Field label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="e.g. New: flashcards for your learners" />
        </Field>
        <Field label="Message (optional)">
          <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} />
        </Field>
        <div className="grid g2" style={{ gap: 12 }}>
          <Field label="Who sees it">
            <select className="select" value={audience} onChange={(e) => setAudience(e.target.value)}>
              <option value="tutors">Tutors</option>
              <option value="everyone">Tutors and learners</option>
            </select>
          </Field>
          <Field label="Show it for">
            <select className="select" value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="1">1 day</option>
              <option value="3">3 days</option>
              <option value="7">A week</option>
              <option value="30">A month</option>
              <option value="">Until I end it</option>
            </select>
          </Field>
        </div>
        <div>
          <button
            className="btn primary"
            disabled={!title.trim()}
            onClick={async () => {
              try {
                await api.adminAnnounce(title.trim(), body.trim(), audience, days ? new Date(Date.now() + Number(days) * 86400000).toISOString() : null);
                setTitle('');
                setBody('');
                invalidate('announcements');
                toast('Announcement is live');
              } catch (e) {
                toast({ title: 'Couldn’t post it', body: e.message, tone: 'bad' });
              }
            }}
          >
            <Icon name="send" size={16} /> Post announcement
          </button>
        </div>
      </div>
      <div className="stack">
        {list.map((a) => (
          <div key={a.id} className="card">
            <div className="row between wrap">
              <div>
                <b>{a.title}</b> <span className="pill">{a.audience === 'everyone' ? 'Tutors and learners' : 'Tutors'}</span>{' '}
                {live(a) ? <span className="pill accent">Live</span> : <span className="pill">Ended</span>}
              </div>
              <span className="small muted">
                {ago(a.created_at)}
                {a.until && live(a) ? ` · until ${new Date(a.until).toLocaleDateString()}` : ''}
              </span>
            </div>
            {a.body && <div className="small pre-wrap">{a.body}</div>}
            {live(a) && (
              <div>
                <button
                  className="btn sm"
                  onClick={async () => {
                    await api.adminEndAnnouncement(a.id);
                    invalidate('announcements');
                  }}
                >
                  End it now
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Prof: what it costs on your Claude key, and roughly how much credit is left
const JOB_KIND = { ask: 'Asked Prof (making work, answers)', mark: 'Marking', auto: 'Weekly auto work', bank: 'Question bank', report: 'Parent reports', syllabus: 'Syllabus', paper: 'StudyBridge papers', cards: 'Flashcards', other: 'Other' };
export function ProfPage() {
  const q = useQuery('admin-prof', api.adminProf, { poll: 60000 });
  const d = q.data;
  if (q.error) return <Page title="Prof"><div className="error">{q.error.message}</div></Page>;
  if (!d) return <Loading />;
  const c = d.credit || {};
  const maxDay = Math.max(1, ...(d.days || []).map((x) => Number(x.cents)));
  const days30 = (d.days || []).reduce((a, x) => a + Number(x.cents), 0);
  const perDay = days30 / 30;
  const daysLeft = c.left_cents != null && perDay > 0 ? Math.floor(Math.max(0, c.left_cents) / perDay) : null;
  return (
    <Page title="Prof" subtitle="What Prof costs on your Claude key. Only you see this; tutors never see money.">
      <div className="admin-stats">
        <Stat n={c.left_cents != null ? money(Math.max(0, c.left_cents)) : '—'} l="Credit left (about)" tone={c.left_cents != null && c.left_cents <= c.low_cents ? 'warn' : ''} />
        <Stat n={money(d.month_cents)} l="This month" />
        <Stat n={money(d.last_month_cents)} l="Last month" />
        <Stat n={daysLeft != null ? (daysLeft > 365 ? '365+' : daysLeft) : '—'} l="Days it lasts at this rate" />
      </div>
      <Credit c={c} />
      <div className="card">
        <h2>Last 30 days</h2>
        <div className="small muted">
          {money(days30)} in 30 days, about {money(perDay)} a day{d.model ? ` (model: ${d.model})` : ''}.
        </div>
        <div className="day-bars" role="img" aria-label="Prof spend per day, last 30 days">
          {(d.days || []).map((x) => (
            <span key={x.day} title={`${x.day}: ${money(x.cents)}`}>
              <i style={{ height: `${Math.max(Number(x.cents) > 0 ? 3 : 0, (100 * Number(x.cents)) / maxDay)}%` }} />
            </span>
          ))}
        </div>
        <div className="row between tiny muted">
          <span>{d.days?.[0]?.day}</span>
          <span>Today</span>
        </div>
      </div>
      <div className="grid g2" style={{ gap: 16 }}>
        <div className="card">
          <h2>Who used it this month</h2>
          {!(d.by_tutor || []).length ? (
            <div className="small muted">Nobody yet this month.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th>Jobs</th>
                  <th>Spent</th>
                  <th>Allowance</th>
                </tr>
              </thead>
              <tbody>
                {d.by_tutor.map((t) => (
                  <tr key={t.id}>
                    <td>{t.role === 'tutor' ? <a href={`#/tutors/${t.id}`}>{t.name}</a> : `${t.name} (admin)`}</td>
                    <td>{t.jobs}</td>
                    <td>{money(t.cents)}</td>
                    <td className={t.limit_cents != null && Number(t.cents) >= 0.8 * t.limit_cents ? 'bad-text' : 'muted'}>{t.limit_cents != null ? money(t.limit_cents) : 'none'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="tiny muted">Change a tutor’s allowance on their page in Tutors.</div>
        </div>
        <div className="card">
          <h2>What it was used for this month</h2>
          {!(d.by_kind || []).length ? (
            <div className="small muted">Nothing yet this month.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Times</th>
                  <th>Spent</th>
                </tr>
              </thead>
              <tbody>
                {d.by_kind.map((k) => (
                  <tr key={k.kind}>
                    <td>{JOB_KIND[k.kind] || k.kind}</td>
                    <td>{k.jobs}</td>
                    <td>{money(k.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Page>
  );
}

function Credit({ c }) {
  const toast = useToast();
  const [bal, setBal] = useState('');
  const [low, setLow] = useState(((c.low_cents ?? 500) / 100).toFixed(2));
  async function save(clear = false) {
    const b = clear ? null : Math.round(Number(String(bal).replace(/[$,\s]/g, '')) * 100);
    const l = Math.round(Number(String(low).replace(/[$,\s]/g, '')) * 100);
    if (!clear && !(b >= 0)) return toast({ title: 'Type the credit in dollars, e.g. 25.40', tone: 'bad' });
    try {
      await api.adminSetProfCredit(b, l >= 0 ? l : null);
      invalidate('admin-prof', 'admin-overview');
      setBal('');
      toast(clear ? 'Stopped counting down' : 'Saved. StudyBridge counts down from this as Prof works.');
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    }
  }
  return (
    <div className="card">
      <h2>Claude credit</h2>
      <div className="small muted">
        Anthropic doesn’t let apps read how much credit is on a Claude key, so StudyBridge counts down for you: type in what the{' '}
        <a href="https://console.anthropic.com/settings/billing" target="_blank" rel="noreferrer">
          Claude Console → Billing
        </a>{' '}
        page shows, and it subtracts what Prof spends. You’ll get a notification when it runs low. Update it whenever you top up.
      </div>
      {c.balance_cents != null && (
        <div className="small">
          You entered {money(c.balance_cents)} {ago(c.set_at)}; Prof has spent {money(c.spent_cents)} since, so about <b>{money(Math.max(0, c.balance_cents - c.spent_cents))}</b> is left.
        </div>
      )}
      <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
        <Field label="Credit on your Claude key now ($)">
          <input className="input" style={{ maxWidth: 160 }} inputMode="decimal" value={bal} onChange={(e) => setBal(e.target.value)} placeholder="e.g. 25.40" />
        </Field>
        <Field label="Tell me below ($)">
          <input className="input" style={{ maxWidth: 120 }} inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} />
        </Field>
        <button className="btn primary" disabled={!bal.trim()} onClick={() => save(false)}>
          Save
        </button>
        {c.balance_cents != null && (
          <button className="btn ghost" onClick={() => save(true)}>
            Stop counting
          </button>
        )}
      </div>
    </div>
  );
}
