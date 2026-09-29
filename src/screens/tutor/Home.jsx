import { useMemo } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Link, Page, go } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, dur, due, when, kindLabel, weekRange, ymd } from '../../lib/format.js';
import { useLookups } from '../shared/lookups.jsx';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default function Home() {
  const app = useApp();
  const lk = useLookups();
  const attempts = useQuery('attempts', api.listAttempts).data || [];
  const assignments = useQuery('assignments', api.listAssignments).data || [];
  const comments = useQuery('comments', api.listComments).data || [];
  const sessions = useQuery('sessions', api.listSessions).data || [];
  const activity = useQuery('activity', api.listActivity).data || [];
  const files = useQuery('files', api.listFiles).data || [];
  const settings = useQuery('settings', api.getSettings).data;

  const aById = useMemo(() => Object.fromEntries(assignments.map((a) => [a.id, a])), [assignments]);
  const toMark = attempts.filter((a) => a.status === 'submitted');
  const liveNow = attempts.filter((t) => t.status === 'in_progress' && aById[t.assignment_id]?.camera);
  const notes = comments.filter((c) => c.author_id !== app.me.id && !c.read_at).slice(-6).reverse();
  const { from } = weekRange(0);
  const weekStr = ymd(from);
  const weekSeconds = (lid) => activity.filter((x) => (!lid || x.learner_id === lid) && x.day >= weekStr).reduce((s, x) => s + x.seconds, 0);
  const soon = assignments
    .filter((a) => !a.draft && a.due_at && new Date(a.due_at) > new Date() && new Date(a.due_at) < new Date(Date.now() + 8 * 86400000))
    .sort((x, y) => new Date(x.due_at) - new Date(y.due_at));
  const upcoming = sessions.filter((s) => new Date(s.starts_at).getTime() + s.duration_min * 60000 > Date.now()).slice(0, 4);

  const setup = [
    { done: lk.subjects.length > 0, label: 'Add your programmes and subjects', to: '/structure' },
    { done: lk.learners.length > 0, label: 'Invite your first learner', to: '/learners' },
    { done: files.length > 0, label: 'Upload a textbook or worksheet (PDF)', to: '/library' },
    { done: assignments.length > 0, label: 'Set the first piece of work', to: '/assignments' },
    { done: !!settings?.livekit_url, label: 'Turn on live video (for sessions and exam cameras)', to: '/settings' },
  ];
  const setupLeft = setup.filter((s) => !s.done).length;

  return (
    <Page eyebrow={new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })} title={`${greeting()}, ${app.me.display_name.split(' ')[0]}`}>
      <div className="kpi">
        <Kpi n={toMark.length} l="Ready to mark" to="/marking" />
        <Kpi n={notes.length} l="New notes" to="/messages" />
        <Kpi n={soon.length} l="Due in the next week" to="/assignments" />
        <Kpi n={dur(weekSeconds())} l="Studied this week" to="/learners" />
      </div>

      {setupLeft > 0 && (
        <div className="card tint">
          <div className="card-head">
            <h2>Get StudyBridge ready</h2>
            <span className="small muted">{setup.length - setupLeft} of {setup.length} done</span>
          </div>
          <div className="list">
            {setup.map((s) => (
              <Link key={s.label} to={s.to} className="item">
                <Icon name={s.done ? 'checkCircle' : 'circle'} style={{ color: s.done ? 'var(--good)' : 'var(--muted)' }} />
                <span className="grow">
                  <span className="name" style={{ textDecoration: s.done ? 'line-through' : 'none', color: s.done ? 'var(--muted)' : undefined }}>
                    {s.label}
                  </span>
                </span>
                <Icon name="right" size={18} />
              </Link>
            ))}
          </div>
        </div>
      )}

      {liveNow.length > 0 && (
        <div className="card warn">
          <div className="card-head">
            <h2 className="row">
              <span className="dot live" /> Working now with camera on
            </h2>
          </div>
          <div className="list">
            {liveNow.map((t) => (
              <Link key={t.id} to={`/watch/${t.id}`} className="item">
                <Avatar person={lk.learner(t.learner_id)} size="sm" />
                <span className="grow">
                  <span className="name">
                    {lk.learner(t.learner_id)?.display_name} · {aById[t.assignment_id]?.title}
                  </span>
                  <span className="meta">Started {ago(t.started_at)}</span>
                </span>
                <span className="btn sm primary">Watch</span>
              </Link>
            ))}
          </div>
        </div>
      )}

      <div className="split">
        <div className="stack lg">
          <div className="card">
            <div className="card-head">
              <h2>Ready to mark</h2>
              <Link to="/marking" className="small">
                All marking
              </Link>
            </div>
            {toMark.length === 0 ? (
              <Empty>Nothing waiting. Submissions appear here the moment they come in.</Empty>
            ) : (
              <div className="list">
                {toMark.slice(0, 6).map((t) => {
                  const a = aById[t.assignment_id];
                  const late = a?.due_at && t.submitted_at && new Date(t.submitted_at) > new Date(a.due_at);
                  return (
                    <Link key={t.id} to={`/marking/${t.id}`} className="item">
                      <Avatar person={lk.learner(t.learner_id)} size="sm" />
                      <span className="grow">
                        <span className="name">{a?.title || 'Assignment'}</span>
                        <span className="meta">
                          {lk.learner(t.learner_id)?.display_name} · {kindLabel[a?.kind]} · submitted {ago(t.submitted_at)}
                          {late && <span className="pill bad">Late</span>}
                          {(t.lockdown_events || []).length > 0 && <span className="pill warn">{t.lockdown_events.length} lockdown alert{t.lockdown_events.length > 1 ? 's' : ''}</span>}
                        </span>
                      </span>
                      <Icon name="right" size={18} />
                    </Link>
                  );
                })}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <h2>Learners this week</h2>
              <Link to="/learners" className="small">
                All learners
              </Link>
            </div>
            {lk.learners.length === 0 ? (
              <Empty action={<button className="btn primary" onClick={() => go('/learners')}><Icon name="plus" size={18} /> Invite a learner</button>}>
                No learners yet.
              </Empty>
            ) : (
              <div className="list">
                {lk.learners.map((l) => {
                  const open = attempts.filter((t) => t.learner_id === l.id && t.status === 'in_progress').length;
                  return (
                    <Link key={l.id} to={`/learners/${l.id}`} className="item">
                      <Avatar person={l} />
                      <span className="grow">
                        <span className="name">{l.display_name}</span>
                        <span className="meta">
                          {dur(weekSeconds(l.id))} studied this week
                          {open > 0 && <span className="pill accent">{open} in progress</span>}
                        </span>
                      </span>
                      <Icon name="right" size={18} />
                    </Link>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <div className="stack lg">
          <div className="card">
            <div className="card-head">
              <h2>New notes</h2>
              <Link to="/messages" className="small">
                Messages
              </Link>
            </div>
            {notes.length === 0 ? (
              <div className="muted small">No new notes from learners.</div>
            ) : (
              <div className="list">
                {notes.map((c) => (
                  <Link key={c.id} to={`/messages/${c.learner_id}`} className="item">
                    <Avatar person={lk.learner(c.learner_id)} size="sm" />
                    <span className="grow">
                      <span className="name">{lk.learner(c.learner_id)?.display_name}{c.assignment_id && aById[c.assignment_id] ? ` · ${aById[c.assignment_id].title}` : ''}</span>
                      <span className="meta ellipsis" style={{ display: 'block' }}>{c.body}</span>
                    </span>
                    <span className="tiny muted">{ago(c.created_at)}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>
          <div className="card">
            <h2>Coming up</h2>
            {soon.length === 0 && upcoming.length === 0 && <div className="muted small">Nothing due in the next week.</div>}
            <div className="list">
              {upcoming.map((s) => (
                <Link key={s.id} to={`/live/${s.id}`} className="item">
                  <Icon name="video" style={{ color: 'var(--accent)' }} />
                  <span className="grow">
                    <span className="name">{s.title}</span>
                    <span className="meta">Live · {when(s.starts_at)}</span>
                  </span>
                </Link>
              ))}
              {soon.map((a) => (
                <Link key={a.id} to={`/assignments/${a.id}`} className="item">
                  <Icon name="clipboard" style={{ color: 'var(--muted)' }} />
                  <span className="grow">
                    <span className="name">{a.title}</span>
                    <span className="meta">{due(a.due_at).text}</span>
                  </span>
                </Link>
              ))}
            </div>
          </div>
        </div>
      </div>
    </Page>
  );
}

function Kpi({ n, l, to }) {
  return (
    <Link to={to} className="stat" style={{ textDecoration: 'none', color: 'inherit' }}>
      <div className="n">{n}</div>
      <div className="l">{l}</div>
    </Link>
  );
}
