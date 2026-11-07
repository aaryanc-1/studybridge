// Parents' meetings (6 Nov 2026). A centre's or school's office and managers set up an evening (a tutor on their own
// sets up theirs; any teacher can offer times to their own classes or learners); each teacher keeps their own times
// (a break, a later start, "running 10 minutes late"); parents book a time with each of their child's teachers, in
// person or by video, change or cancel it; the teacher notes how it went (only for themselves).
import { useMemo, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Link, Loading, Modal, Page, Seg, go, useConfirm, useRoute, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { day, myTimezone, placeOf, time, timeIn, when, ymd } from '../../lib/format.js';
import { yearName } from '../../lib/office.js';
import { YearPicker } from './Office.jsx';
import { useLookups } from './lookups.jsx';

export const HOW = { in_person: 'In person', video: 'By video', choice: 'In person or by video (the family chooses)' };
const STATUS = { draft: ['Not open yet', ''], open: ['Open for booking', 'good'], closed: ['Booking closed', 'warn'], cancelled: ['Cancelled', 'bad'] };
const first = (name) => String(name || '').split(' ')[0];
const refresh = () => invalidate('meetings', 'meeting', 'my-meetings', 'meeting-slots', 'timetable');
const addDays = (d, n) => {
  const x = new Date(d + 'T12:00');
  x.setDate(x.getDate() + n);
  return ymd(x);
};
// "Thu 13 Nov, 16:20" in this device's time, and the place's when it's on another clock
function bothTimes(at, tz) {
  const mine = when(at);
  return tz && tz !== myTimezone() ? `${mine} your time (${timeIn(at, tz)} in ${placeOf(tz)})` : mine;
}
const span = (a, b) => `${day(a)}, ${time(a)}–${time(b)}`;
const canJoin = (b) => b.how === 'video' && b.status === 'booked' && Date.now() > new Date(b.starts_at).getTime() - 15 * 60000 && Date.now() < new Date(b.ends_at).getTime() + 30 * 60000;

// ---------------- staff ----------------
// Timetable → Meetings (and Office → Meetings): every set of meetings this teacher is in or looks after
export function MeetingsList() {
  const q = useQuery('meetings', api.meetingList);
  const org = useQuery('org', api.myOrg).data;
  const [setting, setSetting] = useState(false);
  const list = q.data;
  const full = !!org && (org.kind === 'tutor' || org.role === 'manager' || org.role === 'office');
  const coming = (list || []).filter((e) => e.status !== 'cancelled' && (!e.ends_at || new Date(e.ends_at) > new Date()));
  const past = (list || []).filter((e) => !coming.includes(e));
  return (
    <>
      <div className="row between wrap" style={{ gap: 8 }}>
        <span className="small muted">
          {full ? 'Set up a parents’ evening: families book a time with each of their child’s teachers, in person or by video.' : 'Your parents’ meetings, and times you offer families yourself.'}
        </span>
        <button className="btn primary" onClick={() => setSetting(true)}>
          <Icon name="plus" size={16} /> {full ? 'Set up meetings' : 'Offer meeting times'}
        </button>
      </div>
      {!list ? (
        q.error ? <div className="error">{q.error.message}</div> : <Loading />
      ) : list.length === 0 ? (
        <Empty title="No parents’ meetings yet">{full ? 'Set some up, open them for booking, and families are told.' : 'When your school sets up meetings you’re in, they show here.'}</Empty>
      ) : (
        <>
          {coming.length > 0 && <MeetingRows title="Coming up" list={coming} />}
          {past.length > 0 && <MeetingRows title="Past and cancelled" list={past} />}
        </>
      )}
      {setting && <MeetingSetup full={full} onClose={() => setSetting(false)} />}
    </>
  );
}

function MeetingRows({ title, list }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <div className="list">
        {list.map((e) => (
          <button key={e.id} className="item click" onClick={() => go(`/meetings/${e.id}`)}>
            <Icon name={e.how === 'video' ? 'video' : 'users'} style={{ color: 'var(--accent)' }} />
            <span className="grow">
              <span className="name">{e.title}</span>
              <span className="meta">
                {e.starts_at && <span>{span(e.starts_at, e.ends_at)}</span>}
                <span>
                  {e.teachers} teacher{e.teachers === 1 ? '' : 's'} · {e.booked} booked
                </span>
                {e.me_in && <span>{e.mine} with you</span>}
              </span>
            </span>
            <span className={'pill ' + STATUS[e.status][1]}>{STATUS[e.status][0]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

// Home: "Parents' meetings today", for a teacher with times today
export function MeetingsToday() {
  const list = useQuery('meetings', api.meetingList).data || [];
  const today = list.filter((e) => e.status !== 'cancelled' && e.today?.length);
  if (!today.length) return null;
  return (
    <div className="card">
      <h2>
        <Icon name="users" size={18} /> Parents’ meetings today
      </h2>
      <div className="list">
        {today.map((e) =>
          e.today.map((b) => (
            <Link key={b.id} to={`/meetings/${e.id}`} className="item click">
              <span className="grow">
                <span className="name">{e.title}</span>
                <span className="meta">
                  <span>
                    {time(b.starts_at)}–{time(b.ends_at)}
                    {b.room ? ` · ${b.room}` : ''}
                  </span>
                  <span>
                    {b.booked} booked{b.next ? `, next at ${time(b.next)}` : ''}
                  </span>
                </span>
              </span>
              <Icon name="right" size={16} />
            </Link>
          )),
        )}
      </div>
    </div>
  );
}

// Set up meetings (or change their details)
function MeetingSetup({ full, initial = null, onClose }) {
  const toast = useToast();
  const lk = useLookups();
  const editing = !!initial;
  const aud = initial?.audience || {};
  const [f, setF] = useState(() => ({
    title: initial?.title || '',
    note: initial?.note || '',
    how: initial?.how || 'in_person',
    location: initial?.location || '',
    slot_min: initial?.slot_min || 10,
    gap_min: initial?.gap_min || 0,
    closes: initial?.closes_day || '',
  }));
  const [who, setWho] = useState(() => (aud.years?.length ? 'years' : aud.class_ids?.length ? 'classes' : aud.learner_ids?.length ? 'learners' : full ? 'all' : 'classes'));
  const [years, setYears] = useState(aud.years || []);
  const [classes, setClasses] = useState(aud.class_ids || []);
  const [learners, setLearners] = useState(aud.learner_ids || []);
  const tomorrow = addDays(ymd(new Date()), 7);
  const [days, setDays] = useState([{ day: tomorrow, from: '16:00', to: '18:00' }]);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const myClasses = lk.activeClasses || [];
  async function save() {
    setBusy(true);
    try {
      const audience = who === 'years' ? { years } : who === 'classes' ? { class_ids: classes } : who === 'learners' ? { learner_ids: learners } : {};
      const ev = { ...f, slot_min: Number(f.slot_min), gap_min: Number(f.gap_min), audience, ...(editing ? {} : { days }) };
      const id = await api.saveMeetingEvent(initial?.id || null, ev);
      refresh();
      onClose();
      if (!editing) go(`/meetings/${id}`);
      toast(editing ? 'Saved' : 'Set up. Check the times, then open them for booking.');
    } catch (x) {
      toast({ title: 'Couldn’t save', body: x.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={editing ? 'Change the details' : full ? 'Set up parents’ meetings' : 'Offer meeting times'}
      wide
      onClose={onClose}
      foot={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || !f.title.trim() || (!editing && !days.length) || (who === 'years' && !years.length) || (who === 'classes' && !classes.length) || (who === 'learners' && !learners.length)}
            onClick={save}
          >
            {editing ? 'Save' : 'Set up'}
          </button>
        </>
      }
    >
      <Field label="Name">
        <input className="input" value={f.title} onChange={set('title')} maxLength={120} placeholder="Year 10 parents’ evening" />
      </Field>
      <Field label="A note for families" hint="Optional. Families see it when they book.">
        <textarea className="textarea" rows={2} value={f.note} onChange={set('note')} maxLength={2000} />
      </Field>
      <Seg
        label="How"
        value={f.how}
        onChange={(how) => setF((x) => ({ ...x, how }))}
        options={[
          { value: 'in_person', label: 'In person' },
          { value: 'video', label: 'By video' },
          { value: 'choice', label: 'The family chooses' },
        ]}
      />
      {f.how !== 'video' && (
        <Field label="Where" hint="For meetings in person. Each teacher can add their own room or table.">
          <input className="input" value={f.location} onChange={set('location')} maxLength={120} placeholder="The main hall" />
        </Field>
      )}
      <div className="grid2">
        <Field label="Each meeting">
          <select className="input" value={f.slot_min} onChange={set('slot_min')} disabled={editing && initial.booked_any}>
            {[5, 10, 15, 20, 30].map((n) => (
              <option key={n} value={n}>
                {n} minutes
              </option>
            ))}
          </select>
        </Field>
        <Field label="Time between">
          <select className="input" value={f.gap_min} onChange={set('gap_min')} disabled={editing && initial.booked_any}>
            {[0, 5, 10].map((n) => (
              <option key={n} value={n}>
                {n ? `${n} minutes` : 'None'}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Who it’s for">
        <Seg
          label="Who it’s for"
          value={who}
          onChange={setWho}
          options={[...(full ? [{ value: 'all', label: 'Everyone' }, { value: 'years', label: 'Years' }] : []), { value: 'classes', label: 'Classes' }, { value: 'learners', label: 'Learners' }]}
        />
      </Field>
      {who === 'years' && <YearPicker value={years} onChange={setYears} />}
      {who === 'classes' && (
        <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Classes">
          {myClasses.length === 0 && <span className="small muted">No classes yet.</span>}
          {myClasses.map((c) => (
            <button key={c.id} type="button" className="chip" aria-pressed={classes.includes(c.id)} onClick={() => setClasses((x) => (x.includes(c.id) ? x.filter((y) => y !== c.id) : [...x, c.id]))}>
              {c.name}
            </button>
          ))}
        </div>
      )}
      {who === 'learners' && (
        <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Learners">
          {(lk.learners || []).map((l) => (
            <button key={l.id} type="button" className="chip" aria-pressed={learners.includes(l.id)} onClick={() => setLearners((x) => (x.includes(l.id) ? x.filter((y) => y !== l.id) : [...x, l.id]))}>
              {l.display_name}
            </button>
          ))}
        </div>
      )}
      {who === 'years' && years.length > 0 && <div className="tiny muted">For {years.map(yearName).join(', ')}.</div>}
      <Field label="Booking closes" hint="Optional: families can book until the end of this day (otherwise until the meetings start).">
        <input type="date" className="input" value={f.closes} onChange={set('closes')} />
      </Field>
      {!editing && (
        <div className="stack xs">
          <div className="strong small">When</div>
          <div className="tiny muted">{full ? 'Every teacher who teaches someone it’s for takes part. Each can change their own times afterwards.' : 'Your times. You can change them afterwards.'}</div>
          <DaysEditor days={days} onChange={setDays} />
        </div>
      )}
    </Modal>
  );
}

// Days with a start and end (and, for a teacher's own times, a room)
function DaysEditor({ days, onChange, rooms = false }) {
  const setAt = (i, k, v) => onChange(days.map((d, j) => (j === i ? { ...d, [k]: v } : d)));
  return (
    <div className="stack xs">
      {days.map((d, i) => (
        <div key={i} className="row wrap meet-day" style={{ gap: 6, alignItems: 'flex-end' }}>
          <Field label="Day">
            <input type="date" className="input" value={d.day} onChange={(e) => setAt(i, 'day', e.target.value)} />
          </Field>
          <Field label="From">
            <input type="time" className="input" value={d.from} onChange={(e) => setAt(i, 'from', e.target.value)} />
          </Field>
          <Field label="To">
            <input type="time" className="input" value={d.to} onChange={(e) => setAt(i, 'to', e.target.value)} />
          </Field>
          {rooms && (
            <Field label="Room or table">
              <input className="input" value={d.room || ''} maxLength={60} onChange={(e) => setAt(i, 'room', e.target.value)} />
            </Field>
          )}
          <button type="button" className="btn ghost sm" onClick={() => onChange(days.filter((_, j) => j !== i))} aria-label="Take this time away">
            <Icon name="trash" size={16} />
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn sm" onClick={() => onChange([...days, { ...(days.at(-1) || { day: ymd(new Date()), from: '16:00', to: '18:00' }) }])}>
          <Icon name="plus" size={14} /> Add {days.length ? 'another time' : 'a time'}
        </button>
      </div>
    </div>
  );
}

// One set of meetings for its staff: open it, each teacher's times and who booked, my notes, book for a family
export function MeetingPage({ id }) {
  const app = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery(`meeting:${id}`, () => api.meetingEvent(id), { poll: 60000 });
  const org = useQuery('org', api.myOrg).data;
  // whole-school choices only for those who run the place's meetings; the office's list is under Office
  const full = !!org && (org.kind === 'tutor' || org.role === 'manager' || org.role === 'office');
  const back = org?.role === 'office' ? '/office/meetings' : '/timetable/meetings';
  const [editing, setEditing] = useState(false);
  const [times, setTimes] = useState(null); // a teacher whose times are being changed
  const [booking, setBooking] = useState(false);
  const [adding, setAdding] = useState(false);
  const [cancelling, setCancelling] = useState(null); // 'all' or a booking
  const [noting, setNoting] = useState(null);
  const [showFamilies, setShowFamilies] = useState(false);
  const e = q.data;
  if (!e)
    return (
      <Page title="Parents’ meetings" eyebrow={<Link to={back}><Icon name="left" size={14} /> Meetings</Link>}>
        {q.error ? <div className="error">{q.error.message}</div> : <Loading />}
      </Page>
    );
  const otherClock = e.tz && e.tz !== myTimezone();
  async function status(s, reason = null) {
    try {
      await api.meetingStatus(e.id, s, reason);
      refresh();
      toast(s === 'open' ? 'Open for booking. Families are told.' : s === 'closed' ? 'Booking closed' : s === 'cancelled' ? 'Cancelled. Families with a time are told.' : 'Back to not open yet');
    } catch (x) {
      toast({ title: 'Couldn’t do that', body: x.message, tone: 'bad' });
    }
  }
  return (
    <Page
      eyebrow={
        <Link to={back}>
          <Icon name="left" size={14} /> Meetings
        </Link>
      }
      title={e.title}
      subtitle={`${e.place} · ${HOW[e.how]}${e.location && e.how !== 'video' ? ` · ${e.location}` : ''} · ${e.slot_min} minutes each${e.audience_text ? ` · for ${e.audience_text}` : ''}`}
      actions={
        <span className="row wrap no-print" style={{ gap: 6 }}>
          <span className={'pill ' + STATUS[e.status][1]}>{STATUS[e.status][0]}</span>
          <button className="btn" onClick={() => window.print()}>
            <Icon name="download" size={16} /> Print
          </button>
        </span>
      }
    >
      {otherClock && <div className="note small">Times show in your time. {e.place} is on {placeOf(e.tz)} time.</div>}
      {e.note && <div className="card small">{e.note}</div>}
      {e.can_manage && e.status !== 'cancelled' && (
        <div className="card no-print">
          <div className="row wrap" style={{ gap: 8 }}>
          {e.status !== 'open' && (
            <button className="btn primary" onClick={() => status('open')}>
              Open for booking
            </button>
          )}
          {e.status === 'open' && (
            <button className="btn" onClick={() => status('closed')}>
              Close booking
            </button>
          )}
          <button className="btn" onClick={() => setEditing(true)}>
            <Icon name="pen" size={14} /> Change the details
          </button>
          <button className="btn" onClick={() => setAdding(true)}>
            <Icon name="plus" size={14} /> Add a teacher
          </button>
          {['open', 'closed'].includes(e.status) && (
            <button className="btn" onClick={() => setBooking(true)}>
              Book for a family
            </button>
          )}
          {e.status === 'draft' && !e.booked_any ? (
            <button
              className="btn ghost"
              onClick={async () => {
                if (!(await confirm({ title: 'Delete these meetings?', body: 'Nobody has booked, so nothing else changes.', ok: 'Delete', danger: true }))) return;
                try {
                  await api.deleteMeetingEvent(e.id);
                  refresh();
                  go(back, { replace: true });
                } catch (x) {
                  toast({ title: 'Couldn’t delete them', body: x.message, tone: 'bad' });
                }
              }}
            >
              Delete
            </button>
          ) : (
            <button className="btn ghost" onClick={() => setCancelling('all')}>
              Cancel these meetings…
            </button>
          )}
          {e.closes_at && <span className="small muted">Booking closes {when(new Date(e.closes_at).getTime() - 60000)}</span>}
          </div>
        </div>
      )}
      {e.families && (
        <div className="card">
          <div className="card-head">
            <h2>Families</h2>
            <span className="small muted">
              {e.families.booked} of {e.families.learners} booked · {e.families.with_parents} with a parent on StudyBridge
            </span>
          </div>
          {e.families.not_booked.length > 0 && (
            <>
              <button className="btn sm ghost no-print" onClick={() => setShowFamilies((x) => !x)} aria-expanded={showFamilies}>
                {showFamilies ? 'Hide' : 'Show'} who hasn’t booked ({e.families.not_booked.length})
              </button>
              {showFamilies && (
                <div className="list">
                  {e.families.not_booked.map((l) => (
                    <div key={l.id} className="item">
                      <span className="grow">
                        <span className="name">{l.name}</span>
                        <span className="meta">
                          {l.grade != null && <span>{yearName(l.grade)}</span>}
                          <span>{l.parents ? `${l.parents} parent${l.parents === 1 ? '' : 's'} on StudyBridge` : 'No parent on StudyBridge yet: call or give them a code'}</span>
                        </span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
      {e.teachers.length === 0 && <Empty title="No teachers yet">Add a teacher to give families times to book.</Empty>}
      {e.teachers.map((t) => (
        <div key={t.id} className="card meet-teacher">
          <div className="card-head">
            <h2>{t.me ? 'Your times' : t.name}</h2>
            {(t.me || e.can_manage) && e.status !== 'cancelled' && (
              <button className="btn sm no-print" onClick={() => setTimes(t)}>
                <Icon name="clock" size={14} /> {t.me ? 'Change my times' : 'Change their times'}
              </button>
            )}
          </div>
          {t.blocks.length === 0 && <div className="small muted">No times.</div>}
          {t.blocks.map((b) => {
            const inBlock = t.bookings.filter((x) => new Date(x.starts_at) >= new Date(b.starts_at) && new Date(x.ends_at) <= new Date(b.ends_at));
            return (
              <div key={b.id} className="stack xs meet-block">
                <div className="row wrap between" style={{ gap: 6 }}>
                  <span className="strong">
                    {span(b.starts_at, b.ends_at)}
                    {b.room ? ` · ${b.room}` : ''}
                  </span>
                  {(t.me || e.can_manage) && new Date(b.ends_at) > new Date() && e.status !== 'cancelled' && (
                    <label className="small row no-print" style={{ gap: 6 }}>
                      Running late
                      <select
                        className="input sm"
                        value={b.late_min}
                        onChange={async (ev) => {
                          try {
                            await api.meetingLate(b.id, Number(ev.target.value));
                            refresh();
                          } catch (x) {
                            toast({ title: 'Couldn’t change it', body: x.message, tone: 'bad' });
                          }
                        }}
                      >
                        {[0, 5, 10, 15, 20, 30].map((n) => (
                          <option key={n} value={n}>
                            {n ? `about ${n} minutes` : 'No'}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
                {inBlock.length === 0 ? (
                  <div className="small muted">Nobody booked yet.</div>
                ) : (
                  <div className="list">
                    {inBlock.map((x) => (
                      <div key={x.id} className="item meet-booking">
                        <span className="meet-time">{time(x.starts_at)}</span>
                        <span className="grow">
                          <span className="name">
                            {x.learner.name} <span className="muted">· {x.parent.name}</span>
                          </span>
                          <span className="meta">
                            <span>{x.how === 'video' ? 'By video' : 'In person'}</span>
                            {x.by_staff && <span>Booked for them</span>}
                            {x.status === 'met' && <span className="pill good">Met</span>}
                            {x.status === 'missed' && <span className="pill warn">Didn’t come</span>}
                          </span>
                          {x.parent_note && <span className="small">“{x.parent_note}”</span>}
                          {x.staff_note && <span className="small muted">Your note: {x.staff_note}</span>}
                        </span>
                        <span className="row wrap no-print" style={{ gap: 4, justifyContent: 'flex-end' }}>
                          {t.me && canJoin(x) && (
                            <button className="btn sm primary" onClick={() => go(`/live/meeting/${x.id}`)}>
                              Join
                            </button>
                          )}
                          {t.me && (
                            <button className="btn sm" onClick={() => setNoting(x)}>
                              Notes
                            </button>
                          )}
                          {(t.me || e.can_manage) && x.status === 'booked' && new Date(x.starts_at) > new Date() && (
                            <button className="btn sm ghost" onClick={() => setCancelling(x)}>
                              Cancel…
                            </button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {editing && <MeetingSetup full={full} initial={e} onClose={() => setEditing(false)} />}
      {times && <TeacherTimes e={e} t={times} onClose={() => setTimes(null)} />}
      {adding && <AddTeacher e={e} onClose={() => setAdding(false)} />}
      {booking && <BookForFamily e={e} onClose={() => setBooking(false)} />}
      {noting && <MeetingNotes b={noting} onClose={() => setNoting(null)} />}
      {cancelling && (
        <CancelWithReason
          title={cancelling === 'all' ? 'Cancel these meetings?' : `Cancel ${first(cancelling.learner.name)}’s meeting?`}
          body={cancelling === 'all' ? 'Every family with a time still to come is told, with your reason.' : `${cancelling.parent.name} is told, with your reason, and can book another time.`}
          onClose={() => setCancelling(null)}
          onCancel={async (reason) => {
            if (cancelling === 'all') await status('cancelled', reason);
            else {
              await api.cancelMeeting(cancelling.id, reason);
              refresh();
              toast('Cancelled. They’re told.');
            }
          }}
        />
      )}
      {app.me.role === 'tutor' && <div className="tiny muted no-print">What families write when they book, and your notes, are only for you.</div>}
    </Page>
  );
}

function CancelWithReason({ title, body, onClose, onCancel }) {
  const toast = useToast();
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      foot={
        <>
          <button className="btn ghost" onClick={onClose}>
            Keep it
          </button>
          <button
            className="btn danger solid"
            disabled={busy || !why.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                await onCancel(why.trim());
                onClose();
              } catch (x) {
                toast({ title: 'Couldn’t cancel', body: x.message, tone: 'bad' });
              } finally {
                setBusy(false);
              }
            }}
          >
            Cancel and tell them
          </button>
        </>
      }
    >
      <div className="small muted">{body}</div>
      <Field label="Why">
        <textarea className="textarea" rows={2} maxLength={300} value={why} onChange={(e) => setWhy(e.target.value)} />
      </Field>
    </Modal>
  );
}

// A teacher's times: days with a start and end and a room. Taking away booked times asks why, and tells those families.
function TeacherTimes({ e, t, onClose }) {
  const toast = useToast();
  const [days, setDays] = useState(() => t.blocks.filter((b) => new Date(b.ends_at) > new Date()).map((b) => ({ day: b.day, from: b.from, to: b.to, room: b.room || '' })));
  const [reason, setReason] = useState('');
  const [asking, setAsking] = useState('');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api.saveMeetingTimes(e.id, t.id, days, reason.trim() || null);
      refresh();
      toast(days.length ? 'Times saved' : `${t.me ? 'You’re' : `${t.name} is`} out of these meetings`);
      onClose();
    } catch (x) {
      if (/taking away/.test(x.message)) setAsking(x.message);
      else toast({ title: 'Couldn’t save', body: x.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={t.me ? 'Your times' : `${t.name}’s times`}
      wide
      onClose={onClose}
      foot={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || (asking && !reason.trim())} onClick={save}>
            {asking ? 'Save and tell them' : 'Save'}
          </button>
        </>
      }
    >
      <div className="small muted">
        In {e.place}’s time{e.tz && e.tz !== myTimezone() ? ` (${placeOf(e.tz)})` : ''}. Split a day in two for a break; take every time away to leave these meetings.
      </div>
      <DaysEditor days={days} onChange={setDays} rooms />
      {asking && (
        <>
          <div className="note small">{asking}</div>
          <Field label="Why (the families are told)">
            <textarea className="textarea" rows={2} maxLength={300} value={reason} onChange={(ev) => setReason(ev.target.value)} />
          </Field>
        </>
      )}
    </Modal>
  );
}

function AddTeacher({ e, onClose }) {
  const toast = useToast();
  const [pick, setPick] = useState('');
  const days = useMemo(() => {
    const seen = new Map();
    for (const t of e.teachers) for (const b of t.blocks) if (new Date(b.ends_at) > new Date()) seen.set(`${b.day} ${b.from} ${b.to}`, { day: b.day, from: b.from, to: b.to });
    return [...seen.values()];
  }, [e]);
  const [list, setList] = useState(days.length ? days : [{ day: addDays(ymd(new Date()), 7), from: '16:00', to: '18:00' }]);
  return (
    <Modal
      title="Add a teacher"
      wide
      onClose={onClose}
      foot={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={!pick || !list.length}
            onClick={async () => {
              try {
                await api.meetingAdd(e.id, [pick], list);
                refresh();
                toast('Added');
                onClose();
              } catch (x) {
                toast({ title: 'Couldn’t add them', body: x.message, tone: 'bad' });
              }
            }}
          >
            Add
          </button>
        </>
      }
    >
      <Field label="Teacher">
        <select className="input" value={pick} onChange={(ev) => setPick(ev.target.value)}>
          <option value="">Choose a teacher</option>
          {(e.pool || []).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </Field>
      <DaysEditor days={list} onChange={setList} />
    </Modal>
  );
}

// The office (or a teacher) books for a family that phoned
function BookForFamily({ e, onClose }) {
  const toast = useToast();
  const lk = useLookups();
  const [learner, setLearner] = useState('');
  const pool = useMemo(() => {
    const all = [...(e.families?.not_booked || []).map((l) => ({ id: l.id, name: l.name })), ...(lk.learners || []).map((l) => ({ id: l.id, name: l.display_name }))];
    return [...new Map(all.map((x) => [x.id, x])).values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [e, lk.learners]);
  return (
    <Modal title="Book for a family" wide onClose={onClose}>
      <Field label="Learner">
        <select className="input" value={learner} onChange={(ev) => setLearner(ev.target.value)}>
          <option value="">Choose a learner</option>
          {pool.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>
      {learner && (
        <SlotPicker
          eventId={e.id}
          learnerId={learner}
          staff
          onBooked={() => {
            toast('Booked. The family is told.');
            onClose();
          }}
        />
      )}
    </Modal>
  );
}

function MeetingNotes({ b, onClose }) {
  const toast = useToast();
  const [note, setNote] = useState(b.staff_note || '');
  const started = new Date(b.starts_at) <= new Date();
  async function save(status) {
    try {
      await api.meetingNote(b.id, status, note);
      refresh();
      toast('Saved');
      onClose();
    } catch (x) {
      toast({ title: 'Couldn’t save', body: x.message, tone: 'bad' });
    }
  }
  return (
    <Modal
      title={`${b.learner.name}’s meeting`}
      onClose={onClose}
      foot={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          {started ? (
            <>
              <button className="btn" onClick={() => save('missed')}>
                They didn’t come
              </button>
              <button className="btn primary" onClick={() => save('met')}>
                We met
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={() => save('booked')}>
              Save
            </button>
          )}
        </>
      }
    >
      <div className="small muted">
        {span(b.starts_at, b.ends_at)} with {b.parent.name}.{b.parent_note ? ` They wrote: “${b.parent_note}”` : ''}
      </div>
      <Field label="Your notes" hint="Only you see these. Families never do.">
        <textarea className="textarea" rows={4} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </Modal>
  );
}

// ---------------- booking (parents, and staff for a family) ----------------
// Each of the child's teachers in these meetings, with the times still free; one tap books (or moves) a time
export function SlotPicker({ eventId, learnerId, staff = false, onBooked }) {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery(`meeting-slots:${eventId}:${learnerId}`, () => api.meetingSlots(eventId, learnerId));
  const [how, setHow] = useState('in_person');
  const [note, setNote] = useState('');
  const [parent, setParent] = useState('');
  const [busy, setBusy] = useState(false);
  const d = q.data;
  if (!d) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  const ev = d.event;
  const parentId = staff ? parent || d.parents?.[0]?.id || '' : null;
  async function book(t, at) {
    if (t.booking && !(await confirm({ title: `Move your time with ${t.name}?`, body: `From ${time(t.booking.starts_at)} to ${time(at)}.`, ok: 'Move it', cancel: 'Keep it' }))) return;
    setBusy(true);
    try {
      await api.bookMeeting(ev.id, t.id, learnerId, at, ev.how === 'choice' ? how : null, note.trim() || null, staff ? parentId : null);
      refresh();
      onBooked?.(t, at);
    } catch (x) {
      toast({ title: 'Couldn’t book it', body: x.message, tone: 'bad' });
      refresh();
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack sm">
      {staff && (
        <Field label="Parent">
          {d.parents?.length ? (
            <select className="input" value={parentId} onChange={(e) => setParent(e.target.value)}>
              {d.parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <div className="note small">No parent of theirs is on StudyBridge yet, so there’s nobody to book for. Give them a parent code first.</div>
          )}
        </Field>
      )}
      {ev.how === 'choice' && (
        <Seg
          label="How"
          value={how}
          onChange={setHow}
          options={[
            { value: 'in_person', label: 'In person' },
            { value: 'video', label: 'By video' },
          ]}
        />
      )}
      {!staff && (
        <Field label="Anything you’d like to talk about?" hint="Optional. Only the teacher sees it.">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
      )}
      {d.mine?.length > 0 && (
        <div className="tiny muted">
          Your times: {d.mine.map((m) => `${time(m.starts_at)} ${m.teacher} (${m.child})`).join(' · ')}. Times that clash are left out for you.
        </div>
      )}
      {d.teachers.length === 0 && <div className="note small">None of {first(d.learner.name)}’s teachers are in these meetings.</div>}
      {d.teachers.map((t) => {
        const clash = (at) =>
          (d.mine || []).some((m) => {
            const a = new Date(at).getTime();
            return a < new Date(m.ends_at).getTime() && a + ev.slot_min * 60000 > new Date(m.starts_at).getTime() && !(t.booking && t.booking.starts_at === m.starts_at);
          });
        const free = t.blocks.flatMap((b) => b.slots.filter((s) => s.free && !clash(s.at)).map((s) => ({ ...s, room: b.room, late: b.late_min })));
        return (
          <div key={t.id} className="meet-pick">
            <div className="row between wrap" style={{ gap: 6 }}>
              <span>
                <span className="strong">{t.name}</span>
                {t.classes.length > 0 && <span className="tiny muted"> · {t.classes.join(', ')}</span>}
              </span>
              {t.booking && (
                <span className="pill good">
                  {staff ? 'Booked' : 'Your time'}: {time(t.booking.starts_at)}
                </span>
              )}
            </div>
            {free.length === 0 ? (
              <div className="small muted">{t.booking ? 'No other times free.' : 'No times left. Write to them instead.'}</div>
            ) : (
              <div className="slot-grid" role="group" aria-label={`Times with ${t.name}`}>
                {free.map((s) => (
                  <button key={s.at} type="button" className="chip" disabled={busy || (staff && !parentId)} onClick={() => book(t, s.at)} aria-label={`Book ${time(s.at)} with ${t.name}`}>
                    {time(s.at)}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
      {ev.tz && ev.tz !== myTimezone() && <div className="tiny muted">Times are in your time. {ev.place} is on {placeOf(ev.tz)} time.</div>}
    </div>
  );
}

// A parent's booking page: /meetings/<event>?child=<id>
export function BookMeetings({ eventId }) {
  const route = useRoute();
  const toast = useToast();
  const kids = useQuery('parent-children', api.parentChildren).data || [];
  const child = route.query.get('child') || kids[0]?.id;
  const mine = useQuery(child ? `my-meetings:${child}` : null, () => api.myMeetings(child)).data;
  const ev = mine?.events.find((x) => x.id === eventId);
  const name = kids.find((k) => k.id === child)?.name || '';
  return (
    <Page
      eyebrow={
        <Link to={`/coming${child ? `?child=${child}` : ''}`}>
          <Icon name="left" size={14} /> Coming up
        </Link>
      }
      title={ev?.title || 'Book a meeting'}
      subtitle={ev ? `${ev.place} · ${HOW[ev.how]}${ev.location && ev.how !== 'video' ? ` · ${ev.location}` : ''}${ev.closes_at ? ` · book by ${day(new Date(ev.closes_at).getTime() - 60000)}` : ''}` : ''}
    >
      {ev?.note && <div className="card small">{ev.note}</div>}
      {child ? (
        <div className="card">
          <h2>Times with {first(name)}’s teachers</h2>
          <SlotPicker eventId={eventId} learnerId={child} onBooked={(t, at) => toast(`Booked: ${time(at)} with ${t.name}`)} />
        </div>
      ) : (
        <Loading />
      )}
      {mine && <ParentBookings list={mine.bookings.filter((b) => b.event_id === eventId)} />}
    </Page>
  );
}

// "Coming up": meetings open to book for this child, and the parent's times
export function ParentMeetings({ childId, name }) {
  const q = useQuery(`my-meetings:${childId}`, () => api.myMeetings(childId), { poll: 60000 });
  const d = q.data;
  if (!d || (!d.events.length && !d.bookings.length)) return null;
  return (
    <div className="card">
      <h2>
        <Icon name="users" size={18} /> Parents’ meetings
      </h2>
      {d.events.map((e) => {
        const left = e.teachers.filter((t) => !t.booked).length;
        return (
          <div key={e.id} className="meet-open">
            <span className="grow">
              <span className="strong">{e.title}</span>
              <span className="small muted">
                {' '}
                · {e.place}
                {e.starts_at ? ` · ${day(e.starts_at)}` : ''}
                {e.closes_at ? ` · book by ${day(new Date(e.closes_at).getTime() - 60000)}` : ''}
              </span>
              <div className="small">{left ? `${left} of ${e.teachers.length} of ${first(name)}’s teachers still to book.` : `You’ve booked all ${e.teachers.length}.`}</div>
            </span>
            <button className={'btn ' + (left ? 'primary' : '')} onClick={() => go(`/meetings/${e.id}?child=${childId}`)}>
              {left ? 'Book times' : 'See times'}
            </button>
          </div>
        );
      })}
      <ParentBookings list={d.bookings} bare />
    </div>
  );
}

function ParentBookings({ list, bare = false }) {
  const toast = useToast();
  const confirm = useConfirm();
  if (!list.length) return null;
  const inner = (
    <div className="list">
      {list.map((b) => (
        <div key={b.id} className={'item' + (b.status === 'cancelled' ? ' muted' : '')}>
          <Icon name={b.how === 'video' ? 'video' : 'pin'} style={{ color: b.status === 'cancelled' ? 'var(--muted)' : 'var(--accent)' }} />
          <span className="grow">
            <span className="name">
              {b.teacher.name} <span className="muted">· about {first(b.child.name)}</span>
            </span>
            <span className="meta">
              <span>{bothTimes(b.starts_at, b.tz)}</span>
              <span>{b.how === 'video' ? 'By video' : b.where || 'In person'}</span>
              {b.status === 'booked' && b.late_min > 0 && <span className="pill warn">Running about {b.late_min} minutes late</span>}
              {b.status === 'cancelled' && <span className="pill bad">Cancelled{b.cancel_reason ? `: ${b.cancel_reason}` : ''}</span>}
            </span>
          </span>
          <span className="row wrap" style={{ gap: 4, justifyContent: 'flex-end' }}>
            {canJoin(b) && (
              <button className="btn sm primary" onClick={() => go(`/live/meeting/${b.id}`)}>
                Join
              </button>
            )}
            {b.can_change && (
              <>
                <button className="btn sm" onClick={() => go(`/meetings/${b.event_id}?child=${b.child.id}`)}>
                  Change
                </button>
                <button
                  className="btn sm ghost"
                  onClick={async () => {
                    if (!(await confirm({ title: 'Cancel this meeting?', body: `${b.teacher.name} is told, and the time is free for someone else.`, ok: 'Cancel this meeting', cancel: 'Keep it', danger: true }))) return;
                    try {
                      await api.cancelMeeting(b.id);
                      refresh();
                      toast('Cancelled');
                    } catch (x) {
                      toast({ title: 'Couldn’t cancel it', body: x.message, tone: 'bad' });
                    }
                  }}
                >
                  Cancel
                </button>
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  );
  return bare ? inner : <div className="card"><h2>Your times</h2>{inner}</div>;
}

// "This week": a nudge while there are teachers left to book
export function MeetingNudge({ childId, name }) {
  const d = useQuery(`my-meetings:${childId}`, () => api.myMeetings(childId)).data;
  const e = d?.events.find((x) => x.teachers.some((t) => !t.booked));
  if (!e) return null;
  return (
    <div className="card row wrap meet-nudge" style={{ gap: 10 }}>
      <Icon name="calendar" size={20} style={{ color: 'var(--accent)' }} />
      <span className="grow">
        <span className="strong">Book a time with {first(name)}’s teachers</span>
        <span className="small muted">
          {' '}
          · {e.title}
          {e.closes_at ? `, by ${day(new Date(e.closes_at).getTime() - 60000)}` : ''}
        </span>
      </span>
      <button className="btn primary" onClick={() => go(`/meetings/${e.id}?child=${childId}`)}>
        Book times
      </button>
    </div>
  );
}

// The video meeting itself, for the parent and the teacher (/live/meeting/<booking>)
export { MeetingRoom } from './Live.jsx';
