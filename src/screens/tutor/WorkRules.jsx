// Canvas gaps, part 1 (16 Nov 2026), for teachers. On a piece of work: a closing date, a late rule, group work and its
// groups. On a class: its steps (topics in order, each opening once the one before is done, with where everyone is and
// "Open early"), and copying it for next year. Results question by question. For the office: moving everyone up a year.
import { useEffect, useMemo, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Link, Loading, Markdown, Modal, Page, Toggle, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { invalidate, useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { fromLocalInput, kindLabel, toLocalInput, typeLabel, when } from '../../lib/format.js';
import { items } from '../../lib/questions.js';
import { yearName } from '../../lib/office.js';
import { useLookups } from '../shared/lookups.jsx';

// A hand-in to mark: not a group member's copy of the group's hand-in (unless it was marked on its own)
export const ownHandIn = (t) => !t.group_copy_of || t.group_own;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || lo)));
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// Marks off for lateness, the same sum as the server's _late_off: the rule × days late, of the total, rounded down to the half mark
export function lateOff(rule, days, max, waived) {
  if (waived || !rule || !(days > 0) || !(max > 0)) return 0;
  return Math.floor(((max * Math.min(rule.max, rule.per_day * days)) / 100) * 2) / 2;
}
export const lateRuleText = (r) => (r ? `${r.per_day}% of the marks off a day late${r.max < 100 ? `, up to ${r.max}%` : ''}` : '');

// ---------------- on a piece of work ----------------
export function LateFields({ a, setField }) {
  const rule = a.late_rule;
  const bad = a.due_at && a.closes_at && new Date(a.closes_at) < new Date(a.due_at);
  return (
    <>
      <Field
        label="Close hand-ins"
        hint={
          a.closes_at
            ? 'After this nobody can start it or hand it in, and anything still open is handed in as it is. Extra days and More time push it back for that learner.'
            : 'Optional. Leave it empty to take hand-ins at any time.'
        }
        error={bad ? 'Close hand-ins on or after the due date.' : undefined}
      >
        <input className="input" type="datetime-local" aria-label="Close hand-ins" value={toLocalInput(a.closes_at)} onChange={(e) => setField({ closes_at: fromLocalInput(e.target.value) })} />
      </Field>
      {a.due_at && (
        <Toggle
          checked={!!rule}
          onChange={(v) => setField({ late_rule: v ? { per_day: 10, max: 50 } : null })}
          icon="clock"
          title="Take marks off when it’s late"
          sub={rule ? `${lateRuleText(rule)}. Each part of a day counts. You can let someone off while marking.` : 'Off: late work is only marked “Late”.'}
        />
      )}
      {a.due_at && rule && (
        <div className="grid g2" style={{ gap: 10 }}>
          <Field label="% off a day">
            <input className="input" type="number" min="1" max="100" value={rule.per_day} onChange={(e) => setField({ late_rule: { ...rule, per_day: clamp(e.target.value, 1, 100) } })} />
          </Field>
          <Field label="Most taken off (%)">
            <input className="input" type="number" min="1" max="100" value={rule.max} onChange={(e) => setField({ late_rule: { ...rule, max: clamp(e.target.value, 1, 100) } })} />
          </Field>
        </div>
      )}
    </>
  );
}

// Group work: anyone in a group hands it in for everyone in it. Groups are saved with the class the work is saved for.
export function GroupFields({ a, setField, savedClassId }) {
  const [editing, setEditing] = useState(false);
  const ready = a.groups && a.id && a.class_id && savedClassId === a.class_id;
  const q = useQuery(ready ? `work-groups:${a.id}` : null, () => api.workGroups(a.id));
  const blocked = a.lockdown || a.camera || a.self_mark || a.mock_id;
  const groups = q.data?.groups || [];
  return (
    <div className="card">
      <h3>Group work</h3>
      {!a.class_id ? (
        <div className="small muted">Set it for a class (Who sees it → A class) to let learners work in groups.</div>
      ) : (
        <>
          <Toggle
            checked={!!a.groups}
            disabled={!!blocked && !a.groups}
            onChange={(v) => setField(v ? { groups: true, peer: null } : { groups: false })}
            icon="users"
            title="Work in groups"
            sub="Anyone in a group can hand it in for everyone in it. You mark it once and they all get the marks; you can still change one person’s."
          />
          {blocked && !a.groups && <div className="tiny muted">Not for locked-down, watched, camera, self-marked or mock work.</div>}
          {a.groups &&
            (!ready ? (
              <div className="small muted">Save it, then set the groups.</div>
            ) : (
              <div className="stack sm">
                {!q.data ? (
                  <Loading />
                ) : groups.length === 0 ? (
                  <div className="small muted">No groups yet: everyone works on their own until you set them.</div>
                ) : (
                  <div className="small">
                    {groups.map((g) => (
                      <div key={g.id}>
                        <b>{g.name}:</b> {g.members.map((m) => m.name).join(', ')}
                      </div>
                    ))}
                  </div>
                )}
                <div>
                  <button className="btn sm" onClick={() => setEditing(true)}>
                    <Icon name="users" size={16} /> {groups.length ? 'Change the groups' : 'Set the groups'}
                  </button>
                </div>
              </div>
            ))}
        </>
      )}
      {editing && <GroupsModal assignmentId={a.id} onClose={() => setEditing(false)} />}
    </div>
  );
}

function GroupsModal({ assignmentId, onClose }) {
  const toast = useToast();
  const q = useQuery(`work-groups:${assignmentId}`, () => api.workGroups(assignmentId));
  const [groups, setGroups] = useState(null); // [{ name, learners: [ids] }]
  const [size, setSize] = useState(3);
  const [busy, setBusy] = useState(false);
  const d = q.data;
  useEffect(() => {
    if (d && groups === null) setGroups(d.groups.map((g) => ({ name: g.name, learners: g.members.map((m) => m.id) })));
  }, [d, groups]);
  if (!d || !groups)
    return (
      <Modal title="Groups" onClose={onClose}>
        {q.error ? <div className="error">{q.error.message}</div> : <Loading />}
      </Modal>
    );
  const pool = d.pool || [];
  const groupOf = (id) => groups.findIndex((g) => g.learners.includes(id));
  const put = (id, gi) => setGroups((gs) => gs.map((g, i) => ({ ...g, learners: i === gi ? [...g.learners.filter((x) => x !== id), id] : g.learners.filter((x) => x !== id) })));
  function random() {
    const ids = pool.map((p) => p.id).sort(() => Math.random() - 0.5);
    const n = Math.max(1, Math.round(ids.length / size));
    const next = Array.from({ length: n }, (_, i) => ({ name: groups[i]?.name || `Group ${i + 1}`, learners: [] }));
    ids.forEach((id, i) => next[i % n].learners.push(id));
    setGroups(next);
  }
  async function reuse(otherId) {
    try {
      const o = await api.workGroups(otherId);
      const inClass = new Set(pool.map((p) => p.id));
      setGroups(o.groups.map((g) => ({ name: g.name, learners: g.members.map((m) => m.id).filter((id) => inClass.has(id)) })));
    } catch (e) {
      toast({ title: 'Couldn’t load those groups', body: e.message, tone: 'bad' });
    }
  }
  async function save() {
    setBusy(true);
    try {
      await api.saveWorkGroups(assignmentId, groups.filter((g) => g.learners.length).map((g) => ({ name: g.name, learners: g.learners })));
      invalidate(`work-groups:${assignmentId}`);
      toast('Groups saved');
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save the groups', body: e.message, tone: 'bad' });
      setBusy(false);
    }
  }
  const alone = pool.filter((p) => groupOf(p.id) < 0);
  return (
    <Modal
      title="Groups"
      wide
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            Save groups
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row wrap" style={{ gap: 8 }}>
          <label className="small row" style={{ gap: 6 }}>
            Groups of
            <select className="select" style={{ width: 'auto', minHeight: 34 }} value={size} onChange={(e) => setSize(Number(e.target.value))} aria-label="Group size">
              {[2, 3, 4, 5, 6].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button className="btn sm" onClick={random}>
            <Icon name="refresh" size={16} /> Make random groups
          </button>
          <button className="btn sm" onClick={() => setGroups((gs) => [...gs, { name: `Group ${gs.length + 1}`, learners: [] }])}>
            <Icon name="plus" size={16} /> Add a group
          </button>
          {d.others.length > 0 && (
            <select className="select" style={{ width: 'auto', minHeight: 34 }} value="" onChange={(e) => e.target.value && reuse(e.target.value)} aria-label="Use the groups from other work">
              <option value="">Use the groups from…</option>
              {d.others.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title}
                </option>
              ))}
            </select>
          )}
        </div>
        {groups.length > 0 && (
          <div className="grid g2" style={{ gap: 10 }}>
            {groups.map((g, i) => (
              <div key={i} className="card" style={{ padding: 10 }}>
                <div className="row" style={{ gap: 6 }}>
                  <input className="input" value={g.name} maxLength={60} aria-label={`Name of group ${i + 1}`} onChange={(e) => setGroups((gs) => gs.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  <button className="btn ghost icon sm" aria-label={`Remove ${g.name || `group ${i + 1}`}`} onClick={() => setGroups((gs) => gs.filter((_, j) => j !== i))}>
                    <Icon name="trash" size={16} />
                  </button>
                </div>
                <div className="small muted" style={{ marginTop: 6 }}>
                  {g.learners.length ? g.learners.map((id) => pool.find((p) => p.id === id)?.name || 'Someone').join(', ') : 'Nobody yet'}
                </div>
              </div>
            ))}
          </div>
        )}
        {pool.length === 0 ? (
          <Empty>Nobody is in this class yet.</Empty>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Learner</th>
                <th>Group</th>
              </tr>
            </thead>
            <tbody>
              {pool.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>
                    <select className="select" value={groupOf(p.id)} onChange={(e) => put(p.id, Number(e.target.value))} aria-label={`${p.name}’s group`}>
                      <option value={-1}>On their own</option>
                      {groups.map((g, i) => (
                        <option key={i} value={i}>
                          {g.name || `Group ${i + 1}`}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {alone.length > 0 && groups.length > 0 && <div className="small muted">{plural(alone.length, 'learner')} on their own: they hand it in for just themselves.</div>}
      </div>
    </Modal>
  );
}

// ---------------- a class's steps ----------------
export const stepRuleText = (s, first) =>
  first || s.rule === 'open'
    ? 'Open from the start'
    : s.rule === 'opened'
      ? 'Opens once they’ve opened everything in the step before'
      : s.rule === 'handed_in'
        ? 'Opens once they’ve handed in everything in the step before'
        : `Opens once they score ${s.min_pct}% or more on the step before`;

export function ClassSteps({ classId }) {
  const q = useQuery(`class-steps:${classId}`, () => api.classSteps(classId));
  const [editing, setEditing] = useState(false);
  const [showing, setShowing] = useState(false);
  const d = q.data;
  if (!d) return q.error ? <div className="error">{q.error.message}</div> : null;
  const steps = d.steps;
  return (
    <div className="card">
      <div className="row between wrap">
        <h2>Steps</h2>
        <div className="row wrap" style={{ gap: 8 }}>
          {steps.length > 0 && d.learners.length > 0 && (
            <button className="btn sm" aria-expanded={showing} onClick={() => setShowing((s) => !s)}>
              <Icon name="chart" size={16} /> Where everyone is
            </button>
          )}
          <button className="btn sm" onClick={() => setEditing(true)}>
            <Icon name="layers" size={16} /> {steps.length ? 'Change the steps' : 'Set out in steps'}
          </button>
        </div>
      </div>
      {steps.length === 0 ? (
        <div className="small muted">
          Put this class’s topics in order. Each step opens once learners finish the one before (open its notes, hand in its work, or score enough), so they work through it in order. Work in a step that isn’t open yet shows, but can’t be started.
        </div>
      ) : (
        <ol className="stack sm" style={{ margin: 0, paddingLeft: 22 }}>
          {steps.map((s, i) => (
            <li key={s.id}>
              <span className="strong">{s.title}</span>
              <span className="small muted">
                {' '}
                · {stepRuleText(s, i === 0)} · {plural(Number(s.items), 'thing')} set
              </span>
            </li>
          ))}
        </ol>
      )}
      {showing && <StepProgress classId={classId} d={d} />}
      {editing && <StepsEditor classId={classId} d={d} onClose={() => setEditing(false)} />}
    </div>
  );
}

function StepProgress({ classId, d }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  async function early(step, l, on) {
    setBusy(step.id + l.id);
    try {
      await api.openStepEarly(step.id, l.id, on);
      invalidate(`class-steps:${classId}`);
      toast(on ? `“${step.title}” is open for ${l.name}` : `“${step.title}” is back to opening in order for ${l.name}`);
    } catch (e) {
      toast({ title: 'Couldn’t change that', body: e.message, tone: 'bad' });
    } finally {
      setBusy(null);
    }
  }
  return (
    <div style={{ overflowX: 'auto', marginTop: 10 }}>
      <table className="table">
        <thead>
          <tr>
            <th>Learner</th>
            {d.steps.map((s, i) => (
              <th key={s.id}>
                {i + 1}. {s.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {d.learners.map((l) => (
            <tr key={l.id}>
              <td>{l.name}</td>
              {d.steps.map((s) => {
                const x = (l.steps || []).find((y) => y.step_id === s.id) || {};
                return (
                  <td key={s.id}>
                    {x.done && x.open ? (
                      <span className="pill good">Done</span>
                    ) : x.open ? (
                      <span className="row wrap" style={{ gap: 6 }}>
                        <span className="pill accent">{x.early ? 'Opened early' : 'Open'}</span>
                        {x.early && (
                          <button className="btn ghost sm" disabled={busy === s.id + l.id} onClick={() => early(s, l, false)} aria-label={`Take back opening ${s.title} early for ${l.name}`}>
                            Undo
                          </button>
                        )}
                      </span>
                    ) : (
                      <span className="row wrap" style={{ gap: 6 }}>
                        <span className="pill">
                          <Icon name="lock" size={12} /> Not open yet
                        </span>
                        <button className="btn ghost sm" disabled={busy === s.id + l.id} onClick={() => early(s, l, true)} aria-label={`Open ${s.title} early for ${l.name}`}>
                          Open early
                        </button>
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StepsEditor({ classId, d, onClose }) {
  const toast = useToast();
  const [steps, setSteps] = useState(d.steps.map((s) => ({ topic_id: s.topic_id, rule: s.rule, min_pct: s.min_pct || 60 })));
  const [busy, setBusy] = useState(false);
  const name = (id) => d.topics.find((t) => t.id === id)?.name || d.steps.find((s) => s.topic_id === id)?.title || 'Topic';
  const left = d.topics.filter((t) => !steps.some((s) => s.topic_id === t.id));
  const move = (i, by) =>
    setSteps((xs) => {
      const j = i + by;
      if (j < 0 || j >= xs.length) return xs;
      const next = [...xs];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const set = (i, patch) => setSteps((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  async function save() {
    setBusy(true);
    try {
      await api.saveClassSteps(classId, steps.map((s) => ({ topic_id: s.topic_id, rule: s.rule, min_pct: s.rule === 'scored' ? s.min_pct : null })));
      invalidate(`class-steps:${classId}`, `class-work:${classId}`);
      toast(steps.length ? 'Steps saved' : 'Steps taken away: everything is open');
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save the steps', body: e.message, tone: 'bad' });
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Steps"
      wide
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            Save steps
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          Each step is a topic: the work, lesson notes and files you set for this class on that topic. Put them in order and choose how each one opens. Anything without a topic, or on a topic that isn’t a step, is always open.
        </div>
        {steps.length === 0 && <div className="small">No steps: everything set for the class is open.</div>}
        {steps.map((s, i) => (
          <div key={s.topic_id} className="card" style={{ padding: 10 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <span className="strong grow">
                {i + 1}. {name(s.topic_id)}
              </span>
              <button className="btn ghost icon sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move ${name(s.topic_id)} up`}>
                <Icon name="up" size={16} />
              </button>
              <button className="btn ghost icon sm" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label={`Move ${name(s.topic_id)} down`}>
                <Icon name="down" size={16} />
              </button>
              <button className="btn ghost icon sm" onClick={() => setSteps((xs) => xs.filter((_, j) => j !== i))} aria-label={`Take ${name(s.topic_id)} out of the steps`}>
                <Icon name="trash" size={16} />
              </button>
            </div>
            {i === 0 ? (
              <div className="small muted">The first step is open from the start.</div>
            ) : (
              <div className="row wrap" style={{ gap: 8, marginTop: 6 }}>
                <select className="select" style={{ width: 'auto' }} value={s.rule} onChange={(e) => set(i, { rule: e.target.value })} aria-label={`How ${name(s.topic_id)} opens`}>
                  <option value="handed_in">Opens once they hand in the step before</option>
                  <option value="opened">Opens once they open everything in the step before</option>
                  <option value="scored">Opens once they score enough on the step before</option>
                  <option value="open">Open from the start</option>
                </select>
                {s.rule === 'scored' && (
                  <label className="small row" style={{ gap: 6 }}>
                    at least
                    <input className="input" type="number" min="1" max="100" style={{ width: 80 }} value={s.min_pct} onChange={(e) => set(i, { min_pct: clamp(e.target.value, 1, 100) })} aria-label="Score needed (%)" />%
                  </label>
                )}
              </div>
            )}
          </div>
        ))}
        {left.length > 0 && (
          <select className="select" value="" onChange={(e) => e.target.value && setSteps((xs) => [...xs, { topic_id: e.target.value, rule: 'handed_in', min_pct: 60 }])} aria-label="Add a topic as the next step">
            <option value="">Add a topic as the next step…</option>
            {left.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({plural(Number(t.items), 'thing')} set)
              </option>
            ))}
          </select>
        )}
        {d.topics.length === 0 && <div className="small muted">This class’s subject has no topics yet. Add them in Library → Subjects.</div>}
        <div className="tiny muted">“Score enough” counts marks once you give them back. Work marked straight away counts at once.</div>
      </div>
    </Modal>
  );
}

// ---------------- copy a class for next year ----------------
export function CopyClass({ c, onClose }) {
  const toast = useToast();
  const lk = useLookups();
  const [name, setName] = useState(`${c.name} (next year)`);
  const [what, setWhat] = useState({ work: true, notes: true, steps: true, planner: true, grading: true });
  const [busy, setBusy] = useState(false);
  const opts = [
    ['work', 'Work and its questions (not posted, no dates)'],
    ['notes', 'Lesson notes (not shown yet)'],
    ['steps', 'Steps'],
    ['planner', 'Planner units (no dates)'],
    ['grading', 'Gradebook set-up (categories and scale)'],
  ];
  async function copy(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.copyClass(c.id, name.trim(), what);
      lk.reload();
      invalidate('my-classes');
      toast({
        title: `${r.name} is ready`,
        body: `${[r.work ? `${plural(r.work, 'piece')} of work` : '', r.notes ? `${plural(r.notes, 'set')} of lesson notes` : ''].filter(Boolean).join(' and ') || 'Its set-up'} copied, nothing posted. Add learners, then post work when you’re ready.${r.files ? ' Files stay in My files: set them for the new class from there.' : ''}`,
        ms: 9000,
      });
      onClose();
      go(`/learners/classes/${r.id}/classwork`);
    } catch (x) {
      toast({ title: 'Couldn’t copy the class', body: x.message, tone: 'bad' });
      setBusy(false);
    }
  }
  return (
    <Modal title={`Copy ${c.name} for next year`} onClose={onClose}>
      <form className="stack" onSubmit={copy}>
        <Field label="New class name">
          <input className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="stack sm">
          {opts.map(([k, label]) => (
            <label key={k} className="check">
              <input type="checkbox" checked={what[k]} onChange={(e) => setWhat((w) => ({ ...w, [k]: e.target.checked }))} />
              <span className="t">{label}</span>
            </label>
          ))}
        </div>
        <div className="small muted">The same teachers teach it. It starts with nobody in it: never this year’s learners, posts, marks or registers.</div>
        <div className="foot row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !name.trim()}>
            <Icon name="copy" size={16} /> Copy the class
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------- results question by question ----------------
export function WorkResults({ id }) {
  const a = useQuery(`assignment:${id}`, () => api.getAssignment(id)).data;
  const qs = useQuery(`questions:${id}`, () => api.listQuestions(id)).data || [];
  const keys = useQuery(qs.length ? `keys:${id}:${qs.length}` : null, () => api.listKeys(qs.map((q) => q.id))).data || [];
  const r = useQuery(`work-results:${id}`, () => api.workResults(id));
  const d = r.data;
  const byId = useMemo(() => Object.fromEntries(qs.map((q) => [q.id, q])), [qs]);
  const keyOf = (qid) => keys.find((k) => k.question_id === qid)?.answer || {};
  return (
    <Page
      eyebrow={
        <Link to={`/marking?a=${id}`}>
          <Icon name="left" size={14} /> Submissions
        </Link>
      }
      title="Results by question"
      subtitle={a ? `${a.title} · ${kindLabel[a.kind]}` : ''}
    >
      {!d ? (
        r.error ? <div className="error">{r.error.message}</div> : <Loading />
      ) : d.handed_in === 0 ? (
        <Empty>Nobody has handed it in yet.</Empty>
      ) : (
        <>
          <div className="card">
            <div className="row wrap" style={{ gap: 24 }}>
              <div>
                <div className="score-big">{d.handed_in}</div>
                <div className="small muted">handed in{d.marked < d.handed_in ? ` (${d.marked} marked)` : ''}</div>
              </div>
              {d.average != null && (
                <div>
                  <div className="score-big">{Math.round(d.average)}%</div>
                  <div className="small muted">average</div>
                </div>
              )}
            </div>
            <div className="small muted">From each learner’s latest hand-in; a group’s counts once. No names here.</div>
          </div>
          {d.questions.map((x, i) => {
            const q = byId[x.id] || x;
            const marked = Number(x.marked) || 0;
            const share = (n) => (marked ? Math.round((Number(n) / marked) * 100) : 0);
            const opts = q.type === 'mcq' ? items(q.options) : [];
            const right = new Set([...(keyOf(x.id).choices || []), ...(keyOf(x.id).choice != null ? [String(keyOf(x.id).choice)] : [])]);
            return (
              <div key={x.id} className="card">
                <div className="row between wrap">
                  <h3>
                    Question {i + 1} <span className="muted small">· {typeLabel[q.type] || q.type} · {plural(Number(x.marks), 'mark')}</span>
                  </h3>
                  {marked > 0 && x.average != null && (
                    <span className="strong">
                      {Number(x.average)} / {Number(x.marks)} on average
                    </span>
                  )}
                </div>
                {q.prompt_md && q.type !== 'cloze' && (
                  <div className="small" style={{ maxHeight: 120, overflow: 'hidden' }}>
                    <Markdown src={q.prompt_md} />
                  </div>
                )}
                {marked === 0 ? (
                  <div className="small muted">Not marked yet ({plural(Number(x.answered), 'answer')}).</div>
                ) : (
                  <div className="stack sm">
                    <Bar label="Full marks" n={x.full} of={marked} pct={share(x.full)} tone="good" />
                    <Bar label="No marks" n={x.zero} of={marked} pct={share(x.zero)} tone="bad" />
                  </div>
                )}
                {opts.length > 0 && x.choices && (
                  <div className="stack sm" style={{ marginTop: 8 }}>
                    <div className="tiny strong muted">Who chose what</div>
                    {opts.map((o, j) => (
                      <Bar key={j} label={`${String.fromCharCode(65 + j)}${right.has(String(j)) ? ' (right)' : ''}: ${String(o).slice(0, 80)}`} n={x.choices[String(j)] || 0} of={d.handed_in} pct={Math.round(((x.choices[String(j)] || 0) / Math.max(1, d.handed_in)) * 100)} tone={right.has(String(j)) ? 'good' : ''} />
                    ))}
                  </div>
                )}
                {(x.common || []).length > 0 && (
                  <div className="small" style={{ marginTop: 8 }}>
                    <span className="strong">Commonest wrong answers:</span> {x.common.map((c) => `“${c.answer}” (${c.count})`).join(', ')}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </Page>
  );
}
function Bar({ label, n, of, pct, tone }) {
  return (
    <div>
      <div className="row between small">
        <span>{label}</span>
        <span className="muted">
          {Number(n)} of {Number(of)} ({pct}%)
        </span>
      </div>
      <div className={'bar' + (tone ? ' ' + tone : '')} role="img" aria-label={`${label}: ${pct}%`}>
        <span style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ---------------- for the office: a new school year ----------------
export function NewSchoolYear() {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery('new-year', api.newYearInfo);
  const [putAway, setPutAway] = useState(true);
  const [busy, setBusy] = useState(false);
  const d = q.data;
  if (!d) return null;
  const count = (d.by_grade || []).reduce((s, g) => s + Number(g.count), 0);
  async function move() {
    if (!(await confirm({ title: 'Move everyone up a year?', body: `${plural(count, 'learner')} move up a year${putAway ? `, and ${plural(Number(d.classes), 'class', 'classes')} with learners in them are put away` : ''}. You can undo it within 30 days.`, ok: 'Move everyone up' }))) return;
    setBusy(true);
    try {
      let r;
      try {
        r = await api.moveUpYear(putAway);
      } catch (e) {
        if (!/already/.test(e.message) || !(await confirm({ title: 'Do it again?', body: `${e.message} Moving up again puts everyone up another year.`, ok: 'Move up again' }))) throw e;
        r = await api.moveUpYear(putAway, true);
      }
      invalidate('new-year', 'classes', 'student-records');
      toast(`${plural(r.count, 'learner')} moved up a year${r.put_away ? `; ${plural(r.put_away, 'class', 'classes')} put away` : ''}.`);
    } catch (e) {
      toast({ title: 'Couldn’t move everyone up', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function undo() {
    if (!(await confirm({ title: 'Undo moving everyone up?', body: 'Everyone goes back to the year they were in (unless someone has changed their year since), and the classes put away come back.', ok: 'Undo it' }))) return;
    try {
      const r = await api.undoMoveUp(d.last.id);
      invalidate('new-year', 'classes', 'student-records');
      toast(`Undone: ${plural(r.count, 'learner')} back where they were.`);
    } catch (e) {
      toast({ title: 'Couldn’t undo it', body: e.message, tone: 'bad' });
    }
  }
  return (
    <section className="card">
      <h2>A new school year</h2>
      <div className="small">
        {count ? `${plural(count, 'learner')} with a year set (${d.by_grade.map((g) => `${yearName(g.grade)}: ${g.count}`).join(', ')}).` : 'Nobody has a year set yet.'} Teachers copy their classes for next year from each class’s page.
      </div>
      <label className="check">
        <input type="checkbox" checked={putAway} onChange={(e) => setPutAway(e.target.checked)} />
        <span className="t">Put away this year’s classes too ({plural(Number(d.classes), 'class', 'classes')} with learners in them; new empty ones stay)</span>
      </label>
      <div className="row wrap" style={{ gap: 8 }}>
        <button className="btn primary" disabled={busy || !count} onClick={move}>
          <Icon name="up" size={16} /> Move everyone up a year
        </button>
        {d.last?.can_undo && (
          <button className="btn" onClick={undo}>
            <Icon name="undo" size={16} /> Undo the last move
          </button>
        )}
      </div>
      {d.last && (
        <div className="tiny muted">
          Last moved up {when(d.last.at)}
          {d.last.by ? ` by ${d.last.by}` : ''} ({plural(d.last.count, 'learner')}){d.last.undone_at ? `, undone ${when(d.last.undone_at)}` : ''}.
        </div>
      )}
    </section>
  );
}
