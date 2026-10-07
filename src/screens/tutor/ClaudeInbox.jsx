import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import MathText from '../../ui/MathText.jsx';
import { Avatar, Link, Markdown, go, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, kindLabel } from '../../lib/format.js';
import { useLookups } from '../shared/lookups.jsx';

// Everything Prof (or Claude Desktop) has drafted, waiting for the tutor
export function useDraftCounts() {
  const drafts = useQuery('drafts', api.listDrafts).data || [];
  const assignments = useQuery('assignments', api.listAssignments).data || [];
  const lessons = useQuery('lessons', api.listLessons).data || [];
  return drafts.length + assignments.filter((a) => a.draft).length + lessons.filter((l) => l.draft).length;
}

const from = (src) => (src === 'prof' ? 'Prof' : src === 'claude' ? 'Claude Desktop' : 'you');

export function DraftsWaiting() {
  const drafts = useQuery('drafts', api.listDrafts);
  const assignments = useQuery('assignments', api.listAssignments).data || [];
  const lessons = useQuery('lessons', api.listLessons).data || [];
  const draftAssignments = assignments.filter((a) => a.draft);
  const draftLessons = lessons.filter((l) => l.draft);
  const list = drafts.data || [];
  const lk = useLookups();
  const none = drafts.data && list.length === 0 && draftAssignments.length === 0 && draftLessons.length === 0;

  return (
    <>
      {none && (
        <div className="card">
          <h2>Waiting for you</h2>
          <div className="muted small">Nothing to review. When Prof makes something, it waits here until you approve it.</div>
        </div>
      )}
      {(draftAssignments.length > 0 || draftLessons.length > 0) && (
        <div className="card">
          <h2>Waiting for you</h2>
          <div className="list">
            {draftAssignments.map((a) => (
              <Link key={a.id} to={`/assignments/${a.id}`} className="item">
                <Icon name="clipboard" style={{ color: 'var(--claude)' }} />
                <span className="grow">
                  <span className="name">{a.title}</span>
                  <span className="meta">
                    <span className={'kind ' + a.kind}>{kindLabel[a.kind]}</span> by {from(a.source)} · {ago(a.created_at)}
                    {lk.audience(a).length > 0 && ` · for ${lk.audience(a).map((l) => l.display_name.split(' ')[0]).join(', ')}`}
                  </span>
                </span>
                <span className="btn sm">Review</span>
              </Link>
            ))}
            {draftLessons.map((l) => (
              <Link key={l.id} to={`/lesson/${l.id}`} className="item">
                <Icon name="book" style={{ color: 'var(--claude)' }} />
                <span className="grow">
                  <span className="name">{l.title}</span>
                  <span className="meta">Lesson by {from(l.source)} · {ago(l.created_at)}</span>
                </span>
                <span className="btn sm">Review</span>
              </Link>
            ))}
          </div>
        </div>
      )}
      {list.map((d) => (d.kind === 'marking' ? <MarkingDraft key={d.id} d={d} /> : <MessageDraft key={d.id} d={d} />))}
    </>
  );
}

function MarkingDraft({ d }) {
  const lk = useLookups();
  const toast = useToast();
  const detail = useQuery(d.attempt_id ? `attempt:${d.attempt_id}` : null, () => api.attemptDetail(d.attempt_id));
  const aid = detail.data?.attempt.assignment_id;
  const qs = useQuery(aid ? `questions:${aid}` : null, () => api.listQuestions(aid)).data || [];
  const a = useQuery(aid ? `assignment:${aid}` : null, () => api.getAssignment(aid)).data;
  const [payload, setPayload] = useState(d.payload || {});
  const marks = payload.marks || [];
  const learner = lk.learner(d.learner_id || detail.data?.attempt.learner_id);

  function setMark(i, patch) {
    setPayload((p) => ({ ...p, marks: p.marks.map((m, j) => (j === i ? { ...m, ...patch } : m)) }));
  }
  async function apply() {
    try {
      await api.applyDraft(d.id, payload);
      invalidate('drafts', `attempt:${d.attempt_id}`, 'attempts');
      toast({ title: 'Marks applied', body: 'Check them and return them to your learner.' });
      go(`/marking/${d.attempt_id}`);
    } catch (e) {
      toast({ title: 'Couldn’t apply', body: e.message, tone: 'bad' });
    }
  }
  async function discard() {
    await api.discardDraft(d.id);
    invalidate('drafts');
  }

  return (
    <div className="card claude">
      <div className="card-head">
        <div className="row">
          <Icon name="spark" style={{ color: 'var(--claude)' }} />
          <div>
            <h2>{d.source === 'prof' ? 'Prof’s marking' : 'Suggested marking'}{a ? `: ${a.title}` : ''}</h2>
            <div className="small muted row" style={{ gap: 6 }}>
              {learner && <Avatar person={learner} size="sm" />} {learner?.display_name} · {ago(d.created_at)}
            </div>
          </div>
        </div>
        <div className="row">
          <button className="btn sm" onClick={discard}>
            Discard
          </button>
          <button className="btn sm claude" onClick={apply}>
            <Icon name="check" size={14} /> Apply marks
          </button>
        </div>
      </div>
      {d.summary && <div className="small">{d.summary}</div>}
      <div className="stack">
        {marks.map((m, i) => {
          const qi = qs.findIndex((q) => q.id === m.question_id);
          const q = qs[qi];
          return (
            <div key={i} className="card" style={{ padding: 14, gap: 8 }}>
              <div className="row between">
                <span className="strong">Question {qi >= 0 ? qi + 1 : '?'}</span>
                <label className="row small" style={{ gap: 6 }}>
                  Mark
                  <input className="input sm num" type="number" step="0.5" min="0" value={m.marks ?? ''} onChange={(e) => setMark(i, { marks: e.target.value === '' ? null : Number(e.target.value) })} />
                  <span className="muted">/ {q ? Number(q.marks) : '?'}</span>
                </label>
              </div>
              {q?.prompt_md && <div className="muted small ellipsis">{q.prompt_md.slice(0, 160)}</div>}
              <MathText value={m.feedback_md || ''} onChange={(v) => setMark(i, { feedback_md: v })} label="Feedback" minHeight={60} />
              {m.feedback_md && /\$/.test(m.feedback_md) && <Markdown src={m.feedback_md} className="small" />}
              <div className="row wrap small">
                <input className="input sm" style={{ flex: 1, minWidth: 200 }} value={m.mistake || ''} placeholder="Mistake" onChange={(e) => setMark(i, { mistake: e.target.value })} aria-label="Mistake" />
                <label className="check">
                  <input type="checkbox" checked={!!m.redo} onChange={(e) => setMark(i, { redo: e.target.checked })} />
                  Redo
                </label>
              </div>
            </div>
          );
        })}
      </div>
      <MathText value={payload.feedback_md || ''} onChange={(v) => setPayload((p) => ({ ...p, feedback_md: v }))} placeholder="Overall feedback" label="Overall feedback" />
    </div>
  );
}

function MessageDraft({ d }) {
  const lk = useLookups();
  const toast = useToast();
  const [body, setBody] = useState(d.payload?.body || '');
  const learner = lk.learner(d.learner_id);
  return (
    <div className="card claude">
      <div className="card-head">
        <div className="row">
          <Icon name="spark" style={{ color: 'var(--claude)' }} />
          <div>
            <h2>{d.kind === 'message' ? `Message to ${learner?.display_name || 'learner'}` : 'Note from Claude'}</h2>
            <div className="small muted">{ago(d.created_at)}</div>
          </div>
        </div>
        <div className="row">
          <button
            className="btn sm"
            onClick={async () => {
              await api.discardDraft(d.id);
              invalidate('drafts');
            }}
          >
            {d.kind === 'message' ? 'Discard' : 'Dismiss'}
          </button>
          {d.kind === 'message' && (
            <button
              className="btn sm claude"
              onClick={async () => {
                try {
                  await api.applyDraft(d.id, { body });
                  invalidate('drafts', 'comments');
                  toast('Message sent');
                } catch (e) {
                  toast({ title: 'Couldn’t send', body: e.message, tone: 'bad' });
                }
              }}
            >
              <Icon name="send" size={14} /> Send
            </button>
          )}
        </div>
      </div>
      {d.kind === 'message' ? <textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} /> : <Markdown src={d.summary || d.payload?.body || ''} />}
    </div>
  );
}
