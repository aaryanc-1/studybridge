import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Markdown, Page, Seg, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago } from '../../lib/format.js';
import { useLookups } from './lookups.jsx';

export default function Messages({ learnerId }) {
  const app = useApp();
  const lk = useLookups();
  const isTutor = app.me.role === 'tutor';
  const comments = useQuery('comments', api.listComments);
  const assignments = useQuery(isTutor ? 'assignments' : 'assignments', api.listAssignments).data || [];
  const all = comments.data || [];
  const who = isTutor ? learnerId : app.me.id;
  // A learner taught by more than one teacher (their tutor and a class's teacher) has a conversation with each
  const teachers = useQuery(isTutor ? null : 'my-teachers', api.myTeachers).data || [];
  const [teacherId, setTeacherId] = useState(null);
  const teacher = teachers.length > 1 ? teachers.find((t) => t.id === teacherId) || teachers[0] : null;
  const unreadFrom = (t) => all.filter((c) => c.tutor_id === t.id && c.author_id !== app.me.id && !c.read_at).length;

  const people = isTutor
    ? lk.learners
        .map((l) => {
          const mine = all.filter((c) => c.learner_id === l.id);
          return { l, last: mine[mine.length - 1], unread: mine.filter((c) => c.author_id !== app.me.id && !c.read_at).length };
        })
        .sort((a, b) => new Date(b.last?.created_at || 0) - new Date(a.last?.created_at || 0))
    : [];

  return (
    <Page
      title="Messages"
      subtitle={
        isTutor
          ? 'Notes from learners arrive here instantly, with the question they’re about.'
          : teacher
            ? 'Ask your teachers anything. Notes you leave on questions show up here too.'
            : 'Ask your tutor anything. Notes you leave on questions show up here too.'
      }
    >
      {isTutor ? (
        lk.learners.length === 0 ? (
          <Empty>No learners yet.</Empty>
        ) : (
          <div className={'card pad0 chat' + (learnerId ? ' open' : '')}>
            <div className="people">
              {people.map(({ l, last, unread }) => (
                <button key={l.id} aria-current={l.id === learnerId} onClick={() => go(`/messages/${l.id}`, { replace: !!learnerId })}>
                  <Avatar person={l} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <div className="strong">{l.display_name}</div>
                    <div className="small muted ellipsis">{last ? last.body : 'No messages yet'}</div>
                  </span>
                  {unread > 0 && <span className="pill accent">{unread}</span>}
                </button>
              ))}
            </div>
            <div className="pane">{learnerId ? <Thread learnerId={learnerId} all={all} assignments={assignments} /> : <div className="muted" style={{ padding: 30 }}>Choose a learner.</div>}</div>
          </div>
        )
      ) : (
        <>
          {teacher && (
            <Seg
              label="Who to message"
              value={teacher.id}
              onChange={setTeacherId}
              options={teachers.map((t) => {
                const n = unreadFrom(t);
                return {
                  value: t.id,
                  label: (
                    <>
                      {t.main ? `${t.name} (your tutor)` : t.classes?.length ? `${t.name} (${t.classes.join(', ')})` : t.name}
                      {n > 0 && t.id !== teacher.id && <span className="pill accent">{n}</span>}
                    </>
                  ),
                };
              })}
            />
          )}
          <div className="card pad0 chat open" style={{ gridTemplateColumns: '1fr' }}>
            <div className="pane">
              <Thread key={teacher?.id} learnerId={who} all={all} assignments={assignments} teacher={teacher} />
            </div>
          </div>
        </>
      )}
    </Page>
  );
}

// teacher: for a learner with more than one teacher, the one this conversation is with
export function Thread({ learnerId, all, assignments, assignmentId, questionId, compact, teacher }) {
  const app = useApp();
  // (a learner whose only teacher is a class's teacher, with no tutor of their own)
  const only = useQuery(app.me.role === 'learner' && !app.me.tutor_id ? 'my-teachers' : null, api.myTeachers).data?.[0];
  const lk = useLookups();
  const toast = useToast();
  const confirm = useConfirm();
  const isTutor = app.me.role === 'tutor';
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const end = useRef(null);
  const aById = useMemo(() => Object.fromEntries((assignments || []).map((a) => [a.id, a])), [assignments]);
  // a learner's note on a question goes to whoever set the work
  const tutorId = isTutor ? app.me.id : (assignmentId && aById[assignmentId]?.tutor_id) || teacher?.id || app.me.tutor_id || only?.id;
  const list = all.filter(
    (c) => c.learner_id === learnerId && (!assignmentId || c.assignment_id === assignmentId) && (!questionId || c.question_id === questionId) && (!teacher || c.tutor_id === teacher.id),
  );
  const [pending, setPending] = useState([]);

  // Mark what we've now seen as read
  useEffect(() => {
    const ids = list.filter((c) => c.author_id !== app.me.id && !c.read_at).map((c) => c.id);
    if (ids.length)
      api
        .markCommentsRead(ids)
        .then(() => invalidate('comments'))
        .catch(() => {});
  }, [list.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [list.length, pending.length]);

  async function send(e) {
    e?.preventDefault();
    const body = text.trim();
    if (!body) return;
    setSending(true);
    const row = {
      tutor_id: tutorId,
      learner_id: learnerId,
      body,
      ...(assignmentId ? { assignment_id: assignmentId } : {}),
      ...(questionId ? { question_id: questionId } : {}),
    };
    try {
      const r = await api.sendComment(row);
      setText('');
      if (r?.queued) {
        setPending((p) => [...p, { ...row, id: 'p' + Date.now(), author_id: app.me.id, created_at: new Date().toISOString(), pending: true }]);
        toast({ title: 'Saved', body: 'It sends as soon as you’re back online.' });
      }
      invalidate('comments');
    } catch (x) {
      toast({ title: 'Couldn’t send', body: x.message, tone: 'bad' });
    } finally {
      setSending(false);
    }
  }

  const shown = [...list, ...pending.filter((p) => !list.some((c) => c.body === p.body && c.author_id === p.author_id))];
  async function removeMsg(c) {
    if (!(await confirm({ title: 'Delete this message?', body: 'It’s removed for both of you.', ok: 'Delete', danger: true }))) return;
    try {
      await api.remove('comments', c.id);
      invalidate('comments');
    } catch (e) {
      toast({ title: 'Couldn’t delete it', body: e.message, tone: 'bad' });
    }
  }
  const other = isTutor ? lk.learner(learnerId) : teacher ? { display_name: teacher.name } : null;

  return (
    <>
      <div className="msgs" style={compact ? { maxHeight: 320, overflowY: 'auto', padding: 0 } : undefined}>
        <div className="thread">
          {shown.length === 0 && <div className="muted small">{compact ? 'No notes yet.' : `No messages yet. Say hello${other ? ` to ${other.display_name}` : ''}!`}</div>}
          {shown.map((c) => {
            const mine = c.author_id === app.me.id;
            const a = c.assignment_id ? aById[c.assignment_id] : null;
            return (
              <div key={c.id} className={'bubble' + (mine ? ' mine' : '')}>
                {!compact && a && (
                  <div className="ctx">
                    On {a.title}
                    {c.question_id ? ' · a question' : ''}
                  </div>
                )}
                <Markdown src={c.body} />
                <div className="w">
                  {c.pending ? 'Waiting to send…' : ago(c.created_at)}
                  {mine && c.read_at && ' · Seen'}
                  {mine && isTutor && !c.pending && (
                    <>
                      {' · '}
                      <button type="button" className="linkbtn tiny" onClick={() => removeMsg(c)}>
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          <div ref={end} />
        </div>
      </div>
      <form className="composer" onSubmit={send} style={compact ? { padding: 0, border: 0 } : undefined}>
        <textarea
          className="textarea"
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={
            isTutor
              ? 'Write a message…'
              : compact
                ? tutorId === app.me.tutor_id
                  ? 'Leave a note for your tutor…'
                  : 'Leave a note for your teacher…'
                : teacher && !teacher.main
                  ? `Message ${teacher.name}…`
                  : 'Message your tutor…'
          }
          aria-label="Message"
        />
        <button className="btn primary icon" disabled={sending || !text.trim()} aria-label="Send">
          <Icon name="send" size={18} />
        </button>
      </form>
    </>
  );
}
