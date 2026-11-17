// Office hours (Canvas gaps part 2, 17 Nov 2026): a teacher's weekly times that their own learners book. Each booking is
// a lesson just for that learner (in person or by video), so it shows on both timetables, has reminders and a Join
// button, and either of them can cancel it.
import { useEffect, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Link, Loading, Modal, Page, go, useConfirm, useRoute, useToast } from '../../ui/kit.jsx';
import { invalidate, useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';

const DAYS = ['', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const HOW = { in_person: 'In person', video: 'By video', choice: 'In person or by video (they choose)' };
const whenText = (d) => new Date(d).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const dayText = (d) => new Date(d).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const timeText = (d) => new Date(d).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

// ---------------- teachers: Timetable → Office hours ----------------
export function OfficeHoursTeacher() {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery('office-mine', api.officeHoursMine);
  const [hours, setHours] = useState(null);
  const [busy, setBusy] = useState(false);
  const d = q.data;
  useEffect(() => {
    if (d && hours === null) setHours(d.hours.map(({ id: _id, ...h }) => h));
  }, [d, hours]);
  if (!d || !hours) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  const set = (i, patch) => setHours((hs) => hs.map((h, j) => (j === i ? { ...h, ...patch } : h)));
  async function save() {
    setBusy(true);
    try {
      await api.saveOfficeHours(hours);
      invalidate('office-mine');
      toast(hours.length ? 'Office hours saved. Your learners can book them now.' : 'Office hours taken away');
    } catch (e) {
      toast({ title: 'Couldn’t save them', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function cancel(b) {
    if (!(await confirm({ title: `Cancel ${b.learner}’s time?`, body: `${whenText(b.starts_at)}. They’re told.`, ok: 'Cancel it', cancel: 'Keep it' }))) return;
    try {
      await api.cancelOfficeBooking(b.id);
      invalidate('office-mine', 'sessions');
      toast('Cancelled');
    } catch (e) {
      toast({ title: 'Couldn’t cancel it', body: e.message, tone: 'bad' });
    }
  }
  return (
    <div className="stack lg">
      <section className="card">
        <h2>Your office hours</h2>
        <div className="small muted">Times each week your learners can book a short slot with you. Each booking becomes a lesson just for them, on both your timetables, with reminders. Times on your clock ({d.timezone}).</div>
        {hours.length === 0 && <div className="small">None yet.</div>}
        {hours.map((h, i) => (
          <div key={i} className="row wrap" style={{ gap: 8 }}>
            <select className="select" style={{ width: 'auto' }} value={h.weekday} onChange={(e) => set(i, { weekday: Number(e.target.value) })} aria-label={`Day for office hours ${i + 1}`}>
              {DAYS.slice(1).map((dname, j) => (
                <option key={j + 1} value={j + 1}>
                  {dname}
                </option>
              ))}
            </select>
            <input className="input" type="time" style={{ width: 'auto' }} value={h.starts} onChange={(e) => set(i, { starts: e.target.value })} aria-label={`Starts, office hours ${i + 1}`} />
            <span className="small">to</span>
            <input className="input" type="time" style={{ width: 'auto' }} value={h.ends} onChange={(e) => set(i, { ends: e.target.value })} aria-label={`Ends, office hours ${i + 1}`} />
            <select className="select" style={{ width: 'auto' }} value={h.slot_min} onChange={(e) => set(i, { slot_min: Number(e.target.value) })} aria-label={`Slot length, office hours ${i + 1}`}>
              {[10, 15, 20, 30, 45, 60].map((m) => (
                <option key={m} value={m}>
                  {m}-minute slots
                </option>
              ))}
            </select>
            <select className="select" style={{ width: 'auto' }} value={h.how} onChange={(e) => set(i, { how: e.target.value })} aria-label={`How, office hours ${i + 1}`}>
              {Object.entries(HOW).map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            {h.how !== 'video' && <input className="input" style={{ width: 160 }} value={h.location || ''} maxLength={80} placeholder="Where (e.g. Room 4)" onChange={(e) => set(i, { location: e.target.value })} aria-label={`Where, office hours ${i + 1}`} />}
            <button className="btn ghost icon sm" onClick={() => setHours((hs) => hs.filter((_, j) => j !== i))} aria-label={`Remove office hours ${i + 1}`}>
              <Icon name="trash" size={16} />
            </button>
          </div>
        ))}
        <div className="row wrap" style={{ gap: 8 }}>
          {hours.length < 14 && (
            <button className="btn sm" onClick={() => setHours((hs) => [...hs, { weekday: 1, starts: '15:30', ends: '16:30', slot_min: 15, how: 'choice', location: '' }])}>
              <Icon name="plus" size={16} /> Add a time
            </button>
          )}
          <button className="btn primary sm" disabled={busy} onClick={save}>
            Save office hours
          </button>
        </div>
      </section>
      <section className="card">
        <h2>Booked</h2>
        {d.bookings.length === 0 ? (
          <div className="small muted">Nobody has booked yet.</div>
        ) : (
          <div className="list">
            {d.bookings.map((b) => (
              <div key={b.id} className="item">
                <Icon name={b.how === 'video' ? 'video' : 'users'} size={18} />
                <span className="grow">
                  <span className="name">
                    {b.learner} · {whenText(b.starts_at)}
                  </span>
                  <span className="meta">
                    {b.how === 'video' ? 'By video' : 'In person'}
                    {b.note ? ` · “${b.note}”` : ''}
                  </span>
                </span>
                {b.how === 'video' && b.session_id && (
                  <button className="btn sm" onClick={() => go(`/live/${b.session_id}`)}>
                    Join
                  </button>
                )}
                <button className="btn ghost sm" onClick={() => cancel(b)} aria-label={`Cancel ${b.learner}’s office hours`}>
                  Cancel
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------------- learners: book time with a teacher ----------------
export const useOfficeTeachers = (on = true) => useQuery(on ? 'office-teachers' : null, api.officeTeachers);

// On Today: a way in, once any of their teachers has office hours (and what they've booked)
export function OfficeHoursCard() {
  const d = useOfficeTeachers().data;
  if (!d || (!d.teachers.length && !d.bookings.length)) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h2>Time with a teacher</h2>
        <Link to="/office-hours" className="small">
          Book a time
        </Link>
      </div>
      {d.bookings.length ? (
        <div className="list small">
          {d.bookings.map((b) => (
            <div key={b.id} className="item">
              <Icon name={b.how === 'video' ? 'video' : 'users'} size={16} />
              <span className="grow">
                {b.teacher} · {whenText(b.starts_at)} · {b.how === 'video' ? 'by video' : 'in person'}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div className="small muted">{d.teachers.map((t) => t.name).join(', ')} {d.teachers.length === 1 ? 'has' : 'have'} office hours you can book.</div>
      )}
    </div>
  );
}

export function OfficeHoursLearner() {
  const toast = useToast();
  const confirm = useConfirm();
  const route = useRoute();
  const d = useOfficeTeachers().data;
  const [teacher, setTeacher] = useState(route.query.get('teacher') || '');
  const [booking, setBooking] = useState(null); // a slot
  const chosen = teacher || d?.teachers[0]?.id || '';
  const slots = useQuery(chosen ? `office-slots:${chosen}` : null, () => api.officeSlots(chosen));
  async function cancel(b) {
    if (!(await confirm({ title: 'Cancel this time?', body: `${b.teacher}, ${whenText(b.starts_at)}. They’re told.`, ok: 'Cancel it', cancel: 'Keep it' }))) return;
    try {
      await api.cancelOfficeBooking(b.id);
      invalidate('office-teachers', `office-slots:${b.teacher_id}`, 'sessions');
      toast('Cancelled');
    } catch (e) {
      toast({ title: 'Couldn’t cancel it', body: e.message, tone: 'bad' });
    }
  }
  if (!d) return <Page title="Office hours"><Loading /></Page>;
  const byDay = {};
  for (const s of slots.data || []) (byDay[dayText(s.starts_at)] ||= []).push(s);
  return (
    <Page title="Office hours" subtitle="Book a short time with one of your teachers, in person or by video. It goes on your timetable with a reminder.">
      {d.bookings.length > 0 && (
        <section className="card">
          <h2>Your times</h2>
          <div className="list">
            {d.bookings.map((b) => (
              <div key={b.id} className="item">
                <Icon name={b.how === 'video' ? 'video' : 'users'} size={18} />
                <span className="grow">
                  <span className="name">
                    {b.teacher} · {whenText(b.starts_at)}
                  </span>
                  <span className="meta">{b.how === 'video' ? 'By video: Join from Live when it’s time' : 'In person'}</span>
                </span>
                <button className="btn ghost sm" onClick={() => cancel(b)} aria-label={`Cancel your time with ${b.teacher}`}>
                  Cancel
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
      {d.teachers.length === 0 ? (
        <Empty>None of your teachers has office hours yet.</Empty>
      ) : (
        <section className="card">
          <div className="row between wrap">
            <h2>Free times</h2>
            {d.teachers.length > 1 && (
              <select className="select" style={{ width: 'auto' }} value={chosen} onChange={(e) => setTeacher(e.target.value)} aria-label="Teacher">
                {d.teachers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          {!slots.data ? (
            slots.error ? <div className="error">{slots.error.message}</div> : <Loading />
          ) : slots.data.length === 0 ? (
            <div className="small muted">No free times in the next two weeks.</div>
          ) : (
            Object.entries(byDay).map(([dname, list]) => (
              <div key={dname} className="stack sm">
                <div className="tiny strong muted">{dname}</div>
                <div className="row wrap" style={{ gap: 6 }}>
                  {list.map((s) => (
                    <button key={s.starts_at} className="btn sm" onClick={() => setBooking(s)} aria-label={`Book ${dname} at ${timeText(s.starts_at)}`}>
                      {timeText(s.starts_at)}
                    </button>
                  ))}
                </div>
              </div>
            ))
          )}
        </section>
      )}
      {booking && <BookSlot teacher={d.teachers.find((t) => t.id === chosen)} slot={booking} onClose={() => setBooking(null)} />}
    </Page>
  );
}
function BookSlot({ teacher, slot, onClose }) {
  const toast = useToast();
  const [how, setHow] = useState(slot.how === 'in_person' ? 'in_person' : 'video');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function book(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.bookOfficeHour(teacher.id, slot.starts_at, how, note.trim());
      invalidate('office-teachers', `office-slots:${teacher.id}`, 'sessions');
      toast({ title: 'Booked', body: `${teacher.name}, ${whenText(slot.starts_at)}. It’s on your timetable.` });
      onClose();
    } catch (x) {
      toast({ title: 'Couldn’t book it', body: x.message, tone: 'bad' });
      invalidate(`office-slots:${teacher.id}`);
      setBusy(false);
    }
  }
  return (
    <Modal title={`Book ${teacher?.name || 'your teacher'}`} onClose={onClose}>
      <form className="stack" onSubmit={book}>
        <div className="strong">{whenText(slot.starts_at)}</div>
        {slot.how === 'choice' ? (
          <Field label="How">
            <select className="select" value={how} onChange={(e) => setHow(e.target.value)}>
              <option value="video">By video</option>
              <option value="in_person">In person{slot.location ? ` (${slot.location})` : ''}</option>
            </select>
          </Field>
        ) : (
          <div className="small">{slot.how === 'video' ? 'By video' : `In person${slot.location ? `: ${slot.location}` : ''}`}</div>
        )}
        <Field label="What would you like help with? (optional)">
          <input className="input" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Question 3 of the homework" />
        </Field>
        <div className="foot row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            Book it
          </button>
        </div>
      </form>
    </Modal>
  );
}
