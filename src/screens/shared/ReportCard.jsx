// The weekly report as a proper report page (1.6): filled in by StudyBridge from the week's lessons, work,
// marks, topics, mock grade and exam date. The only words a person writes are the tutor's comment and
// (if they like) next week's plan. The same page is what the tutor approves, the parent reads in their
// account, and the learner sees; it prints or saves as a PDF.
import Icon from '../../ui/Icon.jsx';
import { dur } from '../../lib/format.js';

const fmt = (d, opts) => new Date(String(d).length === 10 ? d + 'T12:00:00' : d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...opts });
const STATUS = { on_time: ['On time', 'good'], late: ['Late', 'warn'], missing: ['Not handed in', 'bad'], open: ['Not due yet', ''] };
const KIND = { homework: 'Homework', quiz: 'Quiz', test: 'Test', exam: 'Exam' };
const n = (x) => (x == null ? '' : String(Math.round(Number(x) * 10) / 10));

export function printReport() {
  document.body.classList.add('print-report');
  const done = () => {
    document.body.classList.remove('print-report');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
  setTimeout(done, 3000);
}

export default function ReportCard({ report, tutorName, draft = false, compact = false }) {
  const d = report.data || {};
  const work = d.work || [];
  const onTime = work.filter((w) => w.status === 'on_time').length;
  const due = work.filter((w) => w.status !== 'open').length;
  const topics = (d.topics || []).filter((t) => t.ratio != null).sort((a, b) => b.ratio - a.ratio);
  const strong = topics.filter((t) => t.strength === 'strong').slice(0, 3);
  const weak = topics.filter((t) => t.strength === 'weak' || t.strength === 'developing').slice(-3).reverse();
  const trend = d.avg_pct != null && d.prev_avg_pct != null ? d.avg_pct - d.prev_avg_pct : null;
  const to = d.to ? new Date(new Date(d.to).getTime() - 864e5) : null;
  const tutor = tutorName || d.tutor || 'Your tutor';
  const next = report.next_week ? null : (d.next || []).slice(0, 5);
  return (
    <article className={'report-card' + (compact ? ' compact' : '')} aria-label={`Weekly report for ${d.learner || 'the learner'}`}>
      <header className="rc-head">
        <div>
          <div className="rc-eyebrow">Weekly report{draft ? ' · draft' : ''}</div>
          <h2 className="rc-name">{d.learner || 'Learner'}</h2>
          <div className="rc-sub">
            {d.from && to ? `${fmt(d.from)} – ${fmt(to, { year: 'numeric' })}` : ''} · {tutor}
          </div>
        </div>
        {d.exam?.date && d.exam.days >= 0 && (
          <div className="rc-countdown">
            <div className="n">{d.exam.days}</div>
            <div className="l">days to {d.exam.name || 'the exam'}</div>
          </div>
        )}
      </header>

      <div className="rc-stats">
        <div className="rc-stat">
          <Icon name="video" size={18} />
          <div className="n">{d.lessons || 0}</div>
          <div className="l">live lesson{d.lessons === 1 ? '' : 's'}</div>
        </div>
        <div className="rc-stat">
          <Icon name="clipboard" size={18} />
          <div className="n">{due ? `${onTime}/${due}` : '—'}</div>
          <div className="l">work on time</div>
        </div>
        <div className="rc-stat">
          <Icon name="chart" size={18} />
          <div className="n">
            {d.avg_pct != null ? `${d.avg_pct}%` : '—'}
            {trend != null && trend !== 0 && (
              <span className={'rc-trend ' + (trend > 0 ? 'up' : 'down')} title={`${trend > 0 ? 'Up' : 'Down'} from ${d.prev_avg_pct}% before`}>
                {trend > 0 ? '▲' : '▼'} {Math.abs(trend)}
              </span>
            )}
          </div>
          <div className="l">average mark</div>
        </div>
        <div className="rc-stat">
          <Icon name="clock" size={18} />
          <div className="n">{d.seconds ? dur(d.seconds) : '—'}</div>
          <div className="l">time studying</div>
        </div>
      </div>

      {report.comment && (
        <section className="rc-comment">
          <div className="rc-label">From {tutor}</div>
          <p>{report.comment}</p>
        </section>
      )}

      <section>
        <h3 className="rc-h">Work this week</h3>
        {work.length === 0 ? (
          <div className="rc-muted">Nothing was due this week.</div>
        ) : (
          <table className="rc-table">
            <tbody>
              {work.slice(0, 10).map((w, i) => {
                const [label, tone] = STATUS[w.status] || [w.status, ''];
                return (
                  <tr key={i}>
                    <td>
                      <div className="rc-strong">{w.title}</div>
                      <div className="rc-muted">
                        {KIND[w.kind] || w.kind}
                        {w.due_at ? ` · due ${fmt(w.due_at, { weekday: 'short' })}` : ''}
                      </div>
                    </td>
                    <td>
                      <span className={'pill ' + tone}>{label}</span>
                    </td>
                    <td className="rc-score">{w.score != null && w.max ? `${n(w.score)}/${n(w.max)}` : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        {d.practice?.tries > 0 && (
          <div className="rc-muted">
            Extra practice: {d.practice.tries} tr{d.practice.tries === 1 ? 'y' : 'ies'}
            {d.practice.pct != null ? `, ${d.practice.pct}% on average` : ''}
          </div>
        )}
      </section>

      {(strong.length > 0 || weak.length > 0 || d.mock) && (
        <div className="rc-two">
          {(strong.length > 0 || weak.length > 0) && (
            <section>
              <h3 className="rc-h">Topics</h3>
              {strong.map((t) => (
                <TopicBar key={'s' + t.topic} t={t} tone="good" label="Strong" />
              ))}
              {weak.map((t) => (
                <TopicBar key={'w' + t.topic} t={t} tone={t.strength === 'weak' ? 'bad' : 'warn'} label="To work on" />
              ))}
            </section>
          )}
          {d.mock && (
            <section className="rc-mock">
              <h3 className="rc-h">Latest mock exam</h3>
              <div className="row" style={{ gap: 14 }}>
                <span className="mock-grade">{d.mock.grade || '—'}</span>
                <div>
                  <div className="rc-strong">{d.mock.title}</div>
                  <div className="rc-muted">
                    {d.mock.pct}%{d.mock.next && d.mock.short_by != null ? ` · ${n(d.mock.short_by)} marks short of ${d.mock.next}` : ''}
                  </div>
                </div>
              </div>
            </section>
          )}
        </div>
      )}

      {(report.next_week || next?.length > 0) && (
        <section>
          <h3 className="rc-h">Next week</h3>
          {report.next_week ? (
            <p className="rc-text">{report.next_week}</p>
          ) : (
            <ul className="rc-list">
              {next.map((x, i) => (
                <li key={i}>
                  {x.title} <span className="rc-muted">· {KIND[x.kind] || x.kind}, due {fmt(x.due_at, { weekday: 'short' })}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <footer className="rc-foot">
        <span>StudyBridge</span>
        <span>{report.sent_at ? `Sent ${fmt(report.sent_at, { year: 'numeric' })}` : draft ? 'Not sent yet' : ''}</span>
      </footer>
    </article>
  );
}

function TopicBar({ t, tone, label }) {
  const pct = Math.round((t.ratio || 0) * 100);
  return (
    <div className="rc-topic">
      <div className="row between">
        <span className="rc-strong">{t.topic}</span>
        <span className={'pill ' + tone}>
          {label} · {pct}%
        </span>
      </div>
      <div className="rc-bar">
        <i className={tone} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
