// StudyBridge admin console (only for StudyBridge admins). Accounts and access:
// approve, pause, reset passwords, delete, plans and Prof allowances, and the
// keys the server uses. It never shows anyone's work, files, marks or messages.
import { useEffect, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Field, Modal, Page, Toggle, copyText, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, bytes } from '../../lib/format.js';
import { easyPassword } from './Learners.jsx';
import { AskProf, ReviewQueue } from './QuestionBank.jsx';
import * as X from '../../lib/exams.js';

const money = (cents) => '$' + (Number(cents || 0) / 100).toFixed(2);
const MODELS = [
  ['claude-sonnet-5-5', 'Claude Sonnet 5.5 (recommended: great work, lower cost)'],
  ['claude-opus-5-5', 'Claude Opus 5.5 (best work, about 2× the cost)'],
  ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5 (cheapest, simpler work)'],
];
const ACTIONS = { approved: 'Approved', paused: 'Paused', switched_on: 'Switched back on', password_reset: 'Password reset', deleted: 'Deleted', plan: 'Plan changed' };

export default function Admin() {
  const app = useApp();
  const tutors = useQuery('admin-tutors', api.adminTutors);
  const settings = useQuery('admin-settings', api.adminSettings);
  const list = tutors.data || [];
  const pending = list.filter((t) => t.status === 'pending');
  const others = list.filter((t) => t.status !== 'pending');
  if (!app.me.is_admin) return <Page title="Admin">Only StudyBridge admins can open this.</Page>;
  return (
    <Page title="Admin" subtitle="Everyone’s accounts and access. You see account details only, never anyone’s work, files, marks or messages. Everything you do here is logged, and tutors can see what was done to their account.">
      {tutors.error && <div className="error">{tutors.error.message}</div>}
      <div className="admin-stats">
        <div className="stat">
          <div className="n">{others.filter((t) => t.status === 'active').length}</div>
          <div className="l">Tutors</div>
        </div>
        <div className="stat">
          <div className="n">{pending.length}</div>
          <div className="l">Waiting for approval</div>
        </div>
        <div className="stat">
          <div className="n">{list.reduce((n, t) => n + Number(t.learners || 0), 0)}</div>
          <div className="l">Learners</div>
        </div>
        <div className="stat">
          <div className="n">{settings.data ? money(settings.data.ai_cents_month) : '—'}</div>
          <div className="l">Prof this month</div>
        </div>
      </div>

      {pending.length > 0 && (
        <div className="card">
          <h2>Waiting for approval</h2>
          <div className="stack">
            {pending.map((t) => (
              <TutorRow key={t.id} t={t} />
            ))}
          </div>
        </div>
      )}

      <div className="card">
        <h2>Tutors</h2>
        <div className="stack">
          {others.map((t) => (
            <TutorRow key={t.id} t={t} self={t.id === app.me.id} />
          ))}
          {tutors.data && others.length === 0 && <div className="muted small">No tutors yet.</div>}
        </div>
      </div>

      <Unfinished />
      <SharedBank />
      <PlatformSettings s={settings.data} />
      <Log />
    </Page>
  );
}

function TutorRow({ t, self }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(null);
  const refresh = () => invalidate('admin-tutors', 'admin-log', 'admin-settings');
  async function act(fn, done) {
    try {
      await fn();
      refresh();
      if (done) toast(done);
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
    }
  }
  const pending = t.status === 'pending';
  return (
    <div className={'tutor-row ' + t.status}>
      <div className="row wrap between" style={{ gap: 10 }}>
        <div className="row" style={{ gap: 10 }}>
          <Icon name={pending ? 'clock' : t.status === 'suspended' ? 'pause' : 'user'} style={{ color: pending ? 'var(--claude)' : 'var(--accent)' }} />
          <div>
            <div className="strong">
              {t.name} {self && <span className="pill">You</span>} {t.is_admin && <span className="pill dark">Admin</span>}{' '}
              {t.status === 'suspended' && <span className="pill bad">Paused</span>}
            </div>
            <div className="small muted">{t.email}</div>
          </div>
        </div>
        <div className="row wrap" style={{ gap: 6 }}>
          {pending ? (
            <>
              <button className="btn sm primary" onClick={() => act(() => api.adminSetStatus(t.id, 'active'), `${t.name} approved`)}>
                <Icon name="check" size={14} /> Approve
              </button>
              <button
                className="btn sm"
                onClick={async () => {
                  if (await confirm({ title: `Decline ${t.name}?`, body: 'Their account is deleted. They can sign up again later.', ok: 'Decline', danger: true }))
                    act(() => api.adminDeleteAccount(t.id), 'Declined');
                }}
              >
                Decline
              </button>
            </>
          ) : (
            <>
              <button className="btn sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                Learners ({t.learners})
              </button>
              {!self && (
                <button className="btn sm" onClick={() => setModal('password')}>
                  Password
                </button>
              )}
              <button className="btn sm" onClick={() => setModal('plan')}>
                Plan & Prof
              </button>
              {!self && t.status === 'active' && (
                <button
                  className="btn sm"
                  onClick={async () => {
                    if (await confirm({ title: `Pause ${t.name}?`, body: 'They can’t sign in until you switch them back on. Their learners can still sign in and see their past work, but get nothing new. Nothing is deleted.', ok: 'Pause' }))
                      act(() => api.adminSetStatus(t.id, 'suspended'), `${t.name} paused`);
                  }}
                >
                  <Icon name="pause" size={14} /> Pause
                </button>
              )}
              {!self && t.status === 'suspended' && (
                <button className="btn sm primary" onClick={() => act(() => api.adminSetStatus(t.id, 'active'), `${t.name} switched back on`)}>
                  Switch back on
                </button>
              )}
              {!self && !t.is_admin && (
                <button className="btn sm danger" onClick={() => setModal('delete')}>
                  <Icon name="trash" size={14} />
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <div className="facts">
        <span>
          Plan <b>{t.plan}</b>
        </span>
        <span>
          Prof <b>{money(t.ai_cents)}</b> of {money(t.ai_limit_cents)}
          {t.ai_limit_custom ? '' : ' (default)'}
        </span>
        <span>
          Files <b>{t.storage_bytes == null ? '—' : bytes(t.storage_bytes)}</b>
        </span>
        <span>Joined {ago(t.joined_at)}</span>
        <span>{t.last_sign_in_at ? `Last signed in ${ago(t.last_sign_in_at)}` : 'Never signed in'}</span>
      </div>
      {open && <LearnerList tutor={t} />}
      {modal === 'password' && <PasswordModal person={t} onClose={() => setModal(null)} />}
      {modal === 'plan' && <PlanModal t={t} onClose={() => setModal(null)} />}
      {modal === 'delete' && <DeleteModal person={t} tutor onClose={() => setModal(null)} />}
    </div>
  );
}

function LearnerList({ tutor }) {
  const q = useQuery(`admin-accounts:${tutor.id}`, () => api.adminAccounts(tutor.id));
  const [modal, setModal] = useState(null);
  const list = q.data || [];
  return (
    <div className="list" style={{ marginTop: 4 }}>
      {q.data && list.length === 0 && <div className="muted small">No learners yet.</div>}
      {list.map((l) => (
        <div key={l.id} className="item">
          <Icon name="user" size={18} />
          <span className="grow">
            <span className="name">{l.name}</span>
            <span className="meta">
              {l.email} · {l.last_sign_in_at ? `last signed in ${ago(l.last_sign_in_at)}` : 'never signed in'}
            </span>
          </span>
          <button className="btn sm" onClick={() => setModal({ kind: 'password', l })}>
            Password
          </button>
          <button className="btn sm danger" onClick={() => setModal({ kind: 'delete', l })} aria-label={`Delete ${l.name}`}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      ))}
      {modal?.kind === 'password' && <PasswordModal person={modal.l} onClose={() => setModal(null)} />}
      {modal?.kind === 'delete' && <DeleteModal person={modal.l} onClose={() => (setModal(null), invalidate(`admin-accounts:${tutor.id}`))} />}
    </div>
  );
}

function PasswordModal({ person, onClose }) {
  const toast = useToast();
  const [pw, setPw] = useState('');
  const [done, setDone] = useState('');
  const first = (person.name || '').split(' ')[0];
  return (
    <Modal title={`New password for ${person.name}`} onClose={onClose}>
      {done ? (
        <>
          <div className="okmsg">Password changed.</div>
          <div className="small">Tell {first} (they can change it in Settings afterwards):</div>
          <div className="code-box" style={{ fontFamily: 'var(--sans)' }}>{`Your StudyBridge password is now: ${done}  (sign in with ${person.email})`}</div>
          <div className="row">
            <button className="btn" onClick={() => (copyText(`Your StudyBridge password is now: ${done}  (sign in with ${person.email})`), toast('Copied'))}>
              <Icon name="copy" size={16} /> Copy
            </button>
            <button className="btn primary" onClick={onClose}>
              Done
            </button>
          </div>
        </>
      ) : (
        <form
          className="stack"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.adminSetPassword(person.id, pw);
              invalidate('admin-log');
              setDone(pw);
            } catch (x) {
              toast({ title: 'Couldn’t change it', body: x.message, tone: 'bad' });
            }
          }}
        >
          <Field label="New password" hint="At least 6 characters.">
            <div className="row">
              <input className="input" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="off" autoFocus />
              <button type="button" className="btn sm" onClick={() => setPw(easyPassword())}>
                Make one up
              </button>
            </div>
          </Field>
          <div>
            <button className="btn primary" disabled={pw.length < 6}>
              Save new password
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function PlanModal({ t, onClose }) {
  const toast = useToast();
  const [plan, setPlan] = useState(t.plan || 'free');
  const [custom, setCustom] = useState(!!t.ai_limit_custom);
  const [limit, setLimit] = useState((Number(t.ai_limit_cents) / 100).toFixed(2));
  return (
    <Modal
      title={`${t.name}: plan & Prof`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              try {
                await api.adminSetPlan(t.id, plan, custom ? Math.round(Number(limit) * 100) : null);
                invalidate('admin-tutors', 'admin-log');
                toast('Saved');
                onClose();
              } catch (e) {
                toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
              }
            }}
          >
            Save
          </button>
        </>
      }
    >
      <Field label="Plan" hint="A label for your own records (billing comes later).">
        <input className="input" value={plan} onChange={(e) => setPlan(e.target.value)} />
      </Field>
      <Toggle checked={custom} onChange={setCustom} title="Own Prof allowance" sub="Otherwise they get the default allowance from Admin settings." />
      {custom && (
        <Field label="Prof allowance per month (US$)" hint={`Used so far this month: ${money(t.ai_cents)}`}>
          <input className="input" type="number" min="0" step="0.5" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}

function DeleteModal({ person, tutor, onClose }) {
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const first = (person.name || '').split(' ')[0] || 'delete';
  return (
    <Modal title={`Delete ${person.name}?`} onClose={onClose}>
      <div className="small">
        {tutor
          ? `This deletes ${person.name}’s tutor account, all ${person.learners} of their learners’ accounts, and everything in their StudyBridge: assignments, work, marks, messages and files. It can’t be undone.`
          : `This deletes ${person.name}’s account and all their work, marks and messages. It can’t be undone.`}
      </div>
      <Field label={`Type ${first} to confirm`}>
        <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </Field>
      <div className="row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn danger solid"
          disabled={typed.trim().toLowerCase() !== first.toLowerCase()}
          onClick={async () => {
            try {
              await api.adminDeleteAccount(person.id);
              invalidate('admin-tutors', 'admin-log', 'admin-unfinished');
              toast(`${person.name} deleted`);
              onClose();
            } catch (e) {
              toast({ title: 'Couldn’t delete', body: e.message, tone: 'bad' });
            }
          }}
        >
          Delete for good
        </button>
      </div>
    </Modal>
  );
}

// People who made an account but never joined a tutor or signed up as one
function Unfinished() {
  const q = useQuery('admin-unfinished', () => api.adminAccounts(null));
  const [del, setDel] = useState(null);
  const list = q.data || [];
  if (!list.length) return null;
  return (
    <div className="card">
      <h2>Unfinished sign-ups</h2>
      <div className="muted small">Accounts that never joined a tutor or signed up as a tutor.</div>
      <div className="list">
        {list.map((l) => (
          <div key={l.id} className="item">
            <Icon name="user" size={18} />
            <span className="grow">
              <span className="name">{l.name || l.email}</span>
              <span className="meta">
                {l.email} · joined {ago(l.joined_at)}
              </span>
            </span>
            <button className="btn sm danger" onClick={() => setDel(l)} aria-label={`Delete ${l.email}`}>
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
      </div>
      {del && <DeleteModal person={{ ...del, name: del.name || del.email }} onClose={() => setDel(null)} />}
    </div>
  );
}

function PlatformSettings({ s }) {
  const toast = useToast();
  const [key, setKey] = useState('');
  const [model, setModel] = useState('');
  const [limit, setLimit] = useState('');
  const [lk, setLk] = useState({ url: '', key: '', secret: '' });
  const [check, setCheck] = useState(null);
  useEffect(() => {
    if (s && !model) {
      setModel(s.prof_model);
      setLimit((s.default_ai_limit_cents / 100).toFixed(2));
      setLk((x) => ({ ...x, url: s.livekit_url || '' }));
    }
  }, [s]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return null;
  const seen = s.prof_seen_at && Date.now() - new Date(s.prof_seen_at) < 7 * 86400000;
  async function saveProf() {
    try {
      await api.adminSetProf({ key: key.trim() || null, model, defaultLimitCents: Math.round(Number(limit || 0) * 100) });
      setKey('');
      invalidate('admin-settings', 'admin-tutors', 'prof-usage');
      toast('Prof settings saved');
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    }
  }
  return (
    <div className="card">
      <h2>StudyBridge settings</h2>
      <Toggle
        checked={s.tutor_signups_open}
        onChange={async (v) => {
          await api.adminSetSignups(v);
          invalidate('admin-settings');
        }}
        title="Accept new tutor sign-ups"
        sub="New tutors wait for your approval either way. Turn this off to stop new sign-ups completely."
      />
      <hr />
      <h3 className="row">
        <Icon name="cap" style={{ color: 'var(--claude)' }} /> Prof
      </h3>
      <div className="row small">
        <span className={'dot ' + (s.prof_key_set && seen ? '' : 'warn')} />
        <span>
          {s.prof_key_set ? 'Claude key saved' : 'No Claude key yet'} · {seen ? `server answered ${ago(s.prof_seen_at)}` : 'server not seen yet'}
          {!s.pg_net && ' · pg_net is off (Prof starts when the app asks)'}
          {!s.pg_cron && ' · Cron is off (weekly work won’t run)'}
        </span>
      </div>
      <Field label="Claude API key" hint="From console.anthropic.com → API keys. It’s stored where only the Prof server can read it, and it can’t be shown again. Never paste it into a chat.">
        <input className="input" type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={s.prof_key_set ? 'Saved (paste a new one to replace it)' : 'sk-ant-…'} autoComplete="off" />
      </Field>
      <div className="grid g2" style={{ gap: 12 }}>
        <Field label="Model">
          <select className="select" value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Default Prof allowance per tutor, per month (US$)">
          <input className="input" type="number" min="0" step="0.5" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </Field>
      </div>
      <div className="row wrap">
        <button className="btn primary" onClick={saveProf}>
          Save
        </button>
        <button
          className="btn"
          onClick={async () => {
            setCheck('Checking…');
            try {
              const r = await api.callProf('hello');
              setCheck(r.key_set ? `Prof server is working (${r.model}).` : 'Prof server is working, but it has no Claude key yet.');
              invalidate('admin-settings');
            } catch (e) {
              setCheck(e.message);
            }
          }}
        >
          Check the Prof server
        </button>
        {check && <span className="small">{check}</span>}
      </div>
      <hr />
      <h3 className="row">
        <Icon name="video" style={{ color: 'var(--accent)' }} /> Live video for every tutor
      </h3>
      <div className="small muted">Tutors who haven’t added their own LiveKit keys use these. {s.livekit_set ? 'Saved.' : 'Not set up.'}</div>
      <Field label="LiveKit WebSocket URL">
        <input className="input" value={lk.url} onChange={(e) => setLk({ ...lk, url: e.target.value })} placeholder="wss://your-project.livekit.cloud" />
      </Field>
      <div className="grid g2" style={{ gap: 12 }}>
        <Field label="API key">
          <input className="input" value={lk.key} onChange={(e) => setLk({ ...lk, key: e.target.value })} placeholder={s.livekit_set ? 'Saved (enter to replace)' : ''} autoComplete="off" />
        </Field>
        <Field label="API secret">
          <input className="input" type="password" value={lk.secret} onChange={(e) => setLk({ ...lk, secret: e.target.value })} placeholder={s.livekit_set ? 'Saved (enter to replace)' : ''} autoComplete="off" />
        </Field>
      </div>
      <div>
        <button
          className="btn"
          onClick={async () => {
            if (lk.url && !/^wss:\/\//.test(lk.url.trim())) return toast({ title: 'The URL should start with wss://', tone: 'bad' });
            try {
              await api.adminSetLivekit(lk.url, lk.key, lk.secret);
              setLk((x) => ({ ...x, key: '', secret: '' }));
              invalidate('admin-settings', 'live-status');
              toast('Live video saved');
            } catch (e) {
              toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
            }
          }}
        >
          Save live video
        </button>
      </div>
    </div>
  );
}

function Log() {
  const q = useQuery('admin-log', api.adminLog);
  const list = q.data || [];
  if (!list.length) return null;
  return (
    <div className="card">
      <h2>What’s been done</h2>
      <div className="list small">
        {list.slice(0, 60).map((x) => (
          <div key={x.id} className="item" style={{ padding: '6px 0' }}>
            <span className="muted" style={{ width: 110, flexShrink: 0 }}>
              {ago(x.at)}
            </span>
            <span className="grow">
              <b>{ACTIONS[x.action] || x.action}</b> · {x.detail?.name || x.email || 'account'}
              {x.action === 'plan' && x.detail?.plan ? ` → ${x.detail.plan}${x.detail.ai_limit_cents != null ? `, Prof ${money(x.detail.ai_limit_cents)}/month` : ''}` : ''}
              {x.action === 'deleted' && x.detail?.learners ? ` (and ${x.detail.learners} learner${x.detail.learners > 1 ? 's' : ''})` : ''}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// StudyBridge's own exam-style questions, shared with every tutor once approved here
function SharedBank() {
  const bank = useQuery('bank', api.listBank);
  const [asking, setAsking] = useState(false);
  const shared = (bank.data || []).filter((b) => b.owner_id === null);
  const waiting = shared.filter((b) => b.status === 'review');
  const live = shared.filter((b) => b.status === 'approved');
  const byTopic = {};
  for (const b of live) {
    const k = `${b.exam_code || '—'} · ${b.topic || 'Other'}`;
    byTopic[k] = (byTopic[k] || 0) + 1;
  }
  return (
    <div className="card">
      <div className="row wrap between">
        <h2 style={{ margin: 0 }}>Shared question bank</h2>
        <button className="btn claude sm" onClick={() => setAsking(true)}>
          <Icon name="cap" size={16} /> Ask Prof for shared questions
        </button>
      </div>
      <div className="small muted">
        StudyBridge’s own exam-style questions. Prof writes them and a second automatic check re-solves each one; every tutor gets them only after you approve them here. This is StudyBridge content, not any tutor’s work.
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        {Object.entries(byTopic).map(([k, n]) => (
          <span key={k} className="pill">
            {k}: {n}
          </span>
        ))}
        {!live.length && <span className="small muted">None approved yet. Start with IGCSE 0607: {X.topicsFor('0607').slice(0, 4).join(', ')}…</span>}
      </div>
      {waiting.length > 0 && <ReviewQueue rows={waiting} title="Shared questions to review" />}
      {asking && <AskProf shared onClose={() => setAsking(false)} />}
    </div>
  );
}
