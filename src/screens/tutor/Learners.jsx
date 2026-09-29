import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Field, Link, Modal, Page, Seg, copyText, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { encodeInvite } from '../../lib/config.js';
import { ago, dur, kindLabel, pct, weekRange, ymd } from '../../lib/format.js';
import { useLookups, SubjectTag } from '../shared/lookups.jsx';
import ProgressView from '../shared/Progress.jsx';

export default function Learners() {
  const lk = useLookups();
  const invites = useQuery('invites', api.listInvites);
  const activity = useQuery('activity', api.listActivity).data || [];
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
                    Code {i.code} · created {ago(i.created_at)}
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

function InviteShow({ invite, onClose }) {
  const app = useApp();
  const toast = useToast();
  const token = encodeInvite({ url: app.server.url, key: app.server.key, code: invite.code });
  const message = `Hi ${invite.name || 'there'}! Join me on StudyBridge.\n\n1. Install the StudyBridge app I sent you and open it.\n2. Choose “I’m a learner” and paste this invite:\n\n${token}\n\nSee you there,\n${app.me.display_name}`;
  return (
    <Modal
      title={`Invite for ${invite.name || 'your learner'}`}
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
      <p className="muted">Send this to your learner. It works once, and it already includes everything their app needs to connect to your StudyBridge.</p>
      <div className="code-box" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', userSelect: 'text', fontFamily: 'var(--sans)', fontSize: 14 }}>
        {message}
      </div>
      <div className="note small">
        Short code: <b className="big-code" style={{ fontSize: 16 }}>{invite.code}</b> (works on a device already connected to your StudyBridge).
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
        </>
      }
    >
      <Seg
        value={tab}
        onChange={(t) => go(`/learners/${id}/${t}`, { replace: true })}
        options={[
          { value: 'progress', label: 'Progress & summaries' },
          { value: 'work', label: `Work (${attempts.length})` },
        ]}
      />
      {tab === 'work' ? (
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
          <button type="button" className="btn danger" onClick={onRemove}>
            Remove learner
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
