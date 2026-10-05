export function dur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  if (sec === 0) return '0 min';
  if (sec < 60) return '<1 min';
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

export function clock(sec) {
  sec = Math.max(0, Math.floor(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}

const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const fullFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export const day = (d) => (d ? dayFmt.format(new Date(d)) : '');
export const time = (d) => (d ? timeFmt.format(new Date(d)) : '');
export const when = (d) => (d ? fullFmt.format(new Date(d)) : '');

// A moment on someone else's clock, e.g. "Tue 16:00" in Africa/Lusaka
export function timeIn(d, tz, { weekday = true } = {}) {
  if (!d) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { ...(weekday ? { weekday: 'short' } : {}), hour: 'numeric', minute: '2-digit', timeZone: tz || undefined }).format(new Date(d));
  } catch {
    return '';
  }
}
// "Africa/Lusaka" → "Lusaka"
export const placeOf = (tz) => String(tz || '').split('/').pop().replace(/_/g, ' ');
export const myTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

export function ago(d) {
  if (!d) return '';
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86400 * 6) return `${Math.round(s / 86400)} d ago`;
  return day(d);
}

// "due in 2 days", "due today 17:00", "3 days late"
export function due(d) {
  if (!d) return { text: 'No due date', tone: '' };
  const t = new Date(d).getTime();
  const diff = t - Date.now();
  const days = diff / 86400000;
  if (diff < 0) return { text: `Overdue · was due ${when(d)}`, tone: 'bad' };
  if (days < 1 && new Date(d).getDate() === new Date().getDate()) return { text: `Due today ${time(d)}`, tone: 'warn' };
  if (days < 2) return { text: `Due tomorrow ${time(d)}`, tone: 'warn' };
  if (days < 7) return { text: `Due ${when(d)}`, tone: '' };
  return { text: `Due ${day(d)}`, tone: '' };
}

// Value for <input type="datetime-local">
export function toLocalInput(d) {
  if (!d) return '';
  const x = new Date(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
}
export const fromLocalInput = (v) => (v ? new Date(v).toISOString() : null);

export function bytes(n) {
  if (!n && n !== 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export const kindLabel = { homework: 'Homework', quiz: 'Quiz', test: 'Test', exam: 'Exam' };
export const typeLabel = {
  mcq: 'Multiple choice',
  numeric: 'Number answer',
  short: 'Written answer',
  steps: 'Maths with working',
  upload: 'Photo of work',
  drawing: 'Drawing',
};

export function pct(score, max) {
  if (score == null || !max) return null;
  return Math.round((Number(score) / Number(max)) * 100);
}

export function weekRange(offset = 0) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dow = (d.getDay() + 6) % 7; // Monday = 0
  const from = new Date(d.getTime() - dow * 86400000 + offset * 7 * 86400000);
  const to = new Date(from.getTime() + 7 * 86400000);
  return { from, to };
}
export function monthRange(offset = 0) {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() + offset, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + offset + 1, 1);
  return { from, to };
}

export function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('');
}

export const palette = ['#0E6B6B', '#8A4FBF', '#C2571B', '#2F6DB5', '#B03A5B', '#4E7D2E', '#9A7A12', '#5A5F66'];
export function colorFor(id) {
  let h = 0;
  for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return palette[h % palette.length];
}

// YYYY-MM-DD for a date in local time
export function ymd(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}
