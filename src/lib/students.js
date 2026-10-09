// Students on their own: are they in their free week, paid up, or out of time?
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function studentAccess(me, now = new Date()) {
  if (!me?.self_learner) return { ok: true };
  if (me.paid_until && String(me.paid_until).slice(0, 10) >= ymd(now)) return { ok: true, paid: true, plan: me.paid_plan, until: String(me.paid_until).slice(0, 10) };
  if (me.trial_until && new Date(me.trial_until) > now) return { ok: true, trial: true, daysLeft: Math.max(1, Math.ceil((new Date(me.trial_until) - now) / 864e5)) };
  return { ok: false };
}

export const GRADES = [
  [6, 'Grade 6 (Year 7)'],
  [7, 'Grade 7 (Year 8)'],
  [8, 'Grade 8 (Year 9)'],
  [9, 'Grade 9 (Year 10)'],
  [10, 'Grade 10 (Year 11)'],
  [11, 'Grade 11 (Year 12)'],
  [12, 'Grade 12 (Year 13)'],
  [13, 'Finished school'],
];
