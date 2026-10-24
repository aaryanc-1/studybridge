// Rubrics: criteria, each with levels worth marks. A teacher marks a question by picking a level for each criterion
// (the mark is the sum); the learner sees the levels they reached once marks are given back.
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Field, Modal, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';

// The most a rubric gives (the best level of each criterion)
export const rubricMax = (r) => (r?.criteria || []).reduce((s, c) => s + Math.max(0, ...(c.levels || []).map((l) => Number(l.points) || 0)), 0);
// The mark for the levels picked ({ criterion index: level index })
export const rubricMark = (r, picked) =>
  (r?.criteria || []).reduce((s, c, i) => (picked?.[i] == null ? s : s + (Number(c.levels?.[picked[i]]?.points) || 0)), 0);

const blankRubric = () => ({
  title: '',
  criteria: [
    { name: 'Understanding', levels: [{ label: 'Not yet', points: 0 }, { label: 'Partly', points: 1 }, { label: 'Fully', points: 2 }] },
    { name: 'Working shown', levels: [{ label: 'Not yet', points: 0 }, { label: 'Partly', points: 1 }, { label: 'Fully', points: 2 }] },
  ],
});

// The grid: criteria down the side, levels across. With onPick it's for marking; without, it shows what was reached.
export function RubricGrid({ rubric, picked = {}, onPick, n }) {
  if (!rubric) return null;
  return (
    <div className="rubric" role="group" aria-label={`Rubric: ${rubric.title}`}>
      {(rubric.criteria || []).map((c, i) => (
        <div key={i} className="rubric-row">
          <div className="rubric-crit">{c.name}</div>
          <div className="rubric-levels">
            {(c.levels || []).map((l, j) => {
              const on = picked?.[i] === j;
              const inner = (
                <>
                  <b>{l.label}</b>
                  <span className="tiny">{Number(l.points)} mark{Number(l.points) === 1 ? '' : 's'}</span>
                  {l.text && <span className="tiny muted">{l.text}</span>}
                </>
              );
              return onPick ? (
                <button
                  key={j}
                  type="button"
                  className={'rubric-level' + (on ? ' on' : '')}
                  aria-pressed={on}
                  aria-label={`${c.name}: ${l.label}${n ? ` (question ${n})` : ''}`}
                  onClick={() => onPick(i, on ? null : j)}
                >
                  {inner}
                </button>
              ) : (
                <span key={j} className={'rubric-level' + (on ? ' on' : '')}>
                  {inner}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

// Make or change a rubric
export function RubricEditor({ rubric, onClose, onSaved }) {
  const toast = useToast();
  const [r, setR] = useState(() => (rubric ? JSON.parse(JSON.stringify(rubric)) : blankRubric()));
  const [busy, setBusy] = useState(false);
  const setCrit = (i, patch) => setR({ ...r, criteria: r.criteria.map((c, k) => (k === i ? { ...c, ...patch } : c)) });
  const setLevel = (i, j, patch) => setCrit(i, { levels: r.criteria[i].levels.map((l, k) => (k === j ? { ...l, ...patch } : l)) });
  async function save() {
    setBusy(true);
    try {
      const row = {
        ...(r.id ? { id: r.id } : {}),
        title: r.title.trim() || 'Rubric',
        criteria: r.criteria.map((c) => ({ name: c.name.trim(), levels: c.levels.map((l) => ({ label: l.label.trim() || '—', points: Number(l.points) || 0, ...(l.text?.trim() ? { text: l.text.trim() } : {}) })) })),
      };
      const saved = await api.save('rubrics', row);
      invalidate('rubrics');
      toast(`Saved ${saved.title}`);
      onSaved?.(saved);
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save the rubric', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={r.id ? `Edit ${r.title || 'rubric'}` : 'New rubric'}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save rubric'}
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Name">
          <input className="input" value={r.title} onChange={(e) => setR({ ...r, title: e.target.value })} placeholder="e.g. Essay, Practical write-up" />
        </Field>
        {r.criteria.map((c, i) => (
          <div key={i} className="card tint stack sm">
            <div className="row" style={{ gap: 8 }}>
              <input className="input grow" value={c.name} onChange={(e) => setCrit(i, { name: e.target.value })} aria-label={`Criterion ${i + 1}`} placeholder="What you’re looking for" />
              <button className="btn sm ghost icon" disabled={r.criteria.length < 2} onClick={() => setR({ ...r, criteria: r.criteria.filter((_, k) => k !== i) })} aria-label={`Remove criterion ${i + 1}`}>
                <Icon name="trash" size={15} />
              </button>
            </div>
            {c.levels.map((l, j) => (
              <div key={j} className="row wrap" style={{ gap: 6 }}>
                <input className="input" style={{ maxWidth: 160 }} value={l.label} onChange={(e) => setLevel(i, j, { label: e.target.value })} aria-label={`Criterion ${i + 1}, level ${j + 1}`} />
                <input className="input sm num" type="number" min="0" max="100" step="0.5" value={l.points} onChange={(e) => setLevel(i, j, { points: e.target.value })} aria-label={`Marks for criterion ${i + 1}, level ${j + 1}`} />
                <input className="input grow" value={l.text || ''} onChange={(e) => setLevel(i, j, { text: e.target.value })} placeholder="What it looks like (optional)" aria-label={`Description for criterion ${i + 1}, level ${j + 1}`} />
                <button className="btn sm ghost icon" disabled={c.levels.length < 3} onClick={() => setCrit(i, { levels: c.levels.filter((_, k) => k !== j) })} aria-label={`Remove level ${j + 1} of criterion ${i + 1}`}>
                  <Icon name="x" size={14} />
                </button>
              </div>
            ))}
            {c.levels.length < 6 && (
              <button className="linkbtn small" onClick={() => setCrit(i, { levels: [...c.levels, { label: '', points: (Number(c.levels.at(-1)?.points) || 0) + 1 }] })}>
                + Add a level
              </button>
            )}
          </div>
        ))}
        {r.criteria.length < 12 && (
          <button className="btn" onClick={() => setR({ ...r, criteria: [...r.criteria, { name: '', levels: [{ label: 'Not yet', points: 0 }, { label: 'Yes', points: 1 }] }] })}>
            <Icon name="plus" size={16} /> Add a criterion
          </button>
        )}
        <div className="small muted">Worth {rubricMax({ criteria: r.criteria.map((c) => ({ levels: c.levels.map((l) => ({ points: Number(l.points) || 0 })) })) })} marks in all (the best level of each).</div>
      </div>
    </Modal>
  );
}

// In the question editor: mark this question with a rubric (its marks become the rubric's)
export function RubricPicker({ q, onChange }) {
  const rubrics = useQuery('rubrics', api.listRubrics).data || [];
  const [editing, setEditing] = useState(null); // {} new, or the rubric
  const r = rubrics.find((x) => x.id === q.rubric_id);
  const use = (x) => onChange({ rubric_id: x?.id || null, ...(x ? { marks: rubricMax(x) } : {}) });
  return (
    <div className="stack sm">
      <div className="row wrap" style={{ gap: 8, alignItems: 'flex-end' }}>
        <Field label="Mark with a rubric">
          <select
            className="select"
            value={q.rubric_id || ''}
            onChange={(e) => (e.target.value === 'new' ? setEditing({}) : use(rubrics.find((x) => x.id === e.target.value)))}
          >
            <option value="">No rubric</option>
            {rubrics.map((x) => (
              <option key={x.id} value={x.id}>
                {x.title} ({rubricMax(x)} marks)
              </option>
            ))}
            <option value="new">New rubric…</option>
          </select>
        </Field>
        {r && (
          <button className="btn sm" onClick={() => setEditing(r)}>
            Edit rubric
          </button>
        )}
      </div>
      {r && <RubricGrid rubric={r} />}
      {editing && <RubricEditor rubric={editing.id ? editing : null} onClose={() => setEditing(null)} onSaved={use} />}
    </div>
  );
}
