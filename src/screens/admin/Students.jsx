// Admin → Students: students studying on their own. The Owner opens sign-up, picks the account that holds
// StudyBridge's own content, puts every subject into it, and records payments taken by hand.
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Page, Toggle, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { CATALOGUE } from '../../lib/catalogue.js';
import { ago } from '../../lib/format.js';
import { studentAccess, GRADES } from '../../lib/students.js';
import site from '../../../website/site.config.json';

const PRICE = site.selfLearner;

const day = (s) => (s ? new Date(String(s).slice(0, 10) + 'T12:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const plus = (months) => {
  const d = new Date();
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
};
// an exam pass lasts through the exams, not just to the first one: about two months past the first exam
const passEnds = (examDate) => {
  if (!examDate) return plus(8);
  const d = new Date(String(examDate).slice(0, 10) + 'T12:00');
  d.setDate(d.getDate() + 60);
  return d.toISOString().slice(0, 10);
};

export default function StudentsPage() {
  const toast = useToast();
  const q = useQuery('admin-students', api.adminStudents, { poll: 30000 }); // new sign-ups show up while it's open
  const d = q.data;
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState('');
  const refresh = () => invalidate('admin-students');
  async function run(what, fn, ok) {
    setBusy(what);
    try {
      const r = await fn();
      refresh();
      if (ok) toast(typeof ok === 'function' ? ok(r) : ok);
      return true;
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
      return false;
    } finally {
      setBusy('');
    }
  }
  if (!d) return <Page title="Students">{q.error ? <div className="error">{q.error.message}</div> : null}</Page>;
  const c = d.content;
  const students = d.students || [];
  return (
    <Page title="Students" subtitle="Students studying on their own: their free week, what they’ve paid, and the subjects they can choose.">
      <div className="card stack">
        <h2>StudyBridge’s content account</h2>
        {c ? (
          <>
            <div className="small">
              <b>{c.name || c.email}</b> <span className="muted">· {c.email}</span>
            </div>
            <div className="small muted">
              {c.subjects} subject{c.subjects === 1 ? '' : 's'} in the catalogue, {c.live} open to students. Switch to this account to add each subject’s syllabus, lessons and
              questions, and open a subject (Subjects page) when it’s ready.
            </div>
            {c.subjects < CATALOGUE.length && (
              <div>
                <button className="btn primary" disabled={!!busy} onClick={() => run('seed', () => api.adminSeedCatalogue(CATALOGUE), (r) => `Added ${r.added} subject${r.added === 1 ? '' : 's'}`)}>
                  <Icon name="plus" size={18} /> Add every subject ({CATALOGUE.length})
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="small muted">
            Sign up a new tutor account just for StudyBridge’s own content (for example with hello+content@gostudybridge.com), approve it in Tutors, then enter its email here.
          </div>
        )}
        <form
          className="row wrap"
          style={{ gap: 8, alignItems: 'flex-end' }}
          onSubmit={(e) => {
            e.preventDefault();
            run('content', () => api.adminSetContentAccount(email.trim()), 'Content account set').then((ok) => ok && setEmail(''));
          }}
        >
          <Field label={c ? 'Use a different account' : 'Content account’s email'}>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="hello+content@gostudybridge.com" style={{ minWidth: 260 }} />
          </Field>
          <button className="btn" disabled={!email.trim() || !!busy}>
            Use this account
          </button>
        </form>
      </div>

      <PayLinks links={d.pay_links || {}} run={run} busy={busy} />

      <div className="card">
        <Toggle
          checked={!!d.open}
          disabled={!c || !!busy}
          onChange={(v) => run('open', () => api.adminStudentsOpen(v), v ? 'Students can sign up now' : 'Student sign-up is closed')}
          title="Students can sign up"
          sub="When on, “I’m a student” appears in the app. Keep it off until the first subjects are open."
        />
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Students ({students.length})</h2>
        </div>
        {students.length === 0 ? (
          <Empty>No students yet. They appear here when they sign up.</Empty>
        ) : (
          <div className="list">
            {students.map((s) => (
              <StudentRow key={s.id} s={s} busy={busy} run={run} />
            ))}
          </div>
        )}
      </div>
    </Page>
  );
}

// Paying by card: two Stripe Payment Links the Owner makes; students see "Pay by card" buttons
function PayLinks({ links, run, busy }) {
  const [monthly, setMonthly] = useState(links.monthly || '');
  const [pass, setPass] = useState(links.pass || '');
  return (
    <div className="card stack">
      <h2>Paying by card</h2>
      <div className="small muted">
        In Stripe, make two Payment Links: <b>Monthly</b> at ${PRICE.month} a month (repeating), and <b>Exam pass</b> at ${PRICE.passMonth} with “Let customers adjust
        quantity” switched on (one for each month until their exams). Paste them here and students see “Pay by card” buttons. When Stripe emails you about a
        payment, mark that student as paid below. The payment shows their StudyBridge account id as the client reference.
      </div>
      <form
        className="stack sm"
        onSubmit={(e) => {
          e.preventDefault();
          run('links', () => api.adminSetPayLinks(monthly.trim(), pass.trim()), 'Payment links saved');
        }}
      >
        <Field label="Monthly link">
          <input className="input" type="url" value={monthly} onChange={(e) => setMonthly(e.target.value)} placeholder="https://buy.stripe.com/…" />
        </Field>
        <Field label="Exam pass link">
          <input className="input" type="url" value={pass} onChange={(e) => setPass(e.target.value)} placeholder="https://buy.stripe.com/…" />
        </Field>
        <div>
          <button className="btn" disabled={!!busy}>
            Save links
          </button>
        </div>
      </form>
    </div>
  );
}

function StudentRow({ s, busy, run }) {
  const [paying, setPaying] = useState(false);
  const [plan, setPlan] = useState('monthly');
  const [until, setUntil] = useState(plus(1));
  const a = studentAccess({ ...s, self_learner: true });
  const status = a.paid
    ? `${s.paid_plan === 'pass' ? 'Exam pass' : 'Monthly'}, paid until ${day(s.paid_until)}`
    : a.trial
      ? `Free trial: ${a.daysLeft} day${a.daysLeft === 1 ? '' : 's'} left`
      : 'Trial over, not paid';
  return (
    <div className="item student-row">
      <span className="grow">
        <span className="name">{s.name || s.email}</span>
        <span className="meta">
          {s.email} · {GRADES.find(([g]) => g === s.grade)?.[1] || 'grade not given'}
          {s.country ? ` · ${s.country}` : ''} · joined {ago(s.joined)}
          {s.last_seen_at ? ` · last seen ${ago(s.last_seen_at)}` : ''}
        </span>
        <span className="meta">
          {s.setup_done ? `${(s.subjects || []).join(', ') || 'No subjects'} · ${s.exam_label || `exams ${day(s.exam_date)}`}` : 'Hasn’t finished setting up yet'}
        </span>
        <span className={'pill ' + (a.paid ? 'good' : a.trial ? 'accent' : 'warn')} style={{ alignSelf: 'flex-start' }}>
          {status}
        </span>
        {paying && (
          <span className="row wrap" style={{ gap: 8, alignItems: 'flex-end', marginTop: 6 }}>
            <span className="seg" role="group" aria-label="What they paid for">
              <button type="button" aria-pressed={plan === 'monthly'} onClick={() => (setPlan('monthly'), setUntil(plus(1)))}>
                Monthly
              </button>
              <button type="button" aria-pressed={plan === 'pass'} onClick={() => (setPlan('pass'), setUntil(passEnds(s.exam_date)))}>
                Exam pass
              </button>
            </span>
            <label className="stack sm small">
              Paid until
              <input className="input sm" type="date" value={until} onChange={(e) => setUntil(e.target.value)} aria-label="Paid until" />
            </label>
            <button className="btn sm primary" disabled={!!busy} onClick={() => run('pay', () => api.adminSetStudentPaid(s.id, plan, until), 'Payment recorded').then((ok) => ok && setPaying(false))}>
              Save
            </button>
            <button className="btn sm ghost" onClick={() => setPaying(false)}>
              Cancel
            </button>
          </span>
        )}
      </span>
      {!paying && (
        <span className="row wrap" style={{ gap: 6, justifyContent: 'flex-end' }}>
          <button className="btn sm" onClick={() => setPaying(true)}>
            {a.paid ? 'Change payment' : 'Mark as paid'}
          </button>
          {!a.paid && (
            <button className="btn sm ghost" disabled={!!busy} onClick={() => run('trial', () => api.adminExtendTrial(s.id, 7), 'Trial extended by 7 days')}>
              +7 days free
            </button>
          )}
          {s.paid_plan && (
            <button className="btn sm ghost" disabled={!!busy} onClick={() => run('unpay', () => api.adminSetStudentPaid(s.id, null, null), 'Payment removed')}>
              Remove payment
            </button>
          )}
        </span>
      )}
    </div>
  );
}
