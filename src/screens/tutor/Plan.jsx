// Teaching plan (1.6): which syllabus topics to teach when, week by week, month by month or chapter by
// chapter. StudyBridge can spread the topics evenly by itself (bigger topics get more time; revision before
// the exam), or Prof can plan it; the tutor checks it, then edits any part. One plan per subject.
import { useEffect, useMemo, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Field, Seg, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { spreadEvenly, today, addDays, fmt } from '../../lib/plan.js';

const KINDS = [
  { value: 'week', label: 'Week by week' },
  { value: 'month', label: 'Month by month' },
  { value: 'chapter', label: 'Chapter by chapter' },
];

export default function TeachingPlan({ subject, topics }) {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery(`plan:${subject.id}`, () => api.getPlan(subject.id));
  const jobs = useQuery('prof-jobs', api.profJobs).data || [];
  const [making, setMaking] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('sb.planSeen') || '[]');
    } catch {
      return [];
    }
  });
  const mine = jobs.filter((j) => j.kind === 'plan' && j.context?.subject_id === subject.id);
  const running = mine.find((j) => ['queued', 'running', 'waiting'].includes(j.status));
  const proposal = mine.find((j) => j.status === 'done' && j.result?.plan && !dismissed.includes(j.id));
  const failed = mine.find((j) => j.status === 'failed' && !dismissed.includes(j.id));
  const dismiss = (id) => {
    const next = [...dismissed, id].slice(-100);
    setDismissed(next);
    try {
      localStorage.setItem('sb.planSeen', JSON.stringify(next));
    } catch {
      /* fine */
    }
  };
  const plan = q.data;
  async function use(p, source) {
    try {
      await api.savePlan({ subject_id: subject.id, kind: p.kind, starts_on: p.starts_on, ends_on: p.ends_on, lessons_per_week: p.lessons_per_week || null, items: p.items, note: p.note || null, source });
      invalidate(`plan:${subject.id}`);
      setMaking(false);
      toast('Teaching plan saved');
      return true;
    } catch (e) {
      toast({ title: 'Couldn’t save the plan', body: e.message, tone: 'bad' });
      return false;
    }
  }
  return (
    <div className="card">
      <div className="row between wrap">
        <h2 style={{ margin: 0 }}>Teaching plan</h2>
        {plan && !making && (
          <div className="row wrap">
            <button className="btn sm" onClick={() => setMaking(true)}>
              <Icon name="refresh" size={14} /> Make a new plan
            </button>
            <button
              className="btn sm ghost"
              onClick={async () => {
                if (!(await confirm({ title: 'Delete this plan?', body: 'Your topics and coverage stay as they are.', ok: 'Delete', danger: true }))) return;
                try {
                  await api.deletePlan(subject.id);
                  invalidate(`plan:${subject.id}`);
                } catch (e) {
                  toast({ title: 'Couldn’t delete it', body: e.message, tone: 'bad' });
                }
              }}
            >
              <Icon name="trash" size={14} /> Delete
            </button>
          </div>
        )}
      </div>
      {running && (
        <div className="note small row">
          <span className="spinner sm" /> Prof is planning {subject.name}… You’ll get a notification.
        </div>
      )}
      {failed && (
        <div className="card warn small row between">
          <span>Prof couldn’t plan it: {failed.error}</span>
          <button className="btn sm" onClick={() => dismiss(failed.id)}>
            OK
          </button>
        </div>
      )}
      {proposal && (
        <div className="stack claude-card plan-proposal">
          <h3 className="row" style={{ margin: 0 }}>
            <Icon name="cap" style={{ color: 'var(--claude)' }} /> Prof’s plan: {proposal.result.plan.items.length} parts
          </h3>
          {proposal.result.plan.note && <div className="small muted">{proposal.result.plan.note}</div>}
          <PlanTimeline items={proposal.result.plan.items} />
          <div className="row wrap">
            <button className="btn primary" onClick={async () => (await use(proposal.result.plan, 'prof')) && dismiss(proposal.id)}>
              {plan ? 'Use this plan instead' : 'Use this plan'}
            </button>
            <button className="btn" onClick={() => dismiss(proposal.id)}>
              Don’t use
            </button>
          </div>
        </div>
      )}
      {!plan || making ? (
        <MakePlan subject={subject} topics={topics} onUse={(p) => use(p, 'tutor')} onCancel={plan ? () => setMaking(false) : null} />
      ) : (
        <SavedPlan plan={plan} topics={topics} onSave={(items) => use({ ...plan, items }, plan.source)} />
      )}
    </div>
  );
}

function MakePlan({ subject, topics, onUse, onCancel }) {
  const toast = useToast();
  const usage = useQuery('prof-usage', api.profUsage).data;
  const [kind, setKind] = useState('week');
  const [start, setStart] = useState(today());
  const [end, setEnd] = useState(() => addDays(today(), 182));
  const [lessons, setLessons] = useState('');
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState(null);
  const ok = start && end && end > start;
  return (
    <div className="stack">
      <div className="small muted">
        Plan when to teach each of the {topics.length} topics in {subject.name}. Bigger topics (more subtopics) get more time, and if the end date is an exam, the last part is kept for revision. You can change any part afterwards.
      </div>
      <Seg value={kind} onChange={setKind} options={KINDS} label="How to plan it" />
      <div className="grid g3" style={{ gap: 10 }}>
        <Field label="Starts">
          <input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} />
        </Field>
        <Field label="Ends (e.g. the exam)">
          <input className="input" type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
        </Field>
        <Field label="Lessons a week (optional)">
          <input className="input" type="number" min="1" max="14" value={lessons} onChange={(e) => setLessons(e.target.value)} />
        </Field>
      </div>
      <Field label="Anything for Prof to know (optional)">
        <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Half term 26 Oct – 1 Nov; start with algebra; a mock in March" />
      </Field>
      <div className="row wrap">
        <button className="btn" disabled={!ok} onClick={() => setPreview(spreadEvenly(topics, kind, start, end))}>
          <Icon name="layers" size={16} /> Spread the topics evenly
        </button>
        <button
          className="btn claude"
          disabled={!ok || (usage && !usage.ready)}
          onClick={async () => {
            try {
              await api.profPlan(subject.id, kind, start, end, lessons ? Number(lessons) : null, note);
              invalidate('prof-jobs');
              toast({ title: 'Prof is planning it', body: 'You’ll check the plan before it’s used.' });
            } catch (e) {
              toast({ title: 'Couldn’t ask Prof', body: e.message, tone: 'bad' });
            }
          }}
        >
          <Icon name="cap" size={16} /> Ask Prof to plan it
        </button>
        {onCancel && (
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      {usage && !usage.ready && <div className="tiny muted">{usage.why_not}</div>}
      {preview && (
        <div className="stack plan-proposal">
          <div className="strong">Spread evenly: {preview.length} parts</div>
          <PlanTimeline items={preview} />
          <div className="row">
            <button className="btn primary" onClick={() => onUse({ kind, starts_on: start, ends_on: end, lessons_per_week: lessons ? Number(lessons) : null, items: preview })}>
              Use this plan
            </button>
            <button className="btn" onClick={() => setPreview(null)}>
              Not this one
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PlanTimeline({ items, onEdit, editing, topics, onSaveItem, onCancelItem, onDelete }) {
  const now = today();
  return (
    <ol className="plan-list">
      {items.map((x, i) => {
        const current = x.starts_on <= now && now <= x.ends_on;
        if (editing === i) return <ItemEdit key={i} item={x} topics={topics} onSave={(v) => onSaveItem(i, v)} onCancel={onCancelItem} onDelete={() => onDelete(i)} />;
        return (
          <li key={i} className={'plan-item' + (current ? ' now' : '') + (x.ends_on < now ? ' past' : '')}>
            <div className="plan-when">
              <div className="strong">{x.label}</div>
              <div className="tiny muted">
                {fmt(x.starts_on)} – {fmt(x.ends_on)}
              </div>
              {current && <span className="pill accent">Now</span>}
            </div>
            <div className="grow stack sm">
              <div className="row wrap" style={{ gap: 6 }}>
                {x.topics.length ? x.topics.map((t) => <span key={t} className="pill">{t}</span>) : <span className="muted small">No new topics</span>}
              </div>
              {x.focus && <div className="small">{x.focus}</div>}
              {x.notes && <div className="small muted">{x.notes}</div>}
            </div>
            {onEdit && (
              <button className="btn ghost icon sm" aria-label={`Edit ${x.label}`} onClick={() => onEdit(i)}>
                <Icon name="pen" size={14} />
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}

function SavedPlan({ plan, topics, onSave }) {
  const [editing, setEditing] = useState(null);
  const items = plan.items || [];
  const planned = useMemo(() => new Set(items.flatMap((x) => x.topics)), [items]);
  const missing = topics.filter((t) => !planned.has(t.name));
  // the part we're in now, scrolled into view once
  useEffect(() => {
    document.querySelector('.plan-item.now')?.scrollIntoView({ block: 'nearest' });
  }, [plan.id]);
  return (
    <div className="stack">
      <div className="small muted">
        {KINDS.find((k) => k.value === plan.kind)?.label} · {fmt(plan.starts_on, { year: 'numeric' })} – {fmt(plan.ends_on, { year: 'numeric' })}
        {plan.lessons_per_week ? ` · ${plan.lessons_per_week} lesson${plan.lessons_per_week === 1 ? '' : 's'} a week` : ''}
        {plan.source === 'prof' ? ' · planned by Prof' : ''}
      </div>
      {plan.note && <div className="small muted">{plan.note}</div>}
      {missing.length > 0 && <div className="note small">Not in the plan yet: {missing.map((t) => t.name).join(', ')}. Edit a part to add them.</div>}
      <PlanTimeline
        items={items}
        topics={topics}
        editing={editing}
        onEdit={setEditing}
        onCancelItem={() => setEditing(null)}
        onSaveItem={async (i, v) => {
          if (await onSave(items.map((x, j) => (j === i ? v : x)))) setEditing(null);
        }}
        onDelete={async (i) => {
          if (await onSave(items.filter((_, j) => j !== i))) setEditing(null);
        }}
      />
      <div>
        <button
          className="btn sm ghost"
          onClick={async () => {
            const last = items[items.length - 1];
            const s = last ? addDays(last.ends_on, 1) : today();
            if (await onSave([...items, { label: 'New part', starts_on: s, ends_on: addDays(s, 6), topics: [], focus: '', notes: '' }])) setEditing(items.length);
          }}
        >
          <Icon name="plus" size={14} /> Add a part
        </button>
      </div>
    </div>
  );
}

function ItemEdit({ item, topics, onSave, onCancel, onDelete }) {
  const [v, setV] = useState(item);
  const set = (p) => setV({ ...v, ...p });
  return (
    <li className="plan-item editing">
      <div className="stack sm grow">
        <div className="grid g3" style={{ gap: 8 }}>
          <Field label="Name">
            <input className="input" value={v.label} onChange={(e) => set({ label: e.target.value })} />
          </Field>
          <Field label="From">
            <input className="input" type="date" value={v.starts_on} onChange={(e) => set({ starts_on: e.target.value })} />
          </Field>
          <Field label="To">
            <input className="input" type="date" value={v.ends_on} onChange={(e) => set({ ends_on: e.target.value })} />
          </Field>
        </div>
        <div className="small strong">Topics</div>
        <div className="row wrap" style={{ gap: 6 }}>
          {topics.map((t) => {
            const on = v.topics.includes(t.name);
            return (
              <button key={t.id} type="button" className="chip" aria-pressed={on} onClick={() => set({ topics: on ? v.topics.filter((x) => x !== t.name) : [...v.topics, t.name] })}>
                {t.code ? `${t.code} ` : ''}
                {t.name}
              </button>
            );
          })}
        </div>
        <Field label="Focus">
          <input className="input" value={v.focus || ''} onChange={(e) => set({ focus: e.target.value })} placeholder="What to teach, e.g. factorising quadratics" />
        </Field>
        <Field label="Notes">
          <input className="input" value={v.notes || ''} onChange={(e) => set({ notes: e.target.value })} placeholder="e.g. quiz on Friday; past paper practice" />
        </Field>
        <div className="row">
          <button className="btn sm primary" disabled={!v.label.trim() || !v.starts_on || !v.ends_on || v.ends_on < v.starts_on} onClick={() => onSave({ ...v, label: v.label.trim() })}>
            Save
          </button>
          <button className="btn sm" onClick={onCancel}>
            Cancel
          </button>
          <span className="grow" />
          <button className="btn sm danger" onClick={onDelete}>
            <Icon name="trash" size={14} /> Remove this part
          </button>
        </div>
      </div>
    </li>
  );
}
