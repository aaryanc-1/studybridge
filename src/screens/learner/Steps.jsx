// Canvas gaps, part 1 (16 Nov 2026), for learners: a class's steps (its topics in order, each opening once the one
// before is done), what's not open yet (shown, never started), and group work.
import { useMemo } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Link } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { kindLabel, when } from '../../lib/format.js';

export const useMySteps = () => useQuery('my-steps', api.mySteps);

// What isn't open yet: `${kind}:${id}` → the step to finish first
export function useLocks() {
  const steps = useMySteps().data;
  return useMemo(() => {
    const m = new Map();
    for (const c of steps || [])
      for (const s of c.steps || [])
        if (!s.open) for (const it of s.items || []) m.set(`${it.kind}:${it.id}`, { after: s.after, step: s.title, class: c.class });
    return m;
  }, [steps]);
}
export const lockText = (l) => (l?.after ? `Opens when you finish “${l.after}”` : 'Not open yet');

// Hand-ins have closed for this learner (no try started)
export const closedFor = (a) => !!a?.closes_at && new Date(a.closes_at) < new Date();

// A class's steps on the learner's class page
export function MyClassSteps({ classId }) {
  const c = (useMySteps().data || []).find((x) => x.class_id === classId);
  if (!c?.steps?.length) return null;
  const href = (it) => (it.kind === 'assignment' ? `/work/${it.id}` : it.kind === 'lesson' ? `/lesson/${it.id}` : `/file/${it.id}`);
  return (
    <div className="card">
      <h2>Steps</h2>
      <div className="small muted">Work through these in order: each step opens once you’ve finished the one before.</div>
      <ol className="stack" style={{ margin: 0, paddingLeft: 22 }}>
        {c.steps.map((s) => (
          <li key={s.id}>
            <div className="row wrap" style={{ gap: 8 }}>
              <span className="strong">{s.title}</span>
              {s.open ? (
                s.done && s.items.length ? (
                  <span className="pill good">Done</span>
                ) : (
                  <span className="pill accent">Open</span>
                )
              ) : (
                <span className="pill">
                  <Icon name="lock" size={12} /> {lockText(s)}
                </span>
              )}
            </div>
            {s.items.length > 0 && (
              <div className="list small">
                {s.items.map((it) =>
                  s.open ? (
                    <Link key={it.kind + it.id} to={href(it)} className="item">
                      <Icon name={it.done ? 'checkCircle' : it.kind === 'assignment' ? 'clipboard' : it.kind === 'lesson' ? 'book' : 'file'} size={16} style={{ color: it.done ? 'var(--good)' : 'var(--muted)' }} />
                      <span className="grow">{it.title}</span>
                      <span className="muted">{it.kind === 'assignment' ? kindLabel[it.type] || 'Work' : it.kind === 'lesson' ? 'Lesson notes' : 'File'}</span>
                    </Link>
                  ) : (
                    <div key={it.kind + it.id} className="item" aria-disabled="true" style={{ opacity: 0.6 }}>
                      <Icon name="lock" size={16} style={{ color: 'var(--muted)' }} />
                      <span className="grow">{it.title}</span>
                    </div>
                  ),
                )}
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

// On a piece of group work: who's in the group, who has started, and how handing in works
export function GroupCard({ a }) {
  const g = a.group;
  if (!a.groups) return null;
  return (
    <div className="card">
      <h3 className="row">
        <Icon name="users" /> Group work{g?.name ? `: ${g.name}` : ''}
      </h3>
      {g ? (
        <div className="stack sm small">
          <div>
            You’re with <b>{(g.members || []).join(', ') || 'nobody else yet'}</b>. Anyone in the group can hand it in for everyone, and you all get the same marks.
          </div>
          {(g.started || []).length > 0 && (
            <div className="note">
              {g.started.join(' and ')} {g.started.length === 1 ? 'has' : 'have'} started it. Agree who hands it in: when one of you does, it replaces anything the others have started.
            </div>
          )}
        </div>
      ) : (
        <div className="small muted">You’re not in a group for this, so you do it on your own.</div>
      )}
    </div>
  );
}

// The line about closing and late rules on a piece of work
export function WorkRulesNote({ a }) {
  const r = a.late_rule;
  if (!a.closes_at && !r) return null;
  return (
    <div className="small muted stack sm">
      {a.closes_at && (
        <div className="row top" style={{ gap: 8 }}>
          <Icon name="lock" size={16} />
          <span>{closedFor(a) ? `Hand-ins closed ${when(a.closes_at)}.` : `Hand-ins close ${when(a.closes_at)}. After that it can’t be started, and anything still open is handed in as it is.`}</span>
        </div>
      )}
      {r && (
        <div className="row top" style={{ gap: 8 }}>
          <Icon name="clock" size={16} />
          <span>
            Handing in after the due date loses {r.per_day}% of the marks a day{r.max < 100 ? `, up to ${r.max}%` : ''}.
          </span>
        </div>
      )}
    </div>
  );
}
