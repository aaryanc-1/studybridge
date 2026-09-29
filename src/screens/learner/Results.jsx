import { useEffect, useState } from 'react';
import { confetti } from '../../ui/confetti.js';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Empty, Link, Loading, Markdown, Page, go, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { dur, kindLabel, pct, typeLabel, when } from '../../lib/format.js';
import { QuestionPrompt, AnswerDisplay } from '../shared/Answer.jsx';
import { Thread } from '../shared/Messages.jsx';

function useCelebrate(id, show) {
  useEffect(() => {
    if (!show) return;
    const key = 'sb.celebrated:' + id;
    try {
      if (localStorage.getItem(key)) return;
      localStorage.setItem(key, '1');
    } catch {}
    confetti();
  }, [id, show]);
}

export default function Results({ id }) {
  const app = useApp();
  const toast = useToast();
  const detail = useQuery(`attempt:${id}`, () => api.attemptDetail(id));
  const assignments = useQuery('assignments', api.listAssignments).data || [];
  const aid = detail.data?.attempt.assignment_id;
  const questions = useQuery(aid ? `questions:${aid}` : null, () => api.listQuestions(aid)).data || [];
  const comments = useQuery('comments', api.listComments).data || [];
  const [busy, setBusy] = useState(false);
  const d = detail.data;
  const a = assignments.find((x) => x.id === aid);
  useCelebrate(id, !!d && d.attempt.released && d.attempt.status === 'marked' && (pct(d.attempt.score, d.attempt.max_score) ?? 0) >= 80);
  if (detail.error && !d) return <Page title="Results"><div className="error">{detail.error.message}</div></Page>;
  if (!d || !a) return <Loading />;
  const t = d.attempt;
  const rel = t.released;
  const byQ = Object.fromEntries(d.responses.map((r) => [r.question_id, r]));
  const keys = Object.fromEntries((d.keys || []).map((k) => [k.question_id, k]));
  const redo = d.responses.filter((r) => r.redo).length;
  const p = pct(t.score, t.max_score);

  return (
    <Page
      size="narrow"
      eyebrow={
        <>
          <Link to="/work">My work</Link> <Icon name="right" size={14} /> <span className={'kind ' + a.kind}>{kindLabel[a.kind]}</span>
        </>
      }
      title={a.title}
      subtitle={`${t.number > 1 ? `Attempt ${t.number} · ` : ''}${t.submitted_at ? `Handed in ${when(t.submitted_at)}` : 'Not handed in yet'} · ${dur(t.time_spent_sec)} spent`}
    >
      {t.status === 'returned' ? (
        <div className="card warn">
          <div className="row between wrap">
            <div>
              <div className="strong">Your tutor wants you to redo {redo} question{redo > 1 ? 's' : ''}</div>
              <div className="small">Read the feedback below, then try them again.</div>
            </div>
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  const x = await api.startAttempt(a.id);
                  invalidate('myattempts');
                  go(`/attempt/${x.id}`);
                } catch (e) {
                  toast({ title: 'Couldn’t open it', body: e.message, tone: 'bad' });
                  setBusy(false);
                }
              }}
            >
              <Icon name="refresh" size={18} /> Redo now
            </button>
          </div>
        </div>
      ) : !rel ? (
        <div className="card tint">
          <div className="row">
            <Icon name="clock" />
            <div>
              <div className="strong">Handed in. Your tutor is marking it.</div>
              <div className="small muted">You’ll get a notification when your marks are back.</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="row wrap" style={{ gap: 22 }}>
            <div className="score-ring" style={{ '--p': p ?? 0, '--ring': p >= 80 ? '#13937F' : p >= 50 ? '#E3A12F' : '#E0604F' }}>
              <div>
                <div className="n">{t.score != null ? Number(t.score) : '—'}</div>
                <div className="l">out of {Number(t.max_score)}</div>
              </div>
            </div>
            <div className="grow stack sm">
              <div style={{ fontFamily: 'var(--serif)', fontSize: 26, fontWeight: 600 }}>
                {p == null ? 'Marked' : p >= 90 ? 'Outstanding!' : p >= 80 ? 'Great work!' : p >= 60 ? 'Good effort!' : p >= 40 ? 'Getting there' : 'Let’s practise this together'}
              </div>
              <div className="muted">{p != null ? `You scored ${p}%.` : ''} {redo ? '' : 'Look through each question below to see what went well and what to fix.'}</div>
            </div>
          </div>
          {t.feedback_md && (
            <div className="feedback">
              <div className="tiny strong" style={{ marginBottom: 4 }}>From your tutor</div>
              <Markdown src={t.feedback_md} />
            </div>
          )}
        </div>
      )}

      {questions.map((q, i) => {
        const r = byQ[q.id] || {};
        const k = keys[q.id];
        const got = r.marks;
        return (
          <div key={q.id} className="qcard">
            <div className="qhead">
              <span className="qnum">{i + 1}</span>
              <span className="muted small">{typeLabel[q.type]}</span>
              <span className="grow" />
              {r.redo && <span className="pill warn">Redo</span>}
              {rel && got != null && (
                <span className={'pill ' + (Number(got) >= Number(q.marks) ? 'good' : Number(got) > 0 ? 'warn' : 'bad')}>
                  {Number(got)} / {Number(q.marks)}
                </span>
              )}
            </div>
            <QuestionPrompt q={q} />
            <div className="label">Your answer</div>
            <AnswerDisplay q={q} mine answer={r.answer || {}} keyAns={k?.answer} stepMarks={rel ? r.step_marks || [] : []} annotation={rel ? r.annotation_path : null} />
            {rel && r.feedback_md && (
              <div className={'feedback' + (Number(got) < Number(q.marks) ? ' bad' : '')}>
                <Markdown src={r.feedback_md} />
              </div>
            )}
            {rel && r.mistake && (
              <div className="small row">
                <Icon name="flag" size={16} style={{ color: 'var(--red)' }} /> <span className="strong">Mistake:</span> {r.mistake}
              </div>
            )}
            {k?.solution_md && (
              <details>
                <summary className="linkbtn small">Show the worked solution</summary>
                <div className="note" style={{ marginTop: 8 }}>
                  <Markdown src={k.solution_md} />
                </div>
              </details>
            )}
          </div>
        );
      })}
      {questions.length === 0 && <Empty>No questions.</Empty>}
      <div className="card">
        <h3>Questions about this?</h3>
        <Thread learnerId={app.me.id} all={comments} assignments={[a]} assignmentId={a.id} compact />
      </div>
    </Page>
  );
}
