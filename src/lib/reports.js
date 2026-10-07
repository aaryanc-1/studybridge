// Weekly parent reports: the text that goes to the parent (WhatsApp formatting: *bold*)
import { dur } from './format.js';
import { plainMaths } from './plain.js';

const fmtDay = (d, opts) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...opts });

export function workLine(w) {
  const counts = { on_time: 0, late: 0, missing: 0, open: 0 };
  for (const x of w) counts[x.status] = (counts[x.status] || 0) + 1;
  const parts = [`${w.length} set`];
  if (counts.on_time) parts.push(`${counts.on_time} on time`);
  if (counts.late) parts.push(`${counts.late} late`);
  if (counts.missing) parts.push(`${counts.missing} missing`);
  if (counts.open) parts.push(`${counts.open} still open`);
  return parts.join(' · ');
}
const STATUS = { on_time: 'on time', late: 'late', missing: 'not handed in', open: 'not due yet' };

export function reportText(r) {
  const d = r.data || {};
  const to = new Date(new Date(d.to).getTime() - 864e5);
  const lines = [];
  lines.push(`*Weekly report: ${d.learner || ''}*`);
  if (d.from) lines.push(`Week of ${fmtDay(d.from)} – ${fmtDay(to, { year: 'numeric' })}`);
  lines.push('');
  if (r.summary) lines.push(r.summary, '');
  lines.push(`*Lessons:* ${d.lessons || 0} live lesson${d.lessons === 1 ? '' : 's'}`);
  const w = d.work || [];
  lines.push(`*Work:* ${w.length ? workLine(w) : 'nothing due this week'}`);
  for (const x of w.slice(0, 8)) {
    const score = x.score != null && x.max ? ` — ${Number(x.score)}/${Number(x.max)}` : '';
    lines.push(`  • ${x.title}${score} (${STATUS[x.status] || x.status})`);
  }
  if (d.avg_pct != null) {
    const trend = d.prev_avg_pct != null ? (d.avg_pct > d.prev_avg_pct ? `, up from ${d.prev_avg_pct}%` : d.avg_pct < d.prev_avg_pct ? `, down from ${d.prev_avg_pct}%` : ', same as before') : '';
    lines.push(`*Marks:* ${d.avg_pct}% average this week${trend}`);
  }
  if (d.practice?.tries) lines.push(`*Practice:* ${d.practice.tries} tr${d.practice.tries === 1 ? 'y' : 'ies'}${d.practice.pct != null ? `, ${d.practice.pct}% average` : ''}`);
  if (d.seconds) lines.push(`*Time studying:* ${dur(d.seconds)}`);
  const topics = (d.topics || []).filter((t) => t.ratio != null).sort((a, b) => b.ratio - a.ratio);
  const strong = topics.filter((t) => t.strength === 'strong').slice(0, 2);
  const weak = topics.filter((t) => t.strength === 'weak' || t.strength === 'developing').slice(-2).reverse();
  if (strong.length) lines.push(`*Strongest:* ${strong.map((t) => `${t.topic} (${Math.round(t.ratio * 100)}%)`).join(', ')}`);
  if (weak.length) lines.push(`*To work on:* ${weak.map((t) => `${t.topic} (${Math.round(t.ratio * 100)}%)`).join(', ')}`);
  if (r.comment) lines.push('', `*From ${d.tutor || 'your tutor'}:* ${plainMaths(r.comment)}`);
  if (r.next_week || (d.next || []).length) {
    lines.push('', `*Next week:* ${plainMaths(r.next_week || '')}`.trim());
    if (!r.next_week) for (const x of d.next.slice(0, 5)) lines.push(`  • ${x.title} (due ${fmtDay(x.due_at, { weekday: 'short' })})`);
  }
  if (d.exam?.date && d.exam.days >= 0) lines.push('', `*${d.exam.name || 'Exam'}:* ${d.exam.days} days to go (${fmtDay(d.exam.date, { year: 'numeric' })})`);
  lines.push('', '— Sent with StudyBridge');
  return lines.join('\n');
}

export const waLink = (phone, text) => `https://wa.me/${String(phone || '').replace(/[^0-9]/g, '')}?text=${encodeURIComponent(text)}`;
export const mailLink = (email, subject, text) => `mailto:${encodeURIComponent(email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text.replace(/\*/g, ''))}`;
