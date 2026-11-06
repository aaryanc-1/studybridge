// School office basics (5 Nov 2026), the parts more than one app uses: a learner's record at a place (the office and
// parents change it, teachers see what they need to know, the learner reads theirs), telling a place a child will be
// away (parents; the office notes a call), a parent's list of what they told and what came back, and a homeroom
// teacher's daily registers.
import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Field, Link, Loading, Modal, Seg, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { day, ymd } from '../../lib/format.js';
import { ABSENCE_STATUS, PARTS, REASONS, RECORD_GROUPS, YEARS, absenceWhen, statusTone, yearName } from '../../lib/office.js';
import { useInSchool } from './School.jsx';

const first = (name) => String(name || '').split(' ')[0];
const filled = (v) => v !== null && v !== undefined && v !== '';
const fieldText = (f, v) => (f.type === 'yesno' ? (v ? f.yes : f.no) : f.type === 'date' ? day(v + 'T12:00') : v);

// ---------- a learner's record ----------
// Read-only: every part that's filled in (teachers get only what they need to know; the office note only the office)
export function RecordView({ rec, compact = false }) {
  const r = rec.record || {};
  const groups = RECORD_GROUPS.map((g) => ({ ...g, fields: g.fields.filter((f) => f.key in r && filled(r[f.key])) })).filter((g) => g.fields.length);
  const contacts = r.contacts || [];
  if (!groups.length && !contacts.length && !filled(r.office_note))
    return <div className="small muted">{rec.view === 'teacher' ? 'Nothing noted yet.' : 'Nothing here yet.'}</div>;
  return (
    <div className="stack sm record-view">
      {groups.map((g) => (
        <div key={g.title} className="stack xs">
          {!compact && <div className="tiny strong muted">{g.title}</div>}
          <dl className="rec-list">
            {g.fields.map((f) => (
              <div key={f.key} className={['allergies', 'medical', 'support'].includes(f.key) ? 'rec-flag' : ''}>
                <dt>{f.label}</dt>
                <dd>{fieldText(f, r[f.key])}</dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {contacts.length > 0 && (
        <div className="stack xs">
          {!compact && <div className="tiny strong muted">Contacts, in the order to call them</div>}
          <div className="list">
            {contacts.map((c, i) => (
              <div key={i} className="item">
                <span className="rec-n">{i + 1}</span>
                <span className="grow">
                  <span className="name">
                    {c.name}
                    {c.relation ? ` (${c.relation})` : ''}
                  </span>
                  <span className="meta">
                    {c.phone && <a href={`tel:${c.phone.replace(/\s/g, '')}`}>{c.phone}</a>}
                    {c.email && <a href={`mailto:${c.email}`}>{c.email}</a>}
                    {c.collect && <span>Can collect them</span>}
                  </span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {filled(r.office_note) && (
        <div className="note">
          <div className="tiny strong">
            <Icon name="lock" size={12} /> Office note (staff who look after them only)
          </div>
          {r.office_note}
        </div>
      )}
    </div>
  );
}

// Change a record. The office (and managers, heads of year, a tutor on their own) any part; a parent everything but the
// student number and the office note, and they can send the same to their child's other schools and tutors.
export function RecordEditor({ rec, places = [], onClose, onSaved }) {
  const toast = useToast();
  const office = rec.view === 'office';
  const [f, setF] = useState(() => ({ ...rec.record, contacts: (rec.record?.contacts || []).map((c) => ({ ...c })) }));
  const others = places.filter((p) => p.place_id !== rec.place_id);
  const [also, setAlso] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const name = first(rec.learner?.name);
  const set = (k, v) => setF((x) => ({ ...x, [k]: v }));
  const setContact = (i, patch) => set('contacts', f.contacts.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  const move = (i, by) => {
    const list = [...f.contacts];
    const [c] = list.splice(i, 1);
    list.splice(i + by, 0, c);
    set('contacts', list);
  };
  async function save() {
    setBusy(true);
    setErr('');
    try {
      const fields = {};
      for (const g of RECORD_GROUPS) for (const x of g.fields) if (!x.office || office) fields[x.key] = filled(f[x.key]) ? f[x.key] : null;
      fields.contacts = f.contacts.filter((c) => [c.name, c.phone, c.email].some((v) => String(v || '').trim()));
      if (office) fields.office_note = filled(f.office_note) ? f.office_note : null;
      const out = await api.saveStudentRecord(rec.learner.id, rec.place_id, fields, office ? null : also);
      invalidate('record', 'child-records', 'student-records', 'register:', 'office-day');
      toast(office ? `${name}’s details are saved` : also.length ? `Sent to ${rec.place} and ${also.length === 1 ? others.find((p) => p.place_id === also[0])?.place : `${also.length} more`}` : `Sent to ${rec.place}`);
      onSaved?.(out);
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      wide
      title={`${name}’s details at ${rec.place}`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : office ? 'Save' : 'Send'}
          </button>
        </>
      }
    >
      <div className="stack">
        {!office && <div className="small muted">{rec.place} sees these details. Change anything that isn’t right, and they’re told.</div>}
        {RECORD_GROUPS.map((g) => (
          <fieldset key={g.title} className="rec-group">
            <legend>{g.title}</legend>
            <div className="grid2">
              {g.fields
                .filter((x) => !x.office || office)
                .map((x) =>
                  x.type === 'yesno' ? (
                    <Field key={x.key} label={x.label}>
                      <Seg
                        label={x.label}
                        value={f[x.key] === true ? 'yes' : f[x.key] === false ? 'no' : ''}
                        onChange={(v) => set(x.key, v === 'yes')}
                        options={[
                          { value: 'yes', label: 'Yes' },
                          { value: 'no', label: 'No' },
                        ]}
                      />
                      <div className="hint">{f[x.key] === true ? x.yes : f[x.key] === false ? x.no : 'Not asked yet'}</div>
                    </Field>
                  ) : (
                    <Field key={x.key} label={x.label} hint={x.hint}>
                      {x.area ? (
                        <textarea className="input" rows={3} maxLength={x.max} value={f[x.key] || ''} onChange={(e) => set(x.key, e.target.value)} />
                      ) : (
                        <input
                          className="input"
                          type={x.type === 'date' ? 'date' : 'text'}
                          maxLength={x.max}
                          max={x.type === 'date' ? ymd(new Date()) : undefined}
                          value={f[x.key] || ''}
                          onChange={(e) => set(x.key, e.target.value)}
                        />
                      )}
                    </Field>
                  ),
                )}
            </div>
          </fieldset>
        ))}
        <fieldset className="rec-group">
          <legend>Contacts, in the order to call them</legend>
          {f.contacts.length === 0 && <div className="small muted">Nobody yet. Add who to call if {name} is ill or hurt.</div>}
          {f.contacts.map((c, i) => (
            <div key={i} className="rec-contact" role="group" aria-label={`Contact ${i + 1}`}>
              <div className="grid2">
                <Field label="Name">
                  <input className="input" maxLength={80} value={c.name || ''} onChange={(e) => setContact(i, { name: e.target.value })} />
                </Field>
                <Field label="Who they are" hint="Mother, grandfather, neighbour…">
                  <input className="input" maxLength={40} value={c.relation || ''} onChange={(e) => setContact(i, { relation: e.target.value })} />
                </Field>
                <Field label="Phone">
                  <input className="input" type="tel" maxLength={40} value={c.phone || ''} onChange={(e) => setContact(i, { phone: e.target.value })} />
                </Field>
                <Field label="Email">
                  <input className="input" type="email" maxLength={120} value={c.email || ''} onChange={(e) => setContact(i, { email: e.target.value })} />
                </Field>
              </div>
              <div className="row between wrap" style={{ gap: 8 }}>
                <label className="row small" style={{ gap: 6 }}>
                  <input type="checkbox" checked={!!c.collect} onChange={(e) => setContact(i, { collect: e.target.checked })} /> Can collect {name}
                </label>
                <span className="row" style={{ gap: 4 }}>
                  <button type="button" className="btn sm ghost" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Call ${c.name || 'this contact'} earlier`}>
                    <Icon name="up" size={14} />
                  </button>
                  <button type="button" className="btn sm ghost" disabled={i === f.contacts.length - 1} onClick={() => move(i, 1)} aria-label={`Call ${c.name || 'this contact'} later`}>
                    <Icon name="down" size={14} />
                  </button>
                  <button type="button" className="btn sm ghost" onClick={() => set('contacts', f.contacts.filter((_, j) => j !== i))} aria-label={`Take ${c.name || 'this contact'} off`}>
                    <Icon name="trash" size={14} />
                  </button>
                </span>
              </div>
            </div>
          ))}
          {f.contacts.length < 6 && (
            <div>
              <button type="button" className="btn sm" onClick={() => set('contacts', [...f.contacts, { name: '', relation: '', phone: '', email: '', collect: false }])}>
                <Icon name="plus" size={14} /> Add a contact
              </button>
            </div>
          )}
        </fieldset>
        {office && (
          <Field label="Office note" hint="Only the office, managers and the head of their year see this. Never the family or their teachers.">
            <textarea className="input" rows={3} maxLength={2000} value={f.office_note || ''} onChange={(e) => set('office_note', e.target.value)} />
          </Field>
        )}
        {!office && others.length > 0 && (
          <div className="stack xs">
            <div className="small strong">Send the same to {name}’s other schools and tutors?</div>
            {others.map((p) => (
              <label key={p.place_id} className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={also.includes(p.place_id)} onChange={(e) => setAlso((a) => (e.target.checked ? [...a, p.place_id] : a.filter((x) => x !== p.place_id)))} />
                {p.place}
              </label>
            ))}
          </div>
        )}
        {err && <div className="error">{err}</div>}
      </div>
    </Modal>
  );
}

// "Need to know" on a teacher's page for a learner: what the office has noted (allergies, health, learning support,
// photos, going home, contacts). The office, a head of year or a tutor on their own can change it from here.
export function NeedToKnow({ learnerId, name }) {
  const app = useApp();
  const q = useQuery(`record:${learnerId}`, () => api.studentRecord(learnerId));
  const [editing, setEditing] = useState(false);
  const rec = q.data;
  if (!rec) return q.error ? null : <div className="card"><Loading /></div>;
  const school = rec.place_id !== app.me.id;
  return (
    <section className="card">
      <div className="card-head">
        <h2>{rec.view === 'office' ? 'Details' : 'Need to know'}</h2>
        <span className="row" style={{ gap: 8 }}>
          {rec.view === 'office' && school && <Link to={`/student/${learnerId}`}>Student page</Link>}
          {rec.can_edit && (
            <button className="btn sm" onClick={() => setEditing(true)}>
              <Icon name="pen" size={14} /> Change
            </button>
          )}
        </span>
      </div>
      {rec.view === 'teacher' && <div className="small muted">What {school ? `${rec.place}’s office` : 'the office'} has noted about {first(name)}, for their teachers.</div>}
      <RecordView rec={rec} />
      {rec.record?.updated_at && rec.view === 'office' && (
        <div className="tiny muted">
          Last changed {day(rec.record.updated_at)}
          {rec.record.updated_by ? ` by ${rec.record.updated_by}` : ''}
        </div>
      )}
      {editing && <RecordEditor rec={rec} onClose={() => setEditing(false)} />}
    </section>
  );
}
// One line for the top of a learner's page: allergies, health, learning support
export function NeedToKnowLine({ learnerId }) {
  const rec = useQuery(`record:${learnerId}`, () => api.studentRecord(learnerId)).data;
  const r = rec?.record;
  if (!r) return null;
  const bits = [filled(r.allergies) && `Allergies: ${r.allergies}`, filled(r.medical) && 'Health: see Details', filled(r.support) && 'Learning support: see Details'].filter(Boolean);
  if (!bits.length) return null;
  return (
    <div className="need-line small">
      <Icon name="alert" size={14} /> {bits.join(' · ')}
    </div>
  );
}

// ---------- absences ----------
const today = () => ymd(new Date());
// A parent tells their child's schools and tutors (all of them, or the ones they tick); the office notes one from a call
export function ReportAbsence({ learnerId, name, places = [], staff = false, onClose }) {
  const toast = useToast();
  const [a, setA] = useState({ starts: today(), ends: '', part: 'day', reason: 'ill', note: '', at: '' });
  const [to, setTo] = useState(() => places.map((p) => p.place_id));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const set = (patch) => setA((x) => ({ ...x, ...patch }));
  const timed = a.part === 'late' || a.part === 'early';
  async function send() {
    setBusy(true);
    setErr('');
    try {
      const n = await api.reportAbsence(learnerId, {
        starts: a.starts,
        ends: a.part === 'day' && a.ends ? a.ends : null,
        part: a.part,
        reason: a.reason,
        note: a.note.trim() || null,
        at: timed ? a.at : null,
        places: staff ? null : to,
      });
      invalidate('child-absences', 'absences', 'office-day', 'register:');
      toast(staff ? `Noted: ${first(name)} is away` : `Sent to ${n === 1 ? places.find((p) => p.place_id === to[0])?.place || 'them' : `${n} places`}. It shows on their registers.`);
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={staff ? `${first(name)} is away` : `${first(name)} will be away`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !a.starts || (timed && !a.at) || (!staff && !to.length)} onClick={send}>
            {busy ? 'Sending…' : staff ? 'Save' : 'Send'}
          </button>
        </>
      }
    >
      <div className="stack">
        {staff && <div className="small muted">For a phone call or a note from home. It’s accepted already, and shows on every register.</div>}
        <Field label="When">
          <Seg label="When" value={a.part} onChange={(part) => set({ part })} options={Object.entries(PARTS).map(([value, label]) => ({ value, label }))} />
        </Field>
        <div className="grid2">
          <Field label={a.part === 'day' ? 'From' : 'Day'}>
            <input className="input" type="date" min={staff ? undefined : ymd(Date.now() - 14 * 864e5)} value={a.starts} onChange={(e) => set({ starts: e.target.value })} />
          </Field>
          {a.part === 'day' ? (
            <Field label="To" hint="Leave it empty for one day">
              <input className="input" type="date" min={a.starts} value={a.ends} onChange={(e) => set({ ends: e.target.value })} />
            </Field>
          ) : timed ? (
            <Field label={a.part === 'late' ? 'In by' : 'Leaving at'}>
              <input className="input" type="time" value={a.at} onChange={(e) => set({ at: e.target.value })} />
            </Field>
          ) : null}
        </div>
        <Field label="Why">
          <select className="input" value={a.reason} onChange={(e) => set({ reason: e.target.value })}>
            {Object.entries(REASONS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </Field>
        <Field label={staff ? 'A note' : 'Anything they should know'} hint={staff ? 'Who called, or what the note said' : 'They see this'}>
          <textarea className="input" rows={2} maxLength={500} value={a.note} onChange={(e) => set({ note: e.target.value })} />
        </Field>
        {!staff && places.length > 1 && (
          <div className="stack xs">
            <div className="small strong">Tell</div>
            {places.map((p) => (
              <label key={p.place_id} className="row small" style={{ gap: 6 }}>
                <input type="checkbox" checked={to.includes(p.place_id)} onChange={(e) => setTo((t) => (e.target.checked ? [...t, p.place_id] : t.filter((x) => x !== p.place_id)))} />
                {p.place}
              </label>
            ))}
          </div>
        )}
        {err && <div className="error">{err}</div>}
      </div>
    </Modal>
  );
}

export function AbsenceItem({ r, who = false, whoTo = (id) => `/student/${id}`, place = false, children }) {
  return (
    <div className="item absence-item">
      <Icon name="calendar" size={18} style={{ color: 'var(--muted)' }} />
      <span className="grow">
        <span className="name">
          {who ? (
            <>
              <Link to={whoTo(r.learner_id)}>{r.learner}</Link> · {absenceWhen(r)}
            </>
          ) : (
            absenceWhen(r)
          )}
        </span>
        <span className="meta">
          <span>{REASONS[r.reason]}</span>
          {place && <span>{r.place}</span>}
          {r.by && <span>{r.by_parent ? `From ${r.by}` : `Noted by ${r.by}`}</span>}
        </span>
        {r.note && <span className="small">“{r.note}”</span>}
        {r.reply && (
          <span className="small muted">
            {r.decided_by || r.place}: {r.reply}
          </span>
        )}
      </span>
      <span className={'pill ' + statusTone(r.status)}>{ABSENCE_STATUS[r.status]}</span>
      {children}
    </div>
  );
}

// The office (or a head of year, or a tutor on their own) accepts an absence or doesn't; the family sees the reply
export function Decide({ r, status, onClose }) {
  const toast = useToast();
  const [reply, setReply] = useState(r.reply || '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const ok = status === 'accepted';
  async function save() {
    setBusy(true);
    try {
      await api.decideAbsence(r.id, status, reply.trim() || null);
      invalidate('absences', 'office-day', 'register:');
      toast(ok ? `Accepted. ${r.by_parent ? `${r.by} is told.` : ''}` : `Not accepted. ${r.by_parent ? `${r.by} is told.` : ''}`);
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={ok ? `Accept ${first(r.learner)}’s absence?` : `Don’t accept ${first(r.learner)}’s absence?`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className={'btn ' + (ok ? 'primary' : 'danger solid')} disabled={busy || (!ok && !reply.trim())} onClick={save}>
            {busy ? 'Saving…' : ok ? 'Accept' : 'Don’t accept'}
          </button>
        </>
      }
    >
      <div className="stack">
        <div className="small">
          {absenceWhen(r)} · {REASONS[r.reason]}
          {r.note ? ` · “${r.note}”` : ''}
        </div>
        <div className="small muted">
          {ok ? 'Registers suggest “excused” for those times.' : 'Registers suggest “absent” for those times.'} {r.by_parent ? `${r.by} sees your reply.` : ''}
        </div>
        <Field label={ok ? 'A reply (if you like)' : 'Tell them why'}>
          <textarea className="input" rows={3} maxLength={500} value={reply} onChange={(e) => setReply(e.target.value)} />
        </Field>
        {err && <div className="error">{err}</div>}
      </div>
    </Modal>
  );
}

// A teacher's card (Timetable → Attendance): absences families reported for the learners they teach. A tutor on their
// own accepts them here; in a centre or school the office does.
export function FamiliesToldUs() {
  const q = useQuery('absences:open', () => api.absenceList('open'));
  const [deciding, setDeciding] = useState(null);
  const list = q.data || [];
  if (!list.length) return null;
  return (
    <div className="card">
      <h2>Families told you about</h2>
      <div className="small muted">Absences parents reported for your learners, waiting or coming up. They show on your registers too.</div>
      <div className="list">
        {list.map((r) => (
          <AbsenceItem key={r.id} r={r} who whoTo={(id) => `/learners/${id}`}>
            {r.can_decide && r.status === 'waiting' && (
              <span className="row wrap" style={{ gap: 6 }}>
                <button className="btn sm primary" onClick={() => setDeciding({ r, status: 'accepted' })} aria-label={`Accept ${r.learner}’s absence`}>
                  Accept
                </button>
                <button className="btn sm" onClick={() => setDeciding({ r, status: 'not_accepted' })} aria-label={`Don’t accept ${r.learner}’s absence`}>
                  Don’t accept
                </button>
              </span>
            )}
          </AbsenceItem>
        ))}
      </div>
      {deciding && <Decide {...deciding} onClose={() => setDeciding(null)} />}
    </div>
  );
}

// A parent's card: tell their child's schools and tutors they'll be away, and see what each one said back
export function ChildAbsences({ id, name }) {
  const toast = useToast();
  const confirm = useConfirm();
  const recs = useQuery(`child-records:${id}`, () => api.childRecords(id)).data;
  const q = useQuery(`child-absences:${id}`, () => api.childAbsences(id));
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const places = (recs || []).map((r) => ({ place_id: r.place_id, place: r.place }));
  if (!recs || !places.length) return null;
  const list = q.data || [];
  async function withdraw(r) {
    if (!(await confirm({ title: 'Take this back?', body: `${r.place} sees that ${first(name)} won’t be away after all.`, ok: 'Take it back' }))) return;
    try {
      await api.withdrawAbsence(r.id);
      invalidate('child-absences');
      toast('Taken back');
    } catch (e) {
      toast({ title: 'Couldn’t take it back', body: e.message, tone: 'bad' });
    }
  }
  return (
    <section className="card">
      <div className="card-head">
        <h2>Away from school or a lesson?</h2>
        <button className="btn primary sm" onClick={() => setOpen(true)}>
          <Icon name="send" size={14} /> Tell them {first(name)} will be away
        </button>
      </div>
      <div className="small muted">They see it on their registers, so nobody tells you {first(name)} was missing.</div>
      {list.length > 0 && (
        <div className="list">
          {list.slice(0, all ? 50 : 4).map((r) => (
            <AbsenceItem key={r.id} r={r} place={places.length > 1}>
              {r.can_withdraw && (
                <button className="btn sm ghost" onClick={() => withdraw(r)} aria-label={`Take back ${absenceWhen(r)}`}>
                  Take back
                </button>
              )}
            </AbsenceItem>
          ))}
        </div>
      )}
      {list.length > 4 && (
        <button className="linkbtn small" onClick={() => setAll(!all)}>
          {all ? 'Fewer' : `All ${list.length}`}
        </button>
      )}
      {open && <ReportAbsence learnerId={id} name={name} places={places} onClose={() => setOpen(false)} />}
    </section>
  );
}

// A parent's card: what each of their child's schools and tutors keeps about them, to check and keep up to date
export function ChildRecords({ id, name }) {
  const q = useQuery(`child-records:${id}`, () => api.childRecords(id));
  const [editing, setEditing] = useState(null);
  const list = q.data || [];
  if (!list.length) return null;
  const places = list.map((r) => ({ place_id: r.place_id, place: r.place }));
  return (
    <section className="card">
      <h2>{first(name)}’s details</h2>
      <div className="small muted">Contacts, health, learning support and photos. Keep them up to date: it’s how they reach you if {first(name)} is ill or hurt.</div>
      {list.map((rec) => (
        <div key={rec.place_id} className="stack sm rec-place">
          <div className="row between wrap" style={{ gap: 8 }}>
            <span className="strong">{rec.place}</span>
            <button className="btn sm" onClick={() => setEditing(rec)}>
              <Icon name="pen" size={14} /> Check and update
            </button>
          </div>
          <RecordView rec={rec} compact />
        </div>
      ))}
      {editing && <RecordEditor rec={editing} places={places} onClose={() => setEditing(null)} />}
    </section>
  );
}

// A learner's own: what each school or tutor keeps about them (Settings)
export function MyRecords() {
  const q = useQuery('child-records:me', () => api.childRecords());
  const list = q.data || [];
  if (!q.data) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  if (!list.length) return <div className="small muted">None of your schools or tutors has noted anything about you yet.</div>;
  return (
    <div className="stack">
      <div className="small muted">What each of your schools and tutors keeps about you. To change something, ask your parent (they can change it in their app) or the office.</div>
      {list.map((rec) => (
        <div key={rec.place_id} className="stack sm rec-place">
          <span className="strong">{rec.place}</span>
          <RecordView rec={rec} compact />
        </div>
      ))}
    </div>
  );
}

// ---------- a homeroom teacher's daily registers ----------
const regState = (c, size) => (c?.marked >= size && size > 0 ? 'done' : c?.marked > 0 ? 'part' : 'none');
export function HomeroomRegisters() {
  const inSchool = useInSchool();
  const q = useQuery(inSchool ? 'homerooms:today' : null, () => api.myHomerooms());
  const h = q.data;
  if (!h || !h.open || !(h.homerooms || []).length) return null;
  const parts = [['am', 'Morning', h.am_at], ...(h.daily_registers === 2 ? [['pm', 'Afternoon', h.pm_at]] : [])];
  return (
    <section className="card">
      <div className="card-head">
        <h2>Homeroom registers</h2>
        <span className="small muted">{day(h.day + 'T12:00')}</span>
      </div>
      <div className="list">
        {h.homerooms.map((c) => (
          <div key={c.id} className="item" style={{ flexWrap: 'wrap' }}>
            <span className="grow">
              <span className="name">{c.name}</span>
              <span className="meta">
                {c.size} learner{c.size === 1 ? '' : 's'}
              </span>
            </span>
            {parts.map(([k, label, at]) => {
              const st = regState(c[k], c.size);
              const to = `/register/${k}/${c.id}/${h.day}`;
              return st === 'done' ? (
                <Link key={k} to={to} className="pill good" style={{ textDecoration: 'none' }}>
                  <Icon name="check" size={13} /> {label} register taken
                </Link>
              ) : (
                <button key={k} className={'btn sm' + (h.now >= at ? ' primary' : '')} onClick={() => go(to)}>
                  {st === 'part' ? `Finish the ${label.toLowerCase()} register` : `${label} register · ${at}`}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </section>
  );
}

// A head of year's years, as chips (Settings → Your organisation)
export function YearPicker({ value, onChange }) {
  return (
    <div className="row wrap" style={{ gap: 6 }} role="group" aria-label="Years they look after">
      {YEARS.map((g) => (
        <button key={g} type="button" className="chip" aria-pressed={value.includes(g)} onClick={() => onChange(value.includes(g) ? value.filter((x) => x !== g) : [...value, g].sort((a, b) => a - b))}>
          {yearName(g)}
        </button>
      ))}
    </div>
  );
}
