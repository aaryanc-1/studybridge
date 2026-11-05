// The assessment calendar (gradebook depth): summative work with a due date, four weeks at a time. A teacher sees the
// learners they teach, with work from every teacher at their centre or school (never from somewhere else); a manager sees
// the whole centre or school. A learner with two or more on one day is a clash; three or more in a week is a busy week.
// Days are the school's own (or the tutor's).
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Link, Loading, Stat } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { kindLabel, time, ymd } from '../../lib/format.js';

const DAY = 86400000;
// 'YYYY-MM-DD' ↔ a local date (noon, so clock changes never move the day)
const parse = (s) => {
  const [y, m, d] = String(s).slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};
const add = (s, n) => ymd(parse(s).getTime() + n * DAY);
const monday = (d = new Date()) => ymd(new Date(d).getTime() - ((new Date(d).getDay() + 6) % 7) * DAY);
const dayName = (s) => parse(s).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' });
const weekName = (s) => parse(s).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
const STATE = { draft: 'Draft', hidden: 'Not posted yet', scheduled: 'Scheduled' };
const names = (list, n = 3) => (list.length <= n ? list.join(', ') : `${list.slice(0, n).join(', ')} and ${list.length - n} more`);

export function AssessmentCalendar({ all = false }) {
  const [start, setStart] = useState(() => monday());
  const [cls, setCls] = useState('');
  const [year, setYear] = useState('');
  const to = add(start, 27);
  const q = useQuery(`assessment-calendar:${all ? 'all' : 'mine'}:${start}`, () => api.assessmentCalendar(start, to, all));
  const o = q.data;
  const today = ymd(new Date());

  const head = (
    <div className="row between wrap" style={{ gap: 10 }}>
      <span className="small muted" style={{ maxWidth: 640 }}>
        Tests, exams and anything marked summative, by due date{all ? ', across the whole school' : ', for the learners you teach (from every teacher here)'}. A clash is a learner with two or more on one
        day; a busy week is three or more.
      </span>
      <span className="row" style={{ gap: 6 }}>
        <button className="btn sm" onClick={() => setStart(add(start, -28))} aria-label="Four weeks earlier">
          <Icon name="left" size={15} /> Earlier
        </button>
        <button className="btn sm" onClick={() => setStart(monday())} disabled={start === monday()}>
          This week
        </button>
        <button className="btn sm" onClick={() => setStart(add(start, 28))} aria-label="Four weeks later">
          Later <Icon name="right" size={15} />
        </button>
      </span>
    </div>
  );
  if (!o) return <>{head}{q.error ? <div className="error">{q.error.message}</div> : <Loading />}</>;

  const classes = [...new Map(o.items.filter((x) => x.class_id).map((x) => [x.class_id, x.class])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  const years = [...new Set(o.items.map((x) => x.year).filter((y) => y != null))].sort((a, b) => a - b);
  const items = o.items.filter((x) => (!cls || x.class_id === cls) && (!year || String(x.year) === year));
  const shownIds = new Set(items.map((x) => x.id));
  const filtered = !!(cls || year);
  const clashes = o.clashes.filter((c) => !filtered || c.ids.some((id) => shownIds.has(id)));
  const busy = o.busy.filter((b) => !filtered || b.ids.some((id) => shownIds.has(id)));
  const title = Object.fromEntries(o.items.map((x) => [x.id, x.title]));
  const weeks = [0, 7, 14, 21].map((n) => add(start, n));

  return (
    <>
      {head}
      <div className="kpi">
        <Stat n={items.length} l="Assessments" />
        <Stat n={new Set(clashes.map((c) => c.learner_id)).size} l="Learners with a clash" />
        <Stat n={new Set(busy.map((b) => b.learner_id)).size} l="Learners with a busy week" />
      </div>
      {(classes.length > 1 || years.length > 1) && (
        <div className="row wrap" style={{ gap: 8 }}>
          {years.length > 1 && (
            <select className="select" style={{ width: 'auto' }} aria-label="Year group" value={year} onChange={(e) => setYear(e.target.value)}>
              <option value="">Every year</option>
              {years.map((y) => (
                <option key={y} value={String(y)}>
                  Grade {y}
                </option>
              ))}
            </select>
          )}
          {classes.length > 1 && (
            <select className="select" style={{ width: 'auto' }} aria-label="Class" value={cls} onChange={(e) => setCls(e.target.value)}>
              <option value="">Every class</option>
              {classes.map(([id, n]) => (
                <option key={id} value={id}>
                  {n}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      {!items.length && <Empty>Nothing summative is due in these four weeks. Tests and exams count, and any work you mark as summative.</Empty>}
      {items.length > 0 &&
        weeks.map((wk) => {
          const busyHere = busy.filter((b) => b.week === wk);
          const days = [0, 1, 2, 3, 4, 5, 6].map((n) => add(wk, n));
          return (
            <div key={wk} className="card">
              <div className="row between wrap" style={{ gap: 8 }}>
                <h3>Week of {weekName(wk)}</h3>
                {busyHere.length > 0 && (
                  <span className="pill warn" title={busyHere.map((b) => `${b.name}: ${b.ids.map((id) => title[id]).join(', ')}`).join('\n')}>
                    Busy week for {names(busyHere.map((b) => b.name))}
                  </span>
                )}
              </div>
              <div className="ac-week">
                {days.map((d, i) => {
                  const list = items.filter((x) => x.day === d);
                  const dayClash = clashes.filter((c) => c.day === d);
                  return (
                    <div key={d} className={'ac-day' + (i >= 5 ? ' off' : '') + (d === today ? ' today' : '') + (dayClash.length ? ' clash' : '') + (list.length ? '' : ' empty')}>
                      <div className="ac-date">
                        <span>{dayName(d)}</span>
                        {d === today && <span>Today</span>}
                      </div>
                      {list.map((x) => {
                        const body = (
                          <>
                            {x.title}
                            <span className="m">
                              {[x.class || x.subject, kindLabel[x.kind], time(x.due_at), !x.mine && x.by, STATE[x.state], `${x.learners} learner${x.learners === 1 ? '' : 's'}`]
                                .filter(Boolean)
                                .join(' · ')}
                            </span>
                          </>
                        );
                        const cn = 'ac-item' + (x.mine ? '' : ' theirs') + (x.clash ? ' clash' : '');
                        return x.mine ? (
                          <Link key={x.id} to={`/assignments/${x.id}`} className={cn}>
                            {body}
                          </Link>
                        ) : (
                          <div key={x.id} className={cn}>
                            {body}
                          </div>
                        );
                      })}
                      {dayClash.length > 0 && (
                        <div className="ac-clash" title={dayClash.map((c) => `${c.name}: ${c.ids.map((id) => title[id]).join(', ')}`).join('\n')}>
                          Clash: {names(dayClash.map((c) => c.name))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
    </>
  );
}
