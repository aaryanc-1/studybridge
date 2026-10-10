import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Modal, Page, useConfirm, useToast } from '../../ui/kit.jsx';
import * as api from '../../lib/api.js';
import { palette } from '../../lib/format.js';
import { useLookups } from '../shared/lookups.jsx';
import * as X from '../../lib/exams.js';

export default function Structure() {
  const app = useApp();
  const lk = useLookups();
  const toast = useToast();
  const confirm = useConfirm();
  const [editProg, setEditProg] = useState(null);
  const [editSubj, setEditSubj] = useState(null);

  const groups = [...lk.programmes.map((p) => ({ p, subjects: lk.subjects.filter((s) => s.programme_id === p.id) }))];
  const loose = lk.subjects.filter((s) => !s.programme_id || !lk.programme(s.programme_id));

  async function delProg(p) {
    if (!(await confirm({ title: `Delete ${p.name}?`, body: 'Its subjects stay; they just won’t belong to a programme.', ok: 'Delete', danger: true }))) return;
    try {
      await api.remove('programmes', p.id);
      lk.reload();
    } catch (e) {
      toast({ title: 'Couldn’t delete', body: e.message, tone: 'bad' });
    }
  }
  async function delSubj(s) {
    if (
      !(await confirm({
        title: `Delete ${s.name}?`,
        body: 'This also deletes its topics, flashcards, teaching plan and coverage, your learners’ formula sheets for it, and who takes it. Assignments, lesson notes and files stay but lose the subject. This can’t be undone.',
        ok: 'Delete subject',
        danger: true,
      }))
    )
      return;
    try {
      await api.remove('subjects', s.id);
      lk.reload();
    } catch (e) {
      toast({ title: 'Couldn’t delete', body: e.message, tone: 'bad' });
    }
  }

  return (
    <Page
      title="Programmes & subjects"
      subtitle={
        app.me.is_studybridge
          ? 'StudyBridge’s own subjects. Add each one’s syllabus, lessons and questions here, then open it to students when it’s ready.'
          : 'Name them however you like. Learners only see the subjects you give them.'
      }
      actions={
        <>
          <button className="btn" onClick={() => setEditProg({ name: '' })}>
            <Icon name="plus" size={18} /> Programme
          </button>
          <button className="btn primary" onClick={() => setEditSubj({ name: '', color: palette[lk.subjects.length % palette.length], programme_id: lk.programmes[0]?.id || null })}>
            <Icon name="plus" size={18} /> Subject
          </button>
        </>
      }
    >
      {lk.programmes.length === 0 && lk.subjects.length === 0 && (
        <Empty
          title="Start with a programme"
          action={
            <button className="btn primary" onClick={() => setEditProg({ name: '' })}>
              <Icon name="plus" size={18} /> New programme
            </button>
          }
        >
          For example “IGCSE”, “IB Diploma” or “Year 9”. Then add subjects such as Mathematics or Physics, and topics inside each subject.
        </Empty>
      )}
      {groups.map(({ p, subjects }) => (
        <div className="card" key={p.id}>
          <div className="card-head">
            <div>
              <h2 style={{ fontFamily: 'var(--serif)', fontSize: 22 }}>{p.name}</h2>
              {p.description && <div className="muted small">{p.description}</div>}
            </div>
            <div className="row">
              <button className="btn sm" onClick={() => setEditSubj({ name: '', color: palette[lk.subjects.length % palette.length], programme_id: p.id })}>
                <Icon name="plus" size={16} /> Subject
              </button>
              <button className="btn sm ghost" onClick={() => setEditProg(p)} aria-label={`Edit ${p.name}`}>
                <Icon name="pen" size={16} />
              </button>
              <button className="btn sm ghost" onClick={() => delProg(p)} aria-label={`Delete ${p.name}`}>
                <Icon name="trash" size={16} />
              </button>
            </div>
          </div>
          {subjects.length === 0 ? <div className="muted small">No subjects yet.</div> : subjects.map((s) => <SubjectRow key={s.id} s={s} onEdit={() => setEditSubj(s)} onDelete={() => delSubj(s)} />)}
        </div>
      ))}
      {loose.length > 0 && (
        <div className="card">
          <h2>{lk.programmes.length ? 'Not in a programme' : 'Subjects'}</h2>
          {loose.map((s) => (
            <SubjectRow key={s.id} s={s} onEdit={() => setEditSubj(s)} onDelete={() => delSubj(s)} />
          ))}
        </div>
      )}
      {editProg && <ProgrammeForm initial={editProg} onClose={() => setEditProg(null)} />}
      {editSubj && <SubjectForm initial={editSubj} onClose={() => setEditSubj(null)} />}
    </Page>
  );
}

function SubjectRow({ s, onEdit, onDelete }) {
  const confirm = useConfirm();
  const app = useApp();
  const lk = useLookups();
  const toast = useToast();
  const [adding, setAdding] = useState('');
  const topics = lk.topicsOf(s.id);
  const learners = lk.learnersOfSubject(s.id).length;

  async function addTopic(e) {
    e.preventDefault();
    const name = adding.trim();
    if (!name) return;
    try {
      await api.save('topics', { subject_id: s.id, name, position: topics.length });
      setAdding('');
      lk.reload();
    } catch (x) {
      toast({ title: 'Couldn’t add topic', body: x.message, tone: 'bad' });
    }
  }
  return (
    <div className="stack sm" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 14 }}>
      <div className="row between">
        <div className="row wrap" style={{ minWidth: 0 }}>
          <span className="swatch" style={{ background: s.color || '#0E6B6B', width: 14, height: 14 }} />
          <span className="strong" style={{ fontSize: 16 }}>{s.name}</span>
          {s.exam && <span className="pill">{X.syllabusLabel(...s.exam.split(':'))}</span>}
          <span className="muted small">
            {learners} {app.me.is_studybridge ? 'student' : 'learner'}
            {learners === 1 ? '' : 's'}
          </span>
        </div>
        <div className="row">
          {app.me.is_studybridge && s.catalogue && (
            <label className="check small" title={topics.length ? '' : 'Add its syllabus first, so students get a plan'}>
              <input
                type="checkbox"
                checked={!!s.live}
                onChange={async (e) => {
                  try {
                    await api.setSubjectLive(s.id, e.target.checked);
                    lk.reload();
                    toast(e.target.checked ? `${s.name} is open to students` : `${s.name} is closed to new students`);
                  } catch (x) {
                    toast({ title: 'Couldn’t change that', body: x.message, tone: 'bad' });
                  }
                }}
              />
              Open to students
            </label>
          )}
          <button className="btn sm ghost" onClick={onEdit} aria-label={`Edit ${s.name}`}>
            <Icon name="pen" size={16} />
          </button>
          <button className="btn sm ghost" onClick={onDelete} aria-label={`Delete ${s.name}`}>
            <Icon name="trash" size={16} />
          </button>
        </div>
      </div>
      <div className="chips">
        {topics.map((t) => (
          <span key={t.id} className="pill" style={{ paddingRight: 4 }}>
            {t.name}
            <button
              className="btn ghost sm icon"
              style={{ minHeight: 20, width: 20, height: 20 }}
              aria-label={`Remove topic ${t.name}`}
              onClick={async () => {
                if (!(await confirm({ title: `Remove the topic ${t.name}?`, body: 'Questions and work tagged with it lose the topic.', ok: 'Remove', danger: true }))) return;
                await api.remove('topics', t.id).catch((e) => toast({ title: e.message, tone: 'bad' }));
                lk.reload();
              }}
            >
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <form onSubmit={addTopic} className="row" style={{ gap: 6 }}>
          <input className="input sm" style={{ width: 180 }} value={adding} onChange={(e) => setAdding(e.target.value)} placeholder="Add a topic…" aria-label={`Add a topic to ${s.name}`} />
          {adding.trim() && <button className="btn sm">Add</button>}
        </form>
      </div>
    </div>
  );
}

function ProgrammeForm({ initial, onClose }) {
  const lk = useLookups();
  const [name, setName] = useState(initial.name || '');
  const [description, setDescription] = useState(initial.description || '');
  const [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return setErr('Give it a name.');
    try {
      await api.save('programmes', { ...(initial.id ? { id: initial.id } : {}), name: name.trim(), description: description.trim() || null });
      lk.reload();
      onClose();
    } catch (x) {
      setErr(x.message);
    }
  }
  return (
    <Modal title={initial.id ? 'Edit programme' : 'New programme'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. IGCSE" />
        </Field>
        <Field label="Description (optional)">
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Cambridge IGCSE, exams in 2028" />
        </Field>
        {err && <div className="error">{err}</div>}
        <div className="foot row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

function SubjectForm({ initial, onClose }) {
  const lk = useLookups();
  const [name, setName] = useState(initial.name || '');
  const [color, setColor] = useState(initial.color || palette[0]);
  const [programme, setProgramme] = useState(initial.programme_id || '');
  const [exam, setExam] = useState(initial.exam || '');
  const [topics, setTopics] = useState('');
  const [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (!name.trim()) return setErr('Give it a name.');
    try {
      const s = await api.save('subjects', { ...(initial.id ? { id: initial.id } : {}), name: name.trim(), color, programme_id: programme || null, exam: exam || null });
      const list = topics.split(/\n|,/).map((t) => t.trim()).filter(Boolean);
      for (let i = 0; i < list.length; i++) await api.save('topics', { subject_id: s.id, name: list[i], position: i });
      lk.reload();
      onClose();
    } catch (x) {
      setErr(x.message);
    }
  }
  return (
    <Modal title={initial.id ? 'Edit subject' : 'New subject'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Name">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mathematics (Extended)" />
        </Field>
        <Field label="Programme">
          <select className="select" value={programme} onChange={(e) => setProgramme(e.target.value)}>
            <option value="">None</option>
            {lk.programmes.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Exam" hint="Optional. Past papers then shows this exam’s papers first for every learner taking this subject.">
          <ExamSelect value={exam} onChange={setExam} />
        </Field>
        <Field label="Colour">
          <div className="row wrap">
            {palette.map((c) => (
              <button key={c} type="button" onClick={() => setColor(c)} aria-label={`Colour ${c}`} aria-pressed={color === c} style={{ width: 30, height: 30, borderRadius: 15, background: c, border: color === c ? '3px solid var(--ink)' : '3px solid #fff', boxShadow: '0 0 0 1px var(--line)', cursor: 'pointer' }} />
            ))}
          </div>
        </Field>
        {!initial.id && (
          <Field label="Topics (optional)" hint="One per line, or separated by commas. You can add more later.">
            <textarea className="textarea" value={topics} onChange={(e) => setTopics(e.target.value)} placeholder={'Number\nAlgebra\nGeometry\nStatistics'} />
          </Field>
        )}
        {err && <div className="error">{err}</div>}
        <div className="foot row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

// Every exam StudyBridge knows: Cambridge IGCSE syllabuses and IB Diploma subjects
export function ExamSelect({ value, onChange, label = 'Exam', none = 'None' }) {
  return (
    <select className="select" value={value || ''} onChange={(e) => onChange(e.target.value)} aria-label={label}>
      <option value="">{none}</option>
      {Object.entries(X.BOARDS).map(([b, info]) => (
        <optgroup key={b} label={info.name}>
          {X.syllabuses(b).map((s) => (
            <option key={s.code} value={`${b}:${s.code}`}>
              {X.syllabusLabel(b, s.code)}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}
