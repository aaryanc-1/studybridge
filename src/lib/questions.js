// Multiple-choice options are stored either as ["a","b"] or { items: [...], multi: true }
export const items = (o) => (Array.isArray(o) ? o : o?.items || []);
export const multi = (o) => !Array.isArray(o) && !!o?.multi;

// Is there a real drawing? (not blank, not rubbed out: `blank` is set when the picture came out empty)
export const drawn = (a) => !!a && !a.blank && (a.strokes || []).some((s) => !s.e && s.p?.length);

// Has the learner answered this question?
export function answered(q, a) {
  if (!a) return false;
  if (q.type === 'drawing') return drawn(a) || (a.files || []).length > 0;
  if (q.type === 'mcq') return multi(q.options) ? (a.choices || []).length > 0 : a.choice != null;
  if (q.type === 'numeric') return !!String(a.value ?? '').trim();
  if (q.type === 'short') return !!String(a.text ?? '').trim() || (a.files || []).length > 0;
  if (q.type === 'steps') return (a.steps || []).some((s) => s && s.trim()) || (a.files || []).length > 0;
  return (a.files || []).length > 0;
}
