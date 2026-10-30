// Running a school, for teachers, learners and parents: the week's lessons (school lessons from the timetable, and live
// lessons), the register for each lesson, attendance, and behaviour (positives and concerns). The learner and their
// parents see every place's records; staff see their own place's, with notes only staff ever see.
import { useEffect, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Field, Link, Loading, Modal, Page, Seg, Stat, go, useConfirm, useLeaveGuard, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { colorFor, day, time, ymd } from '../../lib/format.js';
import { SessionForm } from './Live.jsx';

export const STATUS = { present: 'Present', late: 'Late', absent: 'Absent', excused: 'Excused' };
const addDays = (d, n) => {
  const x = new Date(d + 'T12:00');
  x.setDate(x.getDate() + n);
  return ymd(x);
};
// the Monday of the week a day is in
const monday = (d) => addDays(d, -((new Date(d + 'T12:00').getDay() + 6) % 7));
const dayName = (d) => new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
const roomText = (r) => (r ? (/^\d/.test(r) ? `Room ${r}` : r) : '');
const nowHM = () => new Date().toTimeString().slice(0, 5);
// 95% and up is good; under 90% is the usual line for "missing a lot"
export const pctTone = (p) => (p == null ? '' : p >= 95 ? 'good' : p >= 90 ? 'warn' : 'bad');
const registerPath = (x) => (x.kind === 'live' ? `/register/live/${x.id}` : `/register/lesson/${x.id}/${x.day}`);
// a lesson that has started (a register can be taken from then on)
const started = (x) => (x.kind === 'live' ? new Date(x.starts_at).getTime() - 15 * 60000 < Date.now() : x.day < ymd(new Date()) || (x.day === ymd(new Date()) && x.starts <= nowHM()));

export const useTimetableOn = (on = true) => useQuery(on ? 'timetable-on' : null, api.timetableOn).data;
// School lessons keep the school's clock; live lessons show in this device's time, like the Live page
const hm = (d) => new Date(d).toTimeString().slice(0, 5);
const local = (list) =>
  (list || []).map((x) =>
    x.kind === 'live' && x.starts_at
      ? { ...x, day: ymd(new Date(x.starts_at)), starts: hm(x.starts_at), ends: hm(new Date(x.starts_at).getTime() + (x.duration_min || 60) * 60000) }
      : x,
  );
const myWeek = (from, to, learnerId) => api.myTimetable(from, to, learnerId).then(local);
// a teacher in a tuition centre or school (they set out lessons on its timetable)
export function useInSchool() {
  const org = useQuery('org', api.myOrg).data;
  return !!org && (org.kind === 'centre' || org.kind === 'school');
}

// ---------- the week ----------
// A learner's timetable (tutors have their own page with tabs: TutorTimetable in tutor/SchoolSetup.jsx)
export function TimetablePage() {
  return (
    <Page title="Timetable" subtitle="Your lessons, week by week.">
      <Week />
    </Page>
  );
}

// One week of lessons, a day at a time. Staff take each lesson's register from it, and open a live or in-person
// lesson for its options; `actions` sit beside the week's buttons.
export function Week({ learnerId = null, actions = null }) {
  const app = useApp();
  const staff = app.me.role === 'tutor' && !learnerId;
  const today = ymd(new Date());
  const [start, setStart] = useState(() => monday(today));
  const [open, setOpen] = useState(null);
  const q = useQuery(`timetable:${learnerId || 'me'}:${start}`, () => myWeek(start, addDays(start, 6), learnerId));
  const list = q.data;
  const days = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(start, i)).filter((d, i) => i < 5 || (list || []).some((x) => x.day === d));
  const thisWeek = start === monday(today);
  return (
    <>
      <div className="row between wrap" style={{ gap: 8 }}>
        <span className="strong">{thisWeek ? 'This week' : `Week of ${dayName(start)}`}</span>
        <span className="row wrap" style={{ gap: 8 }}>
          <button className="btn" onClick={() => setStart(addDays(start, -7))} aria-label="The week before">
            <Icon name="left" size={16} /> Week before
          </button>
          {!thisWeek && (
            <button className="btn" onClick={() => setStart(monday(today))}>
              This week
            </button>
          )}
          <button className="btn" onClick={() => setStart(addDays(start, 7))} aria-label="The week after">
            Week after <Icon name="right" size={16} />
          </button>
          {actions}
        </span>
      </div>
      {!list ? (
        q.error ? <div className="error">{q.error.message}</div> : <Loading />
      ) : list.length === 0 ? (
        <Empty title="No lessons this week">
          {staff ? 'Add a lesson, by live video or in person, and it shows here with its register.' : 'Your lessons show here: your school’s timetable, and lessons in person.'}
        </Empty>
      ) : (
        <div className="tt-week" style={{ '--days': days.length }}>
          {days.map((d) => {
            const lessons = list.filter((x) => x.day === d);
            return (
              <section key={d} className={'tt-day' + (d === today ? ' today' : '')} aria-label={dayName(d)}>
                <h3>
                  {dayName(d)}
                  {d === today && <span className="pill accent">Today</span>}
                </h3>
                {lessons.length === 0 ? <div className="tiny muted">No lessons</div> : lessons.map((x) => <LessonCard key={x.kind + x.id + x.day} x={x} staff={staff} onOpen={() => setOpen(x)} />)}
              </section>
            );
          })}
        </div>
      )}
      {open && <LessonOptions x={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function LessonCard({ x, staff, onOpen }) {
  const session = x.kind === 'live';
  return (
    <div className="tt-lesson" style={{ '--c': colorFor(x.class_id || x.id) }}>
      <span className="tt-time">
        {x.starts}–{x.ends}
        {x.period ? ` · ${x.period}` : ''}
      </span>
      {staff && session ? (
        <button className="name linkbtn tt-open" onClick={onOpen} aria-haspopup="dialog">
          <Icon name={x.in_person ? 'pin' : 'video'} size={14} /> {x.class}
        </button>
      ) : (
        <span className="name">
          {session && <Icon name={x.in_person ? 'pin' : 'video'} size={14} />} {x.class}
        </span>
      )}
      <span className="meta">
        {[roomText(x.room), !staff && x.teacher, session && (x.in_person ? x.location || 'In person' : 'Live lesson')].filter(Boolean).join(' · ')}
      </span>
      {staff ? <RegisterState x={x} /> : session && !x.in_person && <Link to={`/live/${x.id}`} className="small">Open</Link>}
    </div>
  );
}

// A live or in-person lesson on a tutor's timetable: its register, joining it, changing it, skipping or cancelling it
function LessonOptions({ x, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const all = useQuery('sessions:all', api.listAllSessions).data;
  const series = useQuery('sessions:series', api.listSeries).data || [];
  const [editing, setEditing] = useState(false);
  const s = (all || []).find((y) => y.id === x.id);
  const future = new Date(x.starts_at).getTime() > Date.now();
  if (editing && s) return <SessionForm initial={s} series={series.find((y) => y.id === s.series_id)} onClose={onClose} />;
  const done = () => {
    invalidate('sessions', 'timetable');
    onClose();
  };
  async function skipOrCancel() {
    try {
      if (x.series_id) {
        if (!(await confirm({ title: 'Skip this lesson?', body: 'Just this one. Your learners are told; the weekly lesson carries on.', ok: 'Skip it', cancel: 'Keep' }))) return;
        await api.skipLesson(x.id);
        toast('Skipped. Your learners have been told.');
      } else {
        if (!(await confirm({ title: 'Cancel this lesson?', body: 'Your learners get a message saying it’s cancelled.', ok: 'Cancel lesson', cancel: 'Keep', danger: true }))) return;
        await api.remove('sessions', x.id);
        toast('Cancelled. Your learners have been told.');
      }
      done();
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
    }
  }
  return (
    <Modal title={x.class} onClose={onClose}>
      <div className="stack">
        <div className="stack sm">
          <div className="row" style={{ gap: 8 }}>
            <Icon name="calendar" size={16} style={{ color: 'var(--muted)' }} />
            {dayName(x.day)}, {x.starts}–{x.ends}
            {x.series_id && <span className="pill accent">Weekly</span>}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Icon name={x.in_person ? 'pin' : 'video'} size={16} style={{ color: 'var(--muted)' }} />
            {x.in_person ? `In person${x.location ? ` · ${x.location}` : ''}` : 'Live video'}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Icon name="users" size={16} style={{ color: 'var(--muted)' }} />
            {x.size} {x.size === 1 ? 'learner' : 'learners'}
          </div>
        </div>
        <div className="sheet-actions">
          {started(x) && (
            <button className="btn primary" onClick={() => go(registerPath(x))}>
              <Icon name="checkCircle" size={18} /> {x.marked ? 'Open the register' : 'Take the register'}
            </button>
          )}
          {!x.in_person && (
            <button className="btn" onClick={() => go(`/live/${x.id}`)}>
              <Icon name="video" size={18} /> {started(x) ? 'Join' : 'Open'}
            </button>
          )}
          {future && s && (
            <button className="btn" onClick={() => setEditing(true)}>
              <Icon name="pen" size={18} /> Change
            </button>
          )}
          {future && s && (
            <button className="btn danger" onClick={skipOrCancel}>
              <Icon name="x" size={18} /> {x.series_id ? 'Skip just this one' : 'Cancel lesson'}
            </button>
          )}
        </div>
        {!started(x) && <div className="small muted">You can take its register once it starts.</div>}
      </div>
    </Modal>
  );
}

function RegisterState({ x }) {
  if (x.marked > 0)
    return (
      <Link to={registerPath(x)} className="pill good" style={{ textDecoration: 'none' }}>
        <Icon name="check" size={13} /> Register taken
      </Link>
    );
  if (!started(x)) return null;
  return (
    <button className="btn sm primary" onClick={() => go(registerPath(x))}>
      Take the register
    </button>
  );
}

// Today's school lessons, on Home (teachers) and Today (learners)
export function TodayLessons({ staff }) {
  const on = useTimetableOn();
  const today = ymd(new Date());
  const q = useQuery(on ? `timetable:me:${today}:${today}` : null, () => myWeek(today, today));
  const list = (q.data || []).filter((x) => x.kind === 'lesson');
  if (!on || !list.length) return null;
  const toTake = staff ? list.filter((x) => !x.marked && started(x)).length : 0;
  return (
    <section className="card">
      <div className="card-head">
        <h2>{staff ? 'Your lessons today' : 'Today’s lessons'}</h2>
        <span className="row small" style={{ gap: 10 }}>
          {toTake > 0 && <span className="pill warn">{toTake} register{toTake === 1 ? '' : 's'} to take</span>}
          <Link to="/timetable">Whole week</Link>
        </span>
      </div>
      <div className="list">
        {list.map((x) => (
          <div key={x.id} className="item">
            <span className="tt-dot" style={{ background: colorFor(x.class_id) }} aria-hidden="true" />
            <span className="grow">
              <span className="name">{x.class}</span>
              <span className="meta">
                <span>
                  {x.starts}–{x.ends} · {x.period}
                </span>
                {x.room && <span>{roomText(x.room)}</span>}
                {!staff && x.teacher && <span>{x.teacher}</span>}
              </span>
            </span>
            {staff && <RegisterState x={x} />}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------- a register ----------
export function RegisterPage({ kind, id, day: onDay }) {
  const toast = useToast();
  const q = useQuery(`register:${kind}:${id}:${onDay || ''}`, () => api.register(kind, id, onDay || null));
  const r = q.data;
  const [marks, setMarks] = useState(null);
  const [notes, setNotes] = useState({});
  const [busy, setBusy] = useState(false);
  const [giving, setGiving] = useState(null);
  useEffect(() => {
    if (r && !marks) setMarks(Object.fromEntries(r.learners.map((l) => [l.id, { status: l.status || '', minutes_late: l.minutes_late ?? '', note: l.note || '' }])));
  }, [r, marks]);
  const changed = (l) => {
    const m = marks?.[l.id];
    return !!m && (m.status !== (l.status || '') || String(m.minutes_late ?? '') !== String(l.minutes_late ?? '') || m.note !== (l.note || ''));
  };
  const dirty = !!r && !!marks && r.learners.some(changed);
  useLeaveGuard(dirty);
  if (!r || !marks)
    return (
      <Page title="Register">
        {q.error ? <div className="card"><div className="error">{q.error.message}</div></div> : <Loading />}
      </Page>
    );
  const set = (lid, patch) => setMarks((m) => ({ ...m, [lid]: { ...m[lid], ...patch } }));
  const unmarked = r.learners.filter((l) => !marks[l.id].status).length;
  const future = r.day > r.today;
  async function save() {
    setBusy(true);
    try {
      await api.saveRegister(
        kind,
        id,
        r.day,
        r.learners.map((l) => ({ learner: l.id, status: marks[l.id].status || null, minutes_late: Number(marks[l.id].minutes_late) || 0, note: marks[l.id].note })),
      );
      const absent = r.learners.filter((l) => marks[l.id].status === 'absent').length;
      invalidate('timetable', 'register:', 'attendance', 'class-attendance');
      await q.refresh();
      setMarks(null);
      toast(absent && r.day === r.today ? 'Register saved. Parents of anyone absent hear about it today.' : 'Register saved');
    } catch (e) {
      toast({ title: 'Couldn’t save the register', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page
      eyebrow={
        <>
          <Link to="/timetable">Timetable</Link> <Icon name="right" size={14} />
        </>
      }
      title={r.title}
      subtitle={`${r.when} · ${day(r.day + 'T12:00')}${r.day === r.today ? ' (today)' : ''}`}
      actions={
        <button className="btn" disabled={future || !unmarked} onClick={() => setMarks((m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.status ? v : { ...v, status: 'present' }])))}>
          <Icon name="check" size={16} /> Everyone else is here
        </button>
      }
    >
      {future && <div className="note">This lesson hasn’t happened yet. Take the register on the day.</div>}
      {kind === 'live' && !r.in_person && <div className="small muted">Learners who came into the live lesson are filled in already: present, or late after 5 minutes.</div>}
      <div className="card">
        {r.learners.length === 0 ? (
          <Empty>Nobody is in this class yet.</Empty>
        ) : (
          <div className="list">
            {r.learners.map((l) => {
              const m = marks[l.id];
              const first = l.name.split(' ')[0];
              return (
                <div key={l.id} className="item reg-row">
                  <Avatar person={{ id: l.id, display_name: l.name }} size="sm" />
                  <span className="grow">
                    <span className="name">{l.name}</span>
                    {l.by_joining && l.joined_at && <span className="meta">Came in at {time(l.joined_at)}</span>}
                  </span>
                  <span className="reg-pick" role="group" aria-label={`${l.name}: present, late, absent or excused`}>
                    {Object.keys(STATUS).map((s) => (
                      <button key={s} type="button" className={'reg-' + s} aria-pressed={m.status === s} disabled={future} onClick={() => set(l.id, { status: m.status === s ? '' : s })}>
                        {STATUS[s]}
                      </button>
                    ))}
                  </span>
                  {m.status === 'late' && (
                    <input
                      className="input reg-min"
                      type="number"
                      min="0"
                      max="600"
                      inputMode="numeric"
                      aria-label={`${first}: minutes late`}
                      placeholder="Mins"
                      value={m.minutes_late}
                      onChange={(e) => set(l.id, { minutes_late: e.target.value })}
                    />
                  )}
                  <button className="btn sm ghost" aria-label={`A note about ${first} (staff only)`} onClick={() => setNotes((n) => ({ ...n, [l.id]: !n[l.id] }))}>
                    <Icon name="pen" size={15} />
                  </button>
                  <button className="btn sm ghost" aria-label={`Give ${first} a point or note a concern`} onClick={() => setGiving([{ id: l.id, name: l.name }])}>
                    <Icon name="star" size={15} />
                  </button>
                  {(notes[l.id] || m.note) && (
                    <input
                      className="input reg-note"
                      aria-label={`A note about ${first}, only staff see it`}
                      placeholder="A note for staff (only staff see it)"
                      maxLength={300}
                      value={m.note}
                      onChange={(e) => set(l.id, { note: e.target.value })}
                    />
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {r.learners.length > 0 && (
        <div className="row between wrap reg-save" style={{ gap: 10 }}>
          <span className="small muted">
            {unmarked ? `${unmarked} not marked yet` : 'Everyone is marked'}
            {r.day === r.today && ' · Parents of anyone marked absent hear about it today'}
          </span>
          <button className="btn primary" disabled={busy || future || (!dirty && (r.taken || unmarked === r.learners.length))} onClick={save}>
            {busy ? 'Saving…' : r.taken ? 'Save changes' : 'Save the register'}
          </button>
        </div>
      )}
      {giving && <GiveBehaviour learners={giving} classId={r.class_id} onClose={() => setGiving(null)} />}
    </Page>
  );
}

// ---------- behaviour ----------
// A positive or a concern for one learner or several. They and their parents are told; the staff note stays with staff.
export function GiveBehaviour({ learners, classId = null, onClose }) {
  const toast = useToast();
  const q = useQuery('behaviour-types', api.behaviourList);
  const types = (q.data || []).filter((t) => !t.archived);
  const [kind, setKind] = useState('positive');
  const [pick, setPick] = useState(null);
  const [who, setWho] = useState(() => (learners.length === 1 ? [learners[0].id] : []));
  const [comment, setComment] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = types.filter((t) => t.kind === kind);
  const chosen = types.find((t) => t.id === pick);
  const one = learners.length === 1;
  async function give() {
    setBusy(true);
    try {
      const n = await api.giveBehaviour(who, pick, comment.trim() || null, note.trim() || null, classId);
      invalidate('behaviour');
      toast(chosen.kind === 'positive' ? `${chosen.name}: given to ${n === 1 ? learners.find((l) => l.id === who[0])?.name.split(' ')[0] : `${n} learners`}` : 'Noted. They and their parents can see it.');
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save it', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={one ? `${learners[0].name.split(' ')[0]}: a point or a concern` : 'A point or a concern'}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !chosen || !who.length} onClick={give}>
            {chosen?.kind === 'concern' ? 'Note it' : 'Give it'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Seg
          label="Positive or concern"
          value={kind}
          onChange={(k) => (setKind(k), setPick(null))}
          options={[
            { value: 'positive', label: 'Positive' },
            { value: 'concern', label: 'Concern' },
          ]}
        />
        {!q.data ? (
          q.error ? <div className="error">{q.error.message}</div> : <Loading />
        ) : (
          <div className="chips-pick" role="group" aria-label={kind === 'positive' ? 'Positives' : 'Concerns'}>
            {shown.map((t) => (
              <button key={t.id} type="button" className={'chip-pick' + (pick === t.id ? ' on' : '')} aria-pressed={pick === t.id} onClick={() => setPick(t.id)}>
                {t.kind === 'positive' ? `+${t.points}` : `−${t.points}`} {t.name}
              </button>
            ))}
          </div>
        )}
        {!one && (
          <Field label="Who">
            <div className="chips-pick" role="group" aria-label="Learners">
              <button type="button" className={'chip-pick' + (who.length === learners.length ? ' on' : '')} aria-pressed={who.length === learners.length} onClick={() => setWho(who.length === learners.length ? [] : learners.map((l) => l.id))}>
                Everyone
              </button>
              {learners.map((l) => (
                <button key={l.id} type="button" className={'chip-pick' + (who.includes(l.id) ? ' on' : '')} aria-pressed={who.includes(l.id)} onClick={() => setWho(who.includes(l.id) ? who.filter((x) => x !== l.id) : [...who, l.id])}>
                  {l.name}
                </button>
              ))}
            </div>
          </Field>
        )}
        <Field label="A word for them" hint="They and their parents see it.">
          <input className="input" maxLength={300} value={comment} onChange={(e) => setComment(e.target.value)} placeholder={kind === 'positive' ? 'Lovely working out today' : 'What happened, kindly put'} />
        </Field>
        <Field label="A note for staff" hint="Only staff see it.">
          <input className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}

// One learner's behaviour: totals and the latest, with Give for their teachers
export function BehaviourCard({ learnerId, name, staff = false, canGive = false }) {
  const q = useQuery(`behaviour:${learnerId}`, () => api.learnerBehaviour(learnerId));
  const confirm = useConfirm();
  const toast = useToast();
  const [giving, setGiving] = useState(false);
  const [all, setAll] = useState(false);
  const b = q.data;
  if (!b) return staff ? <div className="card">{q.error ? <div className="error">{q.error.message}</div> : <Loading />}</div> : null;
  if (!b.records.length && !canGive) return null;
  const first = (name || '').split(' ')[0];
  const shown = all ? b.records : b.records.slice(0, 6);
  const places = new Set(b.records.map((r) => r.place)).size > 1;
  async function remove(r) {
    if (!(await confirm({ title: `Remove “${r.label}”?`, body: `${first} and their parents won’t see it any more.`, ok: 'Remove', danger: true }))) return;
    try {
      await api.removeBehaviour(r.id);
      invalidate('behaviour');
    } catch (e) {
      toast({ title: 'Couldn’t remove it', body: e.message, tone: 'bad' });
    }
  }
  return (
    <div className="card">
      <div className="card-head">
        <h2>Behaviour</h2>
        <span className="row small" style={{ gap: 8 }}>
          <span className="pill good">+{b.positive} positive</span>
          {b.concern > 0 && <span className="pill warn">{b.concern} concern{b.concern === 1 ? '' : 's'}</span>}
          {canGive && (
            <button className="btn sm" onClick={() => setGiving(true)}>
              <Icon name="star" size={15} /> Give a point
            </button>
          )}
        </span>
      </div>
      {b.records.length === 0 ? (
        <div className="small muted">Nothing yet. Positives and concerns from {first}’s teachers show here, for {first} and their parents too.</div>
      ) : (
        <div className="list">
          {shown.map((r) => (
            <div key={r.id} className="item" style={{ alignItems: 'flex-start' }}>
              <Icon name={r.kind === 'positive' ? 'star' : 'alert'} style={{ color: r.kind === 'positive' ? 'var(--good)' : 'var(--amber-ink)' }} />
              <span className="grow">
                <span className="name">
                  {r.kind === 'positive' ? `+${r.points}` : `−${r.points}`} {r.label}
                </span>
                <span className="meta">
                  <span>{day(r.at)}</span>
                  {r.by && <span>{r.by}</span>}
                  {r.class && <span>{r.class}</span>}
                  {places && <span>{r.place}</span>}
                </span>
                {r.comment && <span className="small">“{r.comment}”</span>}
                {r.staff_note && (
                  <span className="small muted">
                    <Icon name="lock" size={12} /> Staff note: {r.staff_note}
                  </span>
                )}
              </span>
              {r.mine && (
                <button className="btn sm ghost" onClick={() => remove(r)} aria-label={`Remove ${r.label} from ${day(r.at)}`}>
                  Remove
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {b.records.length > shown.length && (
        <div>
          <button className="linkbtn small" onClick={() => setAll(true)}>
            Show all {b.records.length}
          </button>
        </div>
      )}
      {giving && <GiveBehaviour learners={[{ id: learnerId, name }]} onClose={() => setGiving(false)} />}
    </div>
  );
}

// One learner's attendance: the share of lessons they came to, and the ones they missed or were late for
export function AttendanceCard({ learnerId, name, staff = false }) {
  const q = useQuery(`attendance:${learnerId}`, () => api.learnerAttendance(learnerId));
  const [all, setAll] = useState(false);
  const a = q.data;
  if (!a) return staff ? <div className="card">{q.error ? <div className="error">{q.error.message}</div> : <Loading />}</div> : null;
  if (!a.lessons && !staff) return null;
  const first = (name || '').split(' ')[0];
  const notable = a.records.filter((r) => all || r.status !== 'present');
  const places = new Set(a.records.map((r) => r.place)).size > 1;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Attendance</h2>
        {a.pct != null && <span className={'pill ' + pctTone(a.pct)}>{a.pct}% of lessons</span>}
      </div>
      {a.lessons === 0 ? (
        <div className="small muted">No registers yet. Registers from {first}’s lessons show here, in person and live.</div>
      ) : (
        <>
          <div className="kpi">
            <Stat n={a.present} l="Present" />
            <Stat n={a.late} l="Late" />
            <Stat n={a.absent} l="Absent" />
            <Stat n={a.excused} l="Excused" />
          </div>
          <div className="small muted">The last four months. Late still counts as there; excused lessons don’t count either way.</div>
          {notable.length > 0 && (
            <div className="list">
              {notable.slice(0, all ? 200 : 8).map((r) => (
                <div key={r.id} className="item">
                  <span className={'pill ' + (r.status === 'present' ? 'good' : r.status === 'late' ? 'warn' : r.status === 'absent' ? 'bad' : '')}>{STATUS[r.status]}</span>
                  <span className="grow">
                    <span className="name">{r.label}</span>
                    <span className="meta">
                      <span>{day(r.day + 'T12:00')}</span>
                      {r.status === 'late' && r.minutes_late ? <span>{r.minutes_late} min late</span> : null}
                      {places && <span>{r.place}</span>}
                    </span>
                    {r.note && (
                      <span className="small muted">
                        <Icon name="lock" size={12} /> Staff note: {r.note}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div>
            <button className="linkbtn small" onClick={() => setAll(!all)}>
              {all ? 'Only absences and lates' : 'Show every lesson'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
