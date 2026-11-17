// Canvas gaps, part 2 (17 Nov 2026), in the assignment editor: question pools (each learner gets a share of a pool at
// random), random numbers in a number question (each learner's own, the answer from a formula) and reading passages that
// several questions share.
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Field, Markdown, Modal, Toggle, useConfirm, useToast } from '../../ui/kit.jsx';
import { invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { evalFormula, fillVars, sampleVars, varsProblem } from '../../lib/randomq.js';

// Which pool a question is in, and which passage it uses (on each question)
export function QuestionPlace({ q, n, onChange, passages }) {
  return (
    <>
      <select className="select" style={{ width: 'auto', minHeight: 34, fontSize: 14 }} value={q.pool || ''} onChange={(e) => onChange({ pool: e.target.value ? Number(e.target.value) : null })} aria-label={`Pool for question ${n}`}>
        <option value="">Everyone gets it</option>
        {[1, 2, 3, 4, 5].map((p) => (
          <option key={p} value={p}>
            In pool {p}
          </option>
        ))}
      </select>
      {passages.length > 0 && (
        <select className="select" style={{ width: 'auto', minHeight: 34, fontSize: 14 }} value={q.passage_id || ''} onChange={(e) => onChange({ passage_id: e.target.value || null })} aria-label={`Reading passage for question ${n}`}>
          <option value="">No passage</option>
          {passages.map((p, i) => (
            <option key={p.id} value={p.id}>
              Passage: {p.title || `Passage ${i + 1}`}
            </option>
          ))}
        </select>
      )}
    </>
  );
}

// The pools used, and how many of each a learner gets
export const usedPools = (qs) => [...new Set(qs.map((q) => q.pool).filter(Boolean))].sort();
export function poolsProblem(a, qs) {
  for (const p of usedPools(qs)) {
    const inPool = qs.filter((q) => q.pool === p);
    const pick = Number(a.pool_pick?.[p]) || 0;
    if (pick < 1 || pick > inPool.length) return `Pool ${p}: choose how many of its ${inPool.length} questions each learner gets.`;
    if (new Set(inPool.map((q) => Number(q.marks) || 0)).size > 1) return `Pool ${p}: give its questions the same marks, so everyone’s total is the same.`;
  }
  return null;
}
// The picks as saved: only pools in use
export const cleanPick = (a, qs) => {
  const used = usedPools(qs);
  if (!used.length) return null;
  return Object.fromEntries(used.map((p) => [String(p), Math.max(1, Math.min(qs.filter((q) => q.pool === p).length, Number(a.pool_pick?.[p]) || 1))]));
};

export function PoolsCard({ a, qs, setField }) {
  const used = usedPools(qs);
  return (
    <div className="card">
      <h3>Question pools</h3>
      {used.length === 0 ? (
        <div className="small muted">Put questions in a pool (on each question) and each learner gets only some of them, picked at random, so neighbours get different questions.</div>
      ) : (
        <div className="stack sm">
          {used.map((p) => {
            const inPool = qs.filter((q) => q.pool === p).length;
            const pick = Math.max(1, Math.min(inPool, Number(a.pool_pick?.[p]) || 1));
            return (
              <label key={p} className="row wrap small" style={{ gap: 6 }}>
                Pool {p}: each learner gets
                <input
                  className="input sm num"
                  type="number"
                  min="1"
                  max={inPool}
                  value={pick}
                  aria-label={`How many from pool ${p}`}
                  onChange={(e) => setField({ pool_pick: { ...(a.pool_pick || {}), [p]: Math.max(1, Math.min(inPool, Number(e.target.value) || 1)) } })}
                />
                of its {inPool}
              </label>
            );
          })}
          <div className="tiny muted">Everyone gets every question that isn’t in a pool. Questions in one pool need the same marks.</div>
        </div>
      )}
    </div>
  );
}

// A number question with random numbers: its letters, and the formula for the answer
export function RandomNumbers({ q, onChange, setAns }) {
  const spec = q.options?.vars || null;
  const on = !!spec;
  const set = (next) => onChange({ options: { vars: next } });
  const sample = on ? sampleVars(spec) : null;
  const result = on ? evalFormula(q.key.answer?.formula, sample) : null;
  const problem = on ? varsProblem(spec) : null;
  return (
    <div className="stack sm">
      <Toggle
        checked={on}
        onChange={(v) => {
          if (v) {
            onChange({ options: { vars: [{ name: 'a', min: 2, max: 9, step: 1 }] }, key: { ...q.key, answer: { ...(q.key.answer || {}), value: '', formula: q.key.answer?.formula || 'a' } } });
          } else {
            const { formula: _f, ...rest } = q.key.answer || {};
            onChange({ options: [], key: { ...q.key, answer: rest } });
          }
        }}
        icon="sigma"
        title="Different numbers for each learner"
        sub="Write letters in curly brackets in the question, like {a} and {b}. Each learner gets their own numbers, and the answer is worked out from your formula."
      />
      {on && (
        <>
          {spec.map((v, i) => (
            <div key={i} className="row wrap" style={{ gap: 6 }}>
              <input className="input sm" style={{ width: 56 }} value={v.name} maxLength={2} aria-label={`Letter ${i + 1}`} onChange={(e) => set(spec.map((x, j) => (j === i ? { ...x, name: e.target.value.toLowerCase() } : x)))} />
              <span className="small">from</span>
              <input className="input sm num" inputMode="decimal" value={v.min} aria-label={`Lowest ${v.name}`} onChange={(e) => set(spec.map((x, j) => (j === i ? { ...x, min: e.target.value } : x)))} />
              <span className="small">to</span>
              <input className="input sm num" inputMode="decimal" value={v.max} aria-label={`Highest ${v.name}`} onChange={(e) => set(spec.map((x, j) => (j === i ? { ...x, max: e.target.value } : x)))} />
              <span className="small">in steps of</span>
              <input className="input sm num" inputMode="decimal" value={v.step ?? 1} aria-label={`Step for ${v.name}`} onChange={(e) => set(spec.map((x, j) => (j === i ? { ...x, step: e.target.value } : x)))} />
              <button className="btn sm ghost icon" disabled={spec.length <= 1} aria-label={`Remove letter ${v.name}`} onClick={() => set(spec.filter((_, j) => j !== i))}>
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
          {spec.length < 6 && (
            <button className="linkbtn small" onClick={() => set([...spec, { name: 'abcdefgh'.split('').find((c) => !spec.some((x) => x.name === c)) || '', min: 1, max: 10, step: 1 }])}>
              + Add a letter
            </button>
          )}
          <Field label="Answer formula" hint="Use the letters, numbers, + − * / ^, brackets and sqrt( ). For example a*b or (a+b)/2.">
            <input className="input" value={q.key.answer?.formula || ''} onChange={(e) => setAns({ formula: e.target.value })} placeholder="e.g. a*b" />
          </Field>
          {problem ? (
            <div className="error small">{problem}</div>
          ) : (
            <div className="small muted">
              For example, with {Object.entries(sample).map(([k, x]) => `${k} = ${x}`).join(', ')}: {result == null ? <span className="error">the formula doesn’t work out yet</span> : <b>{result}</b>}
              {q.prompt_md && /\{[a-z]{1,2}\}/.test(q.prompt_md) && <span> · “{fillVars(q.prompt_md, sample).slice(0, 80)}”</span>}
            </div>
          )}
        </>
      )}
    </div>
  );
}

// Reading passages: saved as they're added or changed (questions then point at them)
export function PassagesCard({ assignmentId, passages }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(null); // a passage, or {} for a new one
  async function remove(p) {
    if (!(await confirm({ title: `Delete “${p.title || 'this passage'}”?`, body: 'Questions that used it stay; they just don’t show it.', ok: 'Delete', danger: true }))) return;
    try {
      await api.remove('question_passages', p.id);
      invalidate(`passages:${assignmentId}`);
    } catch (e) {
      toast({ title: 'Couldn’t delete it', body: e.message, tone: 'bad' });
    }
  }
  return (
    <div className="card">
      <h3>Reading passages</h3>
      <div className="tiny muted">A text or source that several questions share. Learners see it above the first question that uses it.</div>
      {passages.length > 0 && (
        <div className="list small">
          {passages.map((p, i) => (
            <div key={p.id} className="item">
              <span className="grow">{p.title || `Passage ${i + 1}`}</span>
              <button className="btn sm ghost" onClick={() => setEditing(p)} aria-label={`Change ${p.title || `passage ${i + 1}`}`}>
                Change
              </button>
              <button className="btn sm ghost icon" onClick={() => remove(p)} aria-label={`Delete ${p.title || `passage ${i + 1}`}`}>
                <Icon name="trash" size={16} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div>
        <button className="btn sm" onClick={() => setEditing({})}>
          <Icon name="plus" size={16} /> Add a passage
        </button>
      </div>
      {editing && <PassageEditor assignmentId={assignmentId} p={editing} position={passages.length} onClose={() => setEditing(null)} />}
    </div>
  );
}
function PassageEditor({ assignmentId, p, position, onClose }) {
  const toast = useToast();
  const [title, setTitle] = useState(p.title || '');
  const [body, setBody] = useState(p.body_md || '');
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      await api.save('question_passages', { ...(p.id ? { id: p.id } : { assignment_id: assignmentId, position }), title: title.trim(), body_md: body });
      invalidate(`passages:${assignmentId}`);
      toast('Passage saved');
      onClose();
    } catch (x) {
      toast({ title: 'Couldn’t save it', body: x.message, tone: 'bad' });
      setBusy(false);
    }
  }
  return (
    <Modal title={p.id ? 'Change the passage' : 'A reading passage'} wide onClose={onClose}>
      <form className="stack" onSubmit={save}>
        <Field label="Title">
          <input className="input" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Source A: a letter from 1914" />
        </Field>
        <div className="row between">
          <span className="label">The passage</span>
          <button type="button" className="linkbtn small" onClick={() => setPreview((x) => !x)}>
            {preview ? 'Write' : 'Preview'}
          </button>
        </div>
        {preview ? (
          <div className="card">
            <Markdown src={body || '*Nothing yet.*'} />
          </div>
        ) : (
          <textarea className="textarea" style={{ minHeight: 220 }} value={body} maxLength={20000} onChange={(e) => setBody(e.target.value)} aria-label="The passage" />
        )}
        <div className="foot row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            Save passage
          </button>
        </div>
      </form>
    </Modal>
  );
}

// For learners and markers: the passage shown above the first question that uses it
export function PassageBox({ p }) {
  if (!p) return null;
  return (
    <div className="card passage" style={{ background: 'var(--sunk)' }}>
      <div className="tiny strong muted">{p.title || 'Read this first'}</div>
      <Markdown src={p.body_md || ''} />
    </div>
  );
}
// Which questions start a passage (the first of its questions in this list)
export const passageStarts = (qs) => {
  const seen = new Set();
  const out = {};
  for (const q of qs) {
    if (q.passage_id && !seen.has(q.passage_id)) {
      seen.add(q.passage_id);
      out[q.id] = q.passage_id;
    }
  }
  return out;
};
