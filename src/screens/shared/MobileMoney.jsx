// Pay with mobile money (Flutterwave): choose how many months and a currency, then Flutterwave's page takes the
// payment (Airtel, MTN, M-Pesa, local cards). It switches on once Flutterwave confirms it to StudyBridge.
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Field, Modal, useToast } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';

const NAMES = { USD: 'US dollars', ZMW: 'Zambian kwacha', INR: 'Indian rupees' };
const money = (n, cur) => (cur === 'USD' ? '$' + n.toFixed(2).replace(/\.00$/, '') : `${cur} ${Math.ceil(n).toLocaleString('en-US')}`);

// what: essentials | plus (tutors), monthly | pass (students); usdFor(months) is the price in dollars;
// months: fixed (a student's month or exam pass), or null to choose 1–12 (tutors)
export default function MobileMoney({ what, label = 'Pay with mobile money', usdFor, months: fixed = null, forId = null, className = 'btn' }) {
  const toast = useToast();
  const pub = useQuery('public-settings', api.publicSettings).data || {};
  const [open, setOpen] = useState(false);
  const [months, setMonths] = useState(fixed || 1);
  const [cur, setCur] = useState('USD');
  const [busy, setBusy] = useState(false);
  if (!pub.mobile_on) return null;
  const rate = Number(pub.rates?.[cur] || 1);
  const m = fixed || months;
  async function pay() {
    setBusy(true);
    try {
      const r = await api.mobilePay(what, m, cur, forId);
      if (r?.url) window.open(r.url, '_blank'); // the desktop app opens this in the browser
      setOpen(false);
      toast({ title: 'Finish paying on the Flutterwave page', body: 'It switches on here as soon as the payment comes through.' });
    } catch (e) {
      toast({ title: 'Couldn’t start the payment', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <Icon name="phone" size={16} /> {label}
      </button>
      {open && (
        <Modal
          title="Pay with mobile money"
          onClose={() => setOpen(false)}
          foot={
            <>
              <button className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy} onClick={pay}>
                {busy ? 'Opening…' : `Pay ${money(usdFor(m) * rate, cur)}`}
              </button>
            </>
          }
        >
          <div className="stack sm">
            {!fixed && (
              <Field label="How long">
                <select className="select" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
                  {[1, 3, 6, 12].map((n) => (
                    <option key={n} value={n}>
                      {n === 12 ? '12 months (1 month free)' : `${n} month${n === 1 ? '' : 's'}`}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Currency">
              <select className="select" value={cur} onChange={(e) => setCur(e.target.value)}>
                {(pub.currencies || ['USD']).map((c) => (
                  <option key={c} value={c}>
                    {NAMES[c] || c}
                  </option>
                ))}
              </select>
            </Field>
            <div className="small muted">
              {money(usdFor(m) * rate, cur)}
              {fixed ? '' : ` for ${m} month${m === 1 ? '' : 's'}`}, paid once (it doesn’t renew by itself). Flutterwave’s page opens next: pay with Airtel, MTN, M-Pesa or a card.
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
