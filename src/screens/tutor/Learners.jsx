import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Field, Link, Modal, Page, Seg, copyText, go, useConfirm, useRoute, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { builtInServer, encodeInvite } from '../../lib/config.js';
import { ago, day, dur, kindLabel, pct, weekRange, ymd, when } from '../../lib/format.js';
import { StudyForTutor } from '../learner/Study.jsx';
import { useLookups, SubjectTag } from '../shared/lookups.jsx';
import ProgressView from '../shared/Progress.jsx';
import { AccessLine } from './Access.jsx';
import { AttendanceCard, BehaviourCard } from '../shared/School.jsx';

// When a learner is paused for me: by me as their main tutor (on their account), or on the link if they added me
function pausedFor(l, me, links) {
  if (l.tutor_id === me) return l.paused_at || null;
  return links.find((x) => x.learner_id === l.id)?.paused_at || null;
}

export default function Learners({ tab = 'learners' }) {
  const app = useApp();
  const lk = useLookups();
  const confirm = useConfirm();
  const toast = useToast();
  const invites = useQuery('invites', api.listInvites);
  const activity = useQuery('activity', api.listActivity).data || [];
  const accounts = useQuery('accounts', api.learnerAccounts).data || [];
  const route = useRoute();
  const [inviting, setInviting] = useState(() => route.query.get('invite') === '1'); // Home's Invite button
  const [shown, setShown] = useState(null);
  const [editingClass, setEditingClass] = useState(null); // {} for a new class
  const [inClass, setInClass] = useState(''); // show only one class's learners
  const open = (invites.data || []).filter((i) => !i.accepted_by && !i.revoked);
  const weekStr = ymd(weekRange(0).from);
  const filterClass = lk.activeClasses.find((c) => c.id === inClass);
  const learners = filterClass ? lk.learners.filter((l) => filterClass.members.includes(l.id)) : lk.learners;
  const links = useQuery('linked-learners', api.myLinkedLearners).data || [];
  // the classes someone joins when they use the invite
  const joinsOf = (i) => (i.class_ids || []).map((id) => lk.klass(id)?.name).filter(Boolean);

  return (
    <Page
      title="Learners"
      subtitle={tab === 'classes' ? 'Group learners who learn together, then set things for the whole class at once.' : 'Add learners as you go. Each one joins with their own invite.'}
      actions={
        tab === 'classes' ? (
          <button className="btn primary" onClick={() => setEditingClass({})}>
            <Icon name="plus" size={18} /> New class
          </button>
        ) : (
          <button className="btn primary" onClick={() => setInviting(true)}>
            <Icon name="plus" size={18} /> Invite a learner
          </button>
        )
      }
    >
      <LearnerTabs tab={tab} />
      {tab === 'classes' ? (
        <Classes onNew={() => setEditingClass({})} onEdit={setEditingClass} />
      ) : lk.learners.length === 0 ? (
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
        <>
          {lk.activeClasses.length > 0 && (
            <div className="row wrap">
              <label className="small muted" htmlFor="learners-class">
                Class
              </label>
              <select id="learners-class" className="select" style={{ width: 'auto', minHeight: 36 }} value={inClass} onChange={(e) => setInClass(e.target.value)}>
                <option value="">All learners</option>
                {lk.activeClasses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {learners.length === 0 && filterClass && <Empty>Nobody is in {filterClass.name} yet.</Empty>}
          <div className="grid g3">
            {learners.map((l) => {
              const subs = lk.subjectsOfLearner(l.id);
              const classes = lk.classesOf(l.id).filter((c) => !c.archived);
              const secs = activity.filter((x) => x.learner_id === l.id && x.day >= weekStr).reduce((s, x) => s + x.seconds, 0);
              return (
                <Link key={l.id} to={`/learners/${l.id}`} className="card" style={{ textDecoration: 'none', color: 'inherit' }}>
                  <div className="row">
                    <Avatar person={l} size="lg" />
                    <div className="grow">
                      <div className="strong" style={{ fontSize: 17 }}>
                        {l.display_name} {pausedFor(l, app.me.id, links) && <span className="pill warn">Paused</span>}
                      </div>
                      {/* someone else's learner, here because they're in one of my classes (a learner who added me with a code is mine) */}
                      <div className="muted small">
                        {l.tutor_id === app.me.id ? lk.programme(l.programme_id)?.name || 'No programme' : links.some((x) => x.learner_id === l.id) ? 'Your learner' : <span className="pill">In your class</span>}
                      </div>
                    </div>
                  </div>
                  <div className="chips small">
                    {subs.length ? subs.map((s) => <span key={s} className="pill"><SubjectTag id={s} /></span>) : <span className="muted small">No subjects yet</span>}
                  </div>
                  {classes.length > 0 && (
                    <div className="chips">
                      {classes.map((c) => (
                        <span key={c.id} className="pill accent">
                          <Icon name="users" size={12} /> {c.name}
                        </span>
                      ))}
                    </div>
                  )}
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
        </>
      )}

      {tab !== 'classes' && open.length > 0 && (
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
                    {joinsOf(i).length > 0 && ` · joins ${joinsOf(i).join(', ')}`}
                  </span>
                </span>
                <button className="btn sm" onClick={() => setShown(i)}>
                  Show invite
                </button>
                <button
                  className="btn sm ghost"
                  aria-label="Cancel invite"
                  onClick={async () => {
                    if (!(await confirm({ title: `Cancel the invite for ${i.name || 'this learner'}?`, body: 'The code stops working. You can make a new one any time.', ok: 'Cancel invite', cancel: 'Keep it' }))) return;
                    try {
                      await api.revokeInvite(i.id);
                      invalidate('invites');
                    } catch (e) {
                      toast({ title: 'Couldn’t cancel it', body: e.message, tone: 'bad' });
                    }
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
      {editingClass && <ClassForm klass={editingClass} onClose={() => setEditingClass(null)} />}
    </Page>
  );
}

// After a class changes, so does who sees everything set for it (and who's in my learners)
const classesChanged = () => invalidate('classes', 'class_members', 'class_teachers', 'class-pool', 'learners', 'learner_subjects', 'assignments', 'lessons', 'files', 'sessions');

// "you", "Ms Achieng" → "you and Ms Achieng"
const andList = (xs) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

// Who can go in a class and who teaches it. A centre's (or school's) manager makes and changes classes for any of
// its tutors; everyone else makes classes they teach themselves.
function useClassPeople() {
  const app = useApp();
  const lk = useLookups();
  const org = useQuery('org', api.myOrg).data;
  const poolQ = useQuery('class-pool', api.classPool);
  const pool = poolQ.data || [];
  const me = app.me.id;
  const manager = !!org && org.role === 'manager' && (org.kind === 'centre' || org.kind === 'school');
  const teacherName = (id) => org?.members?.find((m) => m.id === id)?.name || pool.find((p) => p.tutor_id === id)?.tutor || 'another teacher';
  return {
    org,
    manager,
    pool,
    poolReady: poolQ.data !== undefined,
    tutors: org?.members || [],
    learnerName: (id) => pool.find((p) => p.id === id)?.name || lk.learner(id)?.display_name,
    // "Taught by you and Ms Achieng"
    taughtBy: (c) => {
      const ids = lk.teachersOf(c.id);
      const names = (ids.length ? ids : [c.tutor_id]).sort((a, b) => (b === me) - (a === me)).map((id) => (id === me ? 'you' : teacherName(id)));
      return `Taught by ${andList([...new Set(names)])}`;
    },
  };
}

// Classes: learners taught together. Anything set for a class goes to whoever is in it, now or later.
function Classes({ onNew, onEdit }) {
  const app = useApp();
  const lk = useLookups();
  const confirm = useConfirm();
  const toast = useToast();
  const cp = useClassPeople();
  const [codes, setCodes] = useState({}); // class id → its code, while it's shown
  const me = app.me.id;
  const teaches = (c) => {
    const t = lk.teachersOf(c.id);
    return t.length ? t.includes(me) : c.tutor_id === me;
  };
  // a manager sees every class in the centre; anyone else the classes they teach
  const listed = cp.manager ? lk.orgClasses : lk.activeClasses;
  const away = lk.classes.filter((c) => c.archived && (cp.manager || teaches(c)));
  const size = (c) => lk.membersOf(c.id).length;

  async function putAway(c, archived = true) {
    try {
      await api.archiveClass(c.id, archived);
      classesChanged();
      toast(archived ? { title: `${c.name} is put away`, body: 'It stays on everything it was used for. Bring it back any time.' } : `${c.name} is back`);
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
    }
  }
  async function del(c) {
    if (!(await confirm({ title: `Delete ${c.name}?`, body: 'Work, lesson notes and lessons set for it keep the learners they have now. Anything set only for it while nobody was in it is hidden.', ok: 'Delete', danger: true }))) return;
    try {
      await api.deleteClass(c.id);
      classesChanged();
      toast(`${c.name} is deleted`);
    } catch (e) {
      toast({ title: 'Couldn’t delete it', body: e.message, tone: 'bad' });
    }
  }
  // The code learners type to join the class (made the first time it's asked for)
  async function showCode(c) {
    if (codes[c.id]) return setCodes((x) => ({ ...x, [c.id]: null }));
    try {
      const code = await api.classCode(c.id);
      setCodes((x) => ({ ...x, [c.id]: code }));
    } catch (e) {
      toast({ title: 'Couldn’t get the code', body: e.message, tone: 'bad' });
    }
  }
  async function newCode(c) {
    if (!(await confirm({ title: 'Make a new code?', body: 'The old one stops working.', ok: 'New code' }))) return;
    try {
      const code = await api.classCode(c.id, true);
      setCodes((x) => ({ ...x, [c.id]: code }));
      toast('New code made');
    } catch (e) {
      toast({ title: 'Couldn’t make a new code', body: e.message, tone: 'bad' });
    }
  }
  const codeMessage = (c, code) =>
    `Join ${c.name} on StudyBridge: open StudyBridge and type the code ${prettyCode(code)} (new accounts: “I have a code from my tutor”; already on StudyBridge: Settings → Your schools and tutors → Add).`;

  return (
    <>
      {cp.manager && <div className="small muted">All the classes in {cp.org.name}</div>}
      {listed.length === 0 ? (
        <Empty
          title={away.length ? 'No classes in use' : 'No classes yet'}
          action={
            <button className="btn primary" onClick={onNew}>
              <Icon name="plus" size={18} /> New class
            </button>
          }
        >
          Group learners who learn together. Set work, lesson notes, files and live lessons for a class, and anyone who joins it later gets them too.
        </Empty>
      ) : (
        <div className="grid g3">
          {listed.map((c) => {
            const n = c.members.length;
            const people = c.members
              .map((id) => ({ id, name: cp.learnerName(id), open: !!lk.learner(id) }))
              .filter((p) => p.name)
              .sort((x, y) => x.name.localeCompare(y.name));
            const code = codes[c.id];
            return (
              <div key={c.id} className="card">
                <div className="stack sm">
                  <Link to={`/learners/classes/${c.id}`} className="strong" style={{ fontSize: 17 }} aria-label={`Open ${c.name}`}>
                    {c.name}
                  </Link>
                  <div className="row wrap small muted" style={{ gap: 8 }}>
                    {c.subject_id && <SubjectTag id={c.subject_id} />}
                    <span>{n ? `${n} learner${n === 1 ? '' : 's'}` : 'Nobody in it yet'}</span>
                  </div>
                  <div className="row small muted" style={{ gap: 6 }}>
                    <Icon name="user" size={14} />
                    <span>{cp.taughtBy(c)}</span>
                  </div>
                </div>
                {people.length > 0 && (
                  <div className="chips">
                    {people.map((p) =>
                      p.open ? (
                        <Link key={p.id} to={`/learners/${p.id}`} className="pill" style={{ textDecoration: 'none' }}>
                          {p.name}
                        </Link>
                      ) : (
                        <span key={p.id} className="pill">
                          {p.name}
                        </span>
                      ),
                    )}
                  </div>
                )}
                {code && (
                  <div className="code-card">
                    <span className="small">Class code</span>
                    <b className="code-show">{prettyCode(code)}</b>
                    <span className="small muted">Learners type it to join {c.name}.</span>
                    <span className="row wrap" style={{ gap: 8 }}>
                      <button className="btn sm" aria-label={`Copy message for ${c.name}`} onClick={() => (copyText(codeMessage(c, code)), toast({ title: 'Message copied', body: 'Paste it into WhatsApp, email or a text.' }))}>
                        <Icon name="copy" size={14} /> Copy message
                      </button>
                      <button className="btn sm ghost" aria-label={`New code for ${c.name}`} onClick={() => newCode(c)}>
                        <Icon name="refresh" size={14} /> New code
                      </button>
                    </span>
                  </div>
                )}
                <div className="row wrap" style={{ gap: 6, marginTop: 'auto' }}>
                  <button className="btn sm" onClick={() => onEdit(c)} aria-label={`Edit ${c.name}`}>
                    <Icon name="pen" size={15} /> Edit
                  </button>
                  <button className="btn sm" onClick={() => showCode(c)} aria-expanded={!!code} aria-label={`Class code for ${c.name}`}>
                    Class code
                  </button>
                  <button className="btn sm" onClick={() => putAway(c)} aria-label={`Put away ${c.name}`}>
                    Put away
                  </button>
                  <button className="btn sm ghost icon" onClick={() => del(c)} aria-label={`Delete ${c.name}`}>
                    <Icon name="trash" size={15} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {away.length > 0 && (
        <div className="card">
          <h2>Put away</h2>
          <div className="small muted">They stay on everything they were used for. Bring one back to use it again.</div>
          <div className="list">
            {away.map((c) => (
              <div key={c.id} className="item">
                <Icon name="users" style={{ color: 'var(--muted)' }} />
                <span className="grow">
                  <span className="name">{c.name}</span>
                  <span className="meta">
                    {c.subject_id && <SubjectTag id={c.subject_id} />}
                    <span>
                      {size(c)} learner{size(c) === 1 ? '' : 's'}
                    </span>
                  </span>
                </span>
                <button className="btn sm" onClick={() => putAway(c, false)} aria-label={`Bring back ${c.name}`}>
                  Bring back
                </button>
                <button className="btn sm ghost icon" onClick={() => del(c)} aria-label={`Delete ${c.name}`}>
                  <Icon name="trash" size={15} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

// Make or change a class: its name, its subject (if it has one), who teaches it (a manager chooses) and who's in it
function ClassForm({ klass, onClose }) {
  const app = useApp();
  const lk = useLookups();
  const toast = useToast();
  const cp = useClassPeople();
  const me = app.me.id;
  const isNew = !klass.id;
  const [name, setName] = useState(klass.name || '');
  const [subject, setSubject] = useState(klass.subject_id || '');
  const [ids, setIds] = useState(() => (isNew ? [] : lk.membersOf(klass.id)));
  const [teachers, setTeachers] = useState(() => (isNew ? [me] : lk.teachersOf(klass.id).length ? lk.teachersOf(klass.id) : [klass.tutor_id]));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  // learners who take the class's subject come first
  const takes = (l) => !!subject && lk.subjectsOfLearner(l.id).includes(subject);
  const people = [...cp.pool].sort((x, y) => takes(y) - takes(x));
  // the subject has to be one of its teachers' (or the manager's own); one we can't see stays as it is
  const hidden = !!klass.subject_id && !lk.subject(klass.subject_id);
  const othersClass = cp.manager && !teachers.includes(me);
  const note = (p) =>
    [p.tutor_id !== me && (p.tutor ? `${p.tutor}’s learner` : 'Another tutor’s learner'), lk.subject(subject) && !takes(p) && `Doesn’t take ${lk.subject(subject).name}`].filter(Boolean).join(' · ');
  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return setErr('Give the class a name.');
    if (cp.manager && !teachers.length) return setErr('Choose at least one teacher.');
    setBusy(true);
    try {
      await api.saveClass({ id: klass.id, name: name.trim(), subject_id: subject || null, learner_ids: ids, ...(cp.manager ? { teacher_ids: teachers } : {}) });
      classesChanged();
      toast(isNew ? 'Class made. Anyone you add is told.' : 'Class saved');
      onClose();
    } catch (x) {
      setErr(x.message);
      setBusy(false);
    }
  }
  return (
    <Modal title={isNew ? 'New class' : `Edit ${klass.name}`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Year 10 maths" maxLength={80} />
        </Field>
        {cp.manager && (
          <Field label="Teachers" hint="They see, mark and message the learners in this class.">
            <div className="stack sm">
              {cp.tutors.map((m) => (
                <label key={m.id} className="check">
                  <input type="checkbox" checked={teachers.includes(m.id)} onChange={(e) => setTeachers(e.target.checked ? [...teachers, m.id] : teachers.filter((x) => x !== m.id))} />
                  <span className="t">
                    {m.name}
                    {m.me ? ' (you)' : ''}
                  </span>
                  {m.role === 'manager' && <span className="s">Manager</span>}
                </label>
              ))}
            </div>
          </Field>
        )}
        <Field label="Subject (optional)" hint={othersClass ? 'Leave it empty, or ask its teacher to add the subject.' : undefined}>
          <select className="select" value={subject} onChange={(e) => setSubject(e.target.value)}>
            <option value="">No subject</option>
            {hidden && <option value={klass.subject_id}>Its current subject</option>}
            {lk.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Learners" hint={cp.pool.length ? 'Anything you set for the class goes to whoever is in it, including people you add later.' : undefined}>
          {!cp.poolReady ? (
            <div className="muted small">Loading…</div>
          ) : cp.pool.length === 0 ? (
            <div className="note small">You don’t have any learners yet. Make the class now and add learners when they join. When you invite someone, you can choose their classes too.</div>
          ) : (
            <div className="stack sm" style={{ maxHeight: 300, overflowY: 'auto' }}>
              {people.map((p) => (
                <label key={p.id} className="check">
                  <input type="checkbox" checked={ids.includes(p.id)} onChange={(e) => setIds(e.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id))} />
                  <span className="t">{p.name}</span>
                  {note(p) && <span className="s">{note(p)}</span>}
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
          <button className="btn primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function InviteForm({ onClose, onCreated }) {
  const lk = useLookups();
  const [name, setName] = useState('');
  const [programme, setProgramme] = useState(lk.programmes[0]?.id || '');
  const [subjects, setSubjects] = useState([]);
  const [classIds, setClassIds] = useState([]);
  const [err, setErr] = useState('');
  const avail = programme ? lk.subjects.filter((s) => s.programme_id === programme || !s.programme_id) : lk.subjects;
  // a class's subject comes with it
  const pickClass = (c, on) => {
    setClassIds(on ? [...classIds, c.id] : classIds.filter((x) => x !== c.id));
    if (on && c.subject_id && !subjects.includes(c.subject_id) && avail.some((s) => s.id === c.subject_id)) setSubjects([...subjects, c.subject_id]);
  };
  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return setErr('Add the learner’s name.');
    try {
      const inv = await api.createInvite({ name: name.trim(), programme_id: programme || null, subject_ids: subjects, ...(classIds.length ? { class_ids: classIds } : {}) });
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
              No subjects yet. <Link to="/library/subjects">Add subjects</Link> first, or add them to this learner later.
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
        {lk.activeClasses.length > 0 && (
          <Field label="Classes (optional)" hint="They join these classes as soon as they use the code.">
            <div className="stack sm">
              {lk.activeClasses.map((c) => (
                <label key={c.id} className="check">
                  <input type="checkbox" checked={classIds.includes(c.id)} onChange={(e) => pickClass(c, e.target.checked)} />
                  <span className="t">{c.name}</span>
                  {c.subject_id && <span className="s">{lk.subject(c.subject_id)?.name}</span>}
                </label>
              ))}
            </div>
          </Field>
        )}
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
                    if (!(await confirm({ title: 'Cancel this parent invite?', body: 'The code stops working. You can make a new one any time.', ok: 'Cancel invite', cancel: 'Keep it' }))) return;
                    try {
                      await api.revokeParentInvite(i.id);
                      reload();
                    } catch (e) {
                      toast({ title: 'Couldn’t cancel it', body: e.message, tone: 'bad' });
                    }
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
  const app = useApp();
  const lk = useLookups();
  const confirm = useConfirm();
  const toast = useToast();
  const l = lk.learner(id);
  const attempts = (useQuery('attempts', api.listAttempts).data || []).filter((t) => t.learner_id === id);
  const assignments = useQuery('assignments', api.listAssignments).data || [];
  const pool = useQuery('class-pool', api.classPool).data;
  const links = useQuery('linked-learners', api.myLinkedLearners).data || [];
  const [editing, setEditing] = useState(false);
  const [account, setAccount] = useState(false);
  const [classing, setClassing] = useState(false);
  if (!l) return <Page title="Learner">{lk.ready ? <Empty>This learner isn’t in your list any more.</Empty> : null}</Page>;
  const aById = Object.fromEntries(assignments.map((a) => [a.id, a]));
  const subs = lk.subjectsOfLearner(id);
  const classes = lk.classesOf(id).filter((c) => !c.archived);
  const first = l.display_name.split(' ')[0];
  // Someone else's learner in my classes: I teach, mark and message them, but only their own tutor changes their
  // details, account and parents. A learner who added me with a code is mine to teach, pause or remove, but their main
  // tutor still looks after their account, name and parents.
  const main = l.tutor_id === app.me.id;
  const own = main || links.some((x) => x.learner_id === id);
  const paused = pausedFor(l, app.me.id, links);
  if (!main && tab === 'parents') tab = 'progress';
  const taught = lk.activeClasses.filter((c) => c.members.includes(id)).map((c) => c.name);
  const theirTutor = pool && (pool.find((p) => p.id === id)?.tutor || 'another tutor');
  // Pausing: they keep everything and can look, but start nothing new and don't count on the plan
  async function pause() {
    const on = !paused;
    if (
      on &&
      !(await confirm({
        title: `Pause ${first}?`,
        body: 'They keep all their work and can still sign in to see it, but can’t start anything new and aren’t told about new work. They don’t count on your plan while paused. Unpause any time.',
        ok: 'Pause',
      }))
    )
      return;
    try {
      await api.pauseLearner(l.id, on);
      invalidate('learners', 'linked-learners', 'my-plan');
      toast(on ? `${first} is paused` : `${first} is back on`);
    } catch (e) {
      toast({ title: on ? 'Couldn’t pause' : 'Couldn’t unpause', body: e.message, tone: 'bad' });
    }
  }

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
          {paused && <span className="pill warn">Paused</span>}
        </span>
      }
      subtitle={
        <>
          {!own && theirTutor && (
            <span className="row wrap" style={{ gap: 8, marginTop: 6 }}>
              <span>
                {first} is {theirTutor}’s learner.{taught.length > 0 && ` You teach them in ${andList(taught)}.`}
              </span>
            </span>
          )}
          <span className="row wrap" style={{ gap: 8, marginTop: 6 }}>
            {(own || lk.programme(l.programme_id)) && <span>{lk.programme(l.programme_id)?.name || 'No programme'}</span>}
            {subs.map((s) => (
              <span key={s} className="pill">
                <SubjectTag id={s} />
              </span>
            ))}
          </span>
          {lk.activeClasses.length > 0 && (
            <span className="row wrap small" style={{ gap: 8, marginTop: 8 }}>
              <Icon name="users" size={15} />
              <span>{classes.length ? `Classes: ${classes.map((c) => c.name).join(', ')}` : 'Not in a class'}</span>
              <button className="linkbtn small" onClick={() => setClassing(true)} aria-label="Change classes">
                Change
              </button>
            </span>
          )}
          <AccessLine id={id} first={first} />
        </>
      }
      actions={
        <>
          <button className="btn" onClick={() => go(`/see/${id}`)}>
            <Icon name="eye" size={18} /> See it as {first}
          </button>
          <button className="btn" onClick={() => go(`/messages/${id}`)}>
            <Icon name="message" size={18} /> Message
          </button>
          {own && (
            <>
              <button className="btn" onClick={() => setEditing(true)}>
                <Icon name="pen" size={18} /> Edit
              </button>
              {main && (
                <button className="btn" onClick={() => setAccount(true)}>
                  <Icon name="lock" size={18} /> Account
                </button>
              )}
              <button className="btn" onClick={pause}>
                <Icon name={paused ? 'play' : 'pause'} size={18} /> {paused ? 'Unpause' : 'Pause'}
              </button>
            </>
          )}
        </>
      }
    >
      {paused && (
        <div className="note warn">
          {first} is paused (since {day(paused)}). They can sign in and see their work, but can’t start anything new from you and aren’t told about new work.
        </div>
      )}
      {main && account && <AccountModal l={l} onClose={() => setAccount(false)} />}
      {classing && <LearnerClasses l={l} onClose={() => setClassing(false)} />}
      <Seg
        value={tab}
        onChange={(t) => go(`/learners/${id}/${t}`, { replace: true })}
        options={[
          { value: 'progress', label: 'Progress & summaries' },
          { value: 'work', label: `Work (${attempts.length})` },
          { value: 'study', label: 'Study' },
          { value: 'school', label: 'Attendance & behaviour' },
          ...(main ? [{ value: 'parents', label: 'Parents' }] : []),
        ]}
      />
      {tab === 'parents' ? (
        <ParentsPanel learner={l} />
      ) : tab === 'school' ? (
        <>
          <AttendanceCard learnerId={id} name={l.display_name} staff />
          <BehaviourCard learnerId={id} name={l.display_name} staff canGive />
        </>
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
      {own && editing && (
        <EditLearner
          l={l}
          main={main}
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

// The classes one learner is in. Each class changed keeps its name, subject and everyone else in it.
function LearnerClasses({ l, onClose }) {
  const lk = useLookups();
  const toast = useToast();
  const first = l.display_name.split(' ')[0];
  const [ids, setIds] = useState(() => lk.activeClasses.filter((c) => c.members.includes(l.id)).map((c) => c.id));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      for (const c of lk.activeClasses) {
        const was = c.members.includes(l.id);
        if (was === ids.includes(c.id)) continue;
        const others = c.members.filter((x) => x !== l.id && lk.learner(x));
        await api.saveClass({ id: c.id, name: c.name, subject_id: c.subject_id, learner_ids: was ? others : [...others, l.id] });
      }
      classesChanged();
      toast(`${first}’s classes are saved`);
      onClose();
    } catch (x) {
      classesChanged(); // some may have saved
      setErr(x.message);
      setBusy(false);
    }
  }
  return (
    <Modal title={`${first}’s classes`} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <div className="stack sm">
          {lk.activeClasses.map((c) => {
            const n = c.members.filter((x) => lk.learner(x)).length;
            return (
              <label key={c.id} className="check">
                <input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))} />
                <span className="t">{c.name}</span>
                <span className="s">{[lk.subject(c.subject_id)?.name, `${n} learner${n === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</span>
              </label>
            );
          })}
        </div>
        <div className="small muted">{first} gets the work, lesson notes, files and coming live lessons set for these classes.</div>
        {err && <div className="error">{err}</div>}
        <div className="foot row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function StatusPill({ t }) {
  if (t.status === 'in_progress') return <span className="pill accent">In progress</span>;
  if (t.status === 'submitted') return <span className="pill warn">To mark</span>;
  if (t.status === 'returned') return <span className="pill warn">Sent back for redo</span>;
  return t.released ? <span className="pill good">Marked · returned</span> : <span className="pill">Marked · not released</span>;
}

function EditLearner({ l, main = true, onClose, onRemove }) {
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
        {main ? (
          <>
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
          </>
        ) : (
          <div className="small muted">{l.display_name} added you with your code. Their main tutor looks after their name and account; you choose the subjects you teach them.</div>
        )}
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

// Learners · Classes · Reports: the parent reports live with the learners they're about
export function LearnerTabs({ tab }) {
  // in a school or centre: students who signed up with its email and aren't in a class yet
  const org = useQuery('org', api.myOrg).data;
  const school = org?.kind === 'school' || org?.kind === 'centre';
  const waiting = (useQuery(school ? 'school-waiting' : null, api.schoolWaiting).data || []).length;
  return (
    <Seg
      value={tab}
      onChange={(t) => go(t === 'learners' ? '/learners' : `/learners/${t}`, { replace: true })}
      options={[
        { value: 'learners', label: 'Learners', icon: 'user' },
        { value: 'classes', label: 'Classes', icon: 'users' },
        ...(school ? [{ value: 'school', label: waiting ? `New from your school (${waiting})` : 'New from your school', icon: 'cap' }] : []),
        { value: 'reports', label: 'Reports', icon: 'send' },
      ]}
    />
  );
}
