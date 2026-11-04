// Term reports (running a school, part 2): one learner's end-of-term report from a centre, school or tutor. Each class's
// grade (or IB MYP criteria levels), effort and comment, an overall comment, and attendance and points over the term.
// Learners and their parents read it once it's sent out; staff can look at it any time. It prints or saves as a PDF,
// one at a time or a whole report's worth at once.
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Empty, Link, Loading, Page } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';

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

export function TermCard({ c }) {
  const r = c.round;
  const a = c.attendance || {};
  const b = c.behaviour || {};
  return (
    <article className="report-card term-card" aria-label={`${r.title} for ${c.learner.name}`}>
      <header className="rc-head">
        <div>
          <div className="rc-eyebrow">{c.place}</div>
          <h2 className="rc-name">{c.learner.name}</h2>
          <div className="rc-sub">
            {r.title}
            {termDates(r) ? ` · ${termDates(r)}` : ''}
          </div>
        </div>
      </header>
      {(a.lessons > 0 || b.positive > 0 || b.concern > 0) && (
        <div className="rc-stats">
          <div className="rc-stat">
            <div className="l">Attendance</div>
            <div className="n">{a.pct != null ? `${a.pct}%` : '—'}</div>
          </div>
          <div className="rc-stat">
            <div className="l">Absences</div>
            <div className="n">{a.absent ?? 0}</div>
          </div>
          <div className="rc-stat">
            <div className="l">Late</div>
            <div className="n">{a.late ?? 0}</div>
          </div>
          <div className="rc-stat">
            <div className="l">Points</div>
            <div className="n">
              +{b.positive ?? 0}
              {b.concern > 0 && <span className="rc-muted">{b.concern} concern{b.concern === 1 ? '' : 's'}</span>}
            </div>
          </div>
        </div>
      )}
      <section>
        <h3 className="rc-h">Subjects</h3>
        {c.subjects.length === 0 ? (
          <p className="rc-muted">Nothing written yet.</p>
        ) : (
          c.subjects.map((s) => (
            <div key={s.class} className="term-subject">
              <div className="term-subject-head">
                <div>
                  <div className="rc-strong">{s.subject || s.class}</div>
                  <div className="rc-muted">{[s.subject && s.class, s.teachers].filter(Boolean).join(' · ')}</div>
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
              {s.criteria && (
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
              )}
              {s.atl?.length > 0 && (
                <table className="rc-table term-crit" aria-label="Approaches to learning">
                  <tbody>
                    {s.atl.map((a) => (
                      <tr key={a.skill}>
                        <td>{a.skill} skills</td>
                        <td className="rc-score">{a.rating}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {s.comment && <p className="rc-text">{s.comment}</p>}
              {c.staff && !s.done && <div className="rc-muted">Not finished yet</div>}
            </div>
          ))
        )}
      </section>
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
      <footer className="rc-foot">
        <span>{c.place}</span>
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
    </section>
  );
}
