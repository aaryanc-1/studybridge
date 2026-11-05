// Term reports (running a school, part 2): one learner's end-of-term report from a centre, school or tutor. Each class's
// grade (or IB MYP criteria levels), effort and comment, an overall comment, and attendance and points over the term.
// Learners and their parents read it once it's sent out; staff can look at it any time. It prints or saves as a PDF,
// one at a time or a whole report's worth at once. Report polish: the place's own look (logo, colour, address, the head's
// signature), a full or grid layout, the sections a report shows, one table for ATL skills, and transcripts.
import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Empty, Link, Loading, Page } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { day } from '../../lib/format.js';
import { ATL_SKILLS } from '../../lib/core.js';

export const EFFORT = { 1: 'Excellent', 2: 'Good', 3: 'Needs work', 4: 'A concern' };
export const SCALES = {
  letters: { label: 'Letters (A* to U)', grades: ['A*', 'A', 'B', 'C', 'D', 'E', 'U'] },
  gcse: { label: 'Numbers (9 to 1)', grades: ['9', '8', '7', '6', '5', '4', '3', '2', '1', 'U'] },
  ib: { label: 'IB (7 to 1)', grades: ['7', '6', '5', '4', '3', '2', '1'] },
  percent: { label: 'Percentages', grades: [] },
  words: { label: 'Words, like the PYP (Beginning to Extending)', grades: [] },
  none: { label: 'Comments only', grades: [] },
};
const fmt = (d) => (d ? new Date(String(d).length === 10 ? d + 'T12:00:00' : d).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');
export const termDates = (r) => (r.starts && r.ends ? `${fmt(r.starts)} to ${fmt(r.ends)}` : '');

// Print just the reports on the page (one, or many with a page each)
export function printTerms() {
  document.body.classList.add('print-terms');
  const done = () => {
    document.body.classList.remove('print-terms');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 3000);
}

// A place's own look (report polish): its logo, name, address and contact line at the top of a report or transcript,
// and its colour (set on the card as --rc)
export const brandStyle = (brand) => (brand?.colour ? { '--rc': brand.colour } : undefined);
export function BrandHead({ brand, place, children }) {
  const name = brand?.name || place;
  return (
    <header className="rc-head term-head">
      <div className="term-brand">
        {brand?.logo && <img className="term-logo" src={brand.logo} alt={`${name} logo`} />}
        <div>
          <div className="term-school">{name}</div>
          {brand?.address && <div className="term-addr">{brand.address}</div>}
          {brand?.contact && <div className="term-addr">{brand.contact}</div>}
        </div>
      </div>
      {children}
    </header>
  );
}
// The head's signature line, when the place has given a name
function Signature({ brand, date }) {
  if (!brand?.head_name) return null;
  return (
    <section className="term-sign">
      <div className="term-sign-line" aria-hidden="true" />
      <div className="rc-strong">{brand.head_name}</div>
      <div className="rc-muted">
        {brand.head_title || 'Head'}
        {date ? ` · ${fmt(date)}` : ''}
      </div>
    </section>
  );
}
const SHOW = { attendance: true, behaviour: true, teachers: true, signature: true };

export function TermCard({ c }) {
  const r = c.round;
  const a = c.attendance || {};
  const b = c.behaviour || {};
  const brand = c.brand || {};
  const show = { ...SHOW, ...(r.show || {}) };
  const grid = r.layout === 'grid';
  const stats = [
    ...(show.attendance && a.lessons > 0
      ? [
          ['Attendance', a.pct != null ? `${a.pct}%` : '—'],
          ['Absences', a.absent ?? 0],
          ['Late', a.late ?? 0],
        ]
      : []),
    ...(show.behaviour && (b.positive > 0 || b.concern > 0)
      ? [['Points', <>+{b.positive ?? 0}{b.concern > 0 && <span className="rc-muted">{b.concern} concern{b.concern === 1 ? '' : 's'}</span>}</>]]
      : []),
  ];
  const who = (s) => [s.subject && s.class, show.teachers && s.teachers].filter(Boolean).join(' · ');
  const atl = c.subjects.filter((s) => s.atl?.length);
  const skills = ATL_SKILLS.filter((k) => atl.some((s) => s.atl.some((x) => x.skill === k)));
  const criteria = (s) =>
    s.criteria && (
      <table className="rc-table term-crit">
        <tbody>
          {s.criteria.map((x) => (
            <tr key={x.letter}>
              <td>
                Criterion {x.letter}: {x.name}
              </td>
              <td className="rc-score">{x.level != null ? `${x.level} / 8` : '—'}</td>
            </tr>
          ))}
          {s.criteria.every((x) => x.level != null) && (
            <tr>
              <td className="rc-muted">All four added up</td>
              <td className="rc-score">{s.myp_total} / 32</td>
            </tr>
          )}
        </tbody>
      </table>
    );
  return (
    <article className={'report-card term-card' + (grid ? ' grid-layout' : '')} style={brandStyle(brand)} aria-label={`${r.title} for ${c.learner.name}`}>
      <BrandHead brand={brand} place={c.place}>
        <div className="term-who">
          <h2 className="rc-name">{c.learner.name}</h2>
          <div className="rc-sub">
            {r.title}
            {termDates(r) ? ` · ${termDates(r)}` : ''}
          </div>
        </div>
      </BrandHead>
      {stats.length > 0 && (
        <div className="rc-stats" style={{ gridTemplateColumns: `repeat(${stats.length}, 1fr)` }}>
          {stats.map(([l, n]) => (
            <div key={l} className="rc-stat">
              <div className="l">{l}</div>
              <div className="n">{n}</div>
            </div>
          ))}
        </div>
      )}
      <section>
        <h3 className="rc-h">Subjects</h3>
        {c.subjects.length === 0 ? (
          <p className="rc-muted">Nothing written yet.</p>
        ) : grid ? (
          <>
            <table className="rc-table term-grid">
              <thead>
                <tr>
                  <th scope="col">Subject</th>
                  {show.teachers && <th scope="col">Teacher</th>}
                  {r.effort && <th scope="col">Effort</th>}
                  <th scope="col" className="rc-score">
                    Grade
                  </th>
                </tr>
              </thead>
              <tbody>
                {c.subjects.map((s) => (
                  <tr key={s.class}>
                    <td>
                      <span className="rc-strong">{s.subject || s.class}</span>
                      {s.criteria?.some((x) => x.level != null) && (
                        <span className="rc-muted term-levels">
                          {' '}
                          {s.criteria.filter((x) => x.level != null).map((x) => `${x.letter}${x.level}`).join(' · ')}
                        </span>
                      )}
                    </td>
                    {show.teachers && <td className="rc-muted">{s.teachers}</td>}
                    {r.effort && <td>{s.effort ? EFFORT[s.effort] : '—'}</td>}
                    <td className="rc-score">{s.grade || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {c.subjects.some((s) => s.comment) && (
              <div className="term-comments">
                {c.subjects
                  .filter((s) => s.comment)
                  .map((s) => (
                    <div key={s.class} className="term-subject">
                      <div className="rc-strong">{s.subject || s.class}</div>
                      <p className="rc-text">{s.comment}</p>
                    </div>
                  ))}
              </div>
            )}
          </>
        ) : (
          c.subjects.map((s) => (
            <div key={s.class} className="term-subject">
              <div className="term-subject-head">
                <div>
                  <div className="rc-strong">{s.subject || s.class}</div>
                  {who(s) && <div className="rc-muted">{who(s)}</div>}
                </div>
                <div className="row wrap" style={{ gap: 8, justifyContent: 'flex-end' }}>
                  {s.effort && <span className="pill">Effort: {EFFORT[s.effort]}</span>}
                  {s.grade && (
                    <span className="term-grade" aria-label={`Grade ${s.grade}`}>
                      {s.grade}
                    </span>
                  )}
                </div>
              </div>
              {criteria(s)}
              {s.comment && <p className="rc-text">{s.comment}</p>}
              {c.staff && !s.done && <div className="rc-muted">Not finished yet</div>}
            </div>
          ))
        )}
      </section>
      {atl.length > 0 && (
        <section>
          <h3 className="rc-h">Approaches to learning</h3>
          <div className="term-atl-wrap">
            <table className="rc-table term-atl-table" aria-label="Approaches to learning">
              <thead>
                <tr>
                  <th scope="col">Subject</th>
                  {skills.map((k) => (
                    <th key={k} scope="col">
                      {k}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {atl.map((s) => (
                  <tr key={s.class}>
                    <td className="rc-strong">{s.subject || s.class}</td>
                    {skills.map((k) => (
                      <td key={k}>{s.atl.find((x) => x.skill === k)?.rating || '—'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      {c.profile?.length > 0 && (
        <section>
          <h3 className="rc-h">Learner Profile</h3>
          <table className="rc-table">
            <tbody>
              {c.profile.map((p) => (
                <tr key={p.attribute}>
                  <td className="rc-strong">{p.attribute}</td>
                  <td className="rc-muted">{p.note ? `“${p.note}”` : ''}</td>
                  <td className="rc-score">{p.times > 1 ? `${p.times} times` : 'Once'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {c.overall?.comment && (
        <section className="rc-comment">
          <div className="rc-label">Overall{c.overall.by ? `, from ${c.overall.by}` : ''}</div>
          <p>{c.overall.comment}</p>
        </section>
      )}
      {show.signature && <Signature brand={brand} date={r.published_at} />}
      <footer className="rc-foot">
        <span>{brand.footer || c.place}</span>
        <span>{r.published_at ? `Sent ${fmt(r.published_at)}` : 'Not sent out yet'}</span>
      </footer>
    </article>
  );
}

// One report on its own page (/report/:round/:learner), for staff, the learner and their parents
export function TermReportPage({ round, learner }) {
  const app = useApp();
  const q = useQuery(`term-card:${round}:${learner}`, () => api.reportCard(round, learner));
  const c = q.data;
  const back = app.me.role === 'tutor' ? `/learners/terms/${round}` : app.me.role === 'parent' ? '/marks' : '/progress';
  return (
    <Page
      eyebrow={
        <Link to={back}>
          <Icon name="left" size={14} /> {app.me.role === 'tutor' ? 'Term reports' : 'Back'}
        </Link>
      }
      title={c?.round.title || 'Term report'}
      subtitle={c ? `${c.learner.name} · ${c.place}` : ''}
      actions={
        c && (
          <button className="btn" onClick={printTerms}>
            <Icon name="download" size={16} /> Print or save as PDF
          </button>
        )
      }
    >
      {!c ? (
        q.error ? <Empty title="This report isn’t here">{q.error.message}</Empty> : <Loading />
      ) : (
        <>
          {c.staff && c.round.status !== 'published' && <div className="note warn">Not sent out yet: this is how it will look to {c.learner.name.split(' ')[0]} and their parents.</div>}
          <div className="term-print">
            <TermCard c={c} />
          </div>
        </>
      )}
    </Page>
  );
}

// A learner's term reports that have gone out (on Progress, and for parents on Marks)
export function MyReports({ learnerId = null }) {
  const app = useApp();
  const who = learnerId || app.me.id;
  const q = useQuery(`my-reports:${who}`, () => api.myReports(learnerId));
  const list = q.data || [];
  if (!list.length) return null;
  return (
    <section className="card">
      <h2>Term reports</h2>
      <div className="list">
        {list.map((r) => (
          <Link key={r.id} to={`/report/${r.id}/${who}`} className="item click">
            <Icon name="file" size={18} style={{ color: 'var(--accent)' }} />
            <span className="grow">
              <span className="name">{r.title}</span>
              <span className="meta">
                <span>{r.place}</span>
                {termDates(r) && <span>{termDates(r)}</span>}
              </span>
            </span>
            <Icon name="right" size={16} />
          </Link>
        ))}
      </div>
      <Link to={`/transcript/${who}`} className="small">
        {learnerId ? 'Their transcript' : 'My transcript'}: every term’s grades together
      </Link>
    </section>
  );
}

// Predicted grades a learner's teachers chose to share (gradebook depth), from every class they're in: on the learner's
// Progress and the parent's Marks. Teachers' notes about them never come here.
export function PredictedGrades({ learnerId = null }) {
  const app = useApp();
  const who = learnerId || app.me.id;
  const list = useQuery(`my-predicted:${who}`, () => api.myPredicted(learnerId)).data || [];
  if (!list.length) return null;
  return (
    <section className="card">
      <h2>Predicted grades</h2>
      <div className="small muted">What {learnerId ? 'their' : 'your'} teachers expect from the work so far. They can change as the year goes on.</div>
      <div className="list">
        {list.map((x, i) => (
          <div key={i} className="item">
            <span className="grow">
              <span className="name">{x.subject || x.class}</span>
              <span className="meta">
                {x.subject && <span>{x.class}</span>}
                {x.by && <span>from {x.by}</span>}
                {x.place && x.place !== x.by && <span>{x.place}</span>}
                <span>{day(x.updated_at)}</span>
              </span>
            </span>
            <b className="predicted-grade">{x.grade}</b>
          </div>
        ))}
      </div>
    </section>
  );
}

// A learner's transcript from one place (report polish): the grades from every term report it sent out, attendance over
// each, IB core results and, if asked for, predicted grades, with the place's look. Staff see their own place's; the
// learner and their parents choose from the places that sent them reports (predicted grades only once shared).
export function TranscriptPage({ learner }) {
  const app = useApp();
  const staff = app.me.role === 'tutor';
  const [org, setOrg] = useState(null);
  const [predicted, setPredicted] = useState(false);
  const q = useQuery(`transcript:${learner}:${org || ''}:${predicted}`, () => api.transcript(learner, org, predicted));
  const t = q.data;
  const back = staff ? `/learners/${learner}` : app.me.role === 'parent' ? '/marks' : '/progress';
  const terms = t?.terms || [];
  return (
    <Page
      eyebrow={
        <Link to={back}>
          <Icon name="left" size={14} /> Back
        </Link>
      }
      title="Transcript"
      subtitle={t ? [t.learner?.name, t.brand?.name].filter(Boolean).join(' · ') : ''}
      actions={
        terms.length > 0 && (
          <button className="btn" onClick={printTerms}>
            <Icon name="download" size={16} /> Print or save as PDF
          </button>
        )
      }
    >
      {!t ? (
        q.error ? <Empty title="This transcript isn’t here">{q.error.message}</Empty> : <Loading />
      ) : (
        <>
          <div className="row wrap" style={{ gap: 12, alignItems: 'center' }}>
            {!staff && t.places?.length > 1 && (
              <select className="select" style={{ width: 'auto' }} aria-label="From" value={t.org_id || ''} onChange={(e) => setOrg(e.target.value)}>
                {t.places.map((p) => (
                  <option key={p.org_id} value={p.org_id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            <label className="row" style={{ gap: 8 }}>
              <input type="checkbox" checked={predicted} onChange={(e) => setPredicted(e.target.checked)} />
              <span className="small">{staff ? 'Include predicted grades' : 'Include predicted grades your teachers shared'}</span>
            </label>
          </div>
          {terms.length === 0 ? (
            <Empty title="Nothing on it yet">A transcript shows the grades from term reports that have been sent out. None have been yet.</Empty>
          ) : (
            <div className="term-print">
              <article className="report-card term-card transcript" style={brandStyle(t.brand)} aria-label={`Transcript for ${t.learner.name}`}>
                <BrandHead brand={t.brand} place={t.brand?.name}>
                  <div className="term-who">
                    <h2 className="rc-name">{t.learner.name}</h2>
                    <div className="rc-sub">Transcript{t.learner.grade ? ` · Grade ${t.learner.grade}` : ''}</div>
                  </div>
                </BrandHead>
                <section>
                  <h3 className="rc-h">Grades</h3>
                  <div className="term-atl-wrap">
                    <table className="rc-table term-transcript">
                      <thead>
                        <tr>
                          <th scope="col">Subject</th>
                          {terms.map((x) => (
                            <th key={x.id} scope="col" className="rc-score">
                              {x.title}
                              {x.ends && <span className="rc-muted term-when">{fmt(x.ends)}</span>}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {t.rows.map((row) => (
                          <tr key={row.subject}>
                            <td className="rc-strong">{row.subject}</td>
                            {terms.map((x) => (
                              <td key={x.id} className="rc-score">
                                {row.grades?.[x.id] || '—'}
                                {row.efforts?.[x.id] && <span className="rc-muted term-when">Effort: {EFFORT[row.efforts[x.id]]}</span>}
                              </td>
                            ))}
                          </tr>
                        ))}
                        {terms.some((x) => x.attendance != null) && (
                          <tr>
                            <td className="rc-muted">Attendance</td>
                            {terms.map((x) => (
                              <td key={x.id} className="rc-score">
                                {x.attendance != null ? `${x.attendance}%` : '—'}
                              </td>
                            ))}
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </section>
                {t.core?.length > 0 && (
                  <section>
                    <h3 className="rc-h">Projects</h3>
                    <table className="rc-table">
                      <tbody>
                        {t.core.map((p, i) => (
                          <tr key={i}>
                            <td className="rc-strong">{p.kind}</td>
                            <td className="rc-muted">{[p.title, p.session].filter(Boolean).join(' · ')}</td>
                            <td className="rc-score">{p.grade || (p.status === 'completed' ? 'Completed' : 'In progress')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                )}
                {t.predicted?.length > 0 && (
                  <section>
                    <h3 className="rc-h">Predicted grades</h3>
                    <table className="rc-table">
                      <tbody>
                        {t.predicted.map((p, i) => (
                          <tr key={i}>
                            <td className="rc-strong">{p.subject}</td>
                            <td className="rc-score">{p.grade}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </section>
                )}
                <Signature brand={t.brand} date={t.issued} />
                <footer className="rc-foot">
                  <span>{t.brand?.footer || t.brand?.name}</span>
                  <span>Issued {fmt(t.issued)}</span>
                </footer>
              </article>
            </div>
          )}
        </>
      )}
    </Page>
  );
}
