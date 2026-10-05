// Prof: the AI teaching assistant (tutors only). Ask for work, switch on
// auto-marking and weekly work, and review everything Prof drafted.
import { useEffect, useRef, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Field, Link, Markdown, Modal, Page, Toggle, go, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, kindLabel } from '../../lib/format.js';
import { compressImage } from '../../lib/image.js';
import { useLookups } from '../shared/lookups.jsx';
import { DraftsWaiting } from './ClaudeInbox.jsx';

const busy = (j) => j.status === 'queued' || j.status === 'running' || j.status === 'waiting';
const sending = new Set(); // page requests this app is answering

export function useProfJobs() {
  const first = useRef(true);
  const q = useQuery('prof-jobs', api.profJobs);
  const jobs = q.data || [];
  const active = jobs.some(busy);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => invalidate('prof-jobs'), 3000);
    return () => clearInterval(t);
  }, [active]);
  // If a job has been waiting a while (the database couldn't wake the server), wake it from here
  useEffect(() => {
    const stale = jobs.some((j) => j.status === 'queued' && Date.now() - new Date(j.created_at) > (first.current ? 0 : 20000));
    first.current = false;
    if (stale) api.callProf().catch(() => {});
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  // Prof asked to read pages of a book: this app opens the book and sends pictures of them
  useEffect(() => {
    for (const j of jobs) {
      const key = j.id + JSON.stringify(j.result?.need_pages || '');
      if (j.status !== 'waiting' || !j.result?.need_pages || sending.has(key)) continue;
      sending.add(key);
      api
        .profProvidePages(j)
        .catch((e) => console.warn('Prof pages', e))
        .finally(() => {
          invalidate('prof-jobs');
          setTimeout(() => sending.delete(key), 30000);
        });
    }
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const doneIds = jobs.filter((j) => j.status === 'done').map((j) => j.id).join();
  useEffect(() => {
    if (doneIds) invalidate('assignments', 'lessons', 'drafts', 'bank');
  }, [doneIds]);
  return q;
}

export default function Prof() {
  const usage = useQuery('prof-usage', api.profUsage);
  const u = usage.data;
  return (
    <Page
      title={
        <span className="row" style={{ gap: 10 }}>
          <span className="prof-badge">
            <Icon name="cap" size={22} />
          </span>
          Prof
        </span>
      }
      subtitle="Your teaching assistant. Ask for homework, quizzes, tests, exams or lessons, and switch on marking. Everything Prof makes waits here until you approve it. Learners never use Prof."
    >
      {u && !u.ready && <div className="card warn small">{u.why_not}</div>}
      <AskProf ready={u?.ready !== false} />
      <DraftsWaiting />
      <Jobs />
      <ProfSettings usage={u} />
    </Page>
  );
}

function AskProf({ ready }) {
  const lk = useLookups();
  const toast = useToast();
  const files = (useQuery('files', api.listFiles).data || []).filter((f) => /pdf/.test(f.mime || '') || /\.pdf$/i.test(f.name));
  const [text, setText] = useState('');
  const [learners, setLearners] = useState([]);
  const [attach, setAttach] = useState([]); // { kind: 'pdf', file, pages } | { kind: 'image', blob, name }
  const [picking, setPicking] = useState(false);
  const [sending, setSending] = useState('');
  const first = lk.learners[0]?.display_name?.split(' ')[0] || 'my learner';
  const examples = [
    `A 10-question quiz on simultaneous equations for ${first}, due Friday`,
    'Homework from the attached pages: 8 questions, getting harder',
    `A 45-minute test on everything ${first} finds hard`,
    'A lesson with worked examples on the sine rule',
  ];
  const pageCount = attach.reduce((n, a) => n + (a.kind === 'pdf' ? a.pages.length : 1), 0);
  const bookCount = attach.filter((a) => a.kind === 'pdf' && !a.pages.length).length;

  async function send(e) {
    e.preventDefault();
    if (text.trim().length < 3) return toast({ title: 'Tell Prof what to make', tone: 'bad' });
    if (pageCount > 20) return toast({ title: 'Choose up to 20 pages', tone: 'bad' });
    if (bookCount > 3) return toast({ title: 'Choose up to 3 whole books', tone: 'bad' });
    try {
      const pages = [];
      const books = [];
      for (const a of attach) {
        if (a.kind === 'image') {
          pages.push({ blob: await compressImage(a.blob, 1600, 0.85), label: a.name });
          continue;
        }
        setSending(`Opening ${a.file.name}…`);
        const { renderPdfPages, pdfBookInfo } = await import('../../ui/PdfViewer.jsx');
        const blob = await api.getBlob('library', a.file.storage_path);
        if (!a.pages.length) {
          // the whole book: Prof gets its outline (or its first pages, to read the contents) and asks for the pages it needs
          const info = await pdfBookInfo(blob);
          books.push({ file_id: a.file.id, name: a.file.name, pages: info.pages, outline: info.outline });
          if (info.outline.split('\n').length < 3) {
            const first = await renderPdfPages(blob, Array.from({ length: Math.min(8, info.pages) }, (_, i) => i + 1), { maxSide: 1200 });
            for (const p of first.pages) pages.push({ blob: p.blob, label: `${a.file.name}, PDF page ${p.page} (to find the contents)` });
          }
          continue;
        }
        const r = await renderPdfPages(blob, a.pages);
        for (const p of r.pages) pages.push({ blob: p.blob, label: `${a.file.name}, page ${p.page}` });
      }
      setSending('Sending to Prof…');
      await api.profAsk(text.trim(), { learnerIds: learners, pages, books });
      setText('');
      setAttach([]);
      setLearners([]);
      invalidate('prof-jobs', 'prof-usage');
      toast({ title: 'Prof is on it', body: 'It’ll be waiting for you below in a minute or two.' });
    } catch (x) {
      toast({ title: 'Couldn’t ask Prof', body: x.message, tone: 'bad' });
    } finally {
      setSending('');
    }
  }

  return (
    <form className="card prof-ask" onSubmit={send}>
      <h2>Ask Prof</h2>
      <textarea
        className="textarea"
        style={{ minHeight: 90 }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={`What should Prof make? For example: a 10-question quiz on simultaneous equations for ${first}, due Friday.`}
        aria-label="What should Prof make?"
        disabled={!ready}
      />
      {!text && (
        <div className="row wrap" style={{ gap: 6 }}>
          {examples.map((x) => (
            <button key={x} type="button" className="chip" onClick={() => setText(x)}>
              {x}
            </button>
          ))}
        </div>
      )}
      {lk.learners.length > 1 && (
        <div className="row wrap small" style={{ gap: 6 }}>
          <span className="muted">For:</span>
          {lk.learners.map((l) => (
            <button
              key={l.id}
              type="button"
              className="chip"
              aria-pressed={learners.includes(l.id)}
              onClick={() => setLearners((xs) => (xs.includes(l.id) ? xs.filter((x) => x !== l.id) : [...xs, l.id]))}
            >
              {l.display_name}
            </button>
          ))}
          <span className="muted tiny">(or just name them above)</span>
        </div>
      )}
      {attach.length > 0 && (
        <div className="stack sm">
          {attach.map((a, i) => (
            <div key={i} className="row small attach-row">
              <Icon name={a.kind === 'pdf' ? 'pdf' : 'image'} size={18} />
              <span className="grow ellipsis">
                {a.kind === 'pdf' ? (a.pages.length ? `${a.file.name}: page${a.pages.length > 1 ? 's' : ''} ${pagesText(a.pages)}` : `${a.file.name}: Prof finds the pages`) : a.name}
              </span>
              <button type="button" className="btn ghost icon sm" aria-label="Remove" onClick={() => setAttach((xs) => xs.filter((_, j) => j !== i))}>
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="row wrap">
        <button type="button" className="btn sm" onClick={() => setPicking(true)} disabled={!ready}>
          <Icon name="book" size={16} /> Use a book from my library
        </button>
        <label className="btn sm" aria-disabled={!ready}>
          <Icon name="camera" size={16} /> Add a photo
          <input
            type="file"
            accept="image/*"
            hidden
            multiple
            onChange={(e) => {
              const fs = [...e.target.files];
              e.target.value = '';
              setAttach((xs) => [...xs, ...fs.map((f) => ({ kind: 'image', blob: f, name: f.name }))]);
            }}
          />
        </label>
        <span className="grow" />
        <button className="btn primary" disabled={!ready || !!sending}>
          {sending || (
            <>
              <Icon name="spark" size={18} /> Ask Prof
            </>
          )}
        </button>
      </div>
      {picking && (
        <PagePicker
          files={files}
          onClose={() => setPicking(false)}
          onAdd={(file, pages) => {
            setAttach((xs) => [...xs, { kind: 'pdf', file, pages }]);
            setPicking(false);
          }}
        />
      )}
    </form>
  );
}

function pagesText(ps) {
  const out = [];
  for (let i = 0; i < ps.length; i++) {
    let j = i;
    while (j + 1 < ps.length && ps[j + 1] === ps[j] + 1) j++;
    out.push(j > i ? `${ps[i]}–${ps[j]}` : `${ps[i]}`);
    i = j;
  }
  return out.join(', ');
}

function PagePicker({ files, onClose, onAdd }) {
  const [picked, setFile] = useState('');
  // the library can finish loading after this opens: fall back to the first file shown
  const file = files.some((f) => f.id === picked) ? picked : files[0]?.id || '';
  const [pages, setPages] = useState('');
  const [err, setErr] = useState('');
  return (
    <Modal
      title="A book for Prof to use"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            onClick={async () => {
              const { parsePages } = await import('../../ui/PdfViewer.jsx');
              const ps = parsePages(pages);
              if (!file) return setErr('Choose a PDF.');
              if (pages.trim() && !ps.length) return setErr('Type the page numbers like 12-15, or leave it empty.');
              onAdd(
                files.find((f) => f.id === file),
                ps,
              );
            }}
          >
            {pages.trim() ? 'Add these pages' : 'Add the book'}
          </button>
        </>
      }
    >
      {files.length === 0 ? (
        <div className="muted">Upload a PDF to your Library first (a textbook chapter, a past paper, a worksheet).</div>
      ) : (
        <>
          <Field label="Book or file">
            <select className="select" value={file} onChange={(e) => setFile(e.target.value)}>
              {files.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Pages (optional)" hint="Leave empty and Prof finds the right pages itself (from the contents), while StudyBridge is open. Or type PDF page numbers, e.g. 12-15 or 12, 14, 20 (up to 20).">
            <input className="input" value={pages} onChange={(e) => setPages(e.target.value)} placeholder="Leave empty, or 12-15" autoFocus />
          </Field>
          {err && <div className="error">{err}</div>}
        </>
      )}
    </Modal>
  );
}

function Jobs() {
  const q = useProfJobs();
  const toast = useToast();
  const lk = useLookups();
  const jobs = q.data || [];
  if (!jobs.length) return null;
  return (
    <div className="card">
      <h2>Recent requests</h2>
      <div className="stack">
        {jobs.slice(0, 15).map((j) => {
          const r = j.result || {};
          const prev = j.context?.reply_to ? jobs.find((x) => x.id === j.context.reply_to) : null;
          return (
            <div key={j.id} className={'prof-job ' + j.status}>
              <div className="row top">
                <Icon name={j.kind === 'mark' ? 'checkCircle' : j.kind === 'auto' ? 'calendar' : 'spark'} size={18} style={{ color: 'var(--claude)', marginTop: 2 }} />
                <div className="grow stack sm">
                  <div className="row wrap between" style={{ gap: 8 }}>
                    <span className="strong ellipsis" style={{ maxWidth: 560 }}>
                      {j.kind === 'mark' ? 'Marking a submission' : j.kind === 'auto' ? 'Weekly work: ' + j.prompt.replace(/^Make next week’s \w+ for /, '').split(':')[0] : j.prompt}
                    </span>
                    <span className="small muted">{ago(j.created_at)}</span>
                  </div>
                  {j.context?.reply_to && <div className="tiny muted ellipsis">↳ Reply{prev ? ` to “${prev.prompt.slice(0, 90)}”` : ''}</div>}
                  {j.context?.books?.length > 0 && <div className="tiny muted ellipsis">Using {j.context.books.map((b) => b.name).join(', ')}</div>}
                  {busy(j) && (
                    <div className="row small">
                      <span className="spinner sm" /> {j.progress || (j.status === 'queued' ? 'Waiting to start…' : 'Working…')}
                      <button className="linkbtn small" onClick={async () => (await api.profCancel(j.id), invalidate('prof-jobs'))}>
                        Cancel
                      </button>
                    </div>
                  )}
                  {j.status === 'done' && (
                    <>
                      {r.reply && <Markdown src={r.reply} className="small" />}
                      <div className="row wrap" style={{ gap: 8 }}>
                        {(r.assignments || []).map((a) => (
                          <Link key={a.id} to={`/assignments/${a.id}`} className="btn sm">
                            <span className={'kind ' + a.kind}>{kindLabel[a.kind]}</span> {a.title} · {a.questions} question{a.questions === 1 ? '' : 's'}
                          </Link>
                        ))}
                        {(r.lessons || []).map((l) => (
                          <Link key={l.id} to={`/lesson/${l.id}`} className="btn sm">
                            <Icon name="book" size={14} /> {l.title}
                          </Link>
                        ))}
                        {r.bank && (
                          <Link to={r.bank.shared ? '/admin' : '/library/bank'} className="btn sm">
                            <Icon name="layers" size={14} /> Review {r.bank.count} bank question{r.bank.count === 1 ? '' : 's'}
                          </Link>
                        )}
                        {r.cards && (
                          <Link to={`/library/cards?subject=${r.cards.subject_id}`} className="btn sm">
                            <Icon name="flame" size={14} /> Pick from {r.cards.list.length} flashcards
                          </Link>
                        )}
                        {r.syllabus && (
                          <Link to={`/library/syllabus?subject=${r.syllabus.subject_id}`} className="btn sm">
                            <Icon name="target" size={14} /> Check {r.syllabus.topics.length} topics
                          </Link>
                        )}
                        {j.attempt_id && (
                          <Link to={`/marking/${j.attempt_id}`} className="btn sm">
                            Open the submission
                          </Link>
                        )}
                      </div>
                      {!['mark', 'bank', 'syllabus', 'report', 'paper'].includes(j.kind) && <ReplyBox job={j} asked={!(r.assignments || []).length && !(r.lessons || []).length} />}
                    </>
                  )}
                  {(j.status === 'failed' || j.status === 'cancelled') && (
                    <div className="row wrap small">
                      <span className={j.status === 'failed' ? 'error' : 'muted'} style={{ padding: j.status === 'failed' ? '4px 8px' : 0 }}>
                        {j.status === 'failed' ? j.error || 'Something went wrong.' : 'Cancelled'}
                      </span>
                      <button
                        className="btn sm"
                        onClick={async () => {
                          try {
                            await api.profRetry(j.id);
                            invalidate('prof-jobs');
                          } catch (e) {
                            toast({ title: 'Couldn’t retry', body: e.message, tone: 'bad' });
                          }
                        }}
                      >
                        <Icon name="refresh" size={14} /> Try again
                      </button>
                    </div>
                  )}
                  {j.context?.learner_ids?.length > 0 && j.kind !== 'mark' && (
                    <div className="tiny muted">For {j.context.learner_ids.map((id) => lk.learner(id)?.display_name || 'a learner').join(', ')}</div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Answer Prof's question, or ask for changes, right under its reply
function ReplyBox({ job, asked }) {
  const toast = useToast();
  const [open, setOpen] = useState(asked);
  const [text, setText] = useState('');
  const [busyNow, setBusyNow] = useState(false);
  if (!open)
    return (
      <div>
        <button className="linkbtn small" onClick={() => setOpen(true)}>
          Reply to Prof
        </button>
      </div>
    );
  return (
    <form
      className="row top"
      style={{ gap: 8 }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (text.trim().length < 2) return;
        setBusyNow(true);
        try {
          await api.profAsk(text.trim(), { replyTo: job.id, learnerIds: job.context?.learner_ids || [], books: job.context?.books || [] });
          setText('');
          setOpen(false);
          invalidate('prof-jobs', 'prof-usage');
          toast({ title: 'Sent to Prof' });
        } catch (x) {
          toast({ title: 'Couldn’t send', body: x.message, tone: 'bad' });
        } finally {
          setBusyNow(false);
        }
      }}
    >
      <textarea
        className="textarea"
        style={{ minHeight: 44, flex: 1 }}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={asked ? 'Answer Prof, e.g. “Simultaneous equations, 10 questions, due Friday”' : 'Ask for changes, e.g. “Make questions 4–6 harder”'}
        aria-label="Reply to Prof"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            e.currentTarget.form.requestSubmit();
          }
        }}
      />
      <button className="btn sm claude" disabled={busyNow || text.trim().length < 2}>
        <Icon name="send" size={14} /> Send
      </button>
    </form>
  );
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function ProfSettings({ usage }) {
  const toast = useToast();
  const app = useApp();
  const s = useQuery('prof-settings', api.profSettings);
  const [v, setV] = useState(null);
  useEffect(() => {
    if (s.data !== undefined && !v) setV(s.data || { auto_mark: false, auto_reports: false, auto_create: false, auto_day: 0, auto_hour: 17, auto_count: 8, auto_kind: 'homework', style_md: '' });
  }, [s.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!v) return null;
  const set = (patch) => setV((x) => ({ ...x, ...patch }));
  async function save(patch = {}) {
    const next = { ...v, ...patch };
    setV(next);
    try {
      await api.saveProfSettings({
        auto_mark: next.auto_mark,
        auto_reports: !!next.auto_reports,
        auto_create: next.auto_create,
        auto_day: Number(next.auto_day),
        auto_hour: Number(next.auto_hour),
        auto_count: Number(next.auto_count),
        auto_kind: next.auto_kind,
        style_md: next.style_md || '',
      });
      invalidate('prof-settings');
      toast('Saved');
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    }
  }
  return (
    <div className="card" id="prof-settings">
      <h2>Prof’s settings</h2>
      <Toggle
        checked={v.auto_mark}
        onChange={(x) => save({ auto_mark: x })}
        title="Mark hand-ins for me"
        sub="When a learner hands in, Prof suggests marks, ticks their working and writes feedback. You check it before anything goes back."
      />
      <Toggle
        checked={!!v.auto_reports}
        onChange={(x) => save({ auto_reports: x })}
        title="Write weekly parent reports"
        sub="Each week Prof writes the words of each report (for learners who switched reports on). You check them in Reports before sending."
      />
      <Toggle
        checked={v.auto_create}
        onChange={(x) => save({ auto_create: x })}
        title="Make next week’s work"
        sub="Once a week Prof drafts work for each learner, aimed at the topics they find hardest. It waits here for you to approve."
      />
      {v.auto_create && (
        <div className="row wrap small" style={{ gap: 8, paddingLeft: 4 }}>
          <span>Every</span>
          <select className="select sm" value={v.auto_day} onChange={(e) => save({ auto_day: Number(e.target.value) })} aria-label="Day">
            {DAYS.map((d, i) => (
              <option key={d} value={i}>
                {d}
              </option>
            ))}
          </select>
          <span>from</span>
          <select className="select sm" value={v.auto_hour} onChange={(e) => save({ auto_hour: Number(e.target.value) })} aria-label="Time">
            {Array.from({ length: 24 }, (_, h) => (
              <option key={h} value={h}>
                {String(h).padStart(2, '0')}:00
              </option>
            ))}
          </select>
          <span>({app.me.timezone.replace(/_/g, ' ')}):</span>
          <select className="select sm" value={v.auto_kind} onChange={(e) => save({ auto_kind: e.target.value })} aria-label="Kind">
            <option value="homework">homework</option>
            <option value="quiz">a quiz</option>
          </select>
          <span>of about</span>
          <input className="input sm num" type="number" min="3" max="30" value={v.auto_count} onChange={(e) => set({ auto_count: e.target.value })} onBlur={() => save()} aria-label="Questions" />
          <span>questions</span>
        </div>
      )}
      <Field label="How Prof should write for you" hint="Your syllabus, level, style and anything Prof should always (or never) do.">
        <textarea
          className="textarea"
          value={v.style_md}
          onChange={(e) => set({ style_md: e.target.value })}
          placeholder="e.g. Cambridge IGCSE International Mathematics 0607, Extended. British spelling. Mark schemes in M1/A1 style. Calculator allowed unless I say so."
        />
      </Field>
      <div>
        <button className="btn" onClick={() => save()}>
          Save
        </button>
      </div>
    </div>
  );
}

// On the marking screen: Prof's suggestion for this submission, or a button to ask for one
export function ProfMarkCard({ attemptId, onApplied }) {
  const toast = useToast();
  const drafts = (useQuery('drafts', api.listDrafts).data || []).filter((d) => d.attempt_id === attemptId && d.kind === 'marking');
  const jobs = (useProfJobs().data || []).filter((j) => j.attempt_id === attemptId);
  const usage = useQuery('prof-usage', api.profUsage).data;
  const running = jobs.find(busy);
  const failed = !running && jobs[0]?.status === 'failed' ? jobs[0] : null;
  const d = drafts[0];
  return (
    <div className="card claude">
      <h3 className="row">
        <Icon name="cap" style={{ color: 'var(--claude)' }} /> Prof
      </h3>
      {d ? (
        <>
          <div className="small">{d.summary || 'Prof has suggested marks and feedback for this.'}</div>
          <div className="row wrap">
            <button
              className="btn sm claude"
              onClick={async () => {
                try {
                  await api.applyDraft(d.id, null);
                  invalidate('drafts', `attempt:${attemptId}`, 'attempts');
                  onApplied?.();
                  toast({ title: 'Prof’s marks are in', body: 'Check them, change anything, then return them.' });
                } catch (e) {
                  toast({ title: 'Couldn’t use them', body: e.message, tone: 'bad' });
                }
              }}
            >
              <Icon name="check" size={14} /> Use Prof’s marks
            </button>
            <button className="btn sm" onClick={() => go('/prof')}>
              Review first
            </button>
          </div>
          <div className="tiny muted">Nothing reaches your learner until you press Return marks.</div>
        </>
      ) : running ? (
        <div className="row small">
          <span className="spinner sm" /> {running.progress || 'Prof is marking…'}
        </div>
      ) : (
        <>
          {failed && <div className="error small">{failed.error}</div>}
          <button
            className="btn sm claude"
            disabled={usage && !usage.ready}
            onClick={async () => {
              try {
                await api.profMark(attemptId);
                invalidate('prof-jobs');
              } catch (e) {
                toast({ title: 'Couldn’t ask Prof', body: e.message, tone: 'bad' });
              }
            }}
          >
            <Icon name="spark" size={14} /> Ask Prof to mark this
          </button>
          <div className="tiny muted">{usage && !usage.ready ? usage.why_not : 'Prof suggests marks and feedback. You check them before anything goes back.'}</div>
        </>
      )}
    </div>
  );
}
