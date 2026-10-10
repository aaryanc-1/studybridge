import { useApp } from '../../App.jsx';
import { StudyNudge } from './Study.jsx';
import { SelfPlan, TrialNote } from './SelfStudy.jsx';
import Icon from '../../ui/Icon.jsx';
import { Empty, Link, go } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, due, dur, kindLabel, when, weekRange, ymd } from '../../lib/format.js';
import { useLookups } from '../shared/lookups.jsx';
import { workState, needsAction } from './workState.js';

export default function Today() {
  const app = useApp();
  const lk = useLookups();
  const assignments = useQuery('assignments', api.listAssignments).data || [];
  const attempts = useQuery('myattempts', () => api.myAttempts()).data || [];
  const sessions = useQuery('sessions', api.listSessions).data || [];
  const lessons = useQuery('lessons', api.listLessons).data || [];
  const files = useQuery('files', api.listFiles).data || [];
  const comments = useQuery('comments', api.listComments).data || [];
  const progress = useQuery(`progress:${app.me.id}`, () => api.learnerProgress(app.me.id)).data;
  const week = useQuery(`summary:${app.me.id}:week:${weekRange(0).from.toISOString().slice(0, 10)}`, () => api.learnerSummary(app.me.id, weekRange(0).from, weekRange(0).to)).data;

  const states = assignments.filter((a) => !a.practice).map((a) => ({ a, s: workState(a, attempts) }));
  const practiceNew = assignments.filter((a) => a.practice && !attempts.some((t) => t.assignment_id === a.id));
  const todo = states.filter((x) => needsAction(x.s)).sort((x, y) => (x.a.due_at ? new Date(x.a.due_at) : Infinity) - (y.a.due_at ? new Date(y.a.due_at) : Infinity));
  const back = attempts.filter((t) => t.released && t.submitted_at && Date.now() - new Date(t.submitted_at) < 14 * 86400000).slice(0, 4);
  const nextSession = sessions.find((s) => new Date(s.starts_at).getTime() + s.duration_min * 60000 > Date.now());
  const fresh = [...lessons.map((l) => ({ ...l, _k: 'lesson' })), ...files.map((f) => ({ ...f, _k: 'file' }))].filter((x) => Date.now() - new Date(x.visible_from || x.created_at) < 7 * 86400000).slice(0, 5);
  const unread = comments.filter((c) => c.author_id !== app.me.id && !c.read_at);
  const tutor = app.me.tutor_id;
  const weak = (progress?.topics || []).filter((t) => t.strength === 'weak').slice(0, 3);
  const aById = Object.fromEntries(assignments.map((a) => [a.id, a]));
  const activity = useQuery('activity', api.listActivity).data || [];

  // Study streak: days in a row with some study, ending today (or yesterday)
  const days = new Set(activity.map((x) => x.day));
  let streak = 0;
  for (let d = new Date(), i = 0; i < 400; i++, d = new Date(d.getTime() - 86400000)) {
    if (days.has(ymd(d))) streak++;
    else if (i > 0 || streak > 0) break;
  }
  // the same streak as Study shows (worked out by the server in her own time zone)
  const study = useQuery('study', () => api.studySummary()).data;
  if (study && Number.isFinite(study.streak)) streak = study.streak;
  const monday = weekRange(0).from;
  const weekDays = Array.from({ length: 7 }, (_, i) => new Date(monday.getTime() + i * 86400000));
  const hour = new Date().getHours();
  const next = todo[0];

  return (
    <div className="page">
      <div className="hero">
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div className="date">
            <Icon name={hour < 18 ? 'sun' : 'moon'} size={16} /> {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}
          </div>
          <h1>
            {hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, {app.me.display_name.split(' ')[0]}!
          </h1>
          <div className="sub">{todo.length ? `You have ${todo.length} thing${todo.length > 1 ? 's' : ''} to do. You’ve got this.` : 'All caught up. Nice work!'}</div>
        </div>
        <div className="hero-stats">
          <div className="hero-stat">
            <div className="n">
              <Icon name="flame" size={22} /> {streak}
            </div>
            <div className="l">day{streak === 1 ? '' : 's'} in a row</div>
          </div>
          <div className="hero-stat">
            <div className="n">{week ? dur(week.seconds) : '—'}</div>
            <div className="l">studied this week</div>
            <div className="week-dots" aria-label="Days studied this week">
              {weekDays.map((d) => (
                <span key={ymd(d)} className={(days.has(ymd(d)) ? 'on ' : '') + (ymd(d) === ymd(new Date()) ? 'today' : '')} title={d.toDateString()}>
                  {d.toLocaleDateString(undefined, { weekday: 'narrow' })}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <TrialNote />
      <SelfPlan />
      <StudyNudge />

      {nextSession && new Date(nextSession.starts_at).getTime() - Date.now() < 30 * 60000 && (
        <div className="card tint">
          <div className="row between wrap">
            <div className="row">
              <span className="dot live" />
              <div>
                <div className="strong">{nextSession.title}</div>
                <div className="small muted">Live lesson · {when(nextSession.starts_at)}</div>
              </div>
            </div>
            <button className="btn primary" onClick={() => go(`/live/${nextSession.id}`)}>
              <Icon name="video" size={18} /> Join
            </button>
          </div>
        </div>
      )}

      {next && (
        <div className="up-next" onClick={(e) => !e.target.closest('button') && go(`/work/${next.a.id}`)} style={{ cursor: 'pointer' }}>
          <span className="badge" style={{ background: lk.subject(next.a.subject_id)?.color || 'var(--accent)' }}>
            <Icon name={next.a.kind === 'exam' || next.a.kind === 'test' ? 'target' : next.a.kind === 'quiz' ? 'star' : 'pen'} size={28} />
          </span>
          <div className="grow stack sm">
            <div className="row wrap" style={{ gap: 8 }}>
              <span className="small strong muted">UP NEXT</span>
              <span className={'kind-pill ' + next.a.kind}>{kindLabel[next.a.kind]}</span>
              {next.s.key !== 'todo' && <span className={'pill ' + next.s.tone}>{next.s.label}</span>}
            </div>
            <div className="t">{next.a.title}</div>
            <div className="small muted">
              {lk.subject(next.a.subject_id)?.name ? `${lk.subject(next.a.subject_id).name} · ` : ''}
              {due(next.a.due_at).text}
            </div>
          </div>
          <button className="btn primary big" onClick={() => go(`/work/${next.a.id}`)}>
            {next.s.key === 'doing' ? 'Keep going' : next.s.key === 'redo' ? 'Redo it' : 'Let’s start'} <Icon name="send2" size={18} />
          </button>
        </div>
      )}

      <div className="split">
        <div className="stack lg">
          <div className="card">
            <div className="card-head">
              <h2>To do</h2>
              <Link to="/work" className="small">
                All work
              </Link>
            </div>
            {todo.length === 0 ? (
              <Empty>Nothing to do right now. New work shows up here.</Empty>
            ) : (
              <div className="stack">
                {todo.map(({ a, s }) => {
                  const d = due(a.due_at);
                  return (
                    <button key={a.id} className="work-card" onClick={() => go(`/work/${a.id}`)}>
                      <span className="bar-l" style={{ background: lk.subject(a.subject_id)?.color || 'var(--accent)' }} />
                      <span className="grow stack sm">
                        <span className="row wrap" style={{ gap: 8 }}>
                          <span className={'kind-pill ' + a.kind}>{kindLabel[a.kind]}</span>
                          {s.key !== 'todo' && <span className={'pill ' + s.tone}>{s.label}</span>}
                          {a.lockdown && <span className="pill dark"><Icon name="lock" size={12} /> Locked</span>}
                          {a.time_limit_min && <span className="pill"><Icon name="clock" size={12} /> {a.time_limit_min} min</span>}
                        </span>
                        <span className="strong" style={{ fontSize: 16 }}>{a.title}</span>
                        <span className={'small ' + (d.tone === 'bad' ? '' : 'muted')} style={d.tone === 'bad' ? { color: 'var(--red-ink)' } : undefined}>
                          {lk.subject(a.subject_id)?.name ? `${lk.subject(a.subject_id).name} · ` : ''}
                          {d.text}
                        </span>
                      </span>
                      <Icon name="right" />
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          {practiceNew.length > 0 && (
            <Link to="/work?tab=practice" className="card tint row">
              <Icon name="target" style={{ color: 'var(--accent)' }} />
              <span className="grow">
                <span className="strong">{app.me.self_learner ? 'New practice' : 'New practice from your tutor'}</span>
                <span className="small muted"> · {practiceNew.map((a) => a.title).join(', ')}. Marked straight away; do it as often as you like.</span>
              </span>
              <Icon name="right" />
            </Link>
          )}
          {back.length > 0 && (
            <div className="card">
              <h2>Marks back</h2>
              <div className="list">
                {back.map((t) => (
                  <Link key={t.id} to={`/results/${t.id}`} className="item">
                    <Icon name="checkCircle" style={{ color: 'var(--good)' }} />
                    <span className="grow">
                      <span className="name">{aById[t.assignment_id]?.title || 'Assignment'}</span>
                      <span className="meta">Submitted {ago(t.submitted_at)}</span>
                    </span>
                    <span className="strong">{t.score != null ? `${Number(t.score)} / ${Number(t.max_score)}` : ''}</span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="stack lg">
          <div className="card">
            <h2>This week</h2>
            <div className="grid g2" style={{ gap: 12 }}>
              <div className="stat">
                <div className="n">{attempts.filter((t) => t.released && new Date(t.released_at || t.submitted_at) >= weekRange(0).from).length}</div>
                <div className="l">Marks back</div>
              </div>
              <div className="stat">
                <div className="n">{week ? week.assignments.length : '—'}</div>
                <div className="l">Handed in</div>
              </div>
            </div>
            {weak.length > 0 && (
              <div className="small">
                <span className="muted">Worth practising: </span>
                {weak.map((t) => t.topic).join(', ')}
              </div>
            )}
            <Link to="/progress" className="small">
              See my progress
            </Link>
          </div>
          {unread.length > 0 && (
            <div className="card">
              <h2>New messages</h2>
              {unread.slice(-3).map((c) => (
                <Link key={c.id} to="/messages" className="item">
                  <Icon name="message" style={{ color: 'var(--accent)' }} />
                  <span className="grow">
                    <span className="name ellipsis">{c.body}</span>
                    <span className="meta">{ago(c.created_at)}</span>
                  </span>
                </Link>
              ))}
            </div>
          )}
          {nextSession && (
            <div className="card">
              <h2>Next live lesson</h2>
              <div className="strong">{nextSession.title}</div>
              <div className="small muted">{when(nextSession.starts_at)} · {nextSession.duration_min} min</div>
            </div>
          )}
          {fresh.length > 0 && (
            <div className="card">
              <h2>New in your library</h2>
              <div className="list">
                {fresh.map((x) => (
                  <Link key={x.id} to={x._k === 'lesson' ? `/lesson/${x.id}` : `/file/${x.id}`} className="item">
                    <Icon name={x._k === 'lesson' ? 'book' : 'file'} style={{ color: 'var(--accent)' }} />
                    <span className="grow">
                      <span className="name">{x.title || x.name}</span>
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
          {!tutor && !app.me.self_learner && <div className="note small">You’re not connected to a tutor any more.</div>}
        </div>
      </div>
    </div>
  );
}
