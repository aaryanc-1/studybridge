// A centre's or school's timetable, set out by its managers (the school day's periods, terms and holidays, and each
// class's lessons in the week; a whole timetable can be pasted from a spreadsheet), and the whole school's attendance
// and behaviour. A class's teachers can set out their own class's lessons too.
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Link, Loading, Modal, Stat, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { day } from '../../lib/format.js';
import { parseTimetable } from '../../lib/roster.js';
import { useLookups } from '../shared/lookups.jsx';
import { GiveBehaviour, pctTone, useInSchool } from '../shared/School.jsx';

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const USUAL_DAY = [
  { name: 'Period 1', starts: '08:30', ends: '09:30' },
  { name: 'Period 2', starts: '09:30', ends: '10:30' },
  { name: 'Period 3', starts: '10:50', ends: '11:50' },
  { name: 'Period 4', starts: '11:50', ends: '12:50' },
  { name: 'Period 5', starts: '13:40', ends: '14:40' },
];
const yearName = (g) => (g == null ? 'No year set' : g >= 13 ? 'Finished school' : `Grade ${g} (Year ${g + 1})`);
const changed = () => invalidate('school-setup', 'timetable');

export function TimetableSetup() {
  const q = useQuery('school-setup', api.schoolSetup);
  const s = q.data;
  if (!s) return q.error ? <div className="card"><div className="error">{q.error.message}</div></div> : <Loading />;
  return (
    <>
      {s.manager && <SchoolDay s={s} />}
      {s.manager && <TermDates s={s} />}
      {s.periods.length > 0 ? <WeekGrid s={s} /> : !s.manager && <Empty title="No school day yet">Your centre’s or school’s manager sets out the periods first.</Empty>}
      {s.manager && s.periods.length > 0 && <PasteTimetable />}
    </>
  );
}

// The school day: its periods (and the school's clock)
function SchoolDay({ s }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [rows, setRows] = useState(() => (s.periods.length ? s.periods.map((p) => ({ ...p })) : []));
  const [tz, setTz] = useState(s.timezone);
  const [busy, setBusy] = useState(false);
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [s.timezone];
  const set = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const gone = s.periods.filter((p) => !rows.some((r) => r.id === p.id));
  async function save() {
    if (gone.length && s.slots.some((x) => gone.some((p) => p.id === x.period_id))) {
      if (!(await confirm({ title: 'Take those periods off?', body: 'Lessons set in them come off the timetable too. Registers already taken stay.', ok: 'Save', danger: true }))) return;
    }
    setBusy(true);
    try {
      if (tz !== s.timezone) await api.setSchoolTimezone(tz);
      await api.savePeriods(rows.map((r) => ({ id: r.id || null, name: r.name, starts: r.starts, ends: r.ends })));
      changed();
      toast('The school day is saved');
    } catch (e) {
      toast({ title: 'Couldn’t save the school day', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <div className="card-head">
        <h2>The school day</h2>
        {!rows.length && (
          <button className="btn sm" onClick={() => setRows(USUAL_DAY.map((p) => ({ ...p })))}>
            Start with a usual day
          </button>
        )}
      </div>
      <div className="small muted">The periods in a day, the same each day of the week. Lessons go into them, and teachers take a register for each one.</div>
      {rows.length > 0 && (
        <div className="list">
          {rows.map((r, i) => (
            <div key={r.id || 'new' + i} className="item period-row">
              <input className="input" aria-label="Period name" value={r.name} maxLength={40} onChange={(e) => set(i, { name: e.target.value })} />
              <input className="input" type="time" aria-label={`${r.name || 'Period'} starts`} value={r.starts} onChange={(e) => set(i, { starts: e.target.value })} />
              <span className="muted">to</span>
              <input className="input" type="time" aria-label={`${r.name || 'Period'} ends`} value={r.ends} onChange={(e) => set(i, { ends: e.target.value })} />
              <button className="btn sm ghost" aria-label={`Remove ${r.name || 'this period'}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row wrap between" style={{ gap: 10, alignItems: 'flex-end' }}>
        <button className="btn sm" onClick={() => setRows([...rows, { name: `Period ${rows.length + 1}`, starts: rows.at(-1)?.ends || '09:00', ends: '' }])}>
          <Icon name="plus" size={15} /> Add a period
        </button>
        <Field label="The school’s clock">
          <select className="select" style={{ width: 'auto', maxWidth: 260 }} value={tz} onChange={(e) => setTz(e.target.value)}>
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replace(/_/g, ' ')}
              </option>
            ))}
          </select>
        </Field>
        <button className="btn primary" disabled={busy || !rows.length || rows.some((r) => !r.name.trim() || !r.starts || !r.ends)} onClick={save}>
          Save the school day
        </button>
      </div>
    </div>
  );
}

// Terms and holidays: no lessons on holidays, or outside the terms once they're set
function TermDates({ s }) {
  const toast = useToast();
  const [rows, setRows] = useState(() => s.dates.map((d) => ({ ...d })));
  const [busy, setBusy] = useState(false);
  const set = (i, patch) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  async function save() {
    setBusy(true);
    try {
      await api.saveSchoolDates(rows.map((r) => ({ kind: r.kind, name: r.name, starts: r.starts, ends: r.ends })));
      changed();
      toast('Terms and holidays are saved');
    } catch (e) {
      toast({ title: 'Couldn’t save the dates', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <h2>Terms and holidays</h2>
      <div className="small muted">Once you add a term, lessons only show inside terms. No lessons (or registers) on holidays.</div>
      {rows.length > 0 && (
        <div className="list">
          {rows.map((r, i) => (
            <div key={i} className="item period-row">
              <select className="select" style={{ width: 'auto' }} aria-label="Term or holiday" value={r.kind} onChange={(e) => set(i, { kind: e.target.value })}>
                <option value="term">Term</option>
                <option value="holiday">Holiday</option>
              </select>
              <input className="input" aria-label="Name" value={r.name} maxLength={60} onChange={(e) => set(i, { name: e.target.value })} />
              <input className="input" type="date" aria-label={`${r.name || 'It'} starts`} value={r.starts} onChange={(e) => set(i, { starts: e.target.value })} />
              <span className="muted">to</span>
              <input className="input" type="date" aria-label={`${r.name || 'It'} ends`} value={r.ends} onChange={(e) => set(i, { ends: e.target.value })} />
              <button className="btn sm ghost" aria-label={`Remove ${r.name || 'this one'}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row wrap between" style={{ gap: 10 }}>
        <span className="row wrap" style={{ gap: 8 }}>
          <button className="btn sm" onClick={() => setRows([...rows, { kind: 'term', name: '', starts: '', ends: '' }])}>
            <Icon name="plus" size={15} /> Add a term
          </button>
          <button className="btn sm" onClick={() => setRows([...rows, { kind: 'holiday', name: '', starts: '', ends: '' }])}>
            <Icon name="plus" size={15} /> Add a holiday
          </button>
        </span>
        <button className="btn primary" disabled={busy || rows.some((r) => !r.name.trim() || !r.starts || !r.ends)} onClick={save}>
          Save the dates
        </button>
      </div>
    </div>
  );
}

// The week: periods down the side, days across; each lesson opens to change it
function WeekGrid({ s }) {
  const [editing, setEditing] = useState(null);
  const days = [1, 2, 3, 4, 5, ...[6, 7].filter((d) => s.slots.some((x) => x.weekday === d))];
  const mineOnly = !s.manager;
  const canAdd = s.manager || s.classes.some((c) => c.mine);
  return (
    <div className="card pad0">
      <div className="row between wrap" style={{ padding: '12px 16px', gap: 8 }}>
        <h2>The week’s lessons</h2>
        <span className="small muted">{s.manager ? 'Press + to add a lesson, or a lesson to change it.' : 'You can set out your own classes’ lessons.'}</span>
      </div>
      <div className="gradebook-wrap">
        <table className="table tt-grid">
          <thead>
            <tr>
              <th>Period</th>
              {days.map((d) => (
                <th key={d}>{DAYS[d - 1]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {s.periods.map((p) => (
              <tr key={p.id}>
                <th scope="row">
                  <span className="strong">{p.name}</span>
                  <span className="tiny muted">
                    {p.starts}–{p.ends}
                  </span>
                </th>
                {days.map((d) => {
                  const here = s.slots.filter((x) => x.weekday === d && x.period_id === p.id);
                  return (
                    <td key={d}>
                      <div className="tt-cell">
                        {here.map((x) => (
                          <button key={x.id} className="tt-slot" disabled={mineOnly && !x.mine} onClick={() => setEditing(x)} aria-label={`${x.class}, ${DAYS[d - 1]} ${p.name}: change`}>
                            <span className="strong">{x.class}</span>
                            <span className="tiny muted">{[x.room, x.teacher].filter(Boolean).join(' · ')}</span>
                          </button>
                        ))}
                        {canAdd && (
                          <button className="btn sm ghost tt-add" aria-label={`Add a lesson on ${DAYS[d - 1]}, ${p.name}`} onClick={() => setEditing({ weekday: d, period_id: p.id })}>
                            <Icon name="plus" size={14} />
                          </button>
                        )}
                      </div>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editing && <SlotEditor s={s} slot={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function SlotEditor({ s, slot, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const classes = s.classes.filter((c) => s.manager || c.mine);
  const [classId, setClassId] = useState(slot.class_id || classes[0]?.id || '');
  const [weekday, setWeekday] = useState(slot.weekday);
  const [period, setPeriod] = useState(slot.period_id);
  const [room, setRoom] = useState(slot.room || '');
  const [teacher, setTeacher] = useState(slot.teacher_id || '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api.saveSlot(slot.id || null, classId, Number(weekday), period, room, teacher || null);
      changed();
      toast('The lesson is saved');
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save the lesson', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!(await confirm({ title: 'Take this lesson off the timetable?', body: 'Registers already taken for it stay.', ok: 'Remove lesson', danger: true }))) return;
    try {
      await api.deleteSlot(slot.id);
      changed();
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t take it off', body: e.message, tone: 'bad' });
    }
  }
  return (
    <Modal
      title={slot.id ? `${slot.class}` : 'Add a lesson'}
      onClose={onClose}
      foot={
        <>
          {slot.id && (
            <button className="btn danger" onClick={remove} style={{ marginRight: 'auto' }}>
              Remove lesson
            </button>
          )}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !classId} onClick={save}>
            Save
          </button>
        </>
      }
    >
      {classes.length === 0 ? (
        <Empty>Make a class first (Learners → Classes), then give it lessons here.</Empty>
      ) : (
        <div className="grid g2" style={{ gap: 12 }}>
          <Field label="Class">
            <select className="select" value={classId} onChange={(e) => setClassId(e.target.value)}>
              {classes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Day">
            <select className="select" value={weekday} onChange={(e) => setWeekday(e.target.value)}>
              {DAYS.map((d, i) => (
                <option key={d} value={i + 1}>
                  {d}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Period">
            <select className="select" value={period} onChange={(e) => setPeriod(e.target.value)}>
              {s.periods.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.starts}–{p.ends})
                </option>
              ))}
            </select>
          </Field>
          <Field label="Room" hint="If you like">
            <input className="input" maxLength={40} value={room} onChange={(e) => setRoom(e.target.value)} />
          </Field>
          {s.manager && (
            <Field label="Teacher" hint="The class’s first teacher if you leave it">
              <select className="select" value={teacher} onChange={(e) => setTeacher(e.target.value)}>
                <option value="">The class’s teacher</option>
                {s.teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
      )}
    </Modal>
  );
}

// A whole timetable from a spreadsheet: class, day, period, room, teacher
function PasteTimetable() {
  const toast = useToast();
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const rows = parseTimetable(text);
  async function add() {
    setBusy(true);
    try {
      const r = await api.timetablePaste(rows.map((x) => ({ class: x.class, weekday: x.weekday, period: x.period, room: x.room, teacher: x.teacher })));
      setResult(r);
      if (r.added) setText('');
      changed();
      if (r.added) toast(`${r.added} lesson${r.added === 1 ? '' : 's'} added`);
    } catch (e) {
      toast({ title: 'Couldn’t add them', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <h2>Add a whole timetable from a spreadsheet</h2>
      <div className="small muted">
        Copy the rows from Excel or Google Sheets and paste them here: class, day, period, room, teacher (a header row can say which is which). Periods by name (“Period 1”) or start time (“09:00”). Classes and teachers by the names they have here.
      </div>
      <textarea
        className="textarea"
        aria-label="Timetable rows"
        style={{ minHeight: 120 }}
        value={text}
        onChange={(e) => (setText(e.target.value), setResult(null))}
        placeholder={'Class\tDay\tPeriod\tRoom\tTeacher\nYear 10 maths\tMonday\tPeriod 1\t12\tGrace Mwansa'}
      />
      {result?.problems?.length > 0 && (
        <div className="note warn">
          {result.problems.length} row{result.problems.length === 1 ? '' : 's'} didn’t fit:{' '}
          {result.problems
            .slice(0, 8)
            .map((p) => `row ${p.row}: ${p.text}`)
            .join('; ')}
          {result.problems.length > 8 ? '…' : ''}
        </div>
      )}
      <div className="row end">
        <button className="btn primary" disabled={busy || !rows.length} onClick={add}>
          {rows.length ? `Add ${rows.length} lesson${rows.length === 1 ? '' : 's'}` : 'Add the lessons'}
        </button>
      </div>
    </div>
  );
}

// ---------- the whole school's attendance and behaviour (managers) ----------
const RANGES = [
  { value: 'week', label: 'This week', days: 7 },
  { value: 'month', label: 'Last 30 days', days: 30 },
  { value: 'term', label: 'Last 4 months', days: 120 },
];
const fromFor = (r) => {
  const d = new Date();
  d.setDate(d.getDate() - (RANGES.find((x) => x.value === r)?.days || 120) + 1);
  return d.toISOString().slice(0, 10);
};
function RangePick({ value, onChange }) {
  return (
    <select className="select" style={{ width: 'auto' }} aria-label="How far back" value={value} onChange={(e) => onChange(e.target.value)}>
      {RANGES.map((r) => (
        <option key={r.value} value={r.value}>
          {r.label}
        </option>
      ))}
    </select>
  );
}
function LearnerName({ id, name }) {
  const lk = useLookups();
  return lk.learner(id) ? <Link to={`/learners/${id}/school`}>{name}</Link> : <span>{name}</span>;
}

export function AttendanceReport() {
  const [range, setRange] = useState('month');
  const q = useQuery(`attendance-overview:${range}`, () => api.attendanceOverview(fromFor(range), null));
  const o = q.data;
  return (
    <>
      <div className="row between wrap" style={{ gap: 10 }}>
        <span className="small muted">Every register taken in your centre or school. Late still counts as there; excused lessons don’t count either way.</span>
        <RangePick value={range} onChange={setRange} />
      </div>
      {!o ? (
        q.error ? <div className="error">{q.error.message}</div> : <Loading />
      ) : (
        <>
          <div className="kpi">
            <Stat n={o.pct != null ? `${o.pct}%` : '—'} l="Attendance" />
            <Stat n={o.lessons} l="Marks in registers" />
            <Stat n={o.absent} l="Absences" />
            <Stat n={o.late} l="Lates" />
          </div>
          <div className="split even">
            <div className="card">
              <h2>Registers not taken yet today</h2>
              {o.not_taken.length === 0 ? (
                <div className="small muted">None. Every lesson that’s started today has its register.</div>
              ) : (
                <div className="list">
                  {o.not_taken.map((x) => (
                    <div key={x.slot_id} className="item">
                      <Icon name="clock" style={{ color: 'var(--amber-ink)' }} />
                      <span className="grow">
                        <span className="name">{x.class}</span>
                        <span className="meta">
                          {x.period} · {x.starts}
                          {x.teacher ? ` · ${x.teacher}` : ''}
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="card">
              <h2>Below 90%</h2>
              {o.below.length === 0 ? (
                <div className="small muted">Nobody. Learners who miss more than 1 lesson in 10 show here.</div>
              ) : (
                <div className="list">
                  {o.below.map((l) => (
                    <div key={l.id} className="item">
                      <span className="grow">
                        <span className="name">
                          <LearnerName id={l.id} name={l.name} />
                        </span>
                        <span className="meta">
                          {yearName(l.grade)} · absent {l.absent} of {l.lessons}
                        </span>
                      </span>
                      <span className={'pill ' + pctTone(l.pct)}>{l.pct}%</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="split even">
            <PctTable title="By year" rows={o.by_year.map((y) => ({ key: y.grade ?? 'none', name: yearName(y.grade), pct: y.pct, extra: `${y.learners} learner${y.learners === 1 ? '' : 's'}` }))} />
            <PctTable title="By class" rows={o.by_class.map((c) => ({ key: c.id, name: c.name, to: `/learners/classes/${c.id}/attendance`, pct: c.pct, extra: `${c.registers} register${c.registers === 1 ? '' : 's'}` }))} />
          </div>
        </>
      )}
    </>
  );
}

function PctTable({ title, rows }) {
  const lk = useLookups();
  return (
    <div className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <div className="small muted">Nothing yet.</div>
      ) : (
        <div className="list">
          {rows.map((r) => (
            <div key={r.key} className="item">
              <span className="grow">
                <span className="name">{r.to && lk.klass(r.key) ? <Link to={r.to}>{r.name}</Link> : r.name}</span>
                <span className="meta">{r.extra}</span>
              </span>
              <span className={'pill ' + pctTone(r.pct)}>{r.pct != null ? `${r.pct}%` : '—'}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function BehaviourReport() {
  const [range, setRange] = useState('month');
  const q = useQuery(`behaviour-overview:${range}`, () => api.behaviourOverview(fromFor(range), null));
  const o = q.data;
  return (
    <>
      <div className="row between wrap" style={{ gap: 10 }}>
        <span className="small muted">Positives and concerns from every teacher. Learners and their parents see their own; staff notes stay with staff.</span>
        <RangePick value={range} onChange={setRange} />
      </div>
      {!o ? (
        q.error ? <div className="error">{q.error.message}</div> : <Loading />
      ) : (
        <>
          <div className="kpi">
            <Stat n={`+${o.positive}`} l="Positive points" />
            <Stat n={o.concern} l="Concern points" />
            <Stat n={o.stars.length} l="Learners with positives" />
            <Stat n={o.top.length} l="Learners with concerns" />
          </div>
          <div className="split even">
            <PeopleList title="Most concerns" list={o.top} empty="No concerns noted." show={(l) => `${l.concern} concern point${l.concern === 1 ? '' : 's'} · +${l.positive}`} />
            <PeopleList title="Most positives" list={o.stars} empty="No positives yet." show={(l) => `+${l.positive}`} />
          </div>
          <div className="split even">
            <BehaviourTable title="By class" rows={o.by_class.map((c) => ({ key: c.id, name: c.name, pos: c.positive, con: c.concern }))} />
            <BehaviourTable title="By year" rows={o.by_year.map((y) => ({ key: y.grade ?? 'none', name: yearName(y.grade), pos: y.positive, con: y.concern }))} />
          </div>
          <div className="card">
            <h2>Latest</h2>
            {o.latest.length === 0 ? (
              <div className="small muted">Nothing yet. Teachers give points from a register, a class or a learner’s page.</div>
            ) : (
              <div className="list">
                {o.latest.map((r) => (
                  <div key={r.id} className="item" style={{ alignItems: 'flex-start' }}>
                    <Icon name={r.kind === 'positive' ? 'star' : 'alert'} style={{ color: r.kind === 'positive' ? 'var(--good)' : 'var(--amber-ink)' }} />
                    <span className="grow">
                      <span className="name">
                        <LearnerName id={r.learner_id} name={r.learner} />: {r.kind === 'positive' ? `+${r.points}` : `−${r.points}`} {r.label}
                      </span>
                      <span className="meta">
                        <span>{day(r.at)}</span>
                        {r.by && <span>{r.by}</span>}
                        {r.class && <span>{r.class}</span>}
                      </span>
                      {r.comment && <span className="small">“{r.comment}”</span>}
                      {r.staff_note && (
                        <span className="small muted">
                          <Icon name="lock" size={12} /> Staff note: {r.staff_note}
                        </span>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
      <BehaviourTypes />
    </>
  );
}

function PeopleList({ title, list, empty, show }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {list.length === 0 ? (
        <div className="small muted">{empty}</div>
      ) : (
        <div className="list">
          {list.map((l) => (
            <div key={l.id} className="item">
              <span className="grow">
                <span className="name">
                  <LearnerName id={l.id} name={l.name} />
                </span>
                <span className="meta">
                  {yearName(l.grade)} · {show(l)}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BehaviourTable({ title, rows }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <div className="small muted">Nothing yet.</div>
      ) : (
        <div className="list">
          {rows.map((r) => (
            <div key={r.key} className="item">
              <span className="grow name">{r.name}</span>
              <span className="pill good">+{r.pos}</span>
              {r.con > 0 && <span className="pill warn">{r.con}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// The place's own list of positives and concerns
function BehaviourTypes() {
  const toast = useToast();
  const q = useQuery('behaviour-types', api.behaviourList);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const list = rows || (q.data || []).filter((t) => !t.archived);
  const set = (i, patch) => setRows(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  async function save() {
    setBusy(true);
    try {
      await api.saveBehaviourTypes(list.map((r) => ({ id: r.id || null, kind: r.kind, name: r.name, points: Number(r.points) || 1 })));
      invalidate('behaviour-types');
      setRows(null);
      toast('The list is saved');
    } catch (e) {
      toast({ title: 'Couldn’t save the list', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  if (!q.data) return null;
  return (
    <div className="card">
      <h2>Your positives and concerns</h2>
      <div className="small muted">What teachers pick from. Taking one off keeps the ones already given.</div>
      <div className="list">
        {list.map((r, i) => (
          <div key={r.id || 'new' + i} className="item period-row">
            <select className="select" style={{ width: 'auto' }} aria-label="Positive or concern" value={r.kind} onChange={(e) => set(i, { kind: e.target.value })}>
              <option value="positive">Positive</option>
              <option value="concern">Concern</option>
            </select>
            <input className="input" aria-label="Name" maxLength={40} value={r.name} onChange={(e) => set(i, { name: e.target.value })} />
            <select className="select" style={{ width: 'auto' }} aria-label="Points" value={r.points} onChange={(e) => set(i, { points: e.target.value })}>
              {[1, 2, 3, 5].map((n) => (
                <option key={n} value={n}>
                  {n} point{n === 1 ? '' : 's'}
                </option>
              ))}
            </select>
            <button className="btn sm ghost" aria-label={`Remove ${r.name || 'this one'}`} onClick={() => setRows(list.filter((_, j) => j !== i))}>
              <Icon name="trash" size={16} />
            </button>
          </div>
        ))}
      </div>
      <div className="row wrap between" style={{ gap: 10 }}>
        <span className="row wrap" style={{ gap: 8 }}>
          <button className="btn sm" onClick={() => setRows([...list, { kind: 'positive', name: '', points: 1 }])}>
            <Icon name="plus" size={15} /> Add a positive
          </button>
          <button className="btn sm" onClick={() => setRows([...list, { kind: 'concern', name: '', points: 1 }])}>
            <Icon name="plus" size={15} /> Add a concern
          </button>
        </span>
        <button className="btn primary" disabled={busy || !rows || list.some((r) => !r.name.trim())} onClick={save}>
          Save the list
        </button>
      </div>
    </div>
  );
}

// A class's attendance (for its teachers): each learner's, and its recent registers
export function ClassAttendance({ id }) {
  const q = useQuery(`class-attendance:${id}`, () => api.classAttendance(id));
  const lk = useLookups();
  const inSchool = useInSchool();
  const [giving, setGiving] = useState(false);
  const c = q.data;
  if (!c) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  const members = lk.membersOf(id).map((mid) => lk.learner(mid)).filter(Boolean);
  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Each learner</h2>
          {inSchool && members.length > 0 && <GiveButton onClick={() => setGiving(true)} />}
        </div>
        {c.learners.length === 0 ? (
          <Empty>Nobody is in this class yet.</Empty>
        ) : (
          <div className="list">
            {c.learners.map((l) => (
              <div key={l.id} className="item">
                <span className="grow">
                  <span className="name">
                    <Link to={`/learners/${l.id}/school`}>{l.name}</Link>
                  </span>
                  <span className="meta">
                    {l.lessons ? `${l.present} present · ${l.late} late · ${l.absent} absent${l.excused ? ` · ${l.excused} excused` : ''}` : 'No registers yet'}
                  </span>
                </span>
                {l.pct != null && <span className={'pill ' + pctTone(l.pct)}>{l.pct}%</span>}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <h2>Registers</h2>
        {c.registers.length === 0 ? (
          <div className="small muted">None yet. Take a register from your timetable, or from a live lesson.</div>
        ) : (
          <div className="list">
            {c.registers.map((r) => (
              <Link key={r.kind + r.id + r.day} to={r.kind === 'live' ? `/register/live/${r.id}` : `/register/lesson/${r.id}/${r.day}`} className="item">
                <span className="grow">
                  <span className="name">{r.label}</span>
                  <span className="meta">
                    {day(r.day + 'T12:00')} · {r.present + r.late} there{r.absent ? ` · ${r.absent} absent` : ''}
                  </span>
                </span>
                <Icon name="right" size={18} />
              </Link>
            ))}
          </div>
        )}
      </div>
      {giving && <GiveBehaviour learners={members.map((l) => ({ id: l.id, name: l.display_name }))} classId={id} onClose={() => setGiving(false)} />}
    </>
  );
}

export function GiveButton({ onClick }) {
  return (
    <button className="btn sm" onClick={onClick}>
      <Icon name="star" size={15} /> Give points
    </button>
  );
}
