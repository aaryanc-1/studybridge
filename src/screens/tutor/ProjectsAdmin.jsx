// IB core and the PYP, for teachers (Projects in the menu): the learners they supervise, and for a centre's or school's
// coordinators (its managers) the cohorts: one kind of project with its deadlines, its learners and each one's supervisor.
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Link, Loading, Modal, Page, Seg, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { KINDS, STARTER_DEADLINES, lateCount, leadWord, progressLine } from '../../lib/core.js';
import { ProjectList } from '../shared/Projects.jsx';

const changed = () => invalidate('core', 'my-core', 'core-cohort', 'core-cohorts');
const yearName = (g) => (g == null ? '' : `Grade ${g}`);

export default function TutorProjects({ tab, id }) {
  const org = useQuery('org', api.myOrg).data;
  const coordinator = !!org && org.role === 'manager' && (org.kind === 'centre' || org.kind === 'school');
  const [editing, setEditing] = useState(null);
  if (tab === 'cohorts' && id) return <CohortPage id={id} />;
  const shown = coordinator && tab === 'cohorts' ? 'cohorts' : 'students';
  return (
    <Page
      title="Projects"
      subtitle="CAS, the Extended Essay, TOK, MYP projects and the PYP Exhibition."
      actions={
        coordinator &&
        shown === 'cohorts' && (
          <button className="btn primary" onClick={() => setEditing({ kind: 'cas', title: '', session: '', deadlines: STARTER_DEADLINES.cas.map((label) => ({ label, due: '' })) })}>
            <Icon name="plus" size={18} /> Start a cohort
          </button>
        )
      }
    >
      {coordinator && (
        <Seg
          label="Projects"
          value={shown}
          onChange={(t) => go(t === 'students' ? '/projects' : '/projects/cohorts', { replace: true })}
          options={[
            { value: 'students', label: 'Your students' },
            { value: 'cohorts', label: 'Cohorts (coordinators)' },
          ]}
        />
      )}
      {shown === 'cohorts' ? <Cohorts /> : <Supervising />}
      {editing && <CohortEditor c={editing} onClose={() => setEditing(null)} />}
    </Page>
  );
}

function Supervising() {
  const q = useQuery('my-core', api.myCore);
  if (!q.data) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  return <ProjectList list={q.data} staff />;
}

function Cohorts() {
  const q = useQuery('core-cohorts', api.coreCohorts);
  const list = q.data;
  if (!list) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  if (!list.length)
    return (
      <Empty title="No cohorts yet">
        A cohort is one kind of project for a group of learners: CAS for this year’s Diploma students, say. Start one, set its deadlines, then add learners and their supervisors.
      </Empty>
    );
  return (
    <div className="grid g2">
      {list.map((c) => (
        <Link key={c.id} to={`/projects/cohorts/${c.id}`} className={'card click' + (c.archived ? ' muted-card' : '')}>
          <div className="row between wrap" style={{ gap: 8 }}>
            <span className="strong">{c.title}</span>
            <span className="pill">{KINDS[c.kind]?.name}</span>
          </div>
          <div className="small muted">{[KINDS[c.kind]?.programme, c.session, `${c.learners} learner${c.learners === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}</div>
          <div className="row wrap" style={{ gap: 6 }}>
            {c.no_supervisor > 0 && <span className="pill warn">{c.no_supervisor} without a supervisor</span>}
            {c.waiting > 0 && <span className="pill">{c.waiting} waiting to be looked at</span>}
            {c.archived && <span className="pill">Put away</span>}
          </div>
        </Link>
      ))}
    </div>
  );
}

function CohortEditor({ c, onClose }) {
  const toast = useToast();
  const [x, setX] = useState(() => ({ ...c, deadlines: (c.deadlines || []).map((d) => ({ ...d, due: d.due || '' })) }));
  const [busy, setBusy] = useState(false);
  const set = (patch) => setX({ ...x, ...patch });
  const setDl = (i, patch) => set({ deadlines: x.deadlines.map((d, j) => (j === i ? { ...d, ...patch } : d)) });
  async function save() {
    setBusy(true);
    try {
      const id = await api.saveCoreCohort(c.id || null, { kind: x.kind, title: x.title, session: x.session, titles: x.titles, deadlines: x.deadlines.filter((d) => d.label.trim()) });
      changed();
      toast(c.id ? 'Saved' : 'Cohort started. Add its learners next.');
      onClose();
      if (!c.id) go(`/projects/cohorts/${id}`);
    } catch (e) {
      toast({ title: 'Couldn’t save it', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title={c.id ? c.title : 'Start a cohort'}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !x.title.trim()} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        {!c.id && (
          <Field label="Kind of project">
            <select
              className="select"
              value={x.kind}
              onChange={(e) => set({ kind: e.target.value, deadlines: (STARTER_DEADLINES[e.target.value] || []).map((label) => ({ label, due: '' })) })}
            >
              {['DP', 'MYP', 'PYP'].map((prog) => (
                <optgroup key={prog} label={prog}>
                  {Object.entries(KINDS)
                    .filter(([, k]) => k.programme === prog)
                    .map(([key, k]) => (
                      <option key={key} value={key}>
                        {k.long}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </Field>
        )}
        <div className="grid g2" style={{ gap: 12 }}>
          <Field label="Name">
            <input className="input" maxLength={80} value={x.title} onChange={(e) => set({ title: e.target.value })} placeholder={`${KINDS[x.kind]?.name}, class of 2027`} />
          </Field>
          <Field label="Exam session" hint="If it has one">
            <input className="input" maxLength={40} value={x.session || ''} onChange={(e) => set({ session: e.target.value })} placeholder="May 2027" />
          </Field>
        </div>
        <Field label="Deadlines" hint="Learners see them, get a reminder two days before, and tick them off as they hand things in">
          <div className="stack sm">
            {x.deadlines.map((d, i) => (
              <div key={i} className="row wrap" style={{ gap: 8 }}>
                <input className="input grow" aria-label={`Deadline ${i + 1}`} maxLength={80} value={d.label} onChange={(e) => setDl(i, { label: e.target.value })} />
                <input className="input" type="date" style={{ width: 'auto' }} aria-label={`${d.label || 'Deadline'}: date`} value={d.due} onChange={(e) => setDl(i, { due: e.target.value })} />
                <button className="btn sm ghost" aria-label={`Remove ${d.label || 'this deadline'}`} onClick={() => set({ deadlines: x.deadlines.filter((_, j) => j !== i) })}>
                  <Icon name="trash" size={15} />
                </button>
              </div>
            ))}
            {x.deadlines.length < 15 && (
              <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => set({ deadlines: [...x.deadlines, { label: '', due: '' }] })}>
                <Icon name="plus" size={15} /> Add a deadline
              </button>
            )}
          </div>
        </Field>
        {(x.kind === 'tok' || x.kind === 'ee') && (
          <Field label="This session’s titles or prompts" hint="Type in the ones you’ve been given for this session, so learners have them to hand">
            <textarea className="textarea" rows={4} maxLength={4000} value={x.titles || ''} onChange={(e) => set({ titles: e.target.value })} />
          </Field>
        )}
      </div>
    </Modal>
  );
}

function CohortPage({ id }) {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery(`core-cohort:${id}`, () => api.coreCohort(id));
  const [editing, setEditing] = useState(false);
  const [picked, setPicked] = useState([]);
  const [supervisor, setSupervisor] = useState('');
  const [team, setTeam] = useState('');
  const [find, setFind] = useState('');
  const c = q.data;
  if (!c) return <Page title="Cohort">{q.error ? <div className="error">{q.error.message}</div> : <Loading />}</Page>;
  const k = KINDS[c.kind] || {};
  const pool = c.pool.filter((l) => !find.trim() || l.name.toLowerCase().includes(find.trim().toLowerCase()));
  async function add() {
    try {
      const n = await api.coreAdd(id, picked, supervisor || null, team || null);
      changed();
      setPicked([]);
      toast(`${n} added. They’ve been told.`);
    } catch (e) {
      toast({ title: 'Couldn’t add them', body: e.message, tone: 'bad' });
    }
  }
  async function setOn(p, patch) {
    try {
      await api.coreSet(p.id, patch);
      changed();
    } catch (e) {
      toast({ title: 'Couldn’t change that', body: e.message, tone: 'bad' });
    }
  }
  async function archive() {
    try {
      await api.archiveCoreCohort(id, !c.archived);
      changed();
      toast(c.archived ? 'Brought back' : 'Put away. Nothing is lost.');
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
    }
  }
  async function remove() {
    if (!(await confirm({ title: `Delete “${c.title}”?`, body: 'Only while nobody has written in it.', ok: 'Delete', danger: true }))) return;
    try {
      await api.deleteCoreCohort(id);
      changed();
      go('/projects/cohorts');
    } catch (e) {
      toast({ title: 'Couldn’t delete it', body: e.message, tone: 'bad' });
    }
  }
  return (
    <Page
      eyebrow={
        <>
          <Link to="/projects/cohorts">Cohorts</Link> <Icon name="right" size={14} /> {c.title}
        </>
      }
      title={c.title}
      subtitle={[k.long, c.session, `${c.projects.length} learner${c.projects.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ')}
      actions={
        <span className="row wrap" style={{ gap: 8 }}>
          <button className="btn" onClick={() => setEditing(true)}>
            <Icon name="pen" size={16} /> Change
          </button>
          <button className="btn" onClick={archive}>
            {c.archived ? 'Bring back' : 'Put away'}
          </button>
          <button className="btn ghost" onClick={remove}>
            Delete
          </button>
        </span>
      }
    >
      <div className="card pad0">
        <div className="row between wrap" style={{ padding: '12px 16px', gap: 8 }}>
          <h2>Learners</h2>
          <span className="small muted">Pick each one’s {leadWord(c.kind)}{k.teams ? ' and team' : ''}; open a project to see their journal.</span>
        </div>
        {c.projects.length === 0 ? (
          <div style={{ padding: '0 16px 16px' }}>
            <Empty>Nobody in it yet. Add learners below.</Empty>
          </div>
        ) : (
          <div className="gradebook-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Learner</th>
                  <th>{k.lead}</th>
                  {k.teams && <th>Team</th>}
                  <th>How it’s going</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {c.projects.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <Link to={`/projects/p/${p.id}`} className="strong">
                        {p.learner}
                      </Link>
                      <div className="tiny muted">{[yearName(p.grade_year), p.title].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td>
                      <select className="select" aria-label={`${p.learner}’s ${leadWord(c.kind)}`} value={p.supervisor_id || ''} onChange={(e) => setOn(p, { supervisor_id: e.target.value || null })}>
                        <option value="">Nobody yet</option>
                        {c.teachers.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    {k.teams && (
                      <td>
                        <input className="input" aria-label={`${p.learner}’s team`} defaultValue={p.team || ''} maxLength={60} onBlur={(e) => e.target.value !== (p.team || '') && setOn(p, { team: e.target.value })} />
                      </td>
                    )}
                    <td>
                      <span className="small">{progressLine(c.kind, p.progress)}</span>
                      <span className="row wrap" style={{ gap: 4 }}>
                        {p.progress?.waiting > 0 && <span className="pill warn">{p.progress.waiting} to look at</span>}
                        {lateCount(p.progress) > 0 && <span className="pill bad">{lateCount(p.progress)} late</span>}
                      </span>
                    </td>
                    <td>
                      <select className="select" aria-label={`${p.learner}: status`} value={p.status} onChange={(e) => setOn(p, { status: e.target.value })}>
                        <option value="active">Going</option>
                        <option value="completed">Finished</option>
                        <option value="withdrawn">Withdrawn</option>
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="card">
        <h2>Add learners</h2>
        {c.pool.length === 0 ? (
          <div className="small muted">Everyone in your centre or school is in it already.</div>
        ) : (
          <>
            <input className="input" aria-label="Find a learner" placeholder="Find a learner" value={find} onChange={(e) => setFind(e.target.value)} />
            <div className="pick-list">
              {pool.map((l) => (
                <label key={l.id} className="check">
                  <input type="checkbox" checked={picked.includes(l.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, l.id] : picked.filter((x) => x !== l.id))} />
                  <span className="t">
                    {l.name} {l.grade != null && <span className="tiny muted">{yearName(l.grade)}</span>}
                  </span>
                </label>
              ))}
            </div>
            <div className="grid g2" style={{ gap: 12 }}>
              <Field label={k.lead} hint="You can change it later">
                <select className="select" value={supervisor} onChange={(e) => setSupervisor(e.target.value)}>
                  <option value="">Pick later</option>
                  {c.teachers.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
              {k.teams && (
                <Field label="Team" hint="The same name works together">
                  <input className="input" maxLength={60} value={team} onChange={(e) => setTeam(e.target.value)} />
                </Field>
              )}
            </div>
            <div className="row end">
              <button className="btn primary" disabled={!picked.length} onClick={add}>
                Add {picked.length || ''} learner{picked.length === 1 ? '' : 's'}
              </button>
            </div>
          </>
        )}
      </div>
      {editing && <CohortEditor c={c} onClose={() => setEditing(false)} />}
    </Page>
  );
}
