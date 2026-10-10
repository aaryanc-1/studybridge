import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Bar, Empty, Loading, Seg, copyText, useToast } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { day, dur, kindLabel, monthRange, pct, weekRange, ymd } from '../../lib/format.js';
import MockHistory from './MockHistory.jsx';

const PERIODS = {
  week: { label: 'This week', range: () => weekRange(0) },
  lastweek: { label: 'Last week', range: () => weekRange(-1) },
  month: { label: 'This month', range: () => monthRange(0) },
  lastmonth: { label: 'Last month', range: () => monthRange(-1) },
};

const tone = { strong: 'good', developing: 'warn', weak: 'bad', none: '' };
const label = { strong: 'Strong', developing: 'Developing', weak: 'Needs work', none: '—' };

// Short times for the chart: "45m", "1h 10m", "2h"
function short(sec) {
  const m = Math.round((sec || 0) / 60);
  if (sec > 0 && m < 1) return '<1m';
  if (m < 60) return `${m}m`;
  return m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`;
}

export default function ProgressView({ learnerId, name }) {
  const app = useApp();
  const toast = useToast();
  const isTutor = app.me.role === 'tutor';
  const [period, setPeriod] = useState('week');
  const { from, to } = PERIODS[period].range();
  const prog = useQuery(`progress:${learnerId}`, () => api.learnerProgress(learnerId));
  const sum = useQuery(`summary:${learnerId}:${period}:${from.toISOString().slice(0, 10)}`, () => api.learnerSummary(learnerId, from, to));

  const p = prog.data;
  const s = sum.data;
  const scored = (s?.assignments || []).filter((a) => a.score != null && a.max_score);
  const avg = scored.length ? Math.round(scored.reduce((x, a) => x + (a.score / a.max_score) * 100, 0) / scored.length) : null;

  // Build the day-by-day chart for the period
  const days = [];
  for (let d = new Date(from); d < to && days.length < 31; d = new Date(d.getTime() + 86400000)) {
    const key = ymd(d);
    const hit = (s?.by_day || []).find((x) => x.day === key);
    days.push({ key, d, seconds: hit ? hit.seconds : 0, subjects: hit?.subjects || [] });
  }
  const maxDay = Math.max(1, ...days.map((d) => d.seconds));
  // the scale tops out at a round number of minutes just above the busiest day
  const top = [10, 20, 30, 60, 90, 120, 180, 240, 300, 360, 480, 600, 720].map((m) => m * 60).find((x) => x >= maxDay) || maxDay; // halves are round too
  const studied = days.filter((d) => d.seconds > 0).length;

  function summaryText() {
    const lines = [
      `${name} · ${PERIODS[period].label} (${day(from)} – ${day(new Date(to.getTime() - 1))})`,
      `Time studied: ${dur(s.seconds)}`,
      `Work submitted: ${s.assignments.length}${avg != null ? ` · average score ${avg}%` : ''}`,
    ];
    if (s.assignments.length) {
      lines.push('', 'Work:');
      for (const a of s.assignments) lines.push(`• ${a.title} (${kindLabel[a.kind]})${a.score != null ? ` – ${Number(a.score)}/${Number(a.max_score)}` : ''}${a.late ? ' – late' : ''}`);
    }
    if (s.missed.length) {
      lines.push('', 'Missed:');
      for (const m of s.missed) lines.push(`• ${m.title} (due ${day(m.due_at)})`);
    }
    const strong = (p?.topics || []).filter((t) => t.strength === 'strong').map((t) => t.topic);
    const weak = (p?.topics || []).filter((t) => t.strength === 'weak').map((t) => t.topic);
    if (strong.length) lines.push('', `Strong: ${strong.join(', ')}`);
    if (weak.length) lines.push(`Needs work: ${weak.join(', ')}`);
    if (s.mistakes.length) lines.push('', `Common mistakes: ${[...new Set(s.mistakes)].slice(0, 5).join('; ')}`);
    return lines.join('\n');
  }

  return (
    <div className="stack lg">
      <div className="row between wrap">
        <Seg value={period} onChange={setPeriod} options={Object.entries(PERIODS).map(([value, v]) => ({ value, label: v.label }))} label="Period" />
        {s && (
          <div className="row">
            <button className="btn sm" onClick={() => (copyText(summaryText()), toast({ title: 'Summary copied', body: 'Paste it into a message or email.' }))}>
              <Icon name="copy" size={16} /> Copy summary
            </button>
            <button className="btn sm" onClick={() => window.print()}>
              Print
            </button>
          </div>
        )}
      </div>
      {!s ? (
        sum.error ? <div className="error">{sum.error.message}</div> : <Loading />
      ) : (
        <>
          <div className="kpi">
            <div className="stat">
              <div className="n">{dur(s.seconds)}</div>
              <div className="l">Time studied</div>
            </div>
            <div className="stat">
              <div className="n">{s.assignments.length}</div>
              <div className="l">Pieces of work submitted</div>
            </div>
            <div className="stat">
              <div className="n">{avg != null ? avg + '%' : '—'}</div>
              <div className="l">Average score</div>
            </div>
            <div className="stat">
              <div className="n">{s.missed.length}</div>
              <div className="l">Missed deadlines</div>
            </div>
          </div>
          <div className="split even">
            <div className="card">
              <h2>Time each day</h2>
              <div className="day-chart">
                <div className="dc-scale" aria-hidden="true">
                  <span>{short(top)}</span>
                  <span>{short(top / 2)}</span>
                  <span>0</span>
                </div>
                <div className="dc-bars" role="list" aria-label="Time studied each day">
                  {days.map((d) => (
                    <button key={d.key} type="button" className="dc-col" role="listitem" aria-label={`${day(d.d)}: ${d.seconds ? dur(d.seconds) : 'nothing'}`}>
                      {days.length <= 7 && d.seconds > 0 && <span className="dc-v">{short(d.seconds)}</span>}
                      <span className="dc-b" style={{ height: `${Math.round((d.seconds / top) * 100)}%` }} />
                      <span className="dc-tip" role="tooltip">
                        <b>{d.d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' })}</b>
                        <span>{d.seconds ? dur(d.seconds) : 'No study'}</span>
                        {d.subjects.map((x) => (
                          <span key={x.subject} className="dc-sub">
                            {x.subject}: {dur(x.seconds)}
                          </span>
                        ))}
                      </span>
                    </button>
                  ))}
                </div>
                <span />
                <div className="dc-x" aria-hidden="true">
                  {days.map((d) => (
                    <span key={d.key}>{days.length <= 7 ? d.d.toLocaleDateString(undefined, { weekday: 'short' }) : d.d.getDate()}</span>
                  ))}
                </div>
              </div>
              <div className="small muted">
                {s?.seconds ? `${dur(s.seconds)} in all, on ${studied} day${studied === 1 ? '' : 's'} · about ${dur(Math.round(s.seconds / Math.max(1, studied)))} on a day they studied` : 'No study time yet in this period.'}
                {days.length > 7 ? ' Tap or hover a bar for that day.' : ''}
              </div>
              {(s.by_subject || []).length > 0 && (
                <div className="stack sm">
                  <h3>By subject</h3>
                  {s.by_subject.map((x) => (
                    <div key={x.subject} className="row">
                      <span style={{ width: 140 }} className="small ellipsis">{x.subject}</span>
                      <div className="grow">
                        <Bar value={(x.seconds / Math.max(1, s.seconds)) * 100} />
                      </div>
                      <span className="small muted" style={{ width: 70, textAlign: 'right' }}>{dur(x.seconds)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="card">
              <h2>Work in this period</h2>
              {s.assignments.length === 0 && s.missed.length === 0 ? (
                <div className="muted small">Nothing submitted in this period.</div>
              ) : (
                <div className="list">
                  {s.assignments.map((a, i) => (
                    <div className="item" key={i}>
                      <span className="grow">
                        <span className="name">{a.title}</span>
                        <span className="meta">
                          <span className={'kind ' + a.kind}>{kindLabel[a.kind]}</span> {day(a.submitted_at)}
                          {a.late && <span className="pill bad">Late</span>}
                          {isTutor && a.lockdown_flags > 0 && <span className="pill warn">{a.lockdown_flags} lockdown alert{a.lockdown_flags > 1 ? 's' : ''}</span>}
                        </span>
                      </span>
                      <span className="strong">{a.score != null ? `${pct(a.score, a.max_score)}%` : a.status === 'submitted' ? <span className="pill warn">Being marked</span> : '—'}</span>
                    </div>
                  ))}
                  {s.missed.map((m, i) => (
                    <div className="item" key={'m' + i}>
                      <span className="grow">
                        <span className="name">{m.title}</span>
                        <span className="meta">Due {day(m.due_at)}</span>
                      </span>
                      <span className="pill bad">Missed</span>
                    </div>
                  ))}
                </div>
              )}
              {isTutor && s.notes > 0 && <div className="muted small">{s.notes} note{s.notes > 1 ? 's' : ''} left for you in this period.</div>}
            </div>
          </div>
        </>
      )}

      <MockHistory learnerId={learnerId} />

      <div className="split even">
        <div className="card">
          <div className="card-head">
            <h2>Strengths by topic</h2>
            <span className="muted small">From the last 10 marked answers per topic</span>
          </div>
          {!p ? (
            <Loading />
          ) : p.topics.length === 0 ? (
            <Empty>Marked work will show strengths here. Tag questions or assignments with a topic to track it.</Empty>
          ) : (
            <div>
              {p.topics.map((t) => (
                <div className="strength" key={t.topic_id}>
                  <div>
                    <div className="strong">{t.topic}</div>
                    <div className="muted tiny">{t.subject} · {t.answered} answer{t.answered > 1 ? 's' : ''} · {dur(t.seconds)}</div>
                  </div>
                  <Bar value={(t.ratio || 0) * 100} tone={tone[t.strength]} />
                  <span className={'pill ' + tone[t.strength]} style={{ justifySelf: 'end' }}>
                    {label[t.strength]}
                  </span>
                </div>
              ))}
            </div>
          )}
          {p && <div className="muted small">All-time study: {dur(p.total_seconds)}</div>}
        </div>
        <div className="card">
          <h2>Mistakes to work on</h2>
          {!p ? (
            <Loading />
          ) : p.mistakes.length === 0 ? (
            <div className="muted small">No mistakes recorded yet. When marking, add a short “mistake” note to a question and it collects here.</div>
          ) : (
            <div className="list">
              {p.mistakes.slice(0, 12).map((m, i) => (
                <div className="item" key={i} style={{ alignItems: 'flex-start' }}>
                  <Icon name="flag" size={18} style={{ color: 'var(--red)', marginTop: 3 }} />
                  <span className="grow">
                    <span className="strong">{m.mistake}</span>
                    <span className="meta">
                      {m.assignment} · {day(m.at)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
