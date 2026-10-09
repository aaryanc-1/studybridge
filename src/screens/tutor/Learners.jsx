import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Field, Link, Modal, Page, Seg, copyText, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { builtInServer, encodeInvite } from '../../lib/config.js';
import { ago, dur, kindLabel, pct, weekRange, ymd, when } from '../../lib/format.js';
import { StudyForTutor } from '../learner/Study.jsx';
import { useLookups, SubjectTag } from '../shared/lookups.jsx';
import ProgressView from '../shared/Progress.jsx';

export default function Learners() {
  const lk = useLookups();
  const invites = useQuery('invites', api.listInvites);
  const activity = useQuery('activity', api.listActivity).data || [];
  const accounts = useQuery('accounts', api.learnerAccounts).data || [];
  const [inviting, setInviting] = useState(false);
  const [shown, setShown] = useState(null);
  const open = (invites.data || []).filter((i) => !i.accepted_by && !i.revoked);
  const weekStr = ymd(weekRange(0).from);

  return (
    <Page
      title="Learners"
      subtitle="Add learners as you go. Each one joins with their own invite."
      actions={
        <button className="btn primary" onClick={() => setInviting(true)}>
          <Icon name="plus" size={18} /> Invite a learner
        </button>
      }
    >
      {lk.learners.length === 0 ? (
        <Empty
          title="No learners yet"
          action={
            <button className="btn primary" onClick={() => setInviting(true)}>
              <Icon name="plus" size={18} /> Invite a learner
            </button>
          }
        >
          Create an invite, send it to your learner, and they paste it into StudyBridge to join.
        </Empty>
      ) : (
        <div className="grid g3">
          {lk.learners.map((l) => {
            const subs = lk.subjectsOfLearner(l.id);
            const secs = activity.filter((x) => x.learner_id === l.id && x.day >= weekStr).reduce((s, x) => s + x.seconds, 0);
            return (
              <Link key={l.id} to={`/learners/${l.id}`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
                <div className="row">
                  <Avatar person={l} size="lg" />
                  <div className="grow">
                    <div className="strong" style={{ fontSize: 17 }}>{l.display_name}</div>
                    <div className="muted small">{lk.programme(l.programme_id)?.name || 'No programme'}</div>
                  </div>
                </div>
                <div className="chips small">
                  {subs.length ? subs.map((s) => <span key={s} className="pill"><SubjectTag id={s} /></span>) : <span className="muted small">No subjects yet</span>}
                </div>
                <div className="muted small">{dur(secs)} studied this week</div>
                {(() => {
                  const acct = accounts.find((x) => x.id === l.id);
                  return acct ? (
                    <div className="tiny muted" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 10 }}>
                      {acct.email} · {acct.last_sign_in_at ? `last signed in ${ago(acct.last_sign_in_at)}` : 'hasn’t signed in yet'}
                    </div>
                  ) : null;
                })()}
              </Link>
            );
          })}
        </div>
      )}

      {open.length > 0 && (
        <div className="card">
          <h2>Invites waiting to be used</h2>
          <div className="list">
            {open.map((i) => (
              <div key={i.id} className="item">
                <Icon name="send" style={{ color: 'var(--muted)' }} />
                <span className="grow">
                  <span className="name">{i.name || 'Unnamed invite'}</span>
                  <span className="meta">
                    Code {prettyCode(i.code)} · created {ago(i.created_at)}
                  </span>
                </span>
                <button className="btn sm" onClick={() => setShown(i)}>
                  Show invite
                </button>
                <button
                  className="btn sm ghost"
                  aria-label="Cancel invite"
                  onClick={async () => {
                    await api.revokeInvite(i.id);
                    invalidate('invites');
                  }}
                >
                  <Icon name="trash" size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {inviting && (
        <InviteForm
          onClose={() => setInviting(false)}
          onCreated={(i) => {
            setInviting(false);
            setShown(i);
            invalidate('invites');
          }}
        />
      )}
      {shown && <InviteShow invite={shown} onClose={() => setShown(null)} />}
    </Page>
  );
}

function InviteForm({ onClose, onCreated }) {
  const lk = useLookups();
  const [name, setName] = useState('');
  const [programme, setProgramme] = useState(lk.programmes[0]?.id || '');
  const [subjects, setSubjects] = useState([]);
  const [err, setErr] = useState('');
  const avail = programme ? lk.subjects.filter((s) => s.programme_id === programme || !s.programme_id) : lk.subjects;
  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return setErr('Add the learner’s name.');
    try {
      const inv = await api.createInvite({ name: name.trim(), programme_id: programme || null, subject_ids: subjects });
      onCreated(inv);
    } catch (x) {
      setErr(x.message);
    }
  }
  return (
    <Modal title="Invite a learner" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Learner’s name">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Anaya" />
        </Field>
        <Field label="Programme">
          <select className="select" value={programme} onChange={(e) => setProgramme(e.target.value)}>
            <option value="">None</option>
            {lk.programmes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Subjects" hint="They’ll see work, lessons and files for these subjects. You can change this any time.">
          {avail.length === 0 ? (
            <div className="muted small">
              No subjects yet. <Link to="/structure">Add subjects</Link> first, or add them to this learner later.
            </div>
          ) : (
            <div className="stack sm">
              {avail.map((s) => (
                <label key={s.id} className="check">
                  <input type="checkbox" checked={subjects.includes(s.id)} onChange={(e) => setSubjects(e.target.checked ? [...subjects, s.id] : subjects.filter((x) => x !== s.id))} />
                  <span className="t">
                    <SubjectTag id={s.id} />
                  </span>
                </label>
              ))}
            </div>
          )}
        </Field>
        {err && <div className="error">{err}</div>}
        <div className="foot row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Create invite</button>
        </div>
      </form>
    </Modal>
  );
}

// Parent accounts for one learner: read-only access to approved reports, lessons, due dates, marks given back
function ParentsPanel({ learner }) {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery(`parents:${learner.id}`, () => api.learnerParents(learner.id));
  const [name, setName] = useState('');
  const [shown, setShown] = useState(null);
  const first = learner.display_name.split(' ')[0];
  const d = q.data;
  const reload = () => invalidate(`parents:${learner.id}`, 'parent-counts');
  return (
    <div className="split even">
      <div className="card">
        <h2>Parents who can see {first}’s progress</h2>
        <div className="small muted">
          Read-only. They see weekly reports you approve, upcoming lessons and due dates, marks once you give them back, topic strengths, mock grades and the exam countdown. Never messages, working, photos, the exam camera or anything from Prof. {first} sees who’s linked and can remove them.
        </div>
        {!d ? (
          q.error ? <div className="error">{q.error.message}</div> : <Empty>Loading…</Empty>
        ) : d.parents.length === 0 ? (
          <div className="note small">No parents linked yet.</div>
        ) : (
          <div className="list">
            {d.parents.map((p) => (
              <div key={p.id} className="item">
                <Icon name="user" style={{ color: 'var(--accent)' }} />
                <span className="grow">
                  <span className="name">{p.name}</span>
                  <span className="meta">
                    {p.email} · since {when(p.since)}
                  </span>
                </span>
                <button
                  className="btn sm ghost"
                  onClick={async () => {
                    if (!(await confirm({ title: `Remove ${p.name}?`, body: `They stop seeing ${first}’s progress straight away.`, ok: 'Remove', danger: true }))) return;
                    try {
                      await api.removeParent(p.id);
                      reload();
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
        )}
      </div>
      <div className="card">
        <h2>Invite a parent</h2>
        <form
          className="row wrap"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const inv = await api.createParentInvite(learner.id, name.trim());
              setName('');
              reload();
              setShown(inv);
            } catch (x) {
              toast({ title: 'Couldn’t make the invite', body: x.message, tone: 'bad' });
            }
          }}
        >
          <input className="input grow" value={name} onChange={(e) => setName(e.target.value)} placeholder="Their name, e.g. Mum" aria-label="Parent’s name" />
          <button className="btn primary">
            <Icon name="plus" size={16} /> Make an invite
          </button>
        </form>
        <div className="tiny muted">Each invite works once, for one parent. They make their own account with it.</div>
        {d?.invites?.length > 0 && (
          <div className="list">
            {d.invites.map((i) => (
              <div key={i.id} className="item">
                <Icon name="send" style={{ color: 'var(--muted)' }} />
                <span className="grow">
                  <span className="name">{i.name || 'Parent'}</span>
                  <span className="meta">Not used yet · made {ago(i.created_at)}</span>
                </span>
                <button className="btn sm" onClick={() => setShown(i)}>
                  Show
                </button>
                <button
                  className="btn sm ghost"
                  onClick={async () => {
                    await api.revokeParentInvite(i.id);
                    reload();
                  }}
                >
                  Cancel
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
      {shown && <ParentInviteShow invite={shown} learner={learner} onClose={() => setShown(null)} />}
    </div>
  );
}

function ParentInviteShow({ invite, learner, onClose }) {
  const app = useApp();
  const toast = useToast();
  const token = encodeInvite({ url: app.server.url, key: app.server.key, code: invite.code });
  const first = learner.display_name.split(' ')[0];
  const phone = api.WEB_APP;
  const message = `Hi ${invite.name || 'there'}! You can now follow ${first}’s progress on StudyBridge: weekly reports, lessons, due dates and marks.

1. On your phone, open ${phone}
2. Choose “I’m a parent”, paste this invite and make your account:

${token}

3. Put StudyBridge on your home screen so it opens like an app:
• iPhone (Safari): tap the Share button, then “Add to Home Screen”.
• Android (Chrome): tap the ⋮ menu, then “Add to Home screen” or “Install app”.

On a computer, the same link works, or use the StudyBridge app.

Best wishes,
${app.me.display_name}`;
  return (
    <Modal
      title={`Parent invite for ${first}`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={() => (copyText(token), toast('Invite copied'))}>
            <Icon name="copy" size={16} /> Copy invite only
          </button>
          <button className="btn primary" onClick={() => (copyText(message), toast({ title: 'Message copied', body: 'Paste it into WhatsApp, email or a text.' }))}>
            <Icon name="copy" size={16} /> Copy message
          </button>
        </>
      }
    >
      <div className="small muted">Send this to {invite.name || 'the parent'}. It works once.</div>
      <pre className="report-preview">{message}</pre>
    </Modal>
  );
}

// 48291375 → "4829 1375", easy to read out and type
export const prettyCode = (c) => (/^\d{8}$/.test(c || '') ? `${c.slice(0, 4)} ${c.slice(4)}` : c);

function InviteShow({ invite, onClose }) {
  const app = useApp();
  const toast = useToast();
  // The app knows the server, so the code is all a learner needs: a link that fills it in, or the 8 digits to type
  const short = !!builtInServer && /^\d{8}$/.test(invite.code);
  const token = encodeInvite({ url: app.server.url, key: app.server.key, code: invite.code });
  const message = short
    ? `Hi ${invite.name || 'there'}! Join me on StudyBridge.\n\nTap this link to join: ${api.WEB_APP}#join=${invite.code}\n\nOr open the StudyBridge app, choose “I’m a learner” and type the code ${prettyCode(invite.code)}.\n\nSee you there,\n${app.me.display_name}`
    : `Hi ${invite.name || 'there'}! Join me on StudyBridge.\n\n1. Install the StudyBridge app I sent you and open it.\n2. Choose “I’m a learner” and paste this invite:\n\n${token}\n\nSee you there,\n${app.me.display_name}`;
  return (
    <Modal
      title={`Invite for ${invite.name || 'your learner'}`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={() => (copyText(short ? invite.code : token), toast(short ? 'Code copied' : 'Invite copied'))}>
            <Icon name="copy" size={16} /> {short ? 'Copy code only' : 'Copy invite only'}
          </button>
          <button className="btn primary" onClick={() => (copyText(message), toast({ title: 'Message copied', body: 'Paste it into WhatsApp, email or a text.' }))}>
            <Icon name="copy" size={16} /> Copy message
          </button>
        </>
      }
    >
      {short && (
        <div className="invite-code">
          <span className="tiny muted">{invite.name ? `${invite.name.split(' ')[0]}’s code` : 'Their code'}</span>
          <b>{prettyCode(invite.code)}</b>
        </div>
      )}
      <p className="muted">Send this to your learner. The code works once.</p>
      <div className="code-box" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text', fontFamily: 'var(--sans)', fontSize: 14 }}>
        {message}
      </div>
    </Modal>
  );
}

export function LearnerDetail({ id, tab = 'progress' }) {
  const lk = useLookups();
  const confirm = useConfirm();
  const toast = useToast();
  const l = lk.learner(id);
  const attempts = (useQuery('attempts', api.listAttempts).data || []).filter((t) => t.learner_id === id);
  const assignments = useQuery('assignments', api.listAssignments).data || [];
  const [editing, setEditing] = useState(false);
  const [account, setAccount] = useState(false);
  if (!l) return <Page title="Learner">{lk.ready ? <Empty>This learner isn’t in your list any more.</Empty> : null}</Page>;
  const aById = Object.fromEntries(assignments.map((a) => [a.id, a]));
  const subs = lk.subjectsOfLearner(id);

  return (
    <Page
      size="wide"
      eyebrow={
        <>
          <Link to="/learners">Learners</Link> <Icon name="right" size={14} />
        </>
      }
      title={
        <span className="row" style={{ gap: 14 }}>
          <Avatar person={l} size="lg" />
          {l.display_name}
        </span>
      }
      subtitle={
        <span className="row wrap" style={{ gap: 8, marginTop: 6 }}>
          <span>{lk.programme(l.programme_id)?.name || 'No programme'}</span>
          {subs.map((s) => (
            <span key={s} className="pill">
              <SubjectTag id={s} />
            </span>
          ))}
        </span>
      }
      actions={
        <>
          <button className="btn" onClick={() => go(`/messages/${id}`)}>
            <Icon name="message" size={18} /> Message
          </button>
          <button className="btn" onClick={() => setEditing(true)}>
            <Icon name="pen" size={18} /> Edit
          </button>
          <button className="btn" onClick={() => setAccount(true)}>
            <Icon name="lock" size={18} /> Account
          </button>
        </>
      }
    >
      {account && <AccountModal l={l} onClose={() => setAccount(false)} />}
      <Seg
        value={tab}
        onChange={(t) => go(`/learners/${id}/${t}`, { replace: true })}
        options={[
          { value: 'progress', label: 'Progress & summaries' },
          { value: 'work', label: `Work (${attempts.length})` },
          { value: 'study', label: 'Study' },
          { value: 'parents', label: 'Parents' },
        ]}
      />
      {tab === 'parents' ? (
        <ParentsPanel learner={l} />
      ) : tab === 'study' ? (
        <StudyForTutor learnerId={id} />
      ) : tab === 'work' ? (
        <div className="card pad0">
          {attempts.length === 0 ? (
            <div style={{ padding: 20 }}>
              <Empty>Nothing started yet.</Empty>
            </div>
          ) : (
            <table className="table responsive">
              <thead>
                <tr>
                  <th>Assignment</th>
                  <th>Status</th>
                  <th>Score</th>
                  <th>Time</th>
                  <th>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {attempts.map((t) => {
                  const a = aById[t.assignment_id];
                  const p = pct(t.score, t.max_score);
                  return (
                    <tr key={t.id} className="click" onClick={() => go(t.status === 'in_progress' && a?.camera ? `/watch/${t.id}` : `/marking/${t.id}`)}>
                      <td data-label="Assignment">
                        <div className="strong">{a?.title}</div>
                        <div className={'kind ' + a?.kind}>{kindLabel[a?.kind]}{t.number > 1 ? ` · attempt ${t.number}` : ''}</div>
                      </td>
                      <td data-label="Status">
                        <StatusPill t={t} />
                      </td>
                      <td data-label="Score">{t.score != null ? `${Number(t.score)} / ${Number(t.max_score)} (${p}%)` : '—'}</td>
                      <td data-label="Time">{dur(t.time_spent_sec)}</td>
                      <td data-label="Submitted">{t.submitted_at ? ago(t.submitted_at) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <ProgressView learnerId={id} name={l.display_name} />
      )}
      {editing && (
        <EditLearner
          l={l}
          onClose={() => setEditing(false)}
          onRemove={async () => {
            if (!(await confirm({ title: `Remove ${l.display_name}?`, body: 'They lose access to your StudyBridge straight away. Their past work stays in your records.', ok: 'Remove', danger: true }))) return;
            try {
              await api.removeLearner(l.id);
              lk.reload();
              go('/learners');
            } catch (e) {
              toast({ title: 'Couldn’t remove', body: e.message, tone: 'bad' });
            }
          }}
        />
      )}
    </Page>
  );
}

export function StatusPill({ t }) {
  if (t.status === 'in_progress') return <span className="pill accent">In progress</span>;
  if (t.status === 'submitted') return <span className="pill warn">To mark</span>;
  if (t.status === 'returned') return <span className="pill warn">Sent back for redo</span>;
  return t.released ? <span className="pill good">Marked · returned</span> : <span className="pill">Marked · not released</span>;
}

function EditLearner({ l, onClose, onRemove }) {
  const lk = useLookups();
  const [name, setName] = useState(l.display_name);
  const [programme, setProgramme] = useState(l.programme_id || '');
  const [subjects, setSubjects] = useState(lk.subjectsOfLearner(l.id));
  const [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault();
    try {
      await api.setLearner(l.id, name, programme, subjects);
      lk.reload();
      onClose();
    } catch (x) {
      setErr(x.message);
    }
  }
  return (
    <Modal title={`Edit ${l.display_name}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Programme">
          <select className="select" value={programme} onChange={(e) => setProgramme(e.target.value)}>
            <option value="">None</option>
            {lk.programmes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Subjects">
          <div className="stack sm">
            {lk.subjects.map((s) => (
              <label key={s.id} className="check">
                <input type="checkbox" checked={subjects.includes(s.id)} onChange={(e) => setSubjects(e.target.checked ? [...subjects, s.id] : subjects.filter((x) => x !== s.id))} />
                <span className="t">
                  <SubjectTag id={s.id} />
                  {s.programme_id && <span className="muted small"> · {lk.programme(s.programme_id)?.name}</span>}
                </span>
              </label>
            ))}
          </div>
        </Field>
        <div className="muted small">Email: {l.email}</div>
        {err && <div className="error">{err}</div>}
        <div className="row between">
          <button type="button" className="btn danger" onClick={onRemove} title="They lose access, but their past work stays in your records">
            Remove from my learners
          </button>
          <div className="row">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary">Save</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}

// Easy-to-read temporary passwords, e.g. "Mango-River-47"
const WORDS = ['Mango', 'River', 'Tiger', 'Cloud', 'Maple', 'Comet', 'Zebra', 'Lemon', 'Otter', 'Pixel', 'Rocket', 'Sunny', 'Violet', 'Panda', 'Ocean', 'Falcon'];
export function easyPassword() {
  const r = (n) => Math.floor((crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32) * n);
  return `${WORDS[r(WORDS.length)]}-${WORDS[r(WORDS.length)]}-${10 + r(90)}`;
}

function AccountModal({ l, onClose }) {
  const lk = useLookups();
  const toast = useToast();
  const accounts = useQuery('accounts', api.learnerAccounts);
  const acct = (accounts.data || []).find((x) => x.id === l.id);
  const [pw, setPw] = useState('');
  const [show, setShow] = useState(true);
  const [done, setDone] = useState('');
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmName, setConfirmName] = useState('');
  const first = l.display_name.split(' ')[0];

  async function setPassword(e) {
    e.preventDefault();
    if (pw.length < 6) return toast({ title: 'Use at least 6 characters', tone: 'bad' });
    setBusy(true);
    try {
      await api.setLearnerPassword(l.id, pw);
      setDone(pw);
      setPw('');
    } catch (x) {
      toast({ title: 'Couldn’t change the password', body: x.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  async function del() {
    setBusy(true);
    try {
      await api.deleteLearnerAccount(l.id);
      invalidate('accounts', 'attempts', 'comments');
      lk.reload();
      toast(`${l.display_name}’s account was deleted`);
      go('/learners');
    } catch (x) {
      toast({ title: 'Couldn’t delete the account', body: x.message, tone: 'bad' });
      setBusy(false);
    }
  }

  return (
    <Modal title={`${l.display_name}’s account`} onClose={onClose}>
      <div className="stack sm small">
        <div className="row between"><span className="muted">Email (their sign-in)</span><span className="strong">{acct?.email || l.email}</span></div>
        <div className="row between"><span className="muted">Joined</span><span>{acct?.joined_at ? when(acct.joined_at) : '—'}</span></div>
        <div className="row between"><span className="muted">Last signed in</span><span>{acct?.last_sign_in_at ? ago(acct.last_sign_in_at) : 'Not yet'}</span></div>
      </div>
      <hr />
      <form className="stack sm" onSubmit={setPassword}>
        <h3>Set a new password</h3>
        <div className="muted small">For when {first} forgets it. {first} can change it again any time in Settings.</div>
        <div className="row">
          <input className="input" type={show ? 'text' : 'password'} value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password" aria-label="New password" autoComplete="new-password" />
          <button type="button" className="btn sm ghost icon" onClick={() => setShow((x) => !x)} aria-label={show ? 'Hide password' : 'Show password'}>
            <Icon name={show ? 'eyeOff' : 'eye'} size={16} />
          </button>
          <button type="button" className="btn sm" onClick={() => setPw(easyPassword())}>Make one up</button>
        </div>
        <div>
          <button className="btn primary" disabled={busy || !pw}>Save new password</button>
        </div>
        {done && (
          <div className="okmsg row between wrap">
            <span>
              Done. Tell {first}: <b style={{ userSelect: 'all' }}>{done}</b>
            </span>
            <button type="button" className="btn sm" onClick={() => (copyText(done), toast('Copied'))}>
              <Icon name="copy" size={14} /> Copy
            </button>
          </div>
        )}
      </form>
      <hr />
      <div className="stack sm">
        <h3 style={{ color: 'var(--red-ink)' }}>Delete account</h3>
        <div className="muted small">
          Deletes {first}’s sign-in and everything of theirs: work, marks, notes, messages and progress. This can’t be undone. (To stop their access but keep their records, use Edit → Remove from my learners.)
        </div>
        {!deleting ? (
          <div>
            <button className="btn danger" onClick={() => setDeleting(true)}>Delete {first}’s account…</button>
          </div>
        ) : (
          <div className="stack sm">
            <label className="small" htmlFor="confirm-delete">Type <b>{first}</b> to confirm</label>
            <div className="row">
              <input id="confirm-delete" className="input" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoFocus />
              <button className="btn danger solid" disabled={busy || confirmName.trim().toLowerCase() !== first.toLowerCase()} onClick={del}>
                Delete forever
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
