import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import MathText from '../../ui/MathText.jsx';
import { AudiencePicker, Empty, Field, Link, Loading, Markdown, Page, Seg, Toggle, VisibilityPicker, go, useConfirm, useToast } from '../../ui/kit.jsx';
import MathField from '../../ui/MathField.jsx';
import { StoredImage } from '../../ui/media.jsx';
import { invalidate, useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { fromLocalInput, toLocalInput, typeLabel, kindLabel } from '../../lib/format.js';
import { BankPicker } from './QuestionBank.jsx';
import { useLookups } from '../shared/lookups.jsx';
import { KIND_DEFAULTS } from './Assignments.jsx';
import { useDiscardDraft } from './ClaudeInbox.jsx';
import { items, multi } from '../../lib/questions.js';

let seq = 0;
const k = () => 'q' + ++seq;

const TYPES = [
  { type: 'mcq', icon: 'check', hint: 'Pick one (or more) options. Marked automatically.' },
  { type: 'numeric', icon: 'sigma', hint: 'A number, with an allowed margin. Marked automatically.' },
  { type: 'steps', icon: 'pen', hint: 'Maths line by line, so you see every step.' },
  { type: 'short', icon: 'text', hint: 'A written answer.' },
  { type: 'upload', icon: 'camera', hint: 'A photo or scan of work on paper.' },
  { type: 'drawing', icon: 'highlighter', hint: 'Drawn on screen: graphs, diagrams, geometry.' },
];

function blankQuestion(type) {
  return {
    _k: k(),
    type,
    prompt_md: '',
    image_path: null,
    options: type === 'mcq' ? ['', '', '', ''] : [],
    marks: type === 'steps' ? 3 : type === 'upload' || type === 'drawing' ? 4 : 1,
    topic_id: null,
    key: { answer: type === 'mcq' ? { choice: '0' } : type === 'numeric' ? { value: '', tolerance: '0' } : {}, solution_md: '', mark_scheme_md: '' },
  };
}

// Anything that would confuse a learner if posted as it is
function checkReady(a, qs) {
  if (!a.title.trim()) return 'Give it a title.';
  if (!qs.length) return 'Add at least one question.';
  for (const [i, q] of qs.entries()) {
    const n = `Question ${i + 1}`;
    if (!q.prompt_md.trim() && !q.image_path) return `${n} has no question text.`;
    if (q.type === 'mcq') {
      const opts = items(q.options);
      if (opts.filter((o) => o.trim()).length < 2) return `${n} needs at least two options.`;
      if (opts.some((o) => !o.trim())) return `${n} has an empty option. Fill it in or remove it.`;
      const right = multi(q.options) ? q.key.answer?.choices || [] : [q.key.answer?.choice].filter((x) => x != null);
      if (!right.length) return `${n}: tick the correct answer.`;
    }
    if (q.type === 'numeric' && !String(q.key.answer?.value ?? '').trim()) return `${n}: add the correct number.`;
  }
  if (a.visibility === 'scheduled' && !a.visible_from) return 'Choose the date it becomes visible.';
  return null;
}

export default function AssignmentEditor({ id }) {
  const lk = useLookups();
  const toast = useToast();
  const confirm = useConfirm();
  const discard = useDiscardDraft();
  const files = useQuery('files', api.listFiles).data || [];
  const [a, setA] = useState(null);
  const [qs, setQs] = useState([]);
  const [removed, setRemoved] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [previewIntro, setPreviewIntro] = useState(false);
  const [picking, setPicking] = useState(false);

  const load = useCallback(async () => {
    try {
      const row = await api.getAssignment(id);
      if (!row) return setErr('This assignment no longer exists.');
      const q = await api.listQuestions(id);
      const keys = await api.listKeys(q.map((x) => x.id));
      setA(row);
      setQs(q.map((x) => ({ ...x, _k: k(), key: keys.find((y) => y.question_id === x.id) || { answer: {}, solution_md: '', mark_scheme_md: '' } })));
      setRemoved([]);
      setDirty(false);
    } catch (e) {
      setErr(e.message);
    }
  }, [id]);
  useEffect(() => {
    load();
  }, [load]);

  const setField = (patch) => {
    setA((x) => ({ ...x, ...patch }));
    setDirty(true);
  };
  const setQ = (i, patch) => {
    setQs((list) => list.map((q, j) => (j === i ? { ...q, ...patch } : q)));
    setDirty(true);
  };

  const saveAll = useCallback(
    async ({ publish = false, quiet = false, post = false } = {}) => {
      if (!a) return;
      if (post) {
        const problem = checkReady(a, qs);
        if (problem) return toast({ title: 'Not ready to post yet', body: problem, tone: 'bad', ms: 7000 });
      }
      setBusy(true);
      try {
        // Posting makes it visible now, unless you chose a date
        const visibility = post && a.visibility === 'hidden' ? 'visible' : a.visibility;
        const row = {
          id: a.id,
          kind: a.kind,
          title: a.title.trim() || 'Untitled',
          instructions_md: a.instructions_md || '',
          subject_id: a.subject_id || null,
          topic_id: a.topic_id || null,
          file_refs: a.file_refs || [],
          due_at: a.due_at || null,
          visibility,
          visible_from: visibility === 'scheduled' ? a.visible_from : null,
          learner_ids: a.learner_ids?.length ? a.learner_ids : null,
          lockdown: !!a.lockdown,
          leave_warnings: Math.max(0, Math.min(5, Number(a.leave_warnings ?? 1))),
          camera: !!a.camera,
          time_limit_min: a.time_limit_min ? Number(a.time_limit_min) : null,
          max_attempts: Math.max(1, Number(a.max_attempts) || 1),
          allow_notes: !!a.allow_notes,
          release_mode: a.release_mode,
          release_at: a.release_mode === 'at' ? a.release_at : null,
          show_answers: !!a.show_answers,
          self_mark: !!a.self_mark,
          draft: publish || post ? false : a.draft,
          updated_at: new Date().toISOString(),
        };
        // Papers kept only on this computer are uploaded once learners can see the assignment
        if (visibility !== 'hidden') await api.ensureCloudIds((row.file_refs || []).map((r) => r.file_id), files);
        // Questions first, so learners never see a half-saved assignment
        for (const qid of removed) await api.remove('questions', qid);
        const next = [];
        for (let i = 0; i < qs.length; i++) {
          const q = qs[i];
          const saved = await api.save('questions', {
            ...(q.id ? { id: q.id } : {}),
            assignment_id: a.id,
            position: i,
            type: q.type,
            prompt_md: q.prompt_md || '',
            image_path: q.image_path || null,
            options: q.type === 'mcq' ? q.options : [],
            marks: Number(q.marks) || 0,
            topic_id: q.topic_id || null,
          });
          await api.saveKey({ question_id: saved.id, answer: q.key.answer || {}, solution_md: q.key.solution_md || null, mark_scheme_md: q.key.mark_scheme_md || null });
          next.push({ ...q, id: saved.id });
        }
        const s = await api.save('assignments', row);
        setA(s);
        setQs(next);
        setRemoved([]);
        setDirty(false);
        invalidate('assignments');
        if (post || publish) {
          const who = lk.audience(s).map((l) => l.display_name);
          const whoText = who.length ? who.join(', ') : 'nobody yet (no learners take this subject)';
          toast(
            s.visibility === 'scheduled'
              ? { title: `Scheduled: ${s.title}`, body: `${whoText} will see it from ${new Date(s.visible_from).toLocaleString()}.` }
              : { title: `Posted: ${s.title}`, body: `Sent to ${whoText}.` },
          );
          go('/assignments');
        } else if (!quiet) toast('Saved');
      } catch (e) {
        toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
      } finally {
        setBusy(false);
      }
    },
    [a, qs, removed, toast, lk],
  );

  // Ctrl/Cmd + S saves
  const saveRef = useRef(saveAll);
  saveRef.current = saveAll;
  useEffect(() => {
    const h = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        saveRef.current();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (err) return <Page title="Assignment"><div className="error">{err}</div></Page>;
  if (!a) return <Loading />;

  const total = qs.reduce((s, q) => s + (Number(q.marks) || 0), 0);
  const live = !a.draft && a.visibility !== 'hidden';
  const attachable = files.filter((f) => !f.link_url);

  return (
    <Page
      size="wide"
      eyebrow={
        <>
          <Link to="/assignments">Assignments</Link> <Icon name="right" size={14} /> <span className={'kind ' + a.kind}>{kindLabel[a.kind]}</span>
        </>
      }
      title={a.title || 'Untitled'}
      actions={
        <>
          <span className="save-state">{busy ? 'Saving…' : dirty ? 'Unsaved changes' : 'All changes saved'}</span>
          <button className="btn" onClick={() => go(`/marking?a=${a.id}`)}>
            <Icon name="checkCircle" size={18} /> Submissions
          </button>
          {live ? (
            <button className="btn primary" onClick={() => saveAll({ post: true })} disabled={busy}>
              <Icon name="check" size={18} /> Save changes
            </button>
          ) : (
            <>
              {a.draft && (
                <button className="btn ghost" onClick={async () => (await discard('assignments', a)) && go(a.source === 'prof' || a.source === 'claude' ? '/prof' : '/assignments')} disabled={busy}>
                  <Icon name="trash" size={16} /> Discard
                </button>
              )}
              <button className="btn" onClick={() => saveAll()} disabled={busy || !dirty} title="Keep it hidden and carry on later">
                Save draft
              </button>
              <button className={'btn ' + (a.draft ? 'claude' : 'primary')} onClick={() => saveAll({ post: true })} disabled={busy}>
                <Icon name="send" size={18} /> {a.visibility === 'scheduled' ? 'Schedule' : a.draft ? 'Approve & post' : 'Post'}
              </button>
            </>
          )}
        </>
      }
    >
      {a.draft && (
        <div className="card claude">
          <div className="row top">
            <Icon name={a.source === 'prof' ? 'cap' : 'spark'} style={{ color: 'var(--claude)', flexShrink: 0 }} />
            <div className="stack sm">
              <div className="strong">{a.source === 'studybridge' ? 'A StudyBridge practice paper, copied for you' : `Drafted by ${a.source === 'prof' ? 'Prof' : 'Claude'}`}. Learners can’t see it yet.</div>
              <div className="small">Check the questions, answers and mark schemes, change anything you like, then press Approve & post. It follows the “Who sees it” setting once approved.</div>
            </div>
          </div>
        </div>
      )}
      <div className="split side-r">
        <div className="stack lg">
          <div className="card">
            <Field label="Title">
              <input className="input" value={a.title} onChange={(e) => setField({ title: e.target.value })} style={{ fontSize: 17, fontWeight: 600 }} />
            </Field>
            <div className="row between">
              <span className="label">Instructions</span>
              <Seg
                value={previewIntro ? 'p' : 'w'}
                onChange={(v) => setPreviewIntro(v === 'p')}
                options={[
                  { value: 'w', label: 'Write' },
                  { value: 'p', label: 'Preview' },
                ]}
              />
            </div>
            {previewIntro ? (
              <Markdown src={a.instructions_md || '*No instructions.*'} />
            ) : (
              <textarea className="textarea" value={a.instructions_md || ''} onChange={(e) => setField({ instructions_md: e.target.value })} placeholder="What should the learner do? e.g. Show all your working. Use the textbook pages attached if you get stuck." />
            )}
          </div>

          {picking && (
            <BankPicker
              onClose={() => setPicking(false)}
              onPick={(rows) => {
                setQs((list) => [...list, ...rows.map((b) => ({ ...api.bankToQuestion(b), topic_id: a.topic_id || null, _k: k() }))]);
                api.bankUsed(rows.map((b) => b.id));
                setDirty(true);
                setPicking(false);
                toast(`Added ${rows.length} question${rows.length === 1 ? '' : 's'} from the bank`);
              }}
            />
          )}
          {qs.length === 0 && <Empty title="No questions yet">Add questions below, or pick some from the question bank. Mix any kinds you like.</Empty>}
          {qs.map((q, i) => (
            <QuestionEditor
              key={q._k}
              q={q}
              n={i + 1}
              total={qs.length}
              onChange={(patch) => setQ(i, patch)}
              onMove={(d) => {
                setQs((list) => {
                  const next = [...list];
                  const [x] = next.splice(i, 1);
                  next.splice(i + d, 0, x);
                  return next;
                });
                setDirty(true);
              }}
              onRemove={async () => {
                if (!(await confirm({ title: `Delete question ${i + 1}?`, body: q.id ? 'Any answers to it are deleted too.' : undefined, ok: 'Delete', danger: true }))) return;
                if (q.id) setRemoved((r) => [...r, q.id]);
                setQs((list) => list.filter((_, j) => j !== i));
                setDirty(true);
              }}
              onDuplicate={() => {
                setQs((list) => {
                  const next = [...list];
                  next.splice(i + 1, 0, { ...structuredClone({ ...q, id: undefined }), _k: k(), id: undefined });
                  return next;
                });
                setDirty(true);
              }}
            />
          ))}
          <div className="card">
            <div className="card-head">
              <h3>Add a question</h3>
              <span className="row" style={{ gap: 8 }}>
                <span className="muted small">Total: {total} mark{total === 1 ? '' : 's'}</span>
                <button className="btn sm" onClick={() => setPicking(true)}>
                  <Icon name="layers" size={16} /> From the bank
                </button>
                {qs.length > 0 && (
                  <button
                    className="btn sm ghost"
                    title="Keep copies of these questions to reuse"
                    onClick={async () => {
                      try {
                        await api.saveQuestionsToBank(qs, { subject_id: a.subject_id || null, topicName: (id) => lk.topic(id)?.name || lk.topic(a.topic_id)?.name, ref: a.title });
                        invalidate('bank');
                        toast({ title: `Saved ${qs.length} question${qs.length === 1 ? '' : 's'} to your bank`, body: 'Find them in Library → Question bank.' });
                      } catch (e) {
                        toast({ title: 'Couldn’t save to the bank', body: e.message, tone: 'bad' });
                      }
                    }}
                  >
                    Save to bank
                  </button>
                )}
              </span>
            </div>
            <div className="grid g3">
              {TYPES.map((t) => (
                <button
                  key={t.type}
                  className="choice"
                  style={{ padding: '12px 14px', gap: 12 }}
                  onClick={() => {
                    setQs((list) => [...list, { ...blankQuestion(t.type), topic_id: a.topic_id || null }]);
                    setDirty(true);
                  }}
                >
                  <span className="ic" style={{ width: 38, height: 38 }}>
                    <Icon name={t.icon} />
                  </span>
                  <span className="grow">
                    <div className="strong small">{typeLabel[t.type]}</div>
                    <div className="tiny muted">{t.hint}</div>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="stack lg">
          <div className="card">
            <h3>Who sees it</h3>
            {a.draft && <div className="small" style={{ color: 'var(--claude)' }}>Nobody yet: a draft stays hidden until you press Approve & post. Then it follows this setting.</div>}
            <VisibilityPicker value={a.visibility} from={a.visible_from} onChange={(v, from) => setField({ visibility: v, visible_from: from })} />
            <AudiencePicker learners={lk.learners} value={a.learner_ids} onChange={(ids) => setField({ learner_ids: ids })} />
            <AudienceNames item={a} />
            <Field label="Due">
              <input className="input" type="datetime-local" value={toLocalInput(a.due_at)} onChange={(e) => setField({ due_at: fromLocalInput(e.target.value) })} />
            </Field>
          </div>
          <div className="card">
            <h3>Settings</h3>
            <Field label="Kind">
              <select
                className="select"
                value={a.kind}
                onChange={async (e) => {
                  const kind = e.target.value;
                  const use = await confirm({ title: `Use the usual ${kindLabel[kind].toLowerCase()} settings?`, body: 'Lockdown, camera, timer, attempts and marks release change to the defaults for this kind. You can adjust them after.', ok: 'Use defaults', cancel: 'Just change the kind' });
                  setField(use ? { kind, ...KIND_DEFAULTS[kind] } : { kind });
                }}
              >
                {Object.entries(kindLabel).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid g2" style={{ gap: 10 }}>
              <Field label="Subject">
                <select className="select" value={a.subject_id || ''} onChange={(e) => setField({ subject_id: e.target.value || null, topic_id: null })}>
                  <option value="">None</option>
                  {lk.subjects.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Topic">
                <select className="select" value={a.topic_id || ''} onChange={(e) => setField({ topic_id: e.target.value || null })} disabled={!a.subject_id}>
                  <option value="">None</option>
                  {lk.topicsOf(a.subject_id).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Toggle checked={a.lockdown} onChange={(v) => setField({ lockdown: v })} icon="lock" title="Lockdown" sub="Their screen stays on StudyBridge until they hand in: there’s no way out. Needs the desktop app." />
            {a.lockdown && (
              <Field label="If they try to leave" hint="Switching window, closing StudyBridge or a blocked shortcut. You’re told each time, and you can end it early from the exam camera page.">
                <select className="select" value={a.leave_warnings ?? 1} onChange={(e) => setField({ leave_warnings: Number(e.target.value) })}>
                  <option value={0}>Hand it in straight away</option>
                  <option value={1}>Warn once, then hand it in</option>
                  <option value={2}>Warn twice, then hand it in</option>
                  <option value={3}>Warn three times, then hand it in</option>
                </select>
              </Field>
            )}
            <Toggle checked={a.camera} onChange={(v) => setField({ camera: v })} icon="camera" title="Camera on" sub="You can watch their camera and screen live while they work." />
            <div className="grid g2" style={{ gap: 10 }}>
              <Field label="Time limit (minutes)">
                <input className="input" type="number" min="1" value={a.time_limit_min || ''} placeholder="None" onChange={(e) => setField({ time_limit_min: e.target.value ? Number(e.target.value) : null })} />
              </Field>
              <Field label="Attempts allowed" hint={a.self_mark ? 'One, as they mark it themselves' : undefined}>
                <input className="input" type="number" min="1" max="20" value={a.self_mark ? 1 : a.max_attempts} disabled={!!a.self_mark} onChange={(e) => setField({ max_attempts: e.target.value })} />
              </Field>
            </div>
            <Toggle checked={a.allow_notes} onChange={(v) => setField({ allow_notes: v })} icon="message" title="Allow notes to you" sub="They can leave you a note on any question while working." />
          </div>
          <div className="card">
            <h3>Marks & answers</h3>
            <Field label="When they see their marks">
              <select className="select" value={a.release_mode} onChange={(e) => setField({ release_mode: e.target.value })}>
                <option value="manual">When I release them</option>
                <option value="on_submit">Straight after submitting (auto-marked parts)</option>
                <option value="at">From a date</option>
              </select>
            </Field>
            {a.release_mode === 'at' && <input className="input" type="datetime-local" aria-label="Release marks from" value={toLocalInput(a.release_at)} onChange={(e) => setField({ release_at: fromLocalInput(e.target.value) })} />}
            <Toggle checked={a.show_answers} onChange={(v) => setField({ show_answers: v })} icon="eye" title="Show answers & solutions" sub="Once marks are released, they see the correct answers and your worked solutions." />
            <Toggle
              checked={!!a.self_mark}
              onChange={(v) => setField(v ? { self_mark: v, max_attempts: 1 } : { self_mark: v })}
              icon="checkCircle"
              title="They mark it themselves first"
              sub="After handing in (one attempt), they see the mark scheme and give themselves marks. You then check their marks (and your own) before returning it. Good for past papers."
            />
          </div>
          <div className="card">
            <h3>Attached from the library</h3>
            <div className="muted tiny">They can open these beside the questions while they work (make the files visible too).</div>
            {attachable.length === 0 ? (
              <div className="muted small">No files in the library yet.</div>
            ) : (
              <div className="stack sm" style={{ maxHeight: 240, overflowY: 'auto' }}>
                {attachable.map((f) => {
                  const on = (a.file_refs || []).some((r) => r.file_id === f.id);
                  return (
                    <label key={f.id} className="check">
                      <input type="checkbox" checked={on} onChange={(e) => setField({ file_refs: e.target.checked ? [...(a.file_refs || []), { file_id: f.id }] : a.file_refs.filter((r) => r.file_id !== f.id) })} />
                      <span className="t small">
                        {f.name} {f.visibility === 'hidden' && <span className="pill">hidden</span>}
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
          <div className="row">
            <button
              className="btn"
              onClick={async () => {
                const c = await api.duplicateAssignment(a);
                invalidate('assignments');
                go(`/assignments/${c.id}`);
              }}
            >
              <Icon name="copy" size={16} /> Duplicate
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                if (!(await confirm({ title: `Delete “${a.title}”?`, body: 'All questions and every learner’s answers and marks for it are deleted.', ok: 'Delete', danger: true }))) return;
                await api.remove('assignments', a.id);
                invalidate('assignments', 'attempts');
                go('/assignments');
              }}
            >
              <Icon name="trash" size={16} /> Delete
            </button>
          </div>
        </div>
      </div>
    </Page>
  );
}

function QuestionEditor({ q, n, total, onChange, onMove, onRemove, onDuplicate }) {
  const lk = useLookups();
  const toast = useToast();
  const [showKey, setShowKey] = useState(true);
  const img = useRef(null);
  const setKey = (patch) => onChange({ key: { ...q.key, ...patch } });
  const setAns = (patch) => setKey({ answer: { ...(q.key.answer || {}), ...patch } });
  const opts = items(q.options);
  const isMulti = multi(q.options);
  const correct = isMulti ? q.key.answer?.choices || [] : [q.key.answer?.choice];

  function setOpts(next, m = isMulti) {
    onChange({ options: m ? { items: next, multi: true } : next });
  }

  return (
    <div className="qcard">
      <div className="qhead">
        <span className="qnum">{n}</span>
        <select className="select" style={{ width: 'auto', minHeight: 36 }} value={q.type} aria-label="Question type" onChange={(e) => onChange({ ...blankQuestion(e.target.value), _k: q._k, id: q.id, prompt_md: q.prompt_md, image_path: q.image_path, topic_id: q.topic_id })}>
          {TYPES.map((t) => (
            <option key={t.type} value={t.type}>
              {typeLabel[t.type]}
            </option>
          ))}
        </select>
        <span className="grow" />
        <label className="row small" style={{ gap: 6 }}>
          Marks
          <input className="input sm num" type="number" min="0" step="0.5" value={q.marks} onChange={(e) => onChange({ marks: e.target.value })} aria-label={`Marks for question ${n}`} />
        </label>
        <button className="btn sm ghost icon" onClick={() => onMove(-1)} disabled={n === 1} aria-label="Move up">
          <Icon name="up" size={16} />
        </button>
        <button className="btn sm ghost icon" onClick={() => onMove(1)} disabled={n === total} aria-label="Move down">
          <Icon name="down" size={16} />
        </button>
        <button className="btn sm ghost icon" onClick={onDuplicate} aria-label="Duplicate question">
          <Icon name="copy" size={16} />
        </button>
        <button className="btn sm ghost icon" onClick={onRemove} aria-label={`Delete question ${n}`}>
          <Icon name="trash" size={16} />
        </button>
      </div>
      <textarea className="textarea" style={{ minHeight: 80 }} value={q.prompt_md} onChange={(e) => onChange({ prompt_md: e.target.value })} placeholder="Question. Maths in $…$, e.g. Solve $2x + 3 = 11$." aria-label={`Question ${n}`} />
      {q.prompt_md && /\$|\*\*|\n/.test(q.prompt_md) && (
        <div className="note">
          <Markdown src={q.prompt_md} />
        </div>
      )}
      <div className="row wrap">
        {q.image_path ? (
          <>
            <StoredImage path={q.image_path} className="qimg" style={{ maxHeight: 160 }} />
            <button className="btn sm" onClick={() => onChange({ image_path: null })}>
              Remove image
            </button>
          </>
        ) : (
          <button className="btn sm" onClick={() => img.current.click()}>
            <Icon name="image" size={16} /> Add image or diagram
          </button>
        )}
        <input
          ref={img}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files[0];
            e.target.value = '';
            if (!f) return;
            try {
              onChange({ image_path: await api.uploadImage(f, 'questions') });
            } catch (x) {
              toast({ title: 'Couldn’t upload image', body: x.message, tone: 'bad' });
            }
          }}
        />
        <span className="grow" />
        <select className="select" style={{ width: 'auto', minHeight: 34, fontSize: 14 }} value={q.topic_id || ''} onChange={(e) => onChange({ topic_id: e.target.value || null })} aria-label="Topic">
          <option value="">Topic: same as assignment</option>
          {lk.topics.map((t) => (
            <option key={t.id} value={t.id}>
              {lk.subject(t.subject_id)?.name} · {t.name}
            </option>
          ))}
        </select>
      </div>

      {q.type === 'mcq' && (
        <div className="stack sm">
          <div className="row between">
            <span className="label">Options (tick the correct {isMulti ? 'ones' : 'one'})</span>
            <label className="check small">
              <input
                type="checkbox"
                checked={isMulti}
                onChange={(e) => {
                  setOpts(opts, e.target.checked);
                  setKey({ answer: e.target.checked ? { choices: correct.filter((x) => x != null) } : { choice: correct[0] ?? '0' } });
                }}
              />
              <span>More than one correct</span>
            </label>
          </div>
          {opts.map((o, i) => (
            <div key={i} className="row">
              <input
                type={isMulti ? 'checkbox' : 'radio'}
                name={`correct-${q._k}`}
                checked={correct.includes(String(i))}
                aria-label={`Option ${String.fromCharCode(65 + i)} is correct`}
                style={{ width: 18, height: 18, accentColor: 'var(--good)' }}
                onChange={(e) => {
                  if (isMulti) setAns({ choices: e.target.checked ? [...correct, String(i)] : correct.filter((c) => c !== String(i)) });
                  else setKey({ answer: { choice: String(i) } });
                }}
              />
              <span className="strong muted" style={{ width: 16 }}>{String.fromCharCode(65 + i)}</span>
              <input className="input" value={o} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? e.target.value : x)))} placeholder={`Option ${String.fromCharCode(65 + i)}`} />
              <button className="btn sm ghost icon" disabled={opts.length <= 2} aria-label="Remove option" onClick={() => setOpts(opts.filter((_, j) => j !== i))}>
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
          {opts.length < 8 && (
            <button className="linkbtn small" onClick={() => setOpts([...opts, ''])}>
              + Add option
            </button>
          )}
        </div>
      )}

      {q.type === 'numeric' && (
        <div className="grid g3" style={{ gap: 10 }}>
          <Field label="Correct answer">
            <input className="input" inputMode="decimal" value={q.key.answer?.value ?? ''} onChange={(e) => setAns({ value: e.target.value })} placeholder="e.g. 12.5" />
          </Field>
          <Field label="Allowed margin ±">
            <input className="input" inputMode="decimal" value={q.key.answer?.tolerance ?? '0'} onChange={(e) => setAns({ tolerance: e.target.value })} />
          </Field>
          <Field label="Unit (shown to learner)">
            <input className="input" value={q.key.answer?.unit ?? ''} onChange={(e) => setAns({ unit: e.target.value })} placeholder="e.g. cm²" />
          </Field>
        </div>
      )}

      <button className="linkbtn small" onClick={() => setShowKey((s) => !s)}>
        {showKey ? 'Hide' : 'Show'} answer & marking notes
      </button>
      {showKey && (
        <div className="stack sm" style={{ borderLeft: '3px solid var(--good)', paddingLeft: 14 }}>
          {q.type === 'steps' && (
            <Field label="Final answer (optional)" hint="If you add it, the marking screen tells you whether their last line matches.">
              <MathField value={q.key.answer?.final || ''} onChange={(v) => setAns({ final: v })} placeholder="x = 4" label="Final answer" />
            </Field>
          )}
          {q.type === 'short' && (
            <Field label="Model answer">
              <textarea className="textarea" style={{ minHeight: 60 }} value={q.key.answer?.text || ''} onChange={(e) => setAns({ text: e.target.value })} />
            </Field>
          )}
          <Field label="Worked solution" hint="Shown to the learner only if you turn on “Show answers & solutions”.">
            <MathText value={q.key.solution_md || ''} onChange={(v) => setKey({ solution_md: v })} label="Worked solution" placeholder="e.g. 2x + 3 = 11, so 2x = 8, so x = 4" minHeight={60} />
          </Field>
          {!['mcq', 'numeric'].includes(q.type) && (
            <Field label="Mark scheme (for you)">
              <MathText value={q.key.mark_scheme_md || ''} onChange={(v) => setKey({ mark_scheme_md: v })} label="Mark scheme" placeholder="M1 for subtracting 3, A1 for x = 4" minHeight={50} />
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

// "Goes to: Aranya, Sam" (each learner still gets their own private copy)
export function AudienceNames({ item }) {
  const lk = useLookups();
  const who = lk.audience(item).map((l) => l.display_name);
  return (
    <div className="small" style={{ color: who.length ? 'var(--ink-2)' : 'var(--amber-ink)' }}>
      {who.length ? (
        <>
          <b>Goes to:</b> {who.join(', ')}
          {who.length > 1 && <span className="muted"> · each works on their own copy</span>}
        </>
      ) : item.subject_id ? (
        'Nobody takes this subject yet. Add it to a learner, or choose learners.'
      ) : (
        'No learners yet.'
      )}
    </div>
  );
}
