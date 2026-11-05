// Term reports, for tutors (Learners → Term reports). A manager (or a tutor on their own) sets one up: its name, the
// dates it covers, when it's due, the grades it uses and which classes. Each class's teachers write a grade (or the IB
// MYP criteria levels), effort and a comment for each learner, with hints from their marks, attendance and points. The
// learner's own teacher (or a manager) writes an overall comment. A manager sends it out; learners and their parents
// are told, and it prints one at a time or all at once.
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Link, Loading, Modal, Page, Toggle, go, useConfirm, useLeaveGuard, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { LETTERS, band, levelsText, mypGrade } from '../../lib/myp.js';
import { ATL_SKILLS, PYP_WORDS } from '../../lib/core.js';
import { useLookups } from '../shared/lookups.jsx';
import { EFFORT, SCALES, TermCard, printTerms, termDates } from '../shared/TermReport.jsx';
import { LearnerTabs } from './Learners.jsx';

const fmt = (d) => (d ? new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }) : '');
const changed = () => invalidate('term-rounds', 'term-round', 'term-class', 'term-card', 'my-reports');

export default function TermReports({ round, part }) {
  if (round && part === 'print') return <PrintAll roundId={round} />;
  if (round && part) return <ClassReports roundId={round} classId={part} />;
  if (round) return <RoundOverview roundId={round} />;
  return <TermList />;
}

function TermList() {
  const q = useQuery('term-rounds', api.reportRounds);
  const [editing, setEditing] = useState(null);
  const d = q.data;
  return (
    <Page
      title="Learners"
      subtitle="End-of-term reports: each class’s teachers write their part, and a manager sends them out to learners and parents."
      actions={
        d?.manager && (
          <button className="btn primary" onClick={() => setEditing({ title: '', scale: 'letters', effort: true, class_ids: null })}>
            <Icon name="plus" size={18} /> New term report
          </button>
        )
      }
    >
      <LearnerTabs tab="terms" />
      {!d ? (
        q.error ? <div className="error">{q.error.message}</div> : <Loading />
      ) : d.rounds.length === 0 ? (
        <Empty title="No term reports yet">
          {d.manager
            ? 'Set one up: the dates it covers, when it’s due and the grades it uses. Each class’s teachers then write their part here.'
            : 'When your manager sets up a term report, your classes show here for you to write.'}
        </Empty>
      ) : (
        d.rounds.map((r) => (
          <div key={r.id} className="card">
            <div className="card-head">
              <h2>
                {r.title} {r.status === 'published' ? <span className="pill good">Sent out</span> : <span className="pill">Being written</span>}
              </h2>
              <span className="row wrap" style={{ gap: 8 }}>
                {d.manager && r.status === 'writing' && (
                  <button className="btn sm" onClick={() => setEditing(r)}>
                    <Icon name="pen" size={15} /> Change
                  </button>
                )}
                {(d.manager || r.my_learners > 0) && (
                  <button className="btn sm" onClick={() => go(`/learners/terms/${r.id}`)}>
                    {d.manager ? 'Overall comments and sending' : 'Overall comments'}
                  </button>
                )}
              </span>
            </div>
            <div className="small muted">
              {[termDates(r) && `Covers ${termDates(r)}`, r.due && r.status === 'writing' && `Due ${fmt(r.due)}`, SCALES[r.scale]?.label, `${r.learners} learner${r.learners === 1 ? '' : 's'}`]
                .filter(Boolean)
                .join(' · ')}
            </div>
            {r.classes.length > 0 && (
              <div className="list">
                {r.classes.map((c) => (
                  <div key={c.id} className="item">
                    <span className="grow">
                      <span className="name">{c.name}</span>
                      <span className="meta">
                        <span>
                          {c.done} of {c.learners} finished
                        </span>
                      </span>
                    </span>
                    {c.done >= c.learners && c.learners > 0 ? <span className="pill good">Done</span> : null}
                    <button className={'btn sm' + (c.mine && r.status === 'writing' && c.done < c.learners ? ' primary' : '')} onClick={() => go(`/learners/terms/${r.id}/${c.id}`)}>
                      {r.status === 'writing' ? 'Write' : 'Open'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))
      )}
      {editing && <RoundEditor r={editing} onClose={() => setEditing(null)} />}
    </Page>
  );
}

function RoundEditor({ r, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const lk = useLookups();
  const classes = lk.activeClasses || [];
  const [x, setX] = useState(() => ({ ...r, class_ids: r.class_ids || null }));
  const [wordText, setWordText] = useState(() => (r.descriptors || PYP_WORDS).join(', '));
  const words = wordText.split(',').map((w) => w.trim()).filter(Boolean);
  const [busy, setBusy] = useState(false);
  const set = (patch) => setX({ ...x, ...patch });
  const picked = x.class_ids || [];
  async function save() {
    setBusy(true);
    try {
      await api.saveReportRound(r.id || null, {
        title: x.title, starts: x.starts || null, ends: x.ends || null, due: x.due || null, scale: x.scale, effort: !!x.effort, class_ids: x.class_ids,
        descriptors: words, atl: !!x.atl, profile: !!x.profile,
      });
      changed();
      toast(r.id ? 'Saved' : 'Term report set up. Each class’s teachers can write their part now.');
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save it', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!(await confirm({ title: `Delete “${r.title}”?`, body: 'Everything written for it goes too.', ok: 'Delete', danger: true }))) return;
    try {
      await api.deleteReportRound(r.id);
      changed();
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t delete it', body: e.message, tone: 'bad' });
    }
  }
  return (
    <Modal
      wide
      title={r.id ? r.title : 'New term report'}
      onClose={onClose}
      foot={
        <>
          {r.id && (
            <button className="btn danger" onClick={remove} style={{ marginRight: 'auto' }}>
              Delete
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !x.title?.trim() || (x.class_ids && !x.class_ids.length) || words.length < 2} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name">
          <input className="input" maxLength={80} value={x.title || ''} onChange={(e) => set({ title: e.target.value })} placeholder="Term 1 report" />
        </Field>
        <div className="grid g3" style={{ gap: 12 }}>
          <Field label="Covers from" hint="Marks, attendance and points from these dates">
            <input className="input" type="date" value={x.starts || ''} onChange={(e) => set({ starts: e.target.value })} />
          </Field>
          <Field label="Covers until">
            <input className="input" type="date" value={x.ends || ''} onChange={(e) => set({ ends: e.target.value })} />
          </Field>
          <Field label="Teachers finish by">
            <input className="input" type="date" value={x.due || ''} onChange={(e) => set({ due: e.target.value })} />
          </Field>
        </div>
        <Field label="Grades" hint="IB MYP classes use their criteria (0 to 8 each) and a 1–7 grade from them, whatever you pick here">
          <select className="select" value={x.scale} onChange={(e) => set({ scale: e.target.value })}>
            {Object.entries(SCALES).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
        {(x.scale === 'words' || x.atl) && (
          <Field label="The words" hint="2 to 8, from the first step to the best, separated by commas">
            <input className="input" value={wordText} onChange={(e) => setWordText(e.target.value)} />
          </Field>
        )}
        <Toggle checked={!!x.effort} onChange={(v) => set({ effort: v })} title="An effort grade too" sub="Excellent, Good, Needs work or A concern" />
        <Toggle checked={!!x.atl} onChange={(v) => set({ atl: v })} title="Approaches to learning (ATL)" sub="Each class rates thinking, research, communication, social and self-management skills in the words above" />
        <Toggle checked={!!x.profile} onChange={(v) => set({ profile: v })} title="The Learner Profile" sub="The attributes teachers noted for each learner in the report’s dates" />
        <Field label="Classes">
          <div className="stack sm">
            <label className="row" style={{ gap: 8 }}>
              <input type="radio" name="which-classes" checked={!x.class_ids} onChange={() => set({ class_ids: null })} /> Every class
            </label>
            <label className="row" style={{ gap: 8 }}>
              <input type="radio" name="which-classes" checked={!!x.class_ids} onChange={() => set({ class_ids: [] })} /> Some classes
            </label>
            {x.class_ids && (
              <div className="row wrap" style={{ gap: 6 }}>
                {classes.map((c) => {
                  const on = picked.includes(c.id);
                  return (
                    <button key={c.id} className="chip" aria-pressed={on} onClick={() => set({ class_ids: on ? picked.filter((y) => y !== c.id) : [...picked, c.id] })}>
                      {c.name}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </Field>
      </div>
    </Modal>
  );
}

// One class's part: a card for each learner
function ClassReports({ roundId, classId }) {
  const toast = useToast();
  const q = useQuery(`term-class:${roundId}:${classId}`, () => api.reportClass(roundId, classId));
  const [edits, setEdits] = useState({});
  const [busy, setBusy] = useState(null);
  useLeaveGuard(Object.keys(edits).length > 0);
  const d = q.data;
  if (!d) return <Page title="Term report">{q.error ? <div className="error">{q.error.message}</div> : <Loading />}</Page>;
  const r = d.round;
  const grades = SCALES[r.scale]?.grades || [];
  const entryOf = (l) => edits[l.id] || { grade: '', criteria: {}, effort: '', comment: '', done: false, ...(l.entry || {}), criteria: l.entry?.criteria || {}, atl: l.entry?.atl || {} };
  const words = r.descriptors || [];
  const edit = (l, patch) => setEdits({ ...edits, [l.id]: { ...entryOf(l), ...patch } });
  const left = d.learners.filter((l) => !entryOf(l).done).length;
  async function save(l, done) {
    const e = { ...entryOf(l), ...(done != null ? { done } : {}) };
    setBusy(l.id);
    try {
      await api.saveReportEntry(roundId, classId, l.id, {
        grade: e.grade || null, criteria: e.criteria, effort: e.effort || null, comment: e.comment || null, done: !!e.done, atl: e.atl,
      });
      const rest = { ...edits };
      delete rest[l.id];
      setEdits(rest);
      changed();
      toast(e.done ? `${l.name.split(' ')[0]}’s part is finished` : 'Saved');
    } catch (err) {
      toast({ title: 'Couldn’t save it', body: err.message, tone: 'bad' });
    } finally {
      setBusy(null);
    }
  }
  return (
    <Page
      eyebrow={
        <>
          <Link to="/learners/terms">Term reports</Link> <Icon name="right" size={14} /> {r.title}
        </>
      }
      title={d.class.name}
      subtitle={[d.class.subject, r.due && r.status === 'writing' && `Due ${fmt(r.due)}`, left ? `${left} still to finish` : 'All finished'].filter(Boolean).join(' · ')}
    >
      {!d.can_edit && <div className="note warn">This report has gone out, so it can’t change. A manager can take it back to change it.</div>}
      {d.myp && <div className="note">An IB MYP class: give a level from 0 to 8 for each criterion. The 1–7 grade comes from all four added up.</div>}
      {d.learners.length === 0 && <Empty>Nobody is in this class.</Empty>}
      {d.learners.map((l) => {
        const e = entryOf(l);
        const h = l.hints || {};
        const dirty = !!edits[l.id];
        const hint = [
          h.work ? `Average ${h.pct}% on ${h.work} piece${h.work === 1 ? '' : 's'} of work given back` : 'No marked work for this class in these dates',
          h.criteria && `Levels given: ${levelsText(h.criteria)}`,
          h.predicted && `Predicted grade ${h.predicted}`,
          h.attendance != null && `Attendance ${h.attendance}%`,
          (h.positive > 0 || h.concern > 0) && `+${h.positive} points${h.concern ? `, ${h.concern} concern${h.concern === 1 ? '' : 's'}` : ''}`,
        ].filter(Boolean);
        return (
          <div key={l.id} className={'card term-entry' + (e.done && !dirty ? ' done' : '')}>
            <div className="card-head">
              <h2>{l.name}</h2>
              {e.done && !dirty ? <span className="pill good">Finished</span> : dirty ? <span className="pill warn">Not saved</span> : null}
            </div>
            <div className="small muted">{hint.join(' · ')}</div>
            <fieldset className="term-fields" disabled={!d.can_edit} aria-label={`${l.name}’s report`}>
              {d.myp ? (
                <div className="term-crit-edit">
                  {LETTERS.map((k) => (
                    <Field key={k} label={`${k}: ${d.myp[k]}`}>
                      <select
                        className="select"
                        value={e.criteria?.[k] ?? ''}
                        onChange={(ev) => edit(l, { criteria: { ...e.criteria, [k]: ev.target.value === '' ? undefined : Number(ev.target.value) } })}
                      >
                        <option value="">Not given</option>
                        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                          <option key={n} value={n}>
                            {n} · {band(n)}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ))}
                  <div className="term-myp-grade">
                    <span className="small muted">Grade</span>
                    <span className="term-grade">{mypGrade(e.criteria) ?? '—'}</span>
                  </div>
                </div>
              ) : (
                r.scale !== 'none' && (
                  <Field label="Grade">
                    {r.scale === 'percent' ? (
                      <input className="input" type="number" min="0" max="100" style={{ maxWidth: 140 }} value={e.grade || ''} onChange={(ev) => edit(l, { grade: ev.target.value })} />
                    ) : (
                      <select className="select" style={{ maxWidth: 220 }} value={e.grade || ''} onChange={(ev) => edit(l, { grade: ev.target.value })}>
                        <option value="">Not given</option>
                        {(r.scale === 'words' ? words : grades).map((g) => (
                          <option key={g}>{g}</option>
                        ))}
                      </select>
                    )}
                  </Field>
                )
              )}
              {r.effort && (
                <Field label="Effort">
                  <select className="select" style={{ maxWidth: 220 }} value={e.effort || ''} onChange={(ev) => edit(l, { effort: ev.target.value ? Number(ev.target.value) : '' })}>
                    <option value="">Not given</option>
                    {Object.entries(EFFORT).map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              {r.atl && (
                <div className="term-atl">
                  {ATL_SKILLS.map((skill) => (
                    <Field key={skill} label={`${skill} skills`}>
                      <select className="select" value={e.atl?.[skill] ?? ''} onChange={(ev) => edit(l, { atl: { ...e.atl, [skill]: ev.target.value === '' ? undefined : Number(ev.target.value) } })}>
                        <option value="">Not given</option>
                        {words.map((w, i) => (
                          <option key={w} value={i + 1}>
                            {w}
                          </option>
                        ))}
                      </select>
                    </Field>
                  ))}
                </div>
              )}
              <Field label="Comment">
                <textarea className="textarea" rows={3} maxLength={2000} value={e.comment || ''} onChange={(ev) => edit(l, { comment: ev.target.value })} />
              </Field>
              <div className="row end wrap" style={{ gap: 8 }}>
                {dirty && (
                  <button className="btn" disabled={busy === l.id} onClick={() => save(l)}>
                    Save
                  </button>
                )}
                {(!e.done || dirty) && (
                  <button className="btn primary" disabled={busy === l.id} onClick={() => save(l, true)}>
                    <Icon name="check" size={16} /> Save and finish
                  </button>
                )}
                {e.done && !dirty && (
                  <button className="btn" disabled={busy === l.id} onClick={() => save(l, false)}>
                    Not finished after all
                  </button>
                )}
              </div>
            </fieldset>
          </div>
        );
      })}
    </Page>
  );
}

// The report as a whole: each class's progress, overall comments, previews, sending it out and printing
function RoundOverview({ roundId }) {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery(`term-round:${roundId}`, () => api.reportRound(roundId));
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState(false);
  useLeaveGuard(Object.keys(notes).length > 0);
  const r = q.data;
  if (!r) return <Page title="Term report">{q.error ? <div className="error">{q.error.message}</div> : <Loading />}</Page>;
  const writing = r.status === 'writing';
  const unfinished = r.classes.reduce((s, c) => s + Math.max(0, c.learners - c.done), 0);
  async function saveNote(l) {
    try {
      await api.saveReportOverall(roundId, l.id, notes[l.id]);
      const rest = { ...notes };
      delete rest[l.id];
      setNotes(rest);
      changed();
      toast('Saved');
    } catch (e) {
      toast({ title: 'Couldn’t save it', body: e.message, tone: 'bad' });
    }
  }
  async function publish(on) {
    const ok = on
      ? await confirm({
          title: `Send “${r.title}” out?`,
          body: `Every learner in it and their parents can read it, and parents get an email.${unfinished ? ` ${unfinished} part${unfinished === 1 ? ' isn’t' : 's aren’t'} finished yet; what’s written so far shows.` : ''}`,
          ok: 'Send it out',
        })
      : await confirm({ title: 'Take it back?', body: 'Learners and parents stop seeing it until you send it out again. Teachers can change their parts meanwhile.', ok: 'Take it back' });
    if (!ok) return;
    setBusy(true);
    try {
      const res = await api.publishReportRound(roundId, on);
      changed();
      toast(on ? `Sent out to ${res.told} learner${res.told === 1 ? '' : 's'} and their parents` : 'Taken back');
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page
      eyebrow={
        <>
          <Link to="/learners/terms">Term reports</Link> <Icon name="right" size={14} /> {r.title}
        </>
      }
      title={r.title}
      subtitle={[termDates(r) && `Covers ${termDates(r)}`, writing && r.due && `Due ${fmt(r.due)}`].filter(Boolean).join(' · ')}
      actions={
        r.manager && (
          <span className="row wrap" style={{ gap: 8 }}>
            <button className="btn" onClick={() => go(`/learners/terms/${roundId}/print`)}>
              <Icon name="download" size={16} /> Print them all
            </button>
            {writing ? (
              <button className="btn primary" disabled={busy} onClick={() => publish(true)}>
                <Icon name="send" size={16} /> Send it out
              </button>
            ) : (
              <button className="btn" disabled={busy} onClick={() => publish(false)}>
                Take it back
              </button>
            )}
          </span>
        )
      }
    >
      {!writing && <div className="note good">Sent out. Learners and their parents can read it, and print it.</div>}
      {r.manager && (
        <div className="card">
          <h2>Classes</h2>
          <div className="list">
            {r.classes.map((c) => (
              <div key={c.id} className="item">
                <span className="grow">
                  <span className="name">{c.name}</span>
                  <span className="meta">
                    {c.teachers && <span>{c.teachers}</span>}
                    <span>
                      {c.done} of {c.learners} finished
                    </span>
                  </span>
                </span>
                {c.done >= c.learners && c.learners > 0 && <span className="pill good">Done</span>}
                <button className="btn sm" onClick={() => go(`/learners/terms/${roundId}/${c.id}`)}>
                  Open
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="card">
        <h2>{r.manager ? 'Learners' : 'Your learners'}</h2>
        <div className="small muted">An overall comment for each one (from their own teacher, or a manager), then look at their whole report.</div>
        {r.learners.length === 0 ? (
          <Empty>Nobody in this report’s classes yet.</Empty>
        ) : (
          r.learners.map((l) => {
            const note = notes[l.id] ?? l.overall ?? '';
            return (
              <div key={l.id} className="term-learner">
                <div className="row between wrap" style={{ gap: 8 }}>
                  <span>
                    <span className="strong">{l.name}</span>{' '}
                    <span className="small muted">
                      {l.done} of {l.classes} subjects finished
                    </span>
                  </span>
                  <Link to={`/report/${roundId}/${l.id}`} className="small">
                    Look at the report
                  </Link>
                </div>
                <textarea
                  className="textarea"
                  rows={2}
                  maxLength={2000}
                  aria-label={`Overall comment for ${l.name}`}
                  placeholder="Overall comment"
                  disabled={!writing}
                  value={note}
                  onChange={(e) => setNotes({ ...notes, [l.id]: e.target.value })}
                />
                {notes[l.id] != null && notes[l.id] !== (l.overall ?? '') && (
                  <div className="row end">
                    <button className="btn sm primary" onClick={() => saveNote(l)}>
                      Save the comment
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </Page>
  );
}

// Every learner's report, a page each, to print or save as one PDF
function PrintAll({ roundId }) {
  const q = useQuery(`term-cards:${roundId}`, () => api.reportCards(roundId));
  const cards = q.data;
  return (
    <Page
      eyebrow={
        <Link to={`/learners/terms/${roundId}`}>
          <Icon name="left" size={14} /> Back
        </Link>
      }
      title="Print them all"
      subtitle={cards ? `${cards.length} report${cards.length === 1 ? '' : 's'}, a page each` : ''}
      actions={
        cards?.length > 0 && (
          <button className="btn primary" onClick={printTerms}>
            <Icon name="download" size={16} /> Print or save as PDF
          </button>
        )
      }
    >
      {!cards ? (
        q.error ? <div className="error">{q.error.message}</div> : <Loading />
      ) : (
        <div className="term-print stack lg">
          {cards.map((c) => (
            <TermCard key={c.learner.id} c={c} />
          ))}
        </div>
      )}
    </Page>
  );
}
