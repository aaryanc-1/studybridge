// One class's page, for its teachers: its stream (posts to the class, and what's been set for it), its classwork by topic
// (from every teacher of the class), a gradebook (each learner × each piece of work, with averages and a spreadsheet to
// download; categories with weights, formative and summative work, and predicted grades), its attendance (each learner's, and its registers), and its people, where a teacher adds a whole class
// list at once (an invite with its own code for each learner) and gives points; and its planner (units of work, and
// each lesson's plan). A centre's manager who doesn't teach the class sees its stream and planner only (never marks).
import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Link, Loading, Modal, Page, Seg, Toggle, copyText, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { day, kindLabel } from '../../lib/format.js';
import { ASSESSMENT, SCALES, assessmentOf, pctText, scaleProblem } from '../../lib/grading.js';
import { useLookups, SubjectTag } from '../shared/lookups.jsx';
import Stream from '../shared/Stream.jsx';
import { Planner } from '../shared/Planner.jsx';
import { GiveBehaviour, GiveProfile } from '../shared/School.jsx';
import { ClassAttendance, GiveButton } from './SchoolSetup.jsx';
import { levelsText } from '../../lib/myp.js';

const prettyCode = (c) => (/^\d{8}$/.test(String(c)) ? `${String(c).slice(0, 4)} ${String(c).slice(4)}` : c);
const STATE = { draft: 'Draft', hidden: 'Hidden', scheduled: 'Scheduled', posted: 'Posted' };

export default function ClassPage({ id, tab = 'stream' }) {
  const lk = useLookups();
  const app = useApp();
  const c = lk.klass(id);
  if (!c) return <Page title="Class">{lk.ready ? <Empty>This class isn’t in your list.</Empty> : <Loading />}</Page>;
  const members = lk.membersOf(id);
  const teaches = lk.teachersOf(id).includes(app.me.id);
  const tabs = teaches
    ? [
        { value: 'stream', label: 'Stream' },
        { value: 'classwork', label: 'Classwork' },
        { value: 'planner', label: 'Planner' },
        { value: 'gradebook', label: 'Gradebook' },
        { value: 'attendance', label: 'Attendance' },
        { value: 'people', label: 'People' },
      ]
    : [
        { value: 'stream', label: 'Stream' },
        { value: 'planner', label: 'Planner' },
      ];
  const shown = tabs.some((t) => t.value === tab) ? tab : 'stream';
  return (
    <Page
      eyebrow={
        <>
          <Link to="/learners/classes">Classes</Link> <Icon name="right" size={14} /> {c.name}
        </>
      }
      title={c.name}
      subtitle={
        <span className="row wrap" style={{ gap: 8 }}>
          {c.subject_id && <SubjectTag id={c.subject_id} />}
          <span>{members.length ? `${members.length} learner${members.length === 1 ? '' : 's'}` : 'Nobody in it yet'}</span>
        </span>
      }
      actions={
        teaches && (
          <button className="btn primary" onClick={() => go(`/assignments?new=1&class=${id}${c.subject_id ? `&subject=${c.subject_id}` : ''}`)}>
            <Icon name="plus" size={18} /> Set work for {c.name}
          </button>
        )
      }
    >
      {tabs.length > 1 && <Seg value={shown} onChange={(t) => go(`/learners/classes/${id}/${t}`, { replace: true })} options={tabs} />}
      {shown === 'gradebook' ? (
        <Gradebook id={id} name={c.name} />
      ) : shown === 'attendance' ? (
        <ClassAttendance id={id} />
      ) : shown === 'people' ? (
        <People c={c} />
      ) : shown === 'classwork' ? (
        <Classwork id={id} />
      ) : shown === 'planner' ? (
        <Planner classId={id} subjectId={c.subject_id} />
      ) : (
        <Stream classId={id} />
      )}
    </Page>
  );
}

// Everything set for the class, grouped by topic
function Classwork({ id }) {
  const q = useQuery(`class-work:${id}`, () => api.classWork(id));
  if (!q.data) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  const items = q.data;
  if (!items.length) return <Empty>Nothing set for this class yet. Work, lesson notes and files you set for it show here, by topic.</Empty>;
  const groups = [];
  for (const x of items) {
    const key = x.topic || 'No topic';
    let g = groups.find((y) => y.key === key);
    if (!g) groups.push((g = { key, items: [] }));
    g.items.push(x);
  }
  const open = (x) => (x.kind === 'assignment' ? `/assignments/${x.id}` : x.kind === 'lesson' ? `/lesson/${x.id}` : '/library');
  return groups.map((g) => (
    <div key={g.key} className="card">
      <h2>{g.key}</h2>
      <div className="list">
        {g.items.map((x) => (
          <div key={x.kind + x.id} className="item">
            <Icon name={x.kind === 'assignment' ? 'clipboard' : x.kind === 'lesson' ? 'book' : 'file'} style={{ color: 'var(--muted)' }} />
            <span className="grow">
              {x.mine ? (
                <Link to={open(x)} className="name">
                  {x.title}
                </Link>
              ) : (
                <span className="name">{x.title}</span>
              )}
              <span className="meta">
                <span>{x.kind === 'assignment' ? kindLabel[x.type] : x.kind === 'lesson' ? 'Lesson notes' : 'File'}</span>
                {x.due_at && <span>due {day(x.due_at)}</span>}
                {!x.mine && <span>set by {x.by}</span>}
                {x.kind === 'assignment' && x.state === 'posted' && <span>{x.handed_in} handed in</span>}
              </span>
            </span>
            <span className={'pill' + (x.state === 'posted' ? ' good' : '')}>{STATE[x.state]}</span>
          </div>
        ))}
      </div>
    </div>
  ));
}

// Each learner × each piece of work: their latest try (marks they've been given back, or what's waiting), sorted into the
// class's categories (each weighted), with each learner's overall, a grade suggested by plain maths and their predicted
// grade. Formative work counts unless the class counts summative work only.
function Gradebook({ id, name }) {
  const q = useQuery(`gradebook:${id}`, () => api.classGradebook(id));
  const toast = useToast();
  const confirm = useConfirm();
  const [view, setView] = useState('all'); // all | summative | formative | a category's id
  const [setting, setSetting] = useState(false);
  const [editing, setEditing] = useState(null); // a piece of work: its category, formative or summative
  const [predicting, setPredicting] = useState(null); // a learner
  const g = q.data;
  if (!g) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  const cats = g.categories || [];
  const weighted = cats.some((c) => Number(c.weight) > 0);
  const catName = (cid) => cats.find((c) => c.id === cid)?.name;
  const work = g.work.filter((w) => view === 'all' || w.assessment === view || w.category_id === view);
  const cell = (l, w) => g.cells.find((x) => x.learner_id === l && x.assignment_id === w);
  const avg = (xs) => {
    const v = xs.filter((x) => x != null).map(Number);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  const byWork = (w) => avg(g.learners.map((l) => cell(l.id, w)?.pct));
  const byCat = (c) => avg(g.learners.map((l) => l.by_category?.[c]));
  const suggests = !!(g.myp || g.grading.scale || g.grading.boundaries);
  const missing = g.learners.filter((l) => !l.predicted && l.suggested);
  const show = (x) => {
    if (!x) return { text: '—', tone: 'muted' };
    if (x.status === 'in_progress') return { text: 'Working', tone: 'muted' };
    if (x.pct == null) return x.status === 'returned' ? { text: 'Working', tone: 'muted' } : { text: 'To mark', tone: 'warn' };
    const p = Math.round(x.pct);
    return { text: `${p}%${x.status === 'returned' ? ' · redo' : ''}`, tone: p >= 70 ? 'good' : p >= 50 ? '' : 'bad' };
  };
  const how = [
    g.grading.counts === 'summative' ? 'Summative work counts' : 'Everything counts',
    weighted ? cats.filter((c) => Number(c.weight) > 0).map((c) => `${c.name} ${pctText(c.weight)}`).join(' · ') : null,
    g.myp
      ? 'Suggested grades come from the MYP criteria'
      : g.grading.scale
        ? `Grades from ${SCALES.find((s) => s.id === g.grading.scale_name)?.name || 'your own scale'}`
        : g.grading.boundaries
          ? `Grades from your grade boundaries${g.grading.boundaries.session ? ` (${g.grading.boundaries.session})` : ''}`
          : null,
  ].filter(Boolean);

  async function fillSuggested() {
    const ok = await confirm({
      title: `Use the suggested grade for ${missing.length} learner${missing.length === 1 ? '' : 's'}?`,
      body: 'It becomes their predicted grade, not shared yet. You can change any of them after.',
      ok: 'Use them',
    });
    if (!ok) return;
    try {
      for (const l of missing) await api.setPredictedGrade(id, l.id, { grade: l.suggested });
      toast(`Predicted grades set for ${missing.length}`);
    } catch (e) {
      toast({ title: 'Couldn’t set them all', body: e.message, tone: 'bad' });
    }
    invalidate(`gradebook:${id}`);
  }

  function download() {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const pc = (v) => (v == null ? '' : pctText(v));
    const head = ['Learner', ...work.map((w) => `${w.title}${w.category_id ? ` (${catName(w.category_id)})` : ''}`), ...cats.map((c) => `${c.name} (${pctText(c.weight)})`), 'Overall'];
    if (suggests) head.push('Suggested');
    head.push('Predicted');
    const rows = [head.map(esc).join(',')];
    for (const l of g.learners) {
      const r = [
        l.name,
        ...work.map((w) => {
          const x = cell(l.id, w.id);
          return x?.pct != null ? pc(x.pct) : x ? show(x).text : '';
        }),
        ...cats.map((c) => pc(l.by_category?.[c.id])),
        pc(l.overall),
      ];
      if (suggests) r.push(l.suggested || '');
      r.push(l.predicted?.grade || '');
      rows.push(r.map(esc).join(','));
    }
    const last = ['Class average', ...work.map((w) => pc(byWork(w.id))), ...cats.map((c) => pc(byCat(c.id))), pc(avg(g.learners.map((l) => l.overall)))];
    rows.push(last.map(esc).join(','));
    const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w -]+/g, '').trim() || 'class'} gradebook.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const views = [
    { value: 'all', label: 'All work' },
    { value: 'summative', label: 'Summative' },
    { value: 'formative', label: 'Formative' },
  ];
  return (
    <>
      <div className="card pad0">
        <div className="row between wrap" style={{ padding: '12px 16px', gap: 8 }}>
          <span className="stack sm" style={{ gap: 2 }}>
            <span className="small muted">Each learner’s latest try. Marks count once they’re marked.</span>
            <span className="small">{how.join(' · ')}</span>
          </span>
          <span className="row wrap" style={{ gap: 8 }}>
            <button className="btn sm" onClick={() => setSetting(true)}>
              <Icon name="settings" size={15} /> Set up
            </button>
            {missing.length > 0 && (
              <button className="btn sm" onClick={fillSuggested}>
                Use suggested grades ({missing.length})
              </button>
            )}
            {g.work.length > 0 && g.learners.length > 0 && (
              <button className="btn sm" onClick={download}>
                <Icon name="download" size={15} /> Download (spreadsheet)
              </button>
            )}
          </span>
        </div>
        {g.work.length > 0 && (
          <div className="row wrap gb-views" style={{ padding: '0 16px 12px', gap: 8 }}>
            <Seg label="Show" value={views.some((v) => v.value === view) ? view : ''} onChange={setView} options={views} />
            {cats.length > 0 && (
              <select className="select" aria-label="Show a category" value={cats.some((c) => c.id === view) ? view : ''} onChange={(e) => setView(e.target.value || 'all')}>
                <option value="">Every category</option>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}
        {!g.learners.length ? (
          <div style={{ padding: '0 16px 16px' }}>
            <Empty>Nobody is in this class yet.</Empty>
          </div>
        ) : !g.work.length ? (
          <div style={{ padding: '0 16px 16px' }}>
            <Empty>No work posted for this class yet. Marks show here as you give them back.</Empty>
          </div>
        ) : (
          <div className="gradebook-wrap">
            <table className="table gradebook">
              <thead>
                <tr>
                  <th>Learner</th>
                  {work.map((w) => (
                    <th key={w.id} title={w.title} className={w.counts ? '' : 'gb-off'}>
                      <button className="gb-head" onClick={() => setEditing(w)} aria-label={`How ${w.title} counts`}>
                        <span className="gb-title">{w.title}</span>
                        <span className="tiny muted">
                          {kindLabel[w.kind]}
                          {w.due_at ? ` · ${day(w.due_at)}` : ''}
                        </span>
                        <span className="gb-tags">
                          <span className={'gb-tag ' + w.assessment} title={ASSESSMENT[w.assessment].sub}>
                            {ASSESSMENT[w.assessment].label}
                          </span>
                          {cats.length > 0 && <span className="gb-tag">{catName(w.category_id) || 'No category'}</span>}
                        </span>
                      </button>
                    </th>
                  ))}
                  {cats.map((c) => (
                    <th key={c.id} className="gb-sum">
                      <span className="gb-title">{c.name}</span>
                      <span className="tiny muted">{Number(c.weight) > 0 ? `${pctText(c.weight)} of overall` : 'Doesn’t count'}</span>
                    </th>
                  ))}
                  <th className="gb-sum">Overall</th>
                  {suggests && <th className="gb-sum">Suggested</th>}
                  <th className="gb-sum">Predicted</th>
                </tr>
              </thead>
              <tbody>
                {g.learners.map((l) => (
                  <tr key={l.id}>
                    <th scope="row">{l.name}</th>
                    {work.map((w) => {
                      const x = cell(l.id, w.id);
                      const s = show(x);
                      return (
                        <td key={w.id} className={w.counts ? '' : 'gb-off'}>
                          {x ? (
                            <>
                              <Link to={`/marking/${x.attempt_id}`} className={'pill ' + s.tone} style={{ textDecoration: 'none' }}>
                                {s.text}
                                {x.late ? ' · late' : ''}
                              </Link>
                              {x.criteria && <span className="gb-crit" title="IB MYP criteria levels">{levelsText(x.criteria)}</span>}
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                      );
                    })}
                    {cats.map((c) => (
                      <td key={c.id} className="gb-sum">
                        {pctText(l.by_category?.[c.id])}
                      </td>
                    ))}
                    <td className="strong gb-sum">
                      {pctText(l.overall)}
                      {l.levels && Object.keys(l.levels).length > 0 && <span className="gb-crit">{levelsText(l.levels)}</span>}
                    </td>
                    {suggests && <td className="gb-sum">{l.suggested || <span className="muted">—</span>}</td>}
                    <td className="gb-sum">
                      <button className={'btn sm' + (l.predicted ? '' : ' ghost')} onClick={() => setPredicting(l)} aria-label={`Predicted grade for ${l.name}`}>
                        {l.predicted ? (
                          <>
                            <b>{l.predicted.grade}</b>
                            {l.predicted.shared && <Icon name="eye" size={14} title="Shared with them" style={{ marginLeft: 4 }} />}
                          </>
                        ) : (
                          'Set'
                        )}
                      </button>
                    </td>
                  </tr>
                ))}
                <tr className="gb-avg">
                  <th scope="row">Class average</th>
                  {work.map((w) => (
                    <td key={w.id} className={'strong' + (w.counts ? '' : ' gb-off')}>
                      {pctText(byWork(w.id))}
                    </td>
                  ))}
                  {cats.map((c) => (
                    <td key={c.id} className="strong gb-sum">
                      {pctText(byCat(c.id))}
                    </td>
                  ))}
                  <td className="strong gb-sum">{pctText(avg(g.learners.map((l) => l.overall)))}</td>
                  {suggests && <td className="gb-sum" />}
                  <td className="gb-sum" />
                </tr>
              </tbody>
            </table>
          </div>
        )}
        {g.work.some((w) => !w.counts) && (
          <div className="tiny muted" style={{ padding: '10px 16px' }}>
            Faded columns don’t count towards the overall:{' '}
            {g.grading.counts === 'summative' && weighted ? 'formative work, and work with no category.' : g.grading.counts === 'summative' ? 'formative work.' : 'work with no category (press its name to give it one).'}
          </div>
        )}
      </div>
      {setting && <GradingSetup id={id} g={g} onClose={() => setSetting(false)} />}
      {editing && <WorkGrading classId={id} w={editing} cats={cats} onClose={() => setEditing(null)} />}
      {predicting && <Predicted classId={id} l={predicting} myp={!!g.myp} onClose={() => setPredicting(null)} />}
    </>
  );
}

// Set up a class's gradebook: categories and their weights, what counts, and the grade scale for suggested grades
function GradingSetup({ id, g, onClose }) {
  const toast = useToast();
  const [cats, setCats] = useState(() => g.categories.map((c) => ({ id: c.id, name: c.name, weight: String(Number(c.weight)) })));
  const [counts, setCounts] = useState(g.grading.counts || 'all');
  const [scaleName, setScaleName] = useState(g.grading.scale ? g.grading.scale_name || 'own' : '');
  const [scale, setScale] = useState(() => (g.grading.scale || []).map((x) => ({ grade: x.grade, min: String(Number(x.min)) })));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const total = cats.reduce((s, c) => s + (Number(c.weight) || 0), 0);
  const setCat = (i, patch) => setCats((list) => list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const setRow = (i, patch) => setScale((list) => list.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  function pickScale(v) {
    setScaleName(v);
    const s = SCALES.find((x) => x.id === v);
    if (s) setScale(s.grades.map((x) => ({ grade: x.grade, min: String(x.min) })));
    else if (v === 'own' && !scale.length) setScale([{ grade: '', min: '' }]);
  }
  async function save() {
    setErr('');
    if (cats.some((c) => !c.name.trim())) return setErr('Every category needs a name.');
    if (cats.some((c) => c.weight === '' || !(Number(c.weight) >= 0 && Number(c.weight) <= 100))) return setErr('Give each category a weight from 0 to 100.');
    if (cats.length && total <= 0) return setErr('At least one category needs a weight above 0.');
    const useScale = scaleName && !g.myp ? scale.filter((x) => String(x.grade).trim() || x.min !== '') : [];
    const problem = useScale.length ? scaleProblem(useScale) : '';
    if (problem) return setErr(problem);
    setBusy(true);
    try {
      await api.saveGrading(id, {
        categories: cats.map((c) => ({ ...(c.id ? { id: c.id } : {}), name: c.name.trim(), weight: Number(c.weight) })),
        counts,
        scale: useScale.length ? useScale.map((x) => ({ grade: String(x.grade).trim(), min: Number(x.min) })) : null,
        scale_name: useScale.length ? scaleName : null,
      });
      invalidate(`gradebook:${id}`, `class-cats:${id}`);
      toast('Gradebook set up');
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Set up the gradebook"
      wide
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="stack sm">
          <h3>Categories</h3>
          <div className="small muted">
            Sort the class’s work into categories, each worth part of the overall, like tests 60% and homework 40%. A category with no marks yet is left out, so the others count in proportion. With
            categories, work with no category doesn’t count.
          </div>
          {cats.map((c, i) => (
            <div key={c.id || i} className="row gb-cat-row" style={{ gap: 8 }}>
              <input className="input grow" aria-label={`Category ${i + 1} name`} value={c.name} maxLength={40} placeholder="Tests" onChange={(e) => setCat(i, { name: e.target.value })} />
              <span className="row" style={{ gap: 4 }}>
                <input className="input" style={{ width: 80 }} type="number" min="0" max="100" aria-label={`${c.name || 'Category'} weight`} value={c.weight} onChange={(e) => setCat(i, { weight: e.target.value })} />
                <span className="small muted">%</span>
              </span>
              <button className="btn ghost icon sm" aria-label={`Take away ${c.name || 'this category'}`} onClick={() => setCats((list) => list.filter((_, j) => j !== i))}>
                <Icon name="trash" size={15} />
              </button>
            </div>
          ))}
          <div className="row wrap" style={{ gap: 8 }}>
            <button className="btn sm" onClick={() => setCats((list) => [...list, { name: '', weight: '' }])} disabled={cats.length >= 12}>
              <Icon name="plus" size={15} /> Add a category
            </button>
            {!cats.length && (
              <button
                className="btn sm ghost"
                onClick={() =>
                  setCats([
                    { name: 'Tests', weight: '60' },
                    { name: 'Homework', weight: '40' },
                  ])
                }
              >
                Start with tests 60% and homework 40%
              </button>
            )}
            {cats.length > 0 && (
              <span className={'small' + (total === 100 ? ' muted' : '')}>
                Adds up to {Math.round(total * 10) / 10}%{total !== 100 && total > 0 ? ' (that’s fine: each counts in proportion)' : ''}
              </span>
            )}
          </div>
          {g.categories.length > 0 && cats.length < g.categories.length && (
            <div className="small" style={{ color: 'var(--amber-ink)' }}>
              Work in a category you take away keeps no category.
            </div>
          )}
        </div>
        <div className="stack sm">
          <h3>What counts</h3>
          <Seg
            label="What counts"
            value={counts}
            onChange={setCounts}
            options={[
              { value: 'all', label: 'Everything' },
              { value: 'summative', label: 'Summative work only' },
            ]}
          />
          <div className="small muted">Formative work is practice and feedback; summative work counts for grades. Tests and exams are summative unless you say otherwise on the work.</div>
        </div>
        <div className="stack sm">
          <h3>Suggested grades</h3>
          {g.myp ? (
            <div className="small muted">This is an IB MYP class: its suggested grade comes from the levels on criteria A to D (the usual level on each, added up), once all four have one.</div>
          ) : (
            <>
              <div className="small muted">
                The overall becomes a suggested grade, by plain maths, to help you decide each predicted grade.{' '}
                {g.grading.boundaries || !scaleName
                  ? 'With no scale here, your own grade boundaries for the subject’s exam are used if you have some (Assignments → Mock exams).'
                  : ''}
              </div>
              <Field label="Grade scale">
                <select className="select" value={scaleName} onChange={(e) => pickScale(e.target.value)}>
                  <option value="">None</option>
                  {SCALES.map((s) => (
                    <option key={s.id} value={s.id}>
                      Start from {s.name}
                    </option>
                  ))}
                  <option value="own">My own</option>
                </select>
              </Field>
              {scaleName && (
                <>
                  <div className="small muted">The lowest percentage for each grade. These are starting points: change them to fit your class.</div>
                  <div className="gb-scale">
                    {scale.map((x, i) => (
                      <div key={i} className="row" style={{ gap: 6 }}>
                        <input className="input" style={{ width: 70 }} aria-label={`Grade ${i + 1}`} value={x.grade} maxLength={12} onChange={(e) => setRow(i, { grade: e.target.value })} />
                        <span className="small muted">from</span>
                        <input className="input" style={{ width: 76 }} type="number" min="0" max="100" aria-label={`${x.grade || 'Grade'} from`} value={x.min} onChange={(e) => setRow(i, { min: e.target.value })} />
                        <span className="small muted">%</span>
                        <button className="btn ghost icon sm" aria-label={`Take away grade ${x.grade || i + 1}`} onClick={() => setScale((list) => list.filter((_, j) => j !== i))}>
                          <Icon name="x" size={14} />
                        </button>
                      </div>
                    ))}
                  </div>
                  <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setScale((list) => [...list, { grade: '', min: '' }])} disabled={scale.length >= 15}>
                    <Icon name="plus" size={15} /> Add a grade
                  </button>
                </>
              )}
            </>
          )}
        </div>
        {err && <div className="error">{err}</div>}
      </div>
    </Modal>
  );
}

// One piece of work: its category in this class, and whether it's formative or summative
function WorkGrading({ classId, w, cats, onClose }) {
  const toast = useToast();
  const [cat, setCat] = useState(w.category_id || '');
  const [kind, setKind] = useState(w.assessment);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      // the kind's own setting (tests and exams summative) stays unset unless it changes
      const set = kind === assessmentOf(w.kind, null) && !w.assessment_set ? null : kind;
      await api.setWorkGrading(w.id, cat || null, set);
      invalidate(`gradebook:${classId}`, 'assignments', 'assessment-calendar');
      toast('Saved');
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={w.title}
      onClose={onClose}
      foot={
        <>
          {w.mine && (
            <button className="btn ghost" onClick={() => go(`/assignments/${w.id}`)}>
              Open it
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          {kindLabel[w.kind]}
          {w.due_at ? `, due ${day(w.due_at)}` : ''}
          {!w.mine && w.by ? `, set by ${w.by}` : ''}
        </div>
        <Field label="Formative or summative">
          <Seg
            label="Formative or summative"
            value={kind}
            onChange={setKind}
            options={[
              { value: 'formative', label: 'Formative' },
              { value: 'summative', label: 'Summative' },
            ]}
          />
        </Field>
        <div className="small muted">{kind === 'summative' ? 'Summative: it counts for grades, and shows on the assessment calendar.' : 'Formative: practice and feedback. It counts only when the class counts everything.'}</div>
        {cats.length > 0 ? (
          <Field label="Category">
            <select className="select" value={cat} onChange={(e) => setCat(e.target.value)}>
              <option value="">No category (doesn’t count)</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({pctText(c.weight)})
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <div className="small muted">Add categories in Set up to weight tests, homework and the rest.</div>
        )}
      </div>
    </Modal>
  );
}

// A learner's predicted grade in the class: the suggestion to start from, a note for teachers, and sharing it with them
function Predicted({ classId, l, myp, onClose }) {
  const toast = useToast();
  const p = l.predicted;
  const [grade, setGrade] = useState(p?.grade || '');
  const [note, setNote] = useState(p?.note || '');
  const [shared, setShared] = useState(!!p?.shared);
  const [busy, setBusy] = useState(false);
  const first = l.name.split(' ')[0];
  async function save(clear = false) {
    setBusy(true);
    try {
      await api.setPredictedGrade(classId, l.id, clear ? { grade: '' } : { grade: grade.trim(), note, shared });
      invalidate(`gradebook:${classId}`);
      toast(clear ? 'Predicted grade taken away' : shared ? `Saved, and shared with ${first}` : 'Saved');
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${l.name}: predicted grade`}
      onClose={onClose}
      foot={
        <>
          {p && (
            <button className="btn ghost" onClick={() => save(true)} disabled={busy}>
              <Icon name="trash" size={15} /> Take it away
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => save()} disabled={busy || !grade.trim()}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="row wrap" style={{ gap: 16 }}>
          <span className="small">
            Overall <b>{pctText(l.overall)}</b>
          </span>
          {l.levels && Object.keys(l.levels).length > 0 && (
            <span className="small">
              Criteria <b>{levelsText(l.levels)}</b>
            </span>
          )}
          <span className="small">
            Suggested <b>{l.suggested || '—'}</b>
          </span>
        </div>
        <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
          <Field label="Predicted grade" hint={myp ? 'An MYP grade from 1 to 7.' : 'Any grade you use, like 6, A or B/C.'}>
            <input className="input" style={{ width: 110 }} value={grade} maxLength={12} onChange={(e) => setGrade(e.target.value)} placeholder={l.suggested || ''} />
          </Field>
          {l.suggested && l.suggested !== grade && (
            <button className="btn sm" style={{ marginBottom: 22 }} onClick={() => setGrade(l.suggested)}>
              Use {l.suggested}
            </button>
          )}
        </div>
        <Field label="Note for teachers" hint={`${first} and their parents never see this.`}>
          <textarea className="textarea" style={{ minHeight: 70 }} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this grade, and what would move it up" />
        </Field>
        <Toggle checked={shared} onChange={setShared} icon="eye" title={`Share it with ${first} and their parents`} sub="They see the grade (never the note) and are told when it’s new or changes." />
        {p?.history?.length > 0 && (
          <div className="small muted">
            Before:{' '}
            {p.history
              .slice(0, 5)
              .map((h) => `${h.grade} (${day(h.at)}${h.by ? `, ${h.by}` : ''})`)
              .join(' · ')}
          </div>
        )}
      </div>
    </Modal>
  );
}

// The class's learners, and adding a whole class list at once
function People({ c }) {
  const lk = useLookups();
  const toast = useToast();
  const [giving, setGiving] = useState(false);
  const [noting, setNoting] = useState(false);
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState('');
  const [made, setMade] = useState(null);
  const [busy, setBusy] = useState(false);
  const members = lk.membersOf(c.id);
  const list = names
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  async function make() {
    setBusy(true);
    try {
      const r = await api.classInvites(c.id, list);
      setMade(r);
      setNames('');
      invalidate('invites');
    } catch (e) {
      toast({ title: 'Couldn’t make the codes', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  const message = (x) => `${x.name}: join ${c.name} on StudyBridge with the code ${prettyCode(x.code)}`;
  return (
    <>
      <div className="card">
        <div className="row between wrap" style={{ gap: 8 }}>
          <h2>Learners</h2>
          <span className="row wrap" style={{ gap: 8 }}>
            {members.length > 0 && <GiveButton onClick={() => setGiving(true)} />}
            {members.length > 0 && (
              <button className="btn" onClick={() => setNoting(true)}>
                <Icon name="spark" size={16} /> Learner Profile
              </button>
            )}
            <button className="btn" onClick={() => (setOpen(true), setMade(null))}>
              <Icon name="users" size={16} /> Add a class list
            </button>
          </span>
        </div>
        {members.length === 0 ? (
          <div className="small muted">Nobody yet. Add a class list, give out the class code, or put your learners in from Edit.</div>
        ) : (
          <div className="chips">
            {members
              .map((mid) => lk.learner(mid))
              .filter(Boolean)
              .sort((x, y) => x.display_name.localeCompare(y.display_name))
              .map((l) => (
                <Link key={l.id} to={`/learners/${l.id}`} className="pill" style={{ textDecoration: 'none' }}>
                  {l.display_name}
                </Link>
              ))}
          </div>
        )}
      </div>
      {noting && (
        <GiveProfile
          learners={members.map((mid) => lk.learner(mid)).filter(Boolean).map((l) => ({ id: l.id, name: l.display_name }))}
          classId={c.id}
          onClose={() => setNoting(false)}
        />
      )}
      {giving && (
        <GiveBehaviour
          learners={members.map((mid) => lk.learner(mid)).filter(Boolean).map((l) => ({ id: l.id, name: l.display_name }))}
          classId={c.id}
          onClose={() => setGiving(false)}
        />
      )}
      {open && (
        <Modal title={`Add a class list to ${c.name}`} onClose={() => setOpen(false)}>
          {made ? (
            <div className="stack sm">
              <div className="small">Here’s a code for each learner. They type it when they sign up (or in Settings → Your schools and tutors), and they’re in {c.name}.</div>
              <div className="list">
                {made.map((x) => (
                  <div key={x.id} className="item">
                    <span className="grow name">{x.name}</span>
                    <b className="code-show" style={{ fontSize: 18 }}>{prettyCode(x.code)}</b>
                  </div>
                ))}
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                <button className="btn primary" onClick={() => (copyText(made.map(message).join('\n')), toast('All codes copied'))}>
                  <Icon name="copy" size={15} /> Copy all
                </button>
                <button className="btn" onClick={() => window.print()}>
                  Print
                </button>
              </div>
            </div>
          ) : (
            <div className="stack sm">
              <label className="label" htmlFor="class-list">
                One name per line
              </label>
              <textarea id="class-list" className="textarea" style={{ minHeight: 180 }} value={names} onChange={(e) => setNames(e.target.value)} placeholder={'Chipo Banda\nTendai Moyo\nAmara Okafor'} />
              <div className="small muted">Each learner gets their own code (it works once). Up to 200 at a time.</div>
              <div className="row end" style={{ gap: 8 }}>
                <button className="btn" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button className="btn primary" disabled={busy || !list.length} onClick={make}>
                  {busy ? 'Making codes…' : `Make ${list.length || ''} code${list.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
