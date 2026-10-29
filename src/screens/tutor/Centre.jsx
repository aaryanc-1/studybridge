import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Field, Loading, Page, Seg, Stat, go } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, day, dur, ymd } from '../../lib/format.js';
import { AttendanceReport, BehaviourReport, TimetableSetup } from './SchoolSetup.jsx';

const count = (n, one, many = one + 's') => `${n} ${Number(n) === 1 ? one : many}`;
// 'YYYY-MM-DD' → "today", "yesterday" or "Tue 20 Oct"
const lastDay = (d) => (!d ? 'not yet' : d === ymd(new Date()) ? 'today' : d === ymd(Date.now() - 86400000) ? 'yesterday' : day(d + 'T12:00'));

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'timetable', label: 'Timetable' },
  { value: 'attendance', label: 'Attendance' },
  { value: 'behaviour', label: 'Behaviour' },
];

// A tuition centre's or school's managers: how everyone is getting on, the timetable they set out, and the whole
// place's attendance and behaviour
export default function Centre({ tab = 'overview' }) {
  const org = useQuery('org', api.myOrg).data;
  const shown = TABS.some((t) => t.value === tab) ? tab : 'overview';
  return (
    <Page title="Centre" subtitle={org?.name}>
      <Seg value={shown} onChange={(t) => go(`/centre/${t}`, { replace: true })} options={TABS} />
      {shown === 'timetable' ? <TimetableSetup /> : shown === 'attendance' ? <AttendanceReport /> : shown === 'behaviour' ? <BehaviourReport /> : <Overview />}
    </Page>
  );
}

// Every tutor and learner in the centre. Read-only: each tutor marks and approves everything for their own learners.
function Overview() {
  const q = useQuery('org-overview', api.orgOverview);
  const [find, setFind] = useState('');
  const [tutor, setTutor] = useState('');
  const d = q.data;
  if (q.error && !d)
    return (
      <div className="card">
        <div className="error">{q.error.message}</div>
      </div>
    );
  if (!d) return <Loading />;

  const tutors = d.tutors || [];
  const learners = d.learners || [];
  const tutorName = Object.fromEntries(tutors.map((t) => [t.id, t.name]));
  const s = find.trim().toLowerCase();
  // a name, subject or class
  const shown = learners.filter((l) => (!tutor || l.tutor_id === tutor) && (!s || [l.name, ...(l.subjects || []), ...(l.classes || [])].some((x) => String(x).toLowerCase().includes(s))));
  const sum = (list, k) => list.reduce((n, x) => n + Number(x[k] || 0), 0);

  return (
    <>
      <div className="muted small">How everyone is getting on. Each tutor marks and approves everything for their own learners.</div>
      <div className="kpi">
        <Stat n={tutors.length} l="Tutors" />
        <Stat n={learners.length} l="Learners" />
        <Stat n={sum(tutors, 'to_mark')} l="Waiting to be marked" />
        <Stat n={dur(sum(learners, 'week_min') * 60)} l="Studied this week" />
      </div>

      <div className="card">
        <h2>Tutors</h2>
        <div className="list">
          {tutors.map((t) => (
            <div key={t.id} className="item">
              <Avatar person={{ id: t.id, display_name: t.name }} size="sm" />
              <span className="grow">
                <span className="row" style={{ gap: 8 }}>
                  <span className="name">{t.name}</span>
                  <span className={'pill' + (t.role === 'manager' ? ' accent' : '')}>{t.role === 'manager' ? 'Manager' : 'Tutor'}</span>
                </span>
                <span className="meta">
                  {count(t.learners, 'learner')} · {count(t.classes, 'class', 'classes')} · {t.to_mark} to mark · {t.last_seen_at ? `last here ${ago(t.last_seen_at)}` : 'not signed in yet'}
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Learners</h2>
          {shown.length !== learners.length && (
            <span className="small muted">
              {shown.length} of {learners.length}
            </span>
          )}
        </div>
        {learners.length === 0 ? (
          <Empty title="No learners yet">When the centre’s tutors invite learners, they show here.</Empty>
        ) : (
          <>
            <div className="row wrap" style={{ alignItems: 'flex-end' }}>
              <div className="grow" style={{ minWidth: 200 }}>
                <Field label="Find a learner">
                  <input className="input" type="search" value={find} onChange={(e) => setFind(e.target.value)} placeholder="Name, subject or class" />
                </Field>
              </div>
              <Field label="Tutor">
                <select className="select" style={{ width: 'auto' }} value={tutor} onChange={(e) => setTutor(e.target.value)}>
                  <option value="">Every tutor</option>
                  {tutors.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {shown.length === 0 ? (
              <div className="muted small">No learners match. Try another name, or Every tutor.</div>
            ) : (
              <div className="list">
                {shown.map((l) => (
                  <div key={l.id} className="item" style={{ alignItems: 'flex-start' }}>
                    <Avatar person={{ id: l.id, display_name: l.name }} size="sm" />
                    <span className="grow" style={{ gap: 4 }}>
                      <span className="name">{l.name}</span>
                      <span className="meta">Tutor: {tutorName[l.tutor_id] || '—'}</span>
                      {(l.subjects?.length > 0 || l.classes?.length > 0) && (
                        <span className="chips">
                          {(l.subjects || []).map((x) => (
                            <span key={'s' + x} className="pill">
                              {x}
                            </span>
                          ))}
                          {(l.classes || []).map((x) => (
                            <span key={'c' + x} className="pill accent">
                              <Icon name="users" size={13} />
                              {x}
                            </span>
                          ))}
                        </span>
                      )}
                      <span className="meta">
                        {dur(Number(l.week_min || 0) * 60)} this week · handed in {l.handed_in_week} this week · last active {lastDay(l.last_active)}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </>
  );
}
