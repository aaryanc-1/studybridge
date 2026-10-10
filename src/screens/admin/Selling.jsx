// Admin → Selling (1.6): plan limits, payments (Stripe), email (Resend) and Google sign-in. Each is off until
// the admin switches it on or adds its keys. Keys are write-only: once saved, nobody can read them back.
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Field, Page, Toggle, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';

const PRICES = [
  ['starter_month', 'Starter, monthly ($15)'],
  ['starter_year', 'Starter, yearly ($150)'],
  ['pro_month', 'Pro, monthly ($29)'],
  ['pro_year', 'Pro, yearly ($290)'],
];

export default function SellingPage() {
  const toast = useToast();
  const q = useQuery('admin-selling', api.adminSelling);
  const s = q.data;
  const [keys, setKeys] = useState({ stripe_secret: '', stripe_webhook: '', resend_key: '' });
  const [prices, setPrices] = useState(null);
  const [from, setFrom] = useState(null);
  async function save(patch, msg = 'Saved') {
    try {
      await api.adminSetSelling(patch);
      invalidate('admin-selling');
      toast(msg);
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    }
  }
  if (!s) return <Page title="Selling">{q.error ? <div className="error">{q.error.message}</div> : null}</Page>;
  const p = prices || s.prices || {};
  const plans = s.plans || {};
  return (
    <Page title="Selling" subtitle="Plans, payments, email and Google sign-in. Each stays off until you switch it on or add its keys.">
      <div className="card">
        <h2>Plans</h2>
        <div className="small muted">
          New prices (on the website): tutors pay per learner on Essentials or Plus, after a 7-day free trial; self-learners pay $11 a month or an exam pass at $9 a month. Until online checkout opens, you take payment yourself, then set the tutor’s plan on their page: Custom (the learners they’ve paid for, until the date they’ve paid to) or Complimentary. Essentials and Plus arrive with the tutor launch. Tutors now: {Object.entries(plans).map(([k, n]) => `${n} ${k}`).join(', ') || 'none yet'}.
        </div>
        <Toggle
          checked={s.enforce_plans}
          onChange={(v) => save({ enforce: v }, v ? 'Plan limits are on' : 'Plan limits are off')}
          title="Enforce plan limits"
          sub="When on, a learner can’t join a tutor whose plan is full. Leave this off until you start charging. You can still set any tutor’s plan by hand on their page."
        />
      </div>

      <div className="card">
        <h2>Payments (Stripe)</h2>
        <div className="small muted">Online checkout comes last, once everything is ready. Leave this empty until then: these steps are for the old Starter and Pro plans and will change for per-learner prices.</div>
        <ol className="small stack sm" style={{ paddingLeft: 18, margin: 0 }}>
          <li>In Stripe, make two products (Starter and Pro), each with a monthly and a yearly price, and copy each price’s ID (it starts with price_).</li>
          <li>Stripe → Developers → API keys: copy the Secret key.</li>
          <li>
            Stripe → Developers → Webhooks → Add endpoint: <span className="code-box" style={{ display: 'inline', padding: '2px 6px' }}>{`${api.profUrl?.() || 'your Supabase URL/functions/v1/prof'}?stripe=webhook`}</span>, events
            checkout.session.completed, customer.subscription.updated and customer.subscription.deleted. Copy its signing secret.
          </li>
        </ol>
        <div className="grid g2" style={{ gap: 10 }}>
          {PRICES.map(([k, label]) => (
            <Field key={k} label={label}>
              <input className="input" value={p[k] || ''} onChange={(e) => setPrices({ ...p, [k]: e.target.value.trim() })} placeholder="price_…" />
            </Field>
          ))}
        </div>
        <div className="grid g2" style={{ gap: 10 }}>
          <Field label={`Secret key ${s.stripe_set ? '(saved)' : ''}`} hint="Write-only: it can’t be read back.">
            <input className="input" type="password" value={keys.stripe_secret} onChange={(e) => setKeys({ ...keys, stripe_secret: e.target.value })} placeholder={s.stripe_set ? '••••••• (leave empty to keep)' : 'sk_live_…'} />
          </Field>
          <Field label={`Webhook signing secret ${s.webhook_set ? '(saved)' : ''}`}>
            <input className="input" type="password" value={keys.stripe_webhook} onChange={(e) => setKeys({ ...keys, stripe_webhook: e.target.value })} placeholder={s.webhook_set ? '••••••• (leave empty to keep)' : 'whsec_…'} />
          </Field>
        </div>
        <div>
          <button
            className="btn primary"
            onClick={async () => {
              await save({ prices: Object.fromEntries(Object.entries(p).filter(([, v]) => v)), stripe_secret: keys.stripe_secret, stripe_webhook: keys.stripe_webhook }, 'Payments saved');
              setKeys({ ...keys, stripe_secret: '', stripe_webhook: '' });
            }}
          >
            Save payments
          </button>
        </div>
        <div className="tiny muted">Tutors see “Upgrade” in Settings once the secret key and at least one price are saved.</div>
      </div>

      <div className="card">
        <h2>Email (Resend)</h2>
        <div className="small muted">
          Add gostudybridge.com in Resend, copy an API key, and use the sender StudyBridge &lt;hello@gostudybridge.com&gt;. Then weekly reports go by email straight from StudyBridge (a parent’s reply goes to the tutor), and website messages, early-access sign-ups and “Contact StudyBridge” messages are emailed to hello@ and support@. For password-reset emails from the domain too, add Resend’s SMTP details in Supabase → Authentication → Emails → SMTP.
        </div>
        <EmailQueue />
        <div className="grid g2" style={{ gap: 10 }}>
          <Field label="Sender">
            <input className="input" value={from ?? s.email_from ?? ''} onChange={(e) => setFrom(e.target.value)} placeholder="StudyBridge <hello@yourdomain.com>" />
          </Field>
          <Field label={`Resend API key ${s.resend_set ? '(saved)' : ''}`}>
            <input className="input" type="password" value={keys.resend_key} onChange={(e) => setKeys({ ...keys, resend_key: e.target.value })} placeholder={s.resend_set ? '••••••• (leave empty to keep)' : 're_…'} />
          </Field>
        </div>
        <div>
          <button
            className="btn primary"
            onClick={async () => {
              await save({ email_from: from ?? s.email_from ?? '', resend_key: keys.resend_key }, 'Email saved');
              setKeys({ ...keys, resend_key: '' });
            }}
          >
            Save email
          </button>
        </div>
      </div>

      <div className="card">
        <h2>Google sign-in</h2>
        <div className="small muted">
          Set it up first in Google Cloud (an OAuth client) and Supabase → Authentication → Sign In / Providers → Google. Then switch it on here: “Continue with Google” appears on the sign-in page of the phone and web version.
        </div>
        <Toggle checked={s.google_on} onChange={(v) => save({ google: v }, v ? 'Google sign-in is on' : 'Google sign-in is off')} icon="globe" title="Show “Continue with Google”" />
      </div>
      <WebsiteMessages />
      <EarlyAccess />
      <div className="tiny muted">
        <Icon name="lock" size={12} /> Keys are stored on the server and can’t be read back by anyone, including you.
      </div>
    </Page>
  );
}

// Emails waiting to go to hello@ / support@ (they wait until email is set up above)
function EmailQueue() {
  const q = useQuery('admin-email-queue', api.adminEmailQueue, { poll: 60000 });
  const e = q.data;
  if (!e) return null;
  return (
    <div className="note small">
      Messages go to <b>{e.contact_email}</b> (website) and <b>{e.support_email}</b> (the app).{' '}
      {Number(e.waiting) > 0 ? `${e.waiting} waiting to be emailed${e.last_error ? ` (last problem: ${e.last_error})` : ' (they go as soon as email is set up)'}. ` : ''}
      {Number(e.sent_week) > 0 ? `${e.sent_week} emailed this week. ` : ''}
      {Number(e.failed) > 0 ? `${e.failed} couldn’t be emailed; they’re still listed here in Admin.` : ''}
    </div>
  );
}

// Messages from the website's Contact page
function WebsiteMessages() {
  const toast = useToast();
  const q = useQuery('admin-contact', api.adminContactMessages, { poll: 120000 });
  const rows = q.data || [];
  const open = rows.filter((m) => !m.handled_at);
  const [showDone, setShowDone] = useState(false);
  const list = showDone ? rows : open;
  return (
    <div className="card">
      <div className="row between wrap">
        <h2>Website messages</h2>
        {rows.length > open.length && (
          <button className="linkbtn small" onClick={() => setShowDone((x) => !x)}>
            {showDone ? 'Hide answered' : `Show answered (${rows.length - open.length})`}
          </button>
        )}
      </div>
      <div className="small muted">{rows.length ? `${open.length} to answer. Reply by email: each one has the sender’s address.` : 'Nothing yet. Messages from the website’s Contact page appear here (and in your hello@ inbox once email is set up).'}</div>
      {list.length > 0 && (
        <div className="list">
          {list.map((m) => (
            <div key={m.id} className="item" style={{ alignItems: 'flex-start' }}>
              <span className="grow stack sm">
                <span>
                  <span className="strong">{m.name || m.email}</span>
                  <span className="tiny muted">
                    {' '}
                    · {m.role || 'not said'} · {new Date(m.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                  </span>
                </span>
                <span className="small" style={{ whiteSpace: 'pre-wrap' }}>{m.message}</span>
                <a className="small" href={`mailto:${m.email}?subject=${encodeURIComponent('Re: your message to StudyBridge')}`}>
                  Reply to {m.email}
                </a>
              </span>
              <button
                className="btn sm"
                onClick={async () => {
                  try {
                    await api.adminContactDone(m.id, !m.handled_at);
                    invalidate('admin-contact');
                  } catch (e) {
                    toast({ title: 'Couldn’t change it', body: e.message, tone: 'bad' });
                  }
                }}
              >
                {m.handled_at ? 'Mark to answer' : 'Answered'}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// People who asked for early access on the website (students on their own, parents, tutors, centres, schools)
function EarlyAccess() {
  const q = useQuery('admin-early-access', api.adminEarlyAccess);
  const rows = q.data || [];
  const roles = rows.reduce((m, r) => ({ ...m, [r.role]: (m[r.role] || 0) + 1 }), {});
  function download() {
    const cols = ['email', 'role', 'curriculum', 'subjects', 'exam', 'country', 'note', 'created_at'];
    const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `studybridge-early-access-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  return (
    <div className="card">
      <div className="row between wrap">
        <h2>Early access</h2>
        {rows.length > 0 && (
          <button className="btn sm" onClick={download}>
            <Icon name="download" size={16} /> Download (CSV)
          </button>
        )}
      </div>
      <div className="small muted">
        {rows.length
          ? `${rows.length} ${rows.length === 1 ? 'person' : 'people'} asked from the website: ${Object.entries(roles).map(([k, n]) => `${n} ${k}${n === 1 ? '' : 's'}`).join(', ')}.`
          : 'Nobody yet. People who ask for early access on the website appear here.'}
      </div>
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Who</th>
                <th>Studying</th>
                <th>Exam</th>
                <th>Country</th>
                <th>Asked</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 50).map((r) => (
                <tr key={r.email}>
                  <td>{r.email}</td>
                  <td>{r.role}</td>
                  <td>{[r.curriculum, r.subjects].filter(Boolean).join(': ') || '–'}{r.note ? <div className="tiny muted">“{r.note}”</div> : null}</td>
                  <td>{r.exam || '–'}</td>
                  <td>{r.country || '–'}</td>
                  <td className="tiny">{new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
