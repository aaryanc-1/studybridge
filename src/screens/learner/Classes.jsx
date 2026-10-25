// A learner's classes: each class's stream (posts from their teachers, and what's been set for the class). Only shown to
// learners who are in a class.
import Icon from '../../ui/Icon.jsx';
import { Empty, Link, Loading, Page } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago } from '../../lib/format.js';
import { SubjectTag } from '../shared/lookups.jsx';
import { FromPlace } from '../shared/places.jsx';
import Stream from '../shared/Stream.jsx';

export const useMyClasses = (on = true) => useQuery(on ? 'my-classes' : null, api.myClasses);

// Words from a post, without the maths and formatting codes, for a one-line preview
const preview = (x) => String(x?.body_md || '').replace(/[$*#_`>\\{}]+/g, '').replace(/\s+/g, ' ').trim() || (x?.files ? 'Shared a picture or file' : '');

export function ClassList() {
  const q = useMyClasses();
  const list = q.data;
  return (
    <Page title="My classes" subtitle="News from your teachers, and what’s been set for each class.">
      {!list ? (
        q.error ? <div className="error">{q.error.message}</div> : <Loading />
      ) : list.length === 0 ? (
        <Empty title="You’re not in a class">When a teacher puts you in a class, it shows up here.</Empty>
      ) : (
        list.map((c) => (
          <Link key={c.id} to={`/classes/${c.id}`} className="card class-tile" aria-label={`Open ${c.name}`}>
            <span className="stream-work-icon" aria-hidden="true">
              <Icon name="users" size={18} />
            </span>
            <span className="grow stack sm">
              <span className="row wrap" style={{ gap: 8 }}>
                <span className="name">{c.name}</span>
                {c.subject_id && <SubjectTag id={c.subject_id} />}
                <FromPlace tutorId={c.tutor_id} />
                {c.new > 0 && <span className="pill good">{c.new} new</span>}
              </span>
              <span className="small muted">{(c.teachers || []).join(', ')}</span>
              {c.latest && (
                <span className="latest">
                  <b>{c.latest.author}:</b> {preview(c.latest)} · {ago(c.latest.at)}
                </span>
              )}
            </span>
            <Icon name="right" size={18} />
          </Link>
        ))
      )}
    </Page>
  );
}

export function ClassView({ id }) {
  const q = useMyClasses();
  const c = (q.data || []).find((x) => x.id === id);
  return (
    <Page
      eyebrow={
        <>
          <Link to="/classes">My classes</Link> <Icon name="right" size={14} /> {c?.name || 'Class'}
        </>
      }
      title={c?.name || 'Class'}
      subtitle={c ? (c.teachers || []).join(', ') : ''}
    >
      <Stream classId={id} learner />
    </Page>
  );
}

// On Today: classes with posts the learner hasn't seen yet
export function NewInClasses() {
  const list = (useMyClasses().data || []).filter((c) => c.new > 0);
  if (!list.length) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h2>New in your classes</h2>
      </div>
      <div className="list">
        {list.map((c) => (
          <Link key={c.id} to={`/classes/${c.id}`} className="item click">
            <Icon name="megaphone" size={18} style={{ color: 'var(--accent)' }} />
            <span className="grow">
              <span className="name">{c.name}</span>
              {c.latest && (
                <span className="meta ellipsis">
                  {c.latest.author}: {preview(c.latest)}
                </span>
              )}
            </span>
            <span className="pill good">{c.new} new</span>
          </Link>
        ))}
      </div>
    </div>
  );
}
