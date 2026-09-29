import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { AudiencePicker, Empty, Field, Link, Loading, Markdown, Page, Seg, Toggle, VisibilityPicker, go, useConfirm, useToast } from '../../ui/kit.jsx';
import MathField from '../../ui/MathField.jsx';
import { StoredImage } from '../../ui/media.jsx';
import { invalidate, useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { fromLocalInput, toLocalInput, typeLabel, kindLabel } from '../../lib/format.js';
import { useLookups } from '../shared/lookups.jsx';
import { KIND_DEFAULTS } from './Assignments.jsx';
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

export default function AssignmentEditor({ id }) {
  const lk = useLookups();
  const toast = useToast();
  const confirm = useConfirm();
  const files = useQuery('files', api.listFiles).data || [];
  const [a, setA] = useState(null);
  const [qs, setQs] = useState([]);
  const [removed, setRemoved] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [previewIntro, setPreviewIntro] = useState(false);

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
    async ({ publish = false, quiet = false } = {}) => {
      if (!a) return;
      setBusy(true);
      try {
        const row = {
          id: a.id,
          kind: a.kind,
          title: a.title.trim() || 'Untitled',
          instructions_md: a.instructions_md || '',
          subject_id: a.subject_id || null,
          topic_id: a.topic_id || null,
          file_refs: a.file_refs || [],
          due_at: a.due_at || null,
          visibility: a.visibility,
          visible_from: a.visibility === 'scheduled' ? a.visible_from : null,
          learner_ids: a.learner_ids?.length ? a.learner_ids : null,
          lockdown: !!a.lockdown,
          camera: !!a.camera,
          time_limit_min: a.time_limit_min ? Number(a.time_limit_min) : null,
          max_attempts: Math.max(1, Number(a.max_attempts) || 1),
          allow_notes: !!a.allow_notes,
          release_mode: a.release_mode,
          release_at: a.release_mode === 'at' ? a.release_at : null,
          show_answers: !!a.show_answers,
          draft: publish ? false : a.draft,
          updated_at: new Date().toISOString(),
        };
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
        if (!quiet) toast(publish ? 'Published' : 'Saved');
      } catch (e) {
        toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
      } finally {
        setBusy(false);
      }
    },
    [a, qs, removed, toast],
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
  const attachable = files;

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
          {a.draft ? (
            <button className="btn claude" onClick={() => saveAll({ publish: true })} disabled={busy}>
              <Icon name="check" size={18} /> Approve
            </button>
          ) : null}
          <button className="btn primary" onClick={() => saveAll()} disabled={busy || !dirty}>
            Save
          </button>
        </>
      }
    >
      {a.draft && (
        <div className="card claude">
          <div className="row top">
            <Icon name="spark" style={{ color: 'var(--claude)', flexShrink: 0 }} />
            <div className="stack sm">
              <div className="strong">Drafted by Claude. Learners can’t see it yet.</div>
              <div className="small">Check the questions and answers, change anything you like, then press Approve. It follows the “Who sees it” setting once approved.</div>
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

          {qs.length === 0 && <Empty title="No questions yet">Add questions below. Mix any kinds you like.</Empty>}
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
              <span className="muted small">Total: {total} mark{total === 1 ? '' : 's'}</span>
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
            <VisibilityPicker value={a.visibility} from={a.visible_from} onChange={(v, from) => setField({ visibility: v, visible_from: from })} />
            <AudiencePicker learners={lk.learners} value={a.learner_ids} onChange={(ids) => setField({ learner_ids: ids })} />
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
            <Toggle checked={a.lockdown} onChange={(v) => setField({ lockdown: v })} icon="lock" title="Lockdown" sub="Their screen stays on StudyBridge until they submit. Needs the desktop app." />
            <Toggle checked={a.camera} onChange={(v) => setField({ camera: v })} icon="camera" title="Camera on" sub="You can watch their camera and screen live while they work." />
            <div className="grid g2" style={{ gap: 10 }}>
              <Field label="Time limit (minutes)">
                <input className="input" type="number" min="1" value={a.time_limit_min || ''} placeholder="None" onChange={(e) => setField({ time_limit_min: e.target.value ? Number(e.target.value) : null })} />
              </Field>
              <Field label="Attempts allowed">
                <input className="input" type="number" min="1" max="20" value={a.max_attempts} onChange={(e) => setField({ max_attempts: e.target.value })} />
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
            <textarea className="textarea" style={{ minHeight: 60 }} value={q.key.solution_md || ''} onChange={(e) => setKey({ solution_md: e.target.value })} placeholder="$2x + 3 = 11 \Rightarrow 2x = 8 \Rightarrow x = 4$" />
          </Field>
          {!['mcq', 'numeric'].includes(q.type) && (
            <Field label="Mark scheme (for you)">
              <textarea className="textarea" style={{ minHeight: 50 }} value={q.key.mark_scheme_md || ''} onChange={(e) => setKey({ mark_scheme_md: e.target.value })} placeholder="M1 for subtracting 3, A1 for x = 4" />
            </Field>
          )}
        </div>
      )}
    </div>
  );
}
