import { useCallback, useEffect, useRef, useState } from 'react';
import { RubricPicker } from '../shared/Rubric.jsx';
import Icon from '../../ui/Icon.jsx';
import MathText from '../../ui/MathText.jsx';
import { AudiencePicker, Empty, Field, Link, Loading, Markdown, Modal, Page, Seg, Toggle, VisibilityPicker, go, useConfirm, useLeaveGuard, useToast } from '../../ui/kit.jsx';
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
import { LETTERS, MYP_GROUPS } from '../../lib/myp.js';
import { ASSESSMENT, assessmentOf, pctText } from '../../lib/grading.js';
import { PARTS, buildQuestion, byHand, editModel, kindProblem } from '../../lib/qkinds.js';
import { KindEditor } from './KindEditors.jsx';
import { CopiesCard, LinksEditor } from '../shared/DriveUI.jsx';

let seq = 0;
const k = () => 'q' + ++seq;

const TYPES = [
  { type: 'mcq', icon: 'check', hint: 'Pick one (or more) options. Marked automatically.' },
  { type: 'numeric', icon: 'sigma', hint: 'A number, with an allowed margin. Marked automatically.' },
  { type: 'steps', icon: 'pen', hint: 'Maths line by line, so you see every step.' },
  { type: 'short', icon: 'text', hint: 'A written answer.' },
  { type: 'upload', icon: 'camera', hint: 'A photo or scan of work on paper.' },
  { type: 'drawing', icon: 'highlighter', hint: 'Drawn on screen: graphs, diagrams, geometry.' },
  { type: 'tf', icon: 'checkCircle', hint: 'True or false. Marked automatically.', label: 'True or false' },
  { type: 'cloze', icon: 'square', hint: 'Gaps to type in or choose from a list. Marked automatically.' },
  { type: 'match', icon: 'link', hint: 'Match each item, or sort them into groups. Marked automatically.' },
  { type: 'order', icon: 'menu', hint: 'Put steps or events in the right order. Marked automatically.' },
  { type: 'label', icon: 'pin', hint: 'Label the numbered places on a picture. Marked automatically.' },
  { type: 'record', icon: 'mic', hint: 'They record their voice, camera or screen.' },
  { type: 'file', icon: 'upload', hint: 'A document, a recording or a link (Google Docs, OneDrive).' },
];
const REAL_TYPES = TYPES.filter((t) => t.type !== 'tf');
const DEFAULT_MARKS = { steps: 3, upload: 4, drawing: 4, cloze: 2, match: 3, order: 2, label: 3, record: 4, file: 4 };

function blankQuestion(type) {
  // True or false is multiple choice with two options
  if (type === 'tf') return { ...blankQuestion('mcq'), options: ['True', 'False'] };
  return {
    _k: k(),
    type,
    prompt_md: '',
    image_path: null,
    options: type === 'mcq' ? ['', '', '', ''] : type === 'record' ? { media: 'audio', max: 180 } : [],
    marks: DEFAULT_MARKS[type] || 1,
    topic_id: null,
    key: { answer: type === 'mcq' ? { choice: '0' } : type === 'numeric' ? { value: '', tolerance: '0' } : {}, solution_md: '', mark_scheme_md: '' },
    ...(type === 'match' ? { edit: { rows: [{ item: '', match: '' }, { item: '', match: '' }, { item: '', match: '' }], extras: [] } } : {}),
    ...(type === 'order' ? { edit: { items: ['', '', ''] } } : {}),
    ...(type === 'label' ? { edit: { spots: [], extras: [] } } : {}),
    ...(type === 'cloze' ? { edit: { src: '' } } : {}),
  };
}
// The editor's model for the newer types (what the teacher edits), from a saved question
const withEdit = (q) => (PARTS.includes(q.type) && !q.edit ? { ...q, edit: editModel(q, q.key?.answer) } : q);

// Anything that would confuse a learner if posted as it is
export function checkReady(a, qs) {
  if (!a.title.trim()) return 'Give it a title.';
  if (!qs.length) return 'Add at least one question.';
  for (const [i, q0] of qs.entries()) {
    const n = `Question ${i + 1}`;
    const q = withEdit(q0);
    const kp = kindProblem(q, n);
    if (kp) return kp;
    if (q.type !== 'cloze' && !q.prompt_md.trim() && !q.image_path) return `${n} has no question text.`;
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

// Post straight from the assignments list: the same checks as the editor's Post button
export async function quickPost(a, files) {
  const q = await api.listQuestions(a.id);
  const keys = await api.listKeys(q.map((x) => x.id));
  const problem = checkReady(a, q.map((x) => ({ ...x, key: keys.find((y) => y.question_id === x.id) || { answer: {} } })));
  if (problem) throw new Error(problem);
  const visibility = a.visibility === 'scheduled' && a.visible_from && new Date(a.visible_from) > new Date() ? 'scheduled' : 'visible';
  if (visibility !== 'hidden') await api.ensureCloudIds((a.file_refs || []).map((r) => r.file_id), files);
  return api.save('assignments', { id: a.id, visibility, visible_from: visibility === 'scheduled' ? a.visible_from : null, draft: false, updated_at: new Date().toISOString() });
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
  const [changing, setChanging] = useState(null); // "Change this part": { q, n }
  useLeaveGuard(dirty);
  // The exam camera comes with Plus: without it, a camera that's already on (saved) stays, and none is switched on
  const noPlus = useQuery('my-plan', api.myPlan).data?.plus === false;
  const savedCamera = useRef(false);

  const load = useCallback(async () => {
    try {
      const row = await api.getAssignment(id);
      if (!row) return setErr('This assignment no longer exists.');
      const q = await api.listQuestions(id);
      const keys = await api.listKeys(q.map((x) => x.id));
      savedCamera.current = !!row.camera;
      setA(row);
      setQs(q.map((x) => withEdit({ ...x, _k: k(), key: keys.find((y) => y.question_id === x.id) || { answer: {}, solution_md: '', mark_scheme_md: '' } })));
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
      const wasLive = !a.draft && a.visibility !== 'hidden'; // already posted: saving keeps you here
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
          links: a.links || [], // Google Drive, OneDrive and web links
          peer: a.class_id ? a.peer || null : null, // peer review (work set for a class)
          due_at: a.due_at || null,
          visibility,
          visible_from: visibility === 'scheduled' ? a.visible_from : null,
          learner_ids: a.learner_ids?.length ? a.learner_ids : null,
          class_id: a.class_id || null, // the server keeps a class's learners in step
          lockdown: !!a.lockdown,
          leave_warnings: Math.max(0, Math.min(5, Number(a.leave_warnings ?? 1))),
          camera: !!a.camera,
          watched: !!a.watched && !!(a.lockdown || a.camera), // also in a browser, full screen and watched
          time_limit_min: a.time_limit_min ? Number(a.time_limit_min) : null,
          max_attempts: Math.max(1, Number(a.max_attempts) || 1),
          allow_notes: !!a.allow_notes,
          release_mode: a.release_mode,
          release_at: a.release_mode === 'at' ? a.release_at : null,
          show_answers: !!a.show_answers,
          self_mark: !!a.self_mark,
          criteria: a.criteria || [], // IB MYP criteria it's assessed on
          category_id: a.class_id ? a.category_id || null : null, // its class's gradebook category
          assessment: a.assessment || null, // formative or summative (unset: from its kind)
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
          const b = buildQuestion(q); // the newer types: the text learners see, the public options and the key
          const saved = await api.save('questions', {
            ...(q.id ? { id: q.id } : {}),
            assignment_id: a.id,
            position: i,
            type: q.type,
            prompt_md: b.prompt_md || '',
            image_path: q.image_path || null,
            options: b.options || [],
            marks: Number(q.marks) || 0,
            topic_id: q.topic_id || null,
            rubric_id: q.rubric_id || null,
          });
          await api.saveKey({ question_id: saved.id, answer: b.answer || {}, solution_md: q.key.solution_md || null, mark_scheme_md: q.key.mark_scheme_md || null });
          next.push({ ...q, id: saved.id, prompt_md: q.type === 'cloze' ? b.prompt_md : q.prompt_md, options: b.options, key: { ...q.key, answer: b.answer } });
        }
        const s = await api.save('assignments', row);
        savedCamera.current = !!s.camera;
        setA(s);
        setQs(next);
        setRemoved([]);
        setDirty(false);
        invalidate('assignments');
        if ((post || publish) && wasLive) toast('Changes saved. Learners see the new version.');
        else if (post || publish) {
          const who = lk.audience(s).map((l) => l.display_name);
          const cls = s.class_id && lk.klass(s.class_id);
          const whoText = who.length ? (cls ? `${cls.name}: ${who.join(', ')}` : who.join(', ')) : cls ? `nobody yet (nobody is in ${cls.name})` : 'nobody yet (no learners take this subject)';
          toast(
            s.visibility === 'scheduled'
              ? { title: `Scheduled: ${s.title}`, body: `${whoText} will see it from ${new Date(s.visible_from).toLocaleString()}.` }
              : { title: `Posted: ${s.title}`, body: `Sent to ${whoText}.` },
          );
          go('/assignments', { force: true });
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

  async function removeIt() {
    if (!(await confirm({ title: `Delete “${a.title}”?`, body: 'All questions and every learner’s answers and marks for it are deleted.', ok: 'Delete', danger: true }))) return;
    try {
      await api.remove('assignments', a.id);
    } catch (e) {
      return toast({ title: 'Couldn’t delete it', body: e.message, tone: 'bad' });
    }
    invalidate('assignments', 'attempts');
    toast('Deleted');
    go('/assignments', { force: true });
  }
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
          {live && (a.time_limit_min || a.lockdown || a.kind === 'test' || a.kind === 'exam') && (
            <button className="btn" onClick={() => go(`/exam/${a.id}`)}>
              <Icon name="users" size={18} /> Exam room
            </button>
          )}
          {!a.draft && (
            <button className="btn ghost" onClick={() => removeIt()} disabled={busy} aria-label={`Delete ${a.title}`}>
              <Icon name="trash" size={16} /> Delete
            </button>
          )}
          {live ? (
            <button className="btn primary" onClick={() => saveAll({ post: true })} disabled={busy}>
              <Icon name="check" size={18} /> Save changes
            </button>
          ) : (
            <>
              {a.draft && (
                <button className="btn ghost" onClick={async () => (await discard('assignments', a)) && go(a.source === 'prof' || a.source === 'claude' ? '/prof' : '/assignments', { force: true })} disabled={busy}>
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
              <textarea className="textarea" aria-label="Instructions" value={a.instructions_md || ''} onChange={(e) => setField({ instructions_md: e.target.value })} placeholder="What should the learner do? e.g. Show all your working. Use the textbook pages attached if you get stuck." />
            )}
          </div>

          {changing && <ChangePart q={changing.q} n={changing.n} onClose={() => setChanging(null)} onDone={load} />}
          {picking && (
            <BankPicker
              onClose={() => setPicking(false)}
              onPick={(rows) => {
                setQs((list) => [...list, ...rows.map((b) => withEdit({ ...api.bankToQuestion(b), topic_id: a.topic_id || null, _k: k() }))]);
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
              onAskProf={q.id && !noPlus ? () => (dirty ? toast({ title: 'Save first', body: 'Save your changes, then ask Prof to change this question.' }) : setChanging({ q, n: i + 1 })) : null}
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
                    <div className="strong small">{t.label || typeLabel[t.type]}</div>
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
            <AudiencePicker learners={lk.learners} value={a.learner_ids} onChange={(ids, cls) => setField({ learner_ids: ids, class_id: cls })} classes={lk.activeClasses} classId={a.class_id} />
            <AudienceNames item={a} />
            <Field label="Due">
              <input className="input" type="datetime-local" value={toLocalInput(a.due_at)} onChange={(e) => setField({ due_at: fromLocalInput(e.target.value) })} />
            </Field>
            <ClashNote a={a} />
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
                  setField(use ? { kind, ...KIND_DEFAULTS[kind], ...(noPlus && !savedCamera.current ? { camera: false } : {}) } : { kind });
                }}
              >
                {Object.entries(kindLabel).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <GradingFields a={a} setField={setField} />
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
              <Field
                label="If they try to leave"
                hint={`Switching window, closing StudyBridge or a blocked shortcut${a.watched ? ' (in a browser: leaving the page or full screen)' : ''}. You’re told each time, and you can end it early from the exam camera page.`}
              >
                <select className="select" value={a.leave_warnings ?? 1} onChange={(e) => setField({ leave_warnings: Number(e.target.value) })}>
                  <option value={0}>Hand it in straight away</option>
                  <option value={1}>Warn once, then hand it in</option>
                  <option value={2}>Warn twice, then hand it in</option>
                  <option value={3}>Warn three times, then hand it in</option>
                </select>
              </Field>
            )}
            <Toggle checked={a.camera} onChange={(v) => setField({ camera: v })} disabled={noPlus && !savedCamera.current && !a.camera} icon="camera" title="Camera on" sub="You can watch their camera and screen live while they work." />
            {noPlus && (
              <div className="small muted plus-note">
                The exam camera comes with Plus. <Link to="/settings?s=plan">See your plan</Link>
              </div>
            )}
            {(a.lockdown || a.camera) && (
              <Toggle
                checked={!!a.watched}
                onChange={(v) => setField({ watched: v })}
                icon="eye"
                title="Allow on any device (watched)"
                sub="Learners can also do it in a browser on a Chromebook, iPad or phone. It goes full screen, and leaving the page counts as trying to leave."
              />
            )}
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
            <MypCriteria a={a} setField={setField} />
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
          <div className="card">
            <h3>Links, Google Drive and OneDrive</h3>
            <div className="muted tiny">They open in the browser. A Drive or OneDrive file can be for everyone to view, or a copy for each learner to work in.</div>
            <LinksEditor links={a.links || []} onChange={(links) => setField({ links })} allowCopy dirty={dirty} />
          </div>
          <CopiesCard assignment={a} />
          <PeerFields a={a} setField={setField} live={live} />
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
            <button className="btn danger" onClick={() => removeIt()}>
              <Icon name="trash" size={16} /> Delete
            </button>
          </div>
        </div>
      </div>
    </Page>
  );
}

const PLACEHOLDER = {
  match: 'e.g. Match each country to its capital.',
  order: 'e.g. Put the stages of mitosis in order.',
  label: 'e.g. Label the parts of the heart.',
  record: 'e.g. Read the poem aloud, then say what it means to you.',
  file: 'e.g. Hand in your essay as a document or a link.',
};

function QuestionEditor({ q, n, total, onChange, onMove, onRemove, onDuplicate, onAskProf }) {
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
        <select className="select" style={{ width: 'auto', minHeight: 36 }} value={q.type} aria-label="Question type" onChange={(e) => onChange({ ...blankQuestion(e.target.value), _k: q._k, id: q.id, prompt_md: q.type === 'cloze' ? '' : q.prompt_md, image_path: q.image_path, topic_id: q.topic_id })}>
          {REAL_TYPES.map((t) => (
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
        {onAskProf && (
          <button className="btn sm ghost" onClick={onAskProf} aria-label={`Change question ${n} with Prof`}>
            <Icon name="cap" size={16} /> Change with Prof
          </button>
        )}
        <button className="btn sm ghost icon" onClick={onDuplicate} aria-label="Duplicate question">
          <Icon name="copy" size={16} />
        </button>
        <button className="btn sm ghost icon" onClick={onRemove} aria-label={`Delete question ${n}`}>
          <Icon name="trash" size={16} />
        </button>
      </div>
      {q.type !== 'cloze' && (
        <textarea
          className="textarea"
          style={{ minHeight: 80 }}
          value={q.prompt_md}
          onChange={(e) => onChange({ prompt_md: e.target.value })}
          placeholder={PLACEHOLDER[q.type] || 'Question. Maths in $…$, e.g. Solve $2x + 3 = 11$.'}
          aria-label={`Question ${n}`}
        />
      )}
      {q.type !== 'cloze' && q.prompt_md && /\$|\*\*|\n/.test(q.prompt_md) && (
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

      <KindEditor q={q} onChange={onChange} />

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
          {['short', 'record', 'file'].includes(q.type) && (
            <Field label="Model answer">
              <textarea className="textarea" style={{ minHeight: 60 }} value={q.key.answer?.text || ''} onChange={(e) => setAns({ text: e.target.value })} />
            </Field>
          )}
          <Field label="Worked solution" hint="Shown to the learner only if you turn on “Show answers & solutions”.">
            <MathText value={q.key.solution_md || ''} onChange={(v) => setKey({ solution_md: v })} label="Worked solution" placeholder="e.g. 2x + 3 = 11, so 2x = 8, so x = 4" minHeight={60} />
          </Field>
          {byHand(q.type) && <RubricPicker q={q} onChange={onChange} />}
          {byHand(q.type) && (
            <Field label="Mark scheme (for you)">
              <MathText value={q.key.mark_scheme_md || ''} onChange={(v) => setKey({ mark_scheme_md: v })} label="Mark scheme" placeholder="M1 for subtracting 3, A1 for x = 4" minHeight={50} />
            </Field>
          )}
        </div>
      )}
    </div>
  );
}

// "Year 10 maths (3 learners)" for something set for a class (null if it isn't, or the class was deleted)
function classText(lk, item) {
  const c = item.class_id && lk.klass(item.class_id);
  if (!c) return null;
  const n = lk.audience(item).length;
  return `${c.name} (${n ? `${n} learner${n === 1 ? '' : 's'}` : 'nobody yet'})`;
}

// "Goes to: Aranya, Sam" (each learner still gets their own private copy)
export function AudienceNames({ item }) {
  const lk = useLookups();
  const who = lk.audience(item).map((l) => l.display_name);
  const cls = classText(lk, item);
  return (
    <div className="small" style={{ color: who.length ? 'var(--ink-2)' : 'var(--amber-ink)' }}>
      {who.length ? (
        <>
          <b>Goes to:</b> {cls || who.join(', ')}
          {who.length > 1 && <span className="muted"> · each works on their own copy</span>}
        </>
      ) : cls ? (
        `Nobody is in ${lk.klass(item.class_id).name} yet. Whoever you add to it gets this.`
      ) : item.subject_id ? (
        'Nobody takes this subject yet. Add it to a learner, or choose learners.'
      ) : (
        'No learners yet.'
      )}
    </div>
  );
}

// "Change this part": Prof changes just this question, or just its mark scheme, as the tutor asks (a fraction of a
// cent instead of redoing the paper). The work stays a draft until the tutor checks it.
function ChangePart({ q, n, onClose, onDone }) {
  const toast = useToast();
  const [part, setPart] = useState('question');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  async function send(e) {
    e.preventDefault();
    if (!text.trim()) return setErr('Say what Prof should change.');
    setBusy(true);
    setErr('');
    try {
      const { id } = await api.profRevise(q.id, part, text.trim());
      // wait for Prof (usually under a minute), then show the change
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const j = await api.profJob(id);
        if (j?.status === 'done') {
          await onDone();
          toast({ title: `Prof changed question ${n}`, body: `${j.result?.reply || ''} Check it before you post.`.trim() });
          return onClose();
        }
        if (j?.status === 'failed') throw new Error(j.error || 'Prof couldn’t change it. Try again.');
      }
      toast({ title: 'Prof is still working on it', body: 'You’ll get a notification when it’s done.' });
      onClose();
    } catch (x) {
      setErr(x.message);
      setBusy(false);
    }
  }
  return (
    <Modal title={`Change question ${n} with Prof`} onClose={busy ? () => {} : onClose}>
      <form className="stack" onSubmit={send}>
        <div className="small muted">Prof changes only this question, so it’s quick. The work stays a draft until you’ve checked it.</div>
        <Seg
          label="What to change"
          value={part}
          onChange={setPart}
          options={[
            { value: 'question', label: 'The question' },
            { value: 'scheme', label: 'Just the mark scheme' },
          ]}
        />
        <Field label="What should Prof change?">
          <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} placeholder={part === 'scheme' ? 'e.g. Give a method mark for setting up the equation' : 'e.g. Make it a bit harder, with a negative answer'} />
        </Field>
        {err && <div className="error">{err}</div>}
        <div className="foot row end">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn claude" disabled={busy}>
            <Icon name="cap" size={18} /> {busy ? 'Prof is changing it…' : 'Ask Prof'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// IB MYP criteria (running a school, part 2): work in an MYP subject can be assessed on some of the subject group's
// criteria A to D; marking it gives a level from 0 to 8 for each
function MypCriteria({ a, setField }) {
  const lk = useLookups();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const s = a.subject_id ? lk.subject(a.subject_id) : null;
  if (!s) return null;
  const group = MYP_GROUPS[s.myp_group];
  const on = a.criteria || [];
  async function setGroup(g) {
    try {
      await api.setMypGroup(s.id, g || null);
      invalidate('subjects');
      if (!g) setField({ criteria: [] });
    } catch (e) {
      toast({ title: 'Couldn’t change the subject', body: e.message, tone: 'bad' });
    }
  }
  if (!group && !open)
    return (
      <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>
        An IB MYP subject? Assess it on its criteria
      </button>
    );
  return (
    <Field label="IB MYP criteria" hint={group ? 'Pick the criteria this work is assessed on. When you mark it, you give a level from 0 to 8 for each.' : 'Which subject group is it in? Its criteria A to D come from that.'}>
      <div className="stack sm">
        <select className="select" aria-label="MYP subject group" value={s.myp_group || ''} onChange={(e) => setGroup(e.target.value)}>
          <option value="">Not an MYP subject</option>
          {Object.entries(MYP_GROUPS).map(([k, g]) => (
            <option key={k} value={k}>
              {g.name}
            </option>
          ))}
        </select>
        {group && (
          <div className="row wrap" style={{ gap: 6 }}>
            {LETTERS.map((k) => {
              const picked = on.includes(k);
              return (
                <button key={k} className="chip" aria-pressed={picked} onClick={() => setField({ criteria: picked ? on.filter((x) => x !== k) : [...on, k].sort() })}>
                  {k}: {group.criteria[k]}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Field>
  );
}

// Gradebook depth: formative (practice and feedback) or summative (it counts for grades; tests and exams are summative
// unless the teacher says otherwise), and, for work set to a class with categories, which category it goes in
// Peer review (step 6): classmates review each other's hand-ins; the teacher reads every review before it's passed on
const PEER_DEFAULT = { count: 2, anonymous: true, prompts: ['What went well?', 'One thing that would make it better'], rubric: true, start: 'due', days: 3 };
function PeerFields({ a, setField, live }) {
  const p = a.peer;
  const set = (patch) => setField({ peer: { ...PEER_DEFAULT, ...(p || {}), ...patch } });
  return (
    <div className="card">
      <h3>Peer review</h3>
      {!a.class_id ? (
        <div className="small muted">Set it for a class (Who sees it → A class) to let classmates review each other’s work.</div>
      ) : (
        <>
          <Toggle checked={!!p} onChange={(v) => setField({ peer: v ? { ...PEER_DEFAULT } : null })} icon="users" title="Classmates review each other’s work" sub="After handing in, each reviews a few classmates’ answers. You read every review before its author sees it, and reviews never change marks." />
          {p && (
            <div className="stack sm">
              <div className="grid g2" style={{ gap: 10 }}>
                <Field label="Reviews each">
                  <select className="select" value={p.count ?? 2} onChange={(e) => set({ count: Number(e.target.value) })}>
                    {[1, 2, 3].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Days to review">
                  <select className="select" value={p.days ?? 3} onChange={(e) => set({ days: Number(e.target.value) })}>
                    {[1, 2, 3, 5, 7, 14].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Reviews start">
                <select className="select" value={p.start || 'due'} onChange={(e) => set({ start: e.target.value })}>
                  <option value="due">At the due date</option>
                  <option value="hand">When I give them out</option>
                </select>
              </Field>
              <Toggle
                checked={p.anonymous !== false}
                onChange={(v) => set({ anonymous: v })}
                icon="eyeOff"
                title="Don’t show names"
                sub={p.anonymous !== false ? 'They review typed answers, maths working and drawings (photos, recordings and files could give a name away).' : 'They see whose work it is, and photos, recordings and files too.'}
              />
              <Toggle checked={p.rubric !== false} onChange={(v) => set({ rubric: v })} icon="layers" title="Show the question’s rubric" sub="Reviewers can pick a level on it. It never sets the mark." />
              <Field label="What reviewers answer (one per line, up to 4)">
                <textarea
                  className="textarea"
                  style={{ minHeight: 60 }}
                  value={(p.prompts || []).join('\n')}
                  onChange={(e) => set({ prompts: e.target.value.split('\n').slice(0, 4) })}
                  aria-label="What reviewers answer"
                />
              </Field>
              {live && a.id && (
                <button className="btn sm" onClick={() => go(`/peer/${a.id}`)}>
                  <Icon name="users" size={16} /> Peer review page
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function GradingFields({ a, setField }) {
  const cats = useQuery(a.class_id ? `class-cats:${a.class_id}` : null, () => api.classCategories(a.class_id)).data || [];
  const kind = assessmentOf(a.kind, a.assessment);
  return (
    <>
      <Field label="Formative or summative" hint={kind === 'summative' ? 'Summative: it counts for grades, and shows on the assessment calendar.' : 'Formative: practice and feedback.'}>
        <Seg
          label="Formative or summative"
          value={kind}
          onChange={(v) => setField({ assessment: v === assessmentOf(a.kind, null) ? null : v })}
          options={['formative', 'summative'].map((v) => ({ value: v, label: ASSESSMENT[v].label }))}
        />
      </Field>
      {a.class_id && cats.length > 0 && (
        <Field label="Gradebook category" hint="How it counts in the class’s gradebook.">
          <select className="select" value={cats.some((c) => c.id === a.category_id) ? a.category_id : ''} onChange={(e) => setField({ category_id: e.target.value || null })}>
            <option value="">No category (doesn’t count)</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({pctText(c.weight)})
              </option>
            ))}
          </select>
        </Field>
      )}
    </>
  );
}

// Before setting summative work: what the same learners already have due that day at this centre or school (or from
// this tutor), and how many would then have three or more that week
function ClashNote({ a }) {
  const summative = assessmentOf(a.kind, a.assessment) === 'summative';
  const key = summative && a.due_at ? `clash:${a.id}:${a.due_at}:${a.class_id || ''}:${(a.learner_ids || []).join(',')}:${a.subject_id || ''}` : null;
  const q = useQuery(key, () => api.assessmentClashes({ due: a.due_at, classId: a.class_id, learners: a.learner_ids, subject: a.subject_id, except: a.id }));
  const c = key && q.data;
  if (!c || (!c.items.length && !c.busy)) return null;
  const n = (k, one, many = one + 's') => `${k} ${k === 1 ? one : many}`;
  return (
    <div className="card warn stack sm" role="status" style={{ padding: '10px 12px' }}>
      {c.items.length > 0 && (
        <div className="small">
          <b>A clash that day:</b> {n(c.learners, 'learner')} already {c.learners === 1 ? 'has' : 'have'}{' '}
          {c.items
            .map((x) => `${x.title} (${[x.class, x.mine ? null : x.by].filter(Boolean).join(', ') || kindLabel[x.kind]}: ${x.learners <= 3 ? (x.names || []).join(', ') : `${x.learners} learners`})`)
            .join('; ')}
          .
        </div>
      )}
      {c.busy > 0 && <div className="small">That week, {n(c.busy, 'learner')} would have three or more tests and exams.</div>}
      <Link to="/timetable/assessments" className="small">
        See the assessment calendar
      </Link>
    </div>
  );
}
