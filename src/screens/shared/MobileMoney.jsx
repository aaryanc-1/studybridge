// Pay with mobile money (Flutterwave): choose how long (and, for a tutor, how many learners) and a currency, then
// Flutterwave's page takes the payment (Airtel, MTN, M-Pesa, local cards). It switches on once Flutterwave confirms it.
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Field, Modal, useToast } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';

const NAMES = { USD: 'US dollars', ZMW: 'Zambian kwacha', INR: 'Indian rupees' };
const money = (n, cur) => (cur === 'USD' ? '$' + n.toFixed(2).replace(/\.00$/, '') : `${cur} ${Math.ceil(n).toLocaleString('en-US')}`);
const s = (n) => (n === 1 ? '' : 's');

// what: essentials | plus | seats (tutors), monthly | pass (students); usdFor(months, places) is the price in dollars.
// A tutor's plan chooses how long and how many learners (at least minPlaces, the learners they have); adding places
// (what = seats) chooses how many more for the time already paid; a student's month or exam pass is fixed (months).
export default function MobileMoney({ what, label = 'Pay with mobile money', usdFor, months: fixed = null, minPlaces = 1, forId = null, className = 'btn' }) {
  const toast = useToast();
  const pub = useQuery('public-settings', api.publicSettings).data || {};
  const [open, setOpen] = useState(false);
  const [months, setMonths] = useState(fixed || 1);
  const [places, setPlaces] = useState(what === 'seats' ? 1 : Math.max(1, minPlaces));
  const [cur, setCur] = useState('USD');
  const [busy, setBusy] = useState(false);
  if (!pub.mobile_on) return null;
  const rate = Number(pub.rates?.[cur] || 1);
  const m = fixed || months;
  const tutor = ['essentials', 'plus', 'seats'].includes(what);
  const n = Math.max(what === 'seats' ? 1 : Math.max(1, minPlaces), Math.round(Number(places)) || 0);
  const price = money(usdFor(m, n) * rate, cur);
  async function pay() {
    setBusy(true);
    try {
      const r = await api.mobilePay(what, m, cur, forId, tutor ? n : null);
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
          title={what === 'seats' ? 'Add places' : 'Pay with mobile money'}
          onClose={() => setOpen(false)}
          foot={
            <>
              <button className="btn" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button className="btn primary" disabled={busy} onClick={pay}>
                {busy ? 'Opening…' : `Pay ${price}`}
              </button>
            </>
          }
        >
          <div className="stack sm">
            {!fixed && what !== 'seats' && (
              <Field label="How long">
                <select className="select" value={months} onChange={(e) => setMonths(Number(e.target.value))}>
                  {[1, 3, 6, 12].map((x) => (
                    <option key={x} value={x}>
                      {x === 12 ? '12 months (1 month free)' : `${x} month${s(x)}`}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {tutor && (
              <Field
                label={what === 'seats' ? 'How many more learners' : 'Learners to pay for'}
                hint={what === 'seats' ? 'For the rest of the time you’ve paid for.' : `One place for each learner. You have ${minPlaces}; pay for more now if more are joining.`}
              >
                <input className="input" type="number" min={what === 'seats' ? 1 : Math.max(1, minPlaces)} step="1" value={places} onChange={(e) => setPlaces(e.target.value)} style={{ maxWidth: 140 }} />
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
              {price}
              {what === 'seats' ? ` for ${n} more place${s(n)}` : tutor ? ` for ${n} learner${s(n)}, ${m} month${s(m)}` : fixed ? '' : ` for ${m} month${s(m)}`}, paid once (it doesn’t renew by itself). Flutterwave’s
              page opens next: pay with Airtel, MTN, M-Pesa or a card.
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
