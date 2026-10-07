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
          Free: 1 learner · Starter: up to 5 · Pro: up to 25 · Custom: you choose · Complimentary: Pro for free. Set each tutor’s plan on their page. Tutors now: {Object.entries(plans).map(([k, n]) => `${n} ${k}`).join(', ') || 'none yet'}.
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
          Once you have a domain: add it in Resend, copy an API key, and choose the sender (e.g. StudyBridge &lt;hello@yourdomain.com&gt;). Weekly reports can then go by email straight from StudyBridge. For password-reset emails from your domain too, add Resend’s SMTP details in Supabase → Authentication → Emails → SMTP.
        </div>
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
      <EarlyAccess />
      <div className="tiny muted">
        <Icon name="lock" size={12} /> Keys are stored on the server and can’t be read back by anyone, including you.
      </div>
    </Page>
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
