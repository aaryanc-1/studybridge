// The school office (5 Nov 2026), for a centre's or school's office and managers (everyone) and heads of year (their
// years): the day (each homeroom's daily register, who isn't in and why, who came late), absences parents reported (to
// accept or not), every learner's record, attendance and behaviour, and which classes are homerooms. A student's page
// brings one learner's record, attendance, behaviour, absences and reports together.
import { useMemo, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Field, Link, Loading, Modal, Page, Seg, Stat, Toggle, go, useRoute, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { day, ymd } from '../../lib/format.js';
import { REASONS, absenceWhen, yearName } from '../../lib/office.js';
import { AbsenceItem, Decide, RecordEditor, RecordView, ReportAbsence } from '../shared/Office.jsx';
import { AttendanceCard, BehaviourCard, GiveBehaviour, ProfileCard } from '../shared/School.jsx';
import { AttendanceReport, BehaviourReport } from './SchoolSetup.jsx';
import { AccessLine } from './Access.jsx';
import { FamilyInbox, MessageFamily, FamilyThreadsFor, useFamilyUnread } from '../shared/Families.jsx';
import { MeetingsList } from '../shared/Meetings.jsx';

const first = (name) => String(name || '').split(' ')[0];
const addDays = (d, n) => {
  const x = new Date(d + 'T12:00');
  x.setDate(x.getDate() + n);
  return ymd(x);
};

// Who sees the Office page: a centre's or school's office and managers, and heads of year
export function officeAccess(org) {
  if (!org || !(org.kind === 'centre' || org.kind === 'school')) return null;
  if (org.role === 'manager' || org.role === 'office') return 'all';
  return (org.years || []).length ? 'years' : null;
}

export default function Office({ tab = 'today' }) {
  const org = useQuery('org', api.myOrg).data;
  const access = officeAccess(org);
  const route = useRoute();
  const unread = useFamilyUnread();
  const tabs = [
    { value: 'today', label: 'Today' },
    { value: 'absences', label: 'Absences' },
    { value: 'students', label: 'Students' },
    { value: 'attendance', label: 'Attendance' },
    { value: 'behaviour', label: 'Behaviour' },
    ...(access === 'all' ? [{ value: 'homerooms', label: 'Homerooms' }] : []),
    // parents, more (6 Nov 2026): messages families send the office, and parents' meetings
    { value: 'messages', label: unread ? `Messages (${unread})` : 'Messages' },
    ...(access === 'all' ? [{ value: 'meetings', label: 'Parents’ meetings' }] : []),
  ];
  const shown = tabs.some((t) => t.value === tab) ? tab : 'today';
  if (!org) return <Page title="Office"><Loading /></Page>;
  return (
    <Page
      title="Office"
      subtitle={access === 'years' ? `${org.name}: ${org.years.map(yearName).join(', ')}` : org.name}
    >
      <Seg label="Office" value={shown} onChange={(t) => go(t === 'today' ? '/office' : `/office/${t}`, { replace: true })} options={tabs} />
      {shown === 'absences' ? (
        <Absences />
      ) : shown === 'students' ? (
        <Students />
      ) : shown === 'attendance' ? (
        <AttendanceReport />
      ) : shown === 'behaviour' ? (
        <BehaviourReport />
      ) : shown === 'homerooms' ? (
        <Homerooms />
      ) : shown === 'messages' ? (
        <FamilyInbox threadId={route.parts[2]} base="/office/messages" officeOnly />
      ) : shown === 'meetings' ? (
        <MeetingsList />
      ) : (
        <Today />
      )}
    </Page>
  );
}

// ---------- the day ----------
const countText = (c, size) => (!c || c.marked === 0 ? 'Not taken yet' : `${c.marked === size ? 'Taken' : `${c.marked} of ${size} marked`} · ${c.absent} absent${c.late ? ` · ${c.late} late` : ''}`);
function Today() {
  const [d, setD] = useState(null);
  const q = useQuery(`office-day:${d || 'today'}`, () => api.officeDay(d));
  const o = q.data;
  if (!o) return q.error ? <div className="card"><div className="error">{q.error.message}</div></div> : <Loading />;
  const isToday = o.day === o.today;
  const parts = [['am', 'Morning', o.am_at], ...(o.daily_registers === 2 ? [['pm', 'Afternoon', o.pm_at]] : [])];
  const unexplained = o.away.filter((a) => a.unexplained).length;
  return (
    <>
      <div className="row between wrap" style={{ gap: 8 }}>
        <span className="strong">
          {isToday ? 'Today' : day(o.day + 'T12:00')} {!o.open && <span className="pill">No school</span>}
        </span>
        <span className="row wrap" style={{ gap: 8 }}>
          <button className="btn" onClick={() => setD(addDays(o.day, -1))} aria-label="The day before">
            <Icon name="left" size={16} /> Day before
          </button>
          {!isToday && (
            <button className="btn" onClick={() => setD(null)}>
              Today
            </button>
          )}
          <button className="btn" onClick={() => setD(addDays(o.day, 1))} aria-label="The day after">
            Day after <Icon name="right" size={16} />
          </button>
        </span>
      </div>
      <div className="kpi">
        <Stat n={o.learners} l={o.all ? 'Learners' : 'Learners in your years'} />
        <Stat n={o.away.length} l="Not in" />
        <Stat n={unexplained} l="No reason yet" />
        <Stat n={o.late.length} l="Late" />
      </div>
      {o.waiting > 0 && (
        <Link to="/office/absences" className="note row" style={{ gap: 8, textDecoration: 'none' }}>
          <Icon name="bell" size={16} /> {o.waiting} absence{o.waiting === 1 ? '' : 's'} from parents to look at
        </Link>
      )}
      <div className="card">
        <h2>Homeroom registers</h2>
        {o.homerooms.length === 0 ? (
          <div className="small muted">
            No homerooms yet. {o.all ? <Link to="/office/homerooms">Pick the classes that take the daily register.</Link> : 'The office picks the classes that take the daily register.'}
          </div>
        ) : (
          <div className="list">
            {o.homerooms.map((h) => (
              <div key={h.id} className="item" style={{ flexWrap: 'wrap' }}>
                <span className="grow">
                  <span className="name">{h.name}</span>
                  <span className="meta">
                    <span>{h.teachers.join(', ') || 'No teacher yet'}</span>
                    <span>
                      {h.size} learner{h.size === 1 ? '' : 's'}
                    </span>
                  </span>
                </span>
                {parts.map(([k, label, at]) => {
                  const c = h[k];
                  const done = c && c.marked >= h.size && h.size > 0;
                  const late = !c?.marked && isToday && o.now >= at;
                  return (
                    <Link key={k} to={`/register/${k}/${h.id}/${o.day}`} className={'pill ' + (done ? 'good' : late ? 'warn' : '')} style={{ textDecoration: 'none' }}>
                      {label}: {countText(c, h.size)}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="split even">
        <div className="card">
          <h2>Not in</h2>
          {o.away.length === 0 ? (
            <div className="small muted">Nobody is marked absent{isToday ? ' so far today' : ''}.</div>
          ) : (
            <div className="list">
              {o.away.map((a) => (
                <div key={a.id} className="item">
                  <span className="grow">
                    <span className="name">
                      <Link to={`/student/${a.id}`}>{a.name}</Link>
                    </span>
                    <span className="meta">
                      {a.homeroom && <span>{a.homeroom}</span>}
                      <span>{(a.marks || []).map((m) => m.label).join(', ')}</span>
                    </span>
                    {a.unexplained && a.contact && (
                      <span className="small">
                        Call {a.contact.name}
                        {a.contact.relation ? ` (${a.contact.relation})` : ''}: {a.contact.phone ? <a href={`tel:${a.contact.phone.replace(/\s/g, '')}`}>{a.contact.phone}</a> : a.contact.email}
                      </span>
                    )}
                  </span>
                  {a.report ? <span className="pill">{REASONS[a.report.reason]}</span> : a.unexplained ? <span className="pill bad">No reason yet</span> : <span className="pill">Excused</span>}
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <h2>Late</h2>
          {o.late.length === 0 ? (
            <div className="small muted">Nobody{isToday ? ' so far' : ''}.</div>
          ) : (
            <div className="list">
              {o.late.map((l, i) => (
                <div key={l.id + i} className="item">
                  <span className="grow">
                    <span className="name">
                      <Link to={`/student/${l.id}`}>{l.name}</Link>
                    </span>
                    <span className="meta">
                      <span>{l.label}</span>
                      {l.minutes_late ? <span>{l.minutes_late} min</span> : null}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="card">
        <h2>{isToday ? 'Families told us about today' : 'Families told us about this day'}</h2>
        {o.reported.length === 0 ? (
          <div className="small muted">Nothing.</div>
        ) : (
          <div className="list">
            {o.reported.map((r) => (
              <AbsenceItem key={r.id} r={r} who />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ---------- absences ----------
function Absences() {
  const [which, setWhich] = useState('open');
  const q = useQuery(`absences:${which}`, () => api.absenceList(which));
  const [deciding, setDeciding] = useState(null);
  const [adding, setAdding] = useState(false);
  const list = q.data || [];
  return (
    <>
      <div className="row between wrap" style={{ gap: 8 }}>
        <Seg
          label="Which absences"
          value={which}
          onChange={setWhich}
          options={[
            { value: 'open', label: 'Waiting and coming up' },
            { value: 'past', label: 'Past' },
          ]}
        />
        <button className="btn primary" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} /> Add one from a call or a note
        </button>
      </div>
      <div className="card">
        {!q.data ? (
          q.error ? <div className="error">{q.error.message}</div> : <Loading />
        ) : list.length === 0 ? (
          <Empty title={which === 'open' ? 'Nothing waiting' : 'Nothing in the last two months'}>When a parent says their child will be away, it shows here and on every register.</Empty>
        ) : (
          <div className="list">
            {list.map((r) => (
              <AbsenceItem key={r.id} r={r} who>
                {r.can_decide && r.status !== 'withdrawn' && (
                  <span className="row wrap" style={{ gap: 6 }}>
                    {r.status !== 'accepted' && (
                      <button className="btn sm primary" onClick={() => setDeciding({ r, status: 'accepted' })} aria-label={`Accept ${r.learner}’s absence`}>
                        Accept
                      </button>
                    )}
                    {r.status !== 'not_accepted' && (
                      <button className="btn sm" onClick={() => setDeciding({ r, status: 'not_accepted' })} aria-label={`Don’t accept ${r.learner}’s absence`}>
                        Don’t accept
                      </button>
                    )}
                  </span>
                )}
              </AbsenceItem>
            ))}
          </div>
        )}
      </div>
      {deciding && <Decide {...deciding} onClose={() => setDeciding(null)} />}
      {adding && <AddAbsence onClose={() => setAdding(false)} />}
    </>
  );
}

// The office notes an absence from a call or a note: pick the learner first
function AddAbsence({ onClose }) {
  const q = useQuery('student-records', api.studentRecords);
  const [find, setFind] = useState('');
  const [who, setWho] = useState(null);
  if (who) return <ReportAbsence staff learnerId={who.id} name={who.name} onClose={onClose} />;
  const s = find.trim().toLowerCase();
  const list = (q.data?.learners || []).filter((l) => !s || l.name.toLowerCase().includes(s)).slice(0, 30);
  return (
    <Modal title="Who is away?" onClose={onClose}>
      <div className="stack">
        <Field label="Find a learner">
          <input className="input" autoFocus value={find} onChange={(e) => setFind(e.target.value)} placeholder="A name" />
        </Field>
        {!q.data ? (
          <Loading />
        ) : (
          <div className="list">
            {list.map((l) => (
              <button key={l.id} className="item click" onClick={() => setWho(l)}>
                <Avatar person={{ id: l.id, display_name: l.name }} size="sm" />
                <span className="grow">
                  <span className="name">{l.name}</span>
                  <span className="meta">{[yearName(l.grade), l.homeroom].filter(Boolean).join(' · ')}</span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ---------- students ----------
function Flags({ l }) {
  const f = [
    l.allergies && ['Allergies', 'bad'],
    l.medical && ['Health', 'warn'],
    l.support && ['Learning support', 'accent'],
    l.access && ['Access arrangements', 'accent'],
    l.photos === false && ['No photos', ''],
    !l.contacts && !l.parents && ['No contacts', 'warn'],
  ].filter(Boolean);
  return f.length ? (
    <span className="row wrap" style={{ gap: 4 }}>
      {f.map(([t, tone]) => (
        <span key={t} className={'pill ' + tone}>
          {t}
        </span>
      ))}
    </span>
  ) : null;
}
function Students() {
  const q = useQuery('student-records', api.studentRecords);
  const [find, setFind] = useState('');
  const [year, setYear] = useState('');
  const [only, setOnly] = useState('');
  const all = q.data?.learners || [];
  const years = useMemo(() => [...new Set(all.map((l) => l.grade))].sort((a, b) => (a ?? 99) - (b ?? 99)), [all]);
  if (!q.data) return q.error ? <div className="card"><div className="error">{q.error.message}</div></div> : <Loading />;
  const s = find.trim().toLowerCase();
  const shown = all.filter(
    (l) =>
      (!s || [l.name, l.homeroom, l.student_no].some((x) => String(x || '').toLowerCase().includes(s))) &&
      (year === '' || String(l.grade) === year) &&
      (!only || (only === 'needs' ? l.allergies || l.medical || l.support || l.access : !l.contacts && !l.parents)),
  );
  return (
    <>
      <div className="row wrap" style={{ gap: 8 }}>
        <input className="input grow" style={{ minWidth: 180 }} aria-label="Find a learner" placeholder="Find a name, homeroom or number" value={find} onChange={(e) => setFind(e.target.value)} />
        <select className="input" style={{ width: 'auto' }} aria-label="Year" value={year} onChange={(e) => setYear(e.target.value)}>
          <option value="">Every year</option>
          {years.map((g) => (
            <option key={String(g)} value={String(g)}>
              {yearName(g)}
            </option>
          ))}
        </select>
        <select className="input" style={{ width: 'auto' }} aria-label="Show" value={only} onChange={(e) => setOnly(e.target.value)}>
          <option value="">Everyone</option>
          <option value="needs">Health, support or extra time</option>
          <option value="contacts">No contacts yet</option>
        </select>
      </div>
      <div className="card pad0">
        {shown.length === 0 ? (
          <div style={{ padding: 20 }}>
            <Empty>{all.length ? 'Nobody matches.' : 'No learners here yet.'}</Empty>
          </div>
        ) : (
          <div className="list">
            {shown.map((l) => (
              <Link key={l.id} to={`/student/${l.id}`} className="item click">
                <Avatar person={{ id: l.id, display_name: l.name }} size="sm" />
                <span className="grow">
                  <span className="name">{l.name}</span>
                  <span className="meta">{[yearName(l.grade), l.homeroom, l.student_no].filter(Boolean).join(' · ')}</span>
                  <Flags l={l} />
                </span>
                <Icon name="right" size={16} />
              </Link>
            ))}
          </div>
        )}
      </div>
      <div className="small muted">
        {shown.length} of {all.length}. Parents keep contacts and health up to date in their app; you’re told when they change something.
      </div>
    </>
  );
}

// ---------- homerooms ----------
function Homerooms() {
  const toast = useToast();
  const q = useQuery('homeroom-setup', api.homeroomSetup);
  const h = q.data;
  const [form, setForm] = useState(null);
  if (!h) return q.error ? <div className="card"><div className="error">{q.error.message}</div></div> : <Loading />;
  const f = form || { n: h.daily_registers, am: h.am_at, pm: h.pm_at };
  async function saveTimes() {
    try {
      await api.setDailyRegisters(f.n, f.am, f.pm);
      invalidate('homeroom-setup', 'homerooms', 'office-day');
      setForm(null);
      toast('Saved');
    } catch (e) {
      toast({ title: 'Couldn’t save that', body: e.message, tone: 'bad' });
    }
  }
  async function flip(c, on) {
    try {
      await api.setHomeroom(c.id, on);
      invalidate('homeroom-setup', 'homerooms', 'office-day');
      toast(on ? `${c.name} takes the daily register now` : `${c.name} isn’t a homeroom now`);
    } catch (e) {
      toast({ title: 'Couldn’t change that', body: e.message, tone: 'bad' });
    }
  }
  return (
    <>
      <div className="card stack">
        <h2>The daily register</h2>
        <div className="small muted">Each homeroom’s teacher takes it, once or twice a day. Parents hear the same day when their child is marked absent, unless they told you already.</div>
        <Field label="How many a day">
          <Seg
            label="How many a day"
            value={f.n}
            onChange={(n) => setForm({ ...f, n })}
            options={[
              { value: 1, label: 'One, in the morning' },
              { value: 2, label: 'Two, morning and afternoon' },
            ]}
          />
        </Field>
        <div className="grid2">
          <Field label="Morning register at">
            <input className="input" type="time" value={f.am} onChange={(e) => setForm({ ...f, am: e.target.value })} />
          </Field>
          {f.n === 2 && (
            <Field label="Afternoon register at">
              <input className="input" type="time" value={f.pm} onChange={(e) => setForm({ ...f, pm: e.target.value })} />
            </Field>
          )}
        </div>
        <div>
          <button className="btn primary" disabled={!form || !h.can_edit} onClick={saveTimes}>
            Save
          </button>
        </div>
      </div>
      <div className="card stack">
        <h2>Homerooms</h2>
        <div className="small muted">The classes that take the daily register: form groups, tutor groups or advisories. Make one in Learners → Classes, then switch it on here.</div>
        {h.classes.length === 0 ? (
          <Empty>No classes yet.</Empty>
        ) : (
          h.classes.map((c) => (
            <Toggle
              key={c.id}
              checked={c.homeroom}
              disabled={!h.can_edit}
              onChange={(on) => flip(c, on)}
              title={c.name}
              sub={`${c.size} learner${c.size === 1 ? '' : 's'} · ${c.teachers.join(', ') || 'no teacher yet'}`}
            />
          ))
        )}
      </div>
    </>
  );
}

// ---------- one student ----------
export function StudentPage({ id }) {
  const q = useQuery(`record:${id}`, () => api.studentRecord(id));
  const open = useQuery('absences:open', () => api.absenceList('open')).data || [];
  const past = useQuery('absences:past', () => api.absenceList('past')).data || [];
  const reports = useQuery(`my-reports:${id}`, () => api.myReports(id)).data || [];
  const [editing, setEditing] = useState(false);
  const [away, setAway] = useState(false);
  const [giving, setGiving] = useState(false);
  const rec = q.data;
  if (!rec)
    return (
      <Page title="Student">
        {q.error ? (
          <div className="card">
            <div className="error">{q.error.message}</div>
          </div>
        ) : (
          <Loading />
        )}
      </Page>
    );
  const l = rec.learner;
  const office = rec.view === 'office';
  const absences = [...open, ...past].filter((r) => r.learner_id === id);
  return (
    <Page
      eyebrow={
        <Link to="/office/students">
          <Icon name="left" size={14} /> Students
        </Link>
      }
      title={l.name}
      subtitle={[yearName(l.grade), rec.homeroom, rec.record?.student_no].filter(Boolean).join(' · ')}
      actions={
        <>
          {rec.can_edit && (
            <button className="btn primary" onClick={() => setEditing(true)}>
              <Icon name="pen" size={16} /> Change details
            </button>
          )}
          {office && (
            <button className="btn" onClick={() => setAway(true)}>
              <Icon name="calendar" size={16} /> Away
            </button>
          )}
          <button className="btn" onClick={() => setGiving(true)}>
            <Icon name="star" size={16} /> Give a point
          </button>
          <button className="btn" onClick={() => go(`/transcript/${id}`)}>
            <Icon name="file" size={16} /> Transcript
          </button>
          {office && <MessageFamily learnerId={id} office label="Message the family" />}
        </>
      }
    >
      <AccessLine id={id} first={first(l.name)} />
      {office && <FamilyThreadsFor learnerId={id} base="/office/messages" />}
      <div className="split">
        <div className="stack">
          <section className="card">
            <h2>Details</h2>
            <RecordView rec={rec} />
            {rec.record?.updated_at && (
              <div className="tiny muted">
                Last changed {day(rec.record.updated_at)}
                {rec.record.updated_by ? ` by ${rec.record.updated_by}` : ''}
              </div>
            )}
          </section>
          {office && (
            <section className="card">
              <h2>Parents on StudyBridge</h2>
              {(rec.parents || []).length === 0 ? (
                <div className="small muted">No parent follows {first(l.name)} yet. Their teacher can give the family a parent code.</div>
              ) : (
                <div className="list">
                  {rec.parents.map((p) => (
                    <div key={p.id} className="item">
                      <Avatar person={{ id: p.id, display_name: p.name }} size="sm" />
                      <span className="grow">
                        <span className="name">{p.name}</span>
                        <span className="meta">{p.email && <a href={`mailto:${p.email}`}>{p.email}</a>}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {(rec.history || []).length > 0 && (
                <>
                  <div className="tiny strong muted">Changes</div>
                  <div className="list">
                    {rec.history.slice(0, 6).map((h, i) => (
                      <div key={i} className="item small">
                        <span className="grow">
                          {h.by || 'Someone'}
                          {h.by_parent ? ' (parent)' : ''} changed {h.fields.join(', ')}
                        </span>
                        <span className="muted">{day(h.at)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}
          <section className="card">
            <h2>Absences families told us about</h2>
            {absences.length === 0 ? (
              <div className="small muted">None in the last two months.</div>
            ) : (
              <div className="list">
                {absences.map((r) => (
                  <AbsenceItem key={r.id} r={r} />
                ))}
              </div>
            )}
          </section>
        </div>
        <div className="stack">
          <AttendanceCard learnerId={id} name={l.name} staff />
          <BehaviourCard learnerId={id} name={l.name} staff canGive />
          <ProfileCard learnerId={id} name={l.name} staff />
          {reports.length > 0 && (
            <section className="card">
              <h2>Term reports</h2>
              <div className="list">
                {reports.map((r) => (
                  <Link key={r.id} to={`/report/${r.id}/${id}`} className="item click">
                    <Icon name="file" size={18} style={{ color: 'var(--accent)' }} />
                    <span className="grow">
                      <span className="name">{r.title}</span>
                    </span>
                    <Icon name="right" size={16} />
                  </Link>
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
      {editing && <RecordEditor rec={rec} onClose={() => setEditing(false)} />}
      {away && <ReportAbsence staff learnerId={id} name={l.name} onClose={() => setAway(false)} />}
      {giving && <GiveBehaviour learners={[{ id, name: l.name }]} onClose={() => setGiving(false)} />}
    </Page>
  );
}
