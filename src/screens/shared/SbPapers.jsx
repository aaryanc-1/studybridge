// StudyBridge practice papers: original papers in the format of a real exam paper, made on StudyBridge's content
// account and checked twice. Tutors look through one and copy it into a draft test of their own.
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Markdown, Modal, go, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as X from '../../lib/exams.js';

const facts = (p) =>
  [`${p.questions.length} question${p.questions.length === 1 ? '' : 's'}`, `${Number(p.marks)} mark${Number(p.marks) === 1 ? '' : 's'}`, p.minutes ? `${p.minutes} minutes` : null]
    .filter(Boolean)
    .join(' · ');

// One paper, question by question, with its answers and mark schemes a tap away
export function PaperView({ p, onClose, actions = null }) {
  const [scheme, setScheme] = useState(false);
  return (
    <Modal title={p.title || 'Practice paper'} onClose={onClose} wide foot={actions}>
      <div className="stack">
        <div className="small muted">
          {p.subject} · {facts(p)} · written by StudyBridge in this paper’s format (original questions), checked twice
        </div>
        <label className="row small" style={{ gap: 6 }}>
          <input type="checkbox" checked={scheme} onChange={(e) => setScheme(e.target.checked)} /> Show answers and mark schemes
        </label>
        {p.instructions && (
          <div className="note small">
            <Markdown src={p.instructions} />
          </div>
        )}
        {p.questions.map((x) => {
          const choices = x.answer?.choices || (x.answer?.choice != null ? [x.answer.choice] : []);
          return (
            <div key={x.number} className="paper-item">
              <div className="row top" style={{ gap: 10 }}>
                <b className="label">{x.number}</b>
                <div className="grow">
                  <Markdown src={x.prompt} />
                  {x.type === 'mcq' && (
                    <ol className="mcq-list" type="A">
                      {(Array.isArray(x.options) ? x.options : x.options?.items || []).map((o, k) => (
                        <li key={k} className={scheme && choices.map(Number).includes(k) ? 'right' : ''}>
                          <Markdown src={String(o)} />
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                <span className="pill">[{Number(x.marks)}]</span>
              </div>
              {scheme && (
                <div className="scheme small">
                  {X.answerText(x) && (
                    <div>
                      <b>Answer:</b> {X.answerText(x)}
                    </div>
                  )}
                  {x.mark_scheme && (
                    <div>
                      <b>Mark scheme:</b> <Markdown src={x.mark_scheme} />
                    </div>
                  )}
                  {x.solution && (
                    <details>
                      <summary className="linkbtn small">Worked solution</summary>
                      <Markdown src={x.solution} />
                    </details>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

// In Past papers, for one exam ('cie:0607'): StudyBridge's practice papers that are up, each ready to copy
export function SbPaperShelf({ exam }) {
  const q = useQuery(exam ? `sb-papers:${exam}` : null, () => api.studybridgePapers(exam));
  const toast = useToast();
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const list = q.data || [];
  if (!list.length) return null;
  async function copy(p) {
    setBusy(true);
    try {
      const id = await api.copyStudybridgePaper(p.id);
      invalidate('assignments');
      toast({ title: 'Copied into a draft test', body: 'Check it, choose who sees it, then post it.' });
      go(`/assignments/${id}`);
    } catch (e) {
      toast({ title: 'Couldn’t copy it', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card sb-shelf">
      <h3 className="row" style={{ margin: 0 }}>
        <Icon name="shield" style={{ color: 'var(--accent)' }} /> StudyBridge practice papers
      </h3>
      <div className="small muted">Original papers in the real format, with mark schemes, each question checked twice. Copy one into a test for your learners.</div>
      <div className="list">
        {list.map((p) => (
          <div key={p.id} className="item">
            <Icon name="clipboard" size={18} />
            <span className="grow">
              <span className="name">{p.title}</span>
              <span className="meta">{facts(p)}</span>
            </span>
            <button className="btn sm" onClick={() => setOpen(p)} aria-label={`Open ${p.title}`}>
              Open
            </button>
          </div>
        ))}
      </div>
      {open && (
        <PaperView
          p={open}
          onClose={() => setOpen(null)}
          actions={
            <>
              <button className="btn" onClick={() => setOpen(null)}>
                Close
              </button>
              <button className="btn primary" disabled={busy} onClick={() => copy(open)}>
                <Icon name="clipboard" size={16} /> Copy into a test
              </button>
            </>
          }
        />
      )}
    </div>
  );
}
