// Access arrangements on a learner's page: extra time on timed work and extra days on deadlines, for everything your
// school (or you) set. The learner and their parents see them; classmates never do; the note is for teachers only.
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Field, Modal, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { fromLocalInput, toLocalInput } from '../../lib/format.js';

export const accessText = (r) =>
  [r?.extra_time_pct ? `${r.extra_time_pct}% extra time` : '', r?.extra_days ? `${r.extra_days} extra day${r.extra_days === 1 ? '' : 's'} on deadlines` : ''].filter(Boolean).join(' · ');

export function AccessLine({ id, first }) {
  const q = useQuery(`access:${id}`, () => api.accessFor(id));
  const [open, setOpen] = useState(false);
  const r = q.data;
  if (!r) return null;
  const text = accessText(r);
  return (
    <span className="row wrap small" style={{ gap: 8, marginTop: 8 }}>
      <Icon name="clock" size={15} />
      <span>{text ? `Access arrangements: ${text}` : 'No access arrangements'}</span>
      <button className="linkbtn small" onClick={() => setOpen(true)} aria-label={text ? `Change ${first}’s access arrangements` : `Give ${first} access arrangements`}>
        {text ? 'Change' : 'Add'}
      </button>
      {open && <AccessModal id={id} first={first} r={r} onClose={() => setOpen(false)} />}
    </span>
  );
}

function AccessModal({ id, first, r, onClose }) {
  const toast = useToast();
  const [time, setTime] = useState(String(r.extra_time_pct || 0));
  const [days, setDays] = useState(String(r.extra_days || 0));
  const [note, setNote] = useState(r.note || '');
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api.setAccess(id, Math.round(Number(time) || 0), Math.round(Number(days) || 0), note);
      invalidate(`access:${id}`);
      toast(Number(time) || Number(days) ? `${first}’s access arrangements are saved` : `${first} has no access arrangements now`);
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${first}’s access arrangements`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          They apply by themselves to all the work set where you teach (your school, centre or your own tutoring): timed tests and exams get the extra time when {first} starts them, and due dates move for {first} only. {first} and their parents can see them; classmates can’t.
        </div>
        <div className="grid g2" style={{ gap: 12 }}>
          <Field label="Extra time on timed work">
            <select className="select" value={time} onChange={(e) => setTime(e.target.value)}>
              {['0', '10', '15', '25', '33', '50', '100'].map((v) => (
                <option key={v} value={v}>
                  {v === '0' ? 'None' : `${v}%`}
                </option>
              ))}
              {!['0', '10', '15', '25', '33', '50', '100'].includes(time) && <option value={time}>{time}%</option>}
            </select>
          </Field>
          <Field label="Extra days on deadlines">
            <input className="input" type="number" min="0" max="30" step="1" value={days} onChange={(e) => setDays(e.target.value)} />
          </Field>
        </div>
        <Field label="Note for teachers (optional)" hint="Only teachers see this. For example, what the arrangement is for.">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
        </Field>
      </div>
    </Modal>
  );
}

// More time on one piece of work for one learner (a later due date, extra minutes on timed work); they're told
export function ExtendWork({ a, l, onClose }) {
  const toast = useToast();
  const base = a.due_at ? new Date(new Date(a.due_at).getTime() + 2 * 86400000) : new Date(Date.now() + 2 * 86400000);
  const [due, setDue] = useState(() => toLocalInput(base.toISOString()));
  const [mins, setMins] = useState('0');
  const [busy, setBusy] = useState(false);
  const first = l.display_name.split(' ')[0];
  async function save() {
    setBusy(true);
    try {
      await api.extendWork(a.id, l.id, due ? fromLocalInput(due) : null, Math.round(Number(mins) || 0));
      invalidate('assignments', 'attempts');
      toast(`${first} has more time on ${a.title}`);
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`More time for ${first}`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            Give more time
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small muted">
          Only for {first}, on {a.title}. Everyone else keeps the class’s due date. {first} is told.
        </div>
        <Field label={`New due date for ${first}`}>
          <input className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} />
        </Field>
        {a.time_limit_min && (
          <Field label="Extra minutes on the time limit" hint={`It has ${a.time_limit_min} minutes.`}>
            <input className="input" type="number" min="0" max="600" step="5" value={mins} onChange={(e) => setMins(e.target.value)} />
          </Field>
        )}
      </div>
    </Modal>
  );
}
