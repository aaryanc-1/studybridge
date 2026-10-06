// Teaching plans (1.6): spreading a syllabus's topics over weeks, months or chapters by plain maths (no AI).
export const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const at = (s) => new Date(String(s).slice(0, 10) + 'T12:00:00');
export const addDays = (s, n) => ymd(new Date(at(s).getTime() + n * 864e5));
export const fmt = (s, o = {}) => at(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', ...o });
export const today = () => ymd(new Date());

// Spread the topics over the time by plain maths: each topic gets time in proportion to its size (1 + its
// subtopics); the last part before an exam is kept for revision.
export function spreadEvenly(topics, kind, start, end, { revision = true } = {}) {
  const days = Math.round((at(end) - at(start)) / 864e5) + 1;
  if (days < 1 || !topics.length) return [];
  const weights = topics.map((t) => 1 + Math.min(12, (t.details || []).length) / 2);
  const W = weights.reduce((a, b) => a + b, 0);
  // revision: about a sixth of the time, at least a week when there are 4+ weeks
  const revDays = revision && days >= 28 ? Math.max(7, Math.round(days / 6)) : 0;
  const teachEnd = addDays(end, -revDays);
  const teachDays = days - revDays;
  const items = [];
  const label = (t) => `${t.code ? t.code + ' ' : ''}${t.name}`;
  if (kind === 'chapter') {
    let cur = start;
    topics.forEach((t, i) => {
      const len = Math.max(1, Math.round((weights[i] / W) * teachDays));
      const last = i === topics.length - 1 ? teachEnd : addDays(cur, len - 1);
      items.push({ label: label(t), starts_on: cur, ends_on: last < cur ? cur : last, topics: [t.name], focus: (t.details || []).slice(0, 4).join('; '), notes: '' });
      cur = addDays(last < cur ? cur : last, 1);
    });
  } else {
    // the periods: weeks of 7 days, or calendar months
    const periods = [];
    let cur = start;
    while (cur <= teachEnd) {
      let stop;
      if (kind === 'week') stop = addDays(cur, 6);
      else {
        const d = at(cur);
        stop = ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0, 12));
      }
      if (stop > teachEnd) stop = teachEnd;
      periods.push([cur, stop]);
      cur = addDays(stop, 1);
    }
    const P = periods.length;
    let c = 0;
    const spans = weights.map((w) => {
      const s = [c, c + w];
      c += w;
      return s;
    });
    periods.forEach(([a, b], i) => {
      const lo = (i * W) / P;
      const hi = ((i + 1) * W) / P;
      const here = topics.filter((_, j) => Math.min(hi, spans[j][1]) - Math.max(lo, spans[j][0]) > 1e-6);
      items.push({
        label: kind === 'week' ? `Week ${i + 1}` : at(a).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
        starts_on: a,
        ends_on: b,
        topics: here.map((t) => t.name),
        focus: here.length === 1 ? (here[0].details || []).slice(0, 4).join('; ') : '',
        notes: '',
      });
    });
  }
  if (revDays) items.push({ label: 'Revision', starts_on: addDays(teachEnd, 1), ends_on: end, topics: [], focus: 'Revision and past papers', notes: '' });
  return items;
}

