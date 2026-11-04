// Planners (running a school, part 2): a class's units of work, with the IB MYP parts for IB classes (statement of
// inquiry, key and related concepts, global context, approaches to learning) or the PYP's (a unit of inquiry: theme,
// central idea, lines of inquiry, key concepts, learner profile), and a plan for each lesson filed under its unit. The
// PYP's programme of inquiry shows every unit of inquiry in the centre or school by year group and theme. The class's teachers and its centre's or school's managers plan; learners in the class (and their parents)
// read the units shared with them, never the teachers' reflections or notes.
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Link, Loading, Modal, Page, Seg, Toggle, go, useConfirm, useLeaveGuard, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ymd } from '../../lib/format.js';
import { useLookups } from './lookups.jsx';
import { KEY_CONCEPTS as PYP_CONCEPTS, LEARNER_PROFILE, THEMES } from '../../lib/core.js';

// The IB MYP's key concepts and global contexts, to pick from
const KEY_CONCEPTS = ['Aesthetics', 'Change', 'Communication', 'Communities', 'Connections', 'Creativity', 'Culture', 'Development', 'Form',
  'Global interactions', 'Identity', 'Logic', 'Perspective', 'Relationships', 'Systems', 'Time, place and space'];
const GLOBAL_CONTEXTS = ['Identities and relationships', 'Orientation in space and time', 'Personal and cultural expression',
  'Scientific and technical innovation', 'Globalization and sustainability', 'Fairness and development'];
const short = (d) => (d ? new Date(d + 'T12:00').toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
const dates = (u) => (u.starts && u.ends ? `${short(u.starts)} – ${short(u.ends)}` : u.starts ? `From ${short(u.starts)}` : u.ends ? `Until ${short(u.ends)}` : '');
const isNow = (u, today) => !!(u.starts || u.ends) && (!u.starts || u.starts <= today) && (!u.ends || u.ends >= today);
const lessonPath = (l) => `/plan/${l.kind}/${l.ref}/${l.day}`;

// A class's planner, for its teachers (and its managers)
export function Planner({ classId, subjectId }) {
  const q = useQuery(`planner:${classId}`, () => api.classUnits(classId));
  const [editing, setEditing] = useState(null);
  const d = q.data;
  if (!d) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  const today = ymd(new Date());
  return (
    <>
      <div className="row between wrap" style={{ gap: 8 }}>
        <span className="small muted">Units of work in order. Learners see the units you share (never your reflections), and each lesson’s plan can sit under its unit.</span>
        <span className="row wrap" style={{ gap: 8 }}>
          {d.units.some((u) => u.pyp) && (
            <button className="btn" onClick={() => go('/programme')}>
              Programme of inquiry
            </button>
          )}
          <button className="btn primary" onClick={() => setEditing({ title: '', shared: true, topic_ids: [] })}>
            <Icon name="plus" size={16} /> New unit
          </button>
        </span>
      </div>
      {d.units.length === 0 ? (
        <Empty title="No units yet">Plan the class’s year as units of work: what it’s about, what they’ll learn, how it’s assessed. Then plan each lesson from your timetable.</Empty>
      ) : (
        d.units.map((u) => (
          <div key={u.id} className={'card unit-card' + (isNow(u, today) ? ' now' : '')}>
            <div className="card-head">
              <h2>
                {u.title} {isNow(u, today) && <span className="pill accent">Now</span>} {u.ib && <span className="pill">MYP</span>} {u.pyp && <span className="pill">PYP</span>}{' '}
                {!u.shared && <span className="pill">Not shared</span>}
              </h2>
              <button className="btn sm" onClick={() => setEditing(u)} aria-label={`Change ${u.title}`}>
                <Icon name="pen" size={15} /> Change
              </button>
            </div>
            <UnitBody u={u} />
            {u.lessons?.length > 0 && (
              <div className="stack sm">
                <div className="tiny muted strong">Lessons planned</div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {u.lessons.map((l) => (
                    <button key={l.id} className="chip" onClick={() => go(lessonPath(l))} title={l.objectives || ''}>
                      {short(l.day)}
                      {l.objectives ? ` · ${l.objectives.slice(0, 40)}${l.objectives.length > 40 ? '…' : ''}` : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {u.by && <div className="tiny muted">Last changed by {u.by}</div>}
          </div>
        ))
      )}
      {editing && <UnitEditor classId={classId} subjectId={subjectId} unit={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function UnitBody({ u, staff = true }) {
  const rows = [
    ['Dates', staff && dates(u)], // (learners see the dates beside the unit's name)
    ['Theme', u.pyp && THEMES[u.theme]],
    ['Central idea', u.pyp && u.central_idea],
    ['Lines of inquiry', u.pyp && u.lines_of_inquiry],
    ['Key concepts', u.pyp && (u.key_concepts || []).join(', ')],
    ['Related concepts', u.pyp && u.related_concepts],
    ['Learner profile', u.pyp && (u.learner_profile || []).join(', ')],
    ['Statement of inquiry', u.ib && u.inquiry],
    ['Key concept', u.ib && u.key_concept],
    ['Related concepts', u.ib && u.related_concepts],
    ['Global context', u.ib && u.global_context],
    ['What it’s about', u.summary],
    ['What they’ll learn', u.objectives],
    [u.ib || u.pyp ? 'Approaches to learning' : 'Skills', u.skills],
    ['How it’s assessed', u.assessment],
    ['Resources', u.resources],
    ['Topics', (u.topics || []).join(', ')],
    ['Reflection', staff && u.reflection],
  ].filter(([, v]) => v);
  if (!rows.length) return null;
  return (
    <dl className="unit-dl">
      {rows.map(([k, v]) => (
        <div key={k}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function UnitEditor({ classId, subjectId, unit, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const lk = useLookups();
  const topics = subjectId ? lk.topicsOf(subjectId) : [];
  const first = { ...unit, topic_ids: unit.topic_ids || [], key_concepts: unit.key_concepts || [], learner_profile: unit.learner_profile || [] };
  const [u, setU] = useState(first);
  const [busy, setBusy] = useState(false);
  const dirty = JSON.stringify(u) !== JSON.stringify(first);
  const pick = (key, v) => setU({ ...u, [key]: u[key].includes(v) ? u[key].filter((x) => x !== v) : [...u[key], v] });
  useLeaveGuard(dirty);
  const set = (patch) => setU({ ...u, ...patch });
  const text = (k, label, hint, rows = 3) => (
    <Field label={label} hint={hint}>
      <textarea className="textarea" rows={rows} value={u[k] || ''} onChange={(e) => set({ [k]: e.target.value })} />
    </Field>
  );
  async function save() {
    setBusy(true);
    try {
      await api.saveUnit(unit.id || null, classId, {
        title: u.title, starts: u.starts || null, ends: u.ends || null, ib: !!u.ib, summary: u.summary, objectives: u.objectives,
        inquiry: u.inquiry, key_concept: u.key_concept, related_concepts: u.related_concepts, global_context: u.global_context,
        skills: u.skills, assessment: u.assessment, resources: u.resources, reflection: u.reflection, topic_ids: u.topic_ids, shared: u.shared !== false,
        pyp: !!u.pyp, theme: u.theme || null, central_idea: u.central_idea, lines_of_inquiry: u.lines_of_inquiry, key_concepts: u.key_concepts,
        learner_profile: u.learner_profile,
      });
      invalidate('planner', 'class-units', 'lesson-plan');
      toast(unit.id ? 'The unit is saved' : 'Unit added');
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save the unit', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!(await confirm({ title: `Delete “${unit.title}”?`, body: 'Its lessons’ plans stay, without a unit.', ok: 'Delete unit', danger: true }))) return;
    try {
      await api.deleteUnit(unit.id);
      invalidate('planner', 'class-units', 'lesson-plan');
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t delete it', body: e.message, tone: 'bad' });
    }
  }
  return (
    <Modal
      wide
      title={unit.id ? unit.title : 'New unit'}
      onClose={onClose}
      foot={
        <>
          {unit.id && (
            <button className="btn danger" onClick={remove} style={{ marginRight: 'auto' }}>
              Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !u.title?.trim() || (u.pyp && !u.theme)} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Title">
          <input className="input" maxLength={120} value={u.title || ''} onChange={(e) => set({ title: e.target.value })} placeholder="Algebra: patterns and equations" />
        </Field>
        <div className="grid g2" style={{ gap: 12 }}>
          <Field label="Starts">
            <input className="input" type="date" value={u.starts || ''} onChange={(e) => set({ starts: e.target.value })} />
          </Field>
          <Field label="Ends">
            <input className="input" type="date" value={u.ends || ''} onChange={(e) => set({ ends: e.target.value })} />
          </Field>
        </div>
        <Seg
          label="Kind of unit"
          value={u.pyp ? 'pyp' : u.ib ? 'myp' : 'plain'}
          onChange={(v) => set({ ib: v === 'myp', pyp: v === 'pyp' })}
          options={[
            { value: 'plain', label: 'A unit' },
            { value: 'myp', label: 'IB MYP unit' },
            { value: 'pyp', label: 'PYP unit of inquiry' },
          ]}
        />
        {u.pyp && (
          <>
            <Field label="Transdisciplinary theme">
              <select className="select" value={u.theme || ''} onChange={(e) => set({ theme: e.target.value })}>
                <option value="">Pick one</option>
                {Object.entries(THEMES).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </Field>
            {text('central_idea', 'Central idea', 'One sentence the unit is built around', 2)}
            {text('lines_of_inquiry', 'Lines of inquiry', 'One a line', 3)}
            <Field label="Key concepts">
              <div className="row wrap" style={{ gap: 6 }}>
                {PYP_CONCEPTS.map((c) => (
                  <button key={c} className="chip" aria-pressed={u.key_concepts.includes(c)} onClick={() => pick('key_concepts', c)}>
                    {c}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Related concepts" hint="Separated by commas">
              <input className="input" maxLength={500} value={u.related_concepts || ''} onChange={(e) => set({ related_concepts: e.target.value })} />
            </Field>
            <Field label="Learner profile attributes">
              <div className="row wrap" style={{ gap: 6 }}>
                {LEARNER_PROFILE.map((a) => (
                  <button key={a} className="chip" aria-pressed={u.learner_profile.includes(a)} onClick={() => pick('learner_profile', a)}>
                    {a}
                  </button>
                ))}
              </div>
            </Field>
          </>
        )}
        {u.ib && (
          <>
            {text('inquiry', 'Statement of inquiry', 'One sentence that ties the concepts and context together', 2)}
            <div className="grid g2" style={{ gap: 12 }}>
              <Field label="Key concept">
                <select className="select" value={u.key_concept || ''} onChange={(e) => set({ key_concept: e.target.value })}>
                  <option value="">Pick one</option>
                  {KEY_CONCEPTS.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </Field>
              <Field label="Global context">
                <select className="select" value={u.global_context || ''} onChange={(e) => set({ global_context: e.target.value })}>
                  <option value="">Pick one</option>
                  {GLOBAL_CONTEXTS.map((k) => (
                    <option key={k}>{k}</option>
                  ))}
                </select>
              </Field>
            </div>
            <Field label="Related concepts" hint="Separated by commas">
              <input className="input" maxLength={500} value={u.related_concepts || ''} onChange={(e) => set({ related_concepts: e.target.value })} />
            </Field>
          </>
        )}
        {text('summary', 'What it’s about')}
        {text('objectives', 'What they’ll learn', 'One a line', 4)}
        {text('skills', u.ib || u.pyp ? 'Approaches to learning' : 'Skills')}
        {text('assessment', 'How it’s assessed')}
        {text('resources', 'Resources')}
        {topics.length > 0 && (
          <Field label="Topics from the syllabus">
            <div className="row wrap" style={{ gap: 6 }}>
              {topics.map((t) => {
                const on = u.topic_ids.includes(t.id);
                return (
                  <button
                    key={t.id}
                    className={'chip' + (on ? ' on' : '')}
                    aria-pressed={on}
                    onClick={() => set({ topic_ids: on ? u.topic_ids.filter((x) => x !== t.id) : [...u.topic_ids, t.id] })}
                  >
                    {t.name}
                  </button>
                );
              })}
            </div>
          </Field>
        )}
        {text('reflection', 'Reflection', 'For teachers only: how it went, what to change next time')}
        <Toggle checked={u.shared !== false} onChange={(v) => set({ shared: v })} title="Learners see this unit" sub="Everything except your reflection." />
      </div>
    </Modal>
  );
}

// "What we’re learning": the units a class's teachers share, for learners and their parents
export function ClassUnits({ classId }) {
  const q = useQuery(`class-units:${classId}`, () => api.classUnits(classId));
  const units = q.data?.units || [];
  if (!units.length) return null;
  const today = ymd(new Date());
  const now = units.filter((u) => isNow(u, today));
  const rest = units.filter((u) => !isNow(u, today));
  return (
    <section className="card">
      <h2>What we’re learning</h2>
      {[...now, ...rest].map((u) => (
        <details key={u.id} className="unit-more" open={now.includes(u)}>
          <summary>
            <span className="strong">{u.title}</span> {isNow(u, today) && <span className="pill accent">Now</span>} <span className="small muted">{dates(u)}</span>
          </summary>
          <UnitBody u={u} staff={false} />
        </details>
      ))}
    </section>
  );
}

// One lesson's plan: its unit, what they'll learn, what you'll do, homework, resources, a note for the learners (they
// see it on their timetable) and notes afterwards (teachers only)
export function LessonPlanPage({ kind, id, day }) {
  const q = useQuery(`lesson-plan:${kind}:${id}:${day || ''}`, () => api.lessonPlan(kind, id, day || null));
  const d = q.data;
  if (!d) return q.error ? <div className="card"><div className="error">{q.error.message}</div></div> : <Loading />;
  return <LessonPlanForm key={d.plan?.updated_at || 'new'} d={d} />;
}

function LessonPlanForm({ d }) {
  const toast = useToast();
  const start = { unit_id: d.plan ? d.plan.unit_id || '' : d.unit_now || '', objectives: '', activities: '', homework: '', resources: '', for_learners: '', notes: '', ...(d.plan || {}) };
  if (d.plan && !d.plan.unit_id) start.unit_id = '';
  const [p, setP] = useState(start);
  const [busy, setBusy] = useState(false);
  const keys = ['unit_id', 'objectives', 'activities', 'homework', 'resources', 'for_learners', 'notes'];
  const dirty = keys.some((k) => (p[k] || '') !== (start[k] || ''));
  useLeaveGuard(dirty);
  const set = (patch) => setP({ ...p, ...patch });
  const text = (k, label, hint, rows = 3, max = 2000) => (
    <Field label={label} hint={hint}>
      <textarea className="textarea" rows={rows} maxLength={max} value={p[k] || ''} onChange={(e) => set({ [k]: e.target.value })} />
    </Field>
  );
  async function save() {
    setBusy(true);
    try {
      await api.saveLessonPlan(d.kind, d.id, d.day, Object.fromEntries(keys.map((k) => [k, p[k] || null])));
      invalidate('lesson-plan', 'planner', 'timetable');
      toast('The plan is saved');
    } catch (e) {
      toast({ title: 'Couldn’t save the plan', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card stack">
      <div className="small muted">
        {new Date(d.day + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} · {d.when}
      </div>
      {d.class_id && (
        <Field label="Unit">
          <select className="select" value={p.unit_id || ''} onChange={(e) => set({ unit_id: e.target.value })}>
            <option value="">No unit</option>
            {d.units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.title}
                {dates(u) ? ` (${dates(u)})` : ''}
              </option>
            ))}
          </select>
        </Field>
      )}
      {text('objectives', 'What they’ll learn', 'One a line')}
      {text('activities', 'What you’ll do', 'Starter, main, plenary… whatever suits you', 6, 6000)}
      {text('homework', 'Homework', null, 2, 1000)}
      {text('resources', 'Resources')}
      {text('for_learners', 'For the learners', 'They see this on their timetable: “Bring a calculator”', 2, 500)}
      {text('notes', 'Notes afterwards', 'For teachers only: how it went')}
      {d.plan?.by && <div className="tiny muted">Last saved by {d.plan.by}</div>}
      <div className="row end">
        <button className="btn primary" disabled={busy || !dirty} onClick={save}>
          Save the plan
        </button>
      </div>
    </div>
  );
}

// The PYP's programme of inquiry: every unit of inquiry in the centre or school, by year group (rows) and theme
// (columns); a year missing a theme shows as a gap
export function ProgrammeOfInquiry() {
  const q = useQuery('programme', api.programmeOfInquiry);
  const list = q.data;
  const years = [...new Set((list || []).map((u) => u.grade ?? null))].sort((a, b) => (a == null) - (b == null) || a - b);
  return (
    <Page title="Programme of inquiry" subtitle="Every PYP unit of inquiry, by year and theme. Each year should cover all six themes.">
      {!list ? (
        q.error ? <div className="error">{q.error.message}</div> : <Loading />
      ) : list.length === 0 ? (
        <Empty title="No units of inquiry yet">Add one from a class’s Planner tab: pick “PYP unit of inquiry” and its theme.</Empty>
      ) : (
        <div className="card pad0">
          <div className="gradebook-wrap">
            <table className="table poi-grid">
              <thead>
                <tr>
                  <th>Year</th>
                  {Object.values(THEMES).map((t) => (
                    <th key={t}>{t}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {years.map((g) => (
                  <tr key={g ?? 'none'}>
                    <th scope="row">{g == null ? 'No year' : `Grade ${g}`}</th>
                    {Object.keys(THEMES).map((t) => {
                      const here = list.filter((u) => (u.grade ?? null) === g && u.theme === t);
                      return (
                        <td key={t} className={here.length ? '' : 'poi-gap'}>
                          {here.map((u) => (
                            <div key={u.id} className="poi-unit">
                              {u.mine ? (
                                <Link to={`/learners/classes/${u.class_id}/planner`} className="strong">
                                  {u.title}
                                </Link>
                              ) : (
                                <span className="strong">{u.title}</span>
                              )}
                              {u.central_idea && <div className="tiny muted">{u.central_idea}</div>}
                              <div className="tiny muted">
                                {u.class}
                                {dates(u) ? ` · ${dates(u)}` : ''}
                              </div>
                            </div>
                          ))}
                          {!here.length && <span className="tiny muted">Not yet</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Page>
  );
}
