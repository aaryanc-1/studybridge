// Admin → Schools and centres: every tuition centre and school. They pay one price for everyone in them (per learner
// a year, at least the minimum, website/site.config.json → schoolPlan), yearly by invoice after a free pilot term. The
// Owner sets each one up here: centre or school, paid up to, the learners paid for, free pilot days, and its email endings
// (students and teachers who sign up with one join it: students wait for a class, teachers for its manager).
import { useState } from 'react';
import { Empty, Field, Modal, Page, Seg, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import site from '../../../website/site.config.json';

const SP = site.schoolPlan;
const day = (s) => (s ? new Date(String(s).slice(0, 10) + 'T12:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const STATE = { trial: 'Free pilot', paid: 'Paid', card: 'Paid by card', unpaid: 'Not paid', free: 'Complimentary' };
const yearOf = (n) => SP.perLearnerYear * Math.max(Number(n) || 0, SP.minLearners);

export default function SchoolsPage() {
  const q = useQuery('admin-orgs', api.adminOrgs, { poll: 60000 });
  const [open, setOpen] = useState(null);
  const orgs = q.data || [];
  return (
    <Page
      title="Schools and centres"
      subtitle={`$${SP.perLearnerYear} per learner a year, everything included, for at least ${SP.minLearners} learners ($${SP.perLearnerYear * SP.minLearners} a year), paid yearly by invoice after a free pilot term.`}
    >
      {q.error && <div className="error">{q.error.message}</div>}
      {q.data && !orgs.length && <Empty>No tuition centres or schools yet. A tutor makes one in Settings → Your organisation.</Empty>}
      <div className="list card pad0">
        {orgs.map((o) => (
          <div key={o.id} className="item" style={{ flexWrap: 'wrap', padding: '12px 16px' }}>
            <span className="grow">
              <span className="name">
                {o.name} <span className="pill">{o.kind === 'school' ? 'School' : 'Centre'}</span>
              </span>
              <span className="meta">
                <span>
                  {o.manager?.name}
                  {o.manager?.email ? ` · ${o.manager.email}` : ''}
                </span>
                <span>
                  {o.teachers} teacher{o.teachers === 1 ? '' : 's'} · {o.learners} learner{o.learners === 1 ? '' : 's'}
                </span>
                <span className={'pill ' + (o.state === 'paid' || o.state === 'card' ? 'good' : o.state === 'unpaid' ? 'bad' : '')}>{STATE[o.state] || o.state}</span>
                {o.state === 'paid' && (
                  <span>
                    up to {day(o.paid_until)}
                    {o.paid_seats ? ` for ${o.paid_seats} learners` : ''}
                  </span>
                )}
                {o.state === 'trial' && o.trial_until && <span>until {day(o.trial_until)}</span>}
                {o.invoice_asked_at && <span className="pill accent">Asked for an invoice {day(o.invoice_asked_at)}</span>}
                {(o.email_domains || []).length > 0 && <span>@{o.email_domains.join(', @')}</span>}
                {o.waiting > 0 && <span>{o.waiting} waiting for a class</span>}
              </span>
            </span>
            <button className="btn sm" onClick={() => setOpen(o)} aria-label={`Set up ${o.name}`}>
              Set up
            </button>
          </div>
        ))}
      </div>
      {open && <SetUp o={open} onClose={() => setOpen(null)} />}
    </Page>
  );
}

function SetUp({ o, onClose }) {
  const toast = useToast();
  const [kind, setKind] = useState(o.kind === 'school' ? 'school' : 'centre');
  const [paid, setPaid] = useState(o.paid_until || '');
  const [seats, setSeats] = useState(o.paid_seats ? String(o.paid_seats) : String(Math.max(o.learners, SP.minLearners)));
  const [pilot, setPilot] = useState('');
  const [domains, setDomains] = useState((o.email_domains || []).join(', '));
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      await api.adminSetSchoolPlan(o.id, paid || null, seats === '' ? null : Math.round(Number(seats)), Math.round(Number(pilot)) || null, kind);
      const list = domains.split(/[\s,;]+/).map((d) => d.trim()).filter(Boolean);
      if (list.join(',') !== (o.email_domains || []).join(',')) await api.adminSetSchoolDomains(o.id, list);
      invalidate('admin-orgs', 'admin-tutors');
      toast(`${o.name} saved`);
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`Set up ${o.name}`}
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
        {o.teachers < 3 && (
          <div className="note warn small">
            {o.name} has {o.teachers} teacher{o.teachers === 1 ? '' : 's'}. The school and centre price is for organisations with several teachers; a tutor on their own pays the tutor price.
          </div>
        )}
        <Seg
          label="What it is"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'centre', label: 'Tuition centre' },
            { value: 'school', label: 'School' },
          ]}
        />
        <div className="grid g2" style={{ gap: 10 }}>
          <Field label="Paid up to" hint="The last day of the year they’ve paid for. Empty: not paid yet.">
            <input className="input" type="date" value={paid} onChange={(e) => setPaid(e.target.value)} />
          </Field>
          <Field label="Learners paid for" hint={`At least ${SP.minLearners}. They have ${o.learners} now.`}>
            <input className="input" type="number" min="1" step="1" value={seats} onChange={(e) => setSeats(e.target.value)} />
          </Field>
        </div>
        <Field label="School email endings" hint="Like hillside.ac.zm. Students who sign up with one join this school and wait for a class; teachers wait for its manager. Several: separate with commas.">
          <input className="input" value={domains} onChange={(e) => setDomains(e.target.value)} placeholder="hillside.ac.zm" spellCheck={false} />
        </Field>
        <Field label="Free pilot days" hint="Days to add to their free time (up to 120). Empty: none.">
          <input className="input" type="number" min="1" max="120" step="1" value={pilot} placeholder="None" onChange={(e) => setPilot(e.target.value)} />
        </Field>
        <div className="small">
          The invoice for a year: <b>${yearOf(seats).toLocaleString('en-US')}</b> ({Math.max(Number(seats) || 0, SP.minLearners)} learners × ${SP.perLearnerYear})
        </div>
      </div>
    </Modal>
  );
}
