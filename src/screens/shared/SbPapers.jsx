// StudyBridge practice papers: original papers in the exact format of a real exam paper,
// approved by StudyBridge. Tutors open them and copy one into a test of their own.
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Loading, Markdown, Modal, go, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as X from '../../lib/exams.js';
import { useLookups } from './lookups.jsx';

export const paperSlot = (p) => `${p.level ? p.level + ' ' : ''}Paper ${p.paper}`;

export function PaperView({ id, onClose, admin = false, actions = null }) {
  const q = useQuery(`sb-paper:${id}`, () => api.getSbPaper(id));
  const [scheme, setScheme] = useState(admin);
  const p = q.data;
  return (
    <Modal title={p?.title || 'Practice paper'} onClose={onClose} wide foot={actions && p ? actions(p) : null}>
      {!p ? (
        <Loading />
      ) : (
        <div className="stack">
          <div className="small muted">
            {X.syllabusLabel(p.board, p.code)} · {paperSlot(p)}
            {p.duration_min ? ` · ${p.duration_min} minutes` : ''}
            {p.total_marks ? ` · ${Number(p.total_marks)} marks` : ''} · written by StudyBridge in this paper’s format (original questions)
          </div>
          <label className="row small" style={{ gap: 6 }}>
            <input type="checkbox" checked={scheme} onChange={(e) => setScheme(e.target.checked)} /> Show answers and mark schemes
          </label>
          {p.instructions_md && (
            <div className="note small">
              <Markdown src={p.instructions_md} />
            </div>
          )}
          {admin && p.items?.some((x) => x.check && !x.check.ok) && (
            <div className="card warn small">
              <b>The automatic check flagged {p.items.filter((x) => x.check && !x.check.ok).length}:</b> fix them below (or reject the paper).
            </div>
          )}
          {(p.items || []).map((x, i) => (
            <div key={i} className={'paper-item' + (admin && x.check && !x.check.ok ? ' flagged' : '')}>
              {x.stem && (
                <div className="stem">
                  <Markdown src={x.stem} />
                </div>
              )}
              <div className="row top" style={{ gap: 10 }}>
                <b className="label">{x.label}</b>
                <div className="grow">
                  <Markdown src={x.prompt} />
                  {x.type === 'mcq' && (
                    <ol className="mcq-list" type="A">
                      {(x.options || []).map((o, k) => (
                        <li key={k} className={scheme && (x.answer?.choices || []).includes(k) ? 'right' : ''}>
                          <Markdown src={o} />
                        </li>
                      ))}
                    </ol>
                  )}
                </div>
                <span className="pill">[{Number(x.marks)}]</span>
              </div>
              {scheme && (
                <div className="scheme small">
                  {X.answerText({ ...x, answer: x.answer }) && (
                    <div>
                      <b>Answer:</b> {X.answerText({ ...x, answer: x.answer })}
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
                  {admin && x.check && !x.check.ok && (
                    <>
                      <div className="bad-text">
                        Check: {x.check.note} (checker got {x.check.my_answer})
                      </div>
                      <FixItem paperId={p.id} index={i} x={x} />
                    </>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// In Past papers, for one exam: the approved StudyBridge papers, grouped by paper
export function SbPaperShelf({ board, code, level = null, paper = null, compact = false }) {
  const q = useQuery(`sb-papers:${board}:${code}`, () => api.listSbPapers(board, code));
  const lk = useLookups();
  const toast = useToast();
  const [open, setOpen] = useState(null);
  const [busy, setBusy] = useState(false);
  const list = (q.data || []).filter((p) => (!level || p.level === level) && (!paper || p.paper === paper));
  if (!list.length) return compact ? null : null;
  const groups = {};
  for (const p of list) (groups[paperSlot(p)] ||= []).push(p);
  // which of the tutor's subjects is this exam (for topics)
  const subject = lk.subjects.find((s) => s.exam === `${board}:${code}`);
  async function use(p) {
    setBusy(true);
    try {
      const full = await api.getSbPaper(p.id);
      const topicIdFor = (name) => (subject && name ? lk.topicsOf(subject.id).find((t) => t.name.toLowerCase() === String(name).toLowerCase())?.id || null : null);
      const a = await api.assignmentFromPaper(full, { subject_id: subject?.id || null, topicIdFor });
      invalidate('assignments');
      toast({ title: 'Copied into a draft test', body: 'Check it, choose who sees it, then post it.' });
      go(`/assignments/${a.id}`);
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
      <div className="small muted">Original papers in the real format, with mark schemes. Yours to use and share with your learners.</div>
      {Object.entries(groups).map(([slot, ps]) => (
        <div key={slot} className="row wrap" style={{ gap: 6 }}>
          <span className="strong small" style={{ minWidth: 90 }}>
            {slot}
          </span>
          {ps.map((p) => (
            <button key={p.id} className="paper-chip sb" onClick={() => setOpen(p)} title={p.title}>
              SB {p.number}
            </button>
          ))}
        </div>
      ))}
      {open && (
        <PaperView
          id={open.id}
          onClose={() => setOpen(null)}
          actions={() => (
            <>
              <button className="btn" onClick={() => setOpen(null)}>
                Close
              </button>
              <button className="btn primary" disabled={busy} onClick={() => use(open)}>
                <Icon name="clipboard" size={16} /> Use with my learners
              </button>
            </>
          )}
        />
      )}
    </div>
  );
}

// Admin: correct a flagged part (answer, mark scheme, worked solution)
function FixItem({ paperId, index, x }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const firstAnswer = x.type === 'numeric' ? x.answer?.value || '' : x.type === 'steps' ? x.answer?.final || '' : x.type === 'short' ? x.answer?.text || '' : '';
  const [answer, setAnswer] = useState(firstAnswer);
  const [scheme, setScheme] = useState(x.mark_scheme || '');
  const [solution, setSolution] = useState(x.solution || '');
  if (!open)
    return (
      <div>
        <button className="btn sm" onClick={() => setOpen(true)}>
          <Icon name="pen" size={14} /> Fix this part
        </button>
      </div>
    );
  return (
    <div className="stack sm">
      {x.type !== 'mcq' && x.type !== 'upload' && <input className="input" value={answer} onChange={(e) => setAnswer(e.target.value)} aria-label="Correct answer" placeholder="Correct answer" />}
      <textarea className="textarea" value={scheme} onChange={(e) => setScheme(e.target.value)} aria-label="Mark scheme" />
      <textarea className="textarea" value={solution} onChange={(e) => setSolution(e.target.value)} aria-label="Worked solution" />
      <div className="row">
        <button
          className="btn sm primary"
          onClick={async () => {
            const ans = x.type === 'numeric' ? { ...x.answer, value: answer } : x.type === 'steps' ? { final: answer } : x.type === 'short' ? { text: answer } : x.answer;
            try {
              await api.adminPaperItem(paperId, index, { answer: ans, mark_scheme: scheme, solution });
              invalidate(`sb-paper:${paperId}`, 'admin-papers');
              toast('Fixed');
              setOpen(false);
            } catch (e) {
              toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
            }
          }}
        >
          Save fix
        </button>
        <button className="btn sm ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
    </div>
  );
}
