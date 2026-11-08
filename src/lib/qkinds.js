// More question types (step 6, 7 Nov 2026): fill in the blanks, matching, put in order, label a picture,
// record an answer and hand in a file.
// Learners read a question's options (the public part: gaps' lists, the things to match, the shuffled items, the
// picture's spots and labels). The right answers live in question_keys like every other type, and the server marks
// the parts (_auto_mark): all right gets full marks, otherwise the share right, rounded down to the half mark.

export const AUTO = ['mcq', 'numeric', 'cloze', 'match', 'order', 'label'];
export const PARTS = ['cloze', 'match', 'order', 'label'];
export const isAuto = (t) => AUTO.includes(t);
// Question types a teacher marks by hand (Prof helps with some of them)
export const byHand = (t) => !isAuto(t);

const clean = (s) => String(s ?? '').trim();
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const sameSet = (a, b) => same([...a].sort(), [...b].sort());
const unique = (list) => [...new Set(list.map(clean).filter(Boolean))];

// A shuffled copy, never left in the order given in `avoid` (when it can be helped)
export function shuffled(list, avoid = null) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (avoid && out.length > 1 && same(out, avoid)) out.push(out.shift());
  return out;
}
// Keep the order learners already see when the same things are there; shuffle when they changed
const keepOrShuffle = (prev, next, avoid) => (Array.isArray(prev) && prev.length && sameSet(prev, next) ? prev : shuffled(next, avoid));

// ---------------- fill in the blanks ----------------
// The teacher writes: The capital of France is [[Paris]].
// Other answers that count go after a semicolon: [[colour; color]]. A list to choose from: the right one first,
// then the others after a bar: [[Paris|Lyon|Nice]]. Learners see [[1]], [[2]]… and the lists, never the answers.
const GAP = /\[\[([^[\]\n]+?)\]\]/g;
export function clozeBuild(src, prev) {
  const gaps = [];
  const keys = [];
  const prompt = String(src || '').replace(GAP, (_, inner) => {
    const n = gaps.length;
    if (inner.includes('|')) {
      const choices = unique(inner.split('|'));
      const right = clean(inner.split('|')[0]);
      const before = prev?.options?.gaps?.[n]?.choices;
      const order = keepOrShuffle(before, choices, choices);
      gaps.push({ choices: order });
      keys.push({ choice: String(order.indexOf(right)) });
    } else {
      gaps.push({});
      keys.push({ accept: unique(inner.split(';')) });
    }
    return `[[${n + 1}]]`;
  });
  return { prompt_md: prompt, options: { gaps }, answer: { gaps: keys } };
}
// Back to what the teacher wrote, for editing
export function clozeSource(q, key) {
  const gaps = q.options?.gaps || [];
  const keys = key?.gaps || [];
  return String(q.prompt_md || '').replace(/\[\[(\d+)\]\]/g, (m, d) => {
    const i = Number(d) - 1;
    const g = gaps[i];
    const k = keys[i] || {};
    if (!g) return m;
    if (g.choices?.length) {
      const right = g.choices[Number(k.choice)] ?? g.choices[0];
      return `[[${[right, ...g.choices.filter((c) => c !== right)].join('|')}]]`;
    }
    return `[[${(k.accept || []).join('; ')}]]`;
  });
}
// The text in pieces: strings and { gap: index }
export function clozePieces(prompt) {
  const out = [];
  let last = 0;
  const re = /\[\[(\d+)\]\]/g;
  let m;
  while ((m = re.exec(prompt || ''))) {
    if (m.index > last) out.push(prompt.slice(last, m.index));
    out.push({ gap: Number(m[1]) - 1 });
    last = m.index + m[0].length;
  }
  if (last < (prompt || '').length) out.push(prompt.slice(last));
  return out;
}
// Is a typed answer one of the accepted ones? (same rule as the server: case, spaces and number formats don't matter)
const norm = (s) => clean(s).toLowerCase().replace(/\s+/g, ' ');
export function gapRight(answer, keyGap) {
  if (!keyGap) return null;
  if (keyGap.choice != null) return String(answer ?? '') === String(keyGap.choice);
  const a = norm(answer);
  if (!a) return false;
  return (keyGap.accept || []).some((x) => {
    const b = norm(x);
    if (a === b) return true;
    const sa = a.replace(/\s/g, '');
    const sb = b.replace(/\s/g, '');
    const num = /^-?(\d+(\.\d*)?|\.\d+)$/; // the same rule as the server's _same_answer
    return num.test(sa) && num.test(sb) && Number(sa) === Number(sb);
  });
}

// ---------------- matching (and sorting into groups) ----------------
// Each item has its match; several items can share one (that sorts them into groups). Extra wrong matches are optional.
export function matchBuild(edit, prev) {
  const rows = (edit?.rows || []).map((r) => ({ item: clean(r.item), match: clean(r.match) })).filter((r) => r.item || r.match);
  const right = keepOrShuffle(prev?.options?.right, unique([...rows.map((r) => r.match), ...(edit?.extras || [])]));
  return { options: { left: rows.map((r) => r.item), right }, answer: { pairs: rows.map((r) => String(right.indexOf(r.match))) } };
}
export function matchEdit(q, key) {
  const left = q.options?.left || [];
  const right = q.options?.right || [];
  const pairs = key?.pairs || [];
  const rows = left.map((item, i) => ({ item, match: right[Number(pairs[i])] ?? '' }));
  return { rows: rows.length ? rows : [{ item: '', match: '' }, { item: '', match: '' }], extras: right.filter((r) => !rows.some((x) => x.match === r)) };
}

// ---------------- put in order ----------------
export function orderBuild(edit, prev) {
  const correct = (edit?.items || []).map(clean);
  const items = keepOrShuffle(prev?.options?.items, correct, correct);
  return { options: { items }, answer: { order: correct.map((x) => String(items.indexOf(x))) } };
}
export function orderEdit(q, key) {
  const items = q.options?.items || [];
  const order = key?.order || [];
  const list = order.map((i) => items[Number(i)]).filter((x) => x != null);
  return { items: list.length ? list : ['', '', ''] };
}

// ---------------- label a picture ----------------
// Spots are fractions of the picture's width and height, so they stay put at any size
export function labelBuild(edit, prev) {
  const spots = (edit?.spots || []).map((s) => ({ x: Math.round(s.x * 1000) / 1000, y: Math.round(s.y * 1000) / 1000, label: clean(s.label) }));
  const labels = keepOrShuffle(prev?.options?.labels, unique([...spots.map((s) => s.label), ...(edit?.extras || [])]));
  return { options: { spots: spots.map(({ x, y }) => ({ x, y })), labels }, answer: { spots: spots.map((s) => String(labels.indexOf(s.label))) } };
}
export function labelEdit(q, key) {
  const labels = q.options?.labels || [];
  const ks = key?.spots || [];
  const spots = (q.options?.spots || []).map((p, i) => ({ ...p, label: labels[Number(ks[i])] ?? '' }));
  return { spots, extras: labels.filter((l) => !spots.some((s) => s.label === l)) };
}

// ---------------- record / file / written ----------------
export const MEDIA = [
  { value: 'audio', label: 'Voice' },
  { value: 'video', label: 'Video (camera)' },
  { value: 'screen', label: 'Screen' },
  { value: 'any', label: 'Any of these' },
];
export const recordModes = (o) => (o?.media === 'any' || !o?.media ? ['audio', 'video', 'screen'] : [o.media]);
export const recordMax = (o) => Math.max(30, Math.min(600, Number(o?.max) || 180));
export const wordCount = (s) => (String(s || '').match(/[^\s$]+/g) || []).length;

// The editor's model for a type (what the teacher edits), from a saved question and its key
export function editModel(q, keyAnswer) {
  if (q.type === 'cloze') return { src: clozeSource(q, keyAnswer) };
  if (q.type === 'match') return matchEdit(q, keyAnswer);
  if (q.type === 'order') return orderEdit(q, keyAnswer);
  if (q.type === 'label') return labelEdit(q, keyAnswer);
  return null;
}
// What to save: the public options, the key, and (for fill in the blanks) the text learners see
export function buildQuestion(q) {
  const prev = { options: q.options };
  // Saved already and not opened in the editor: keep it exactly as it is
  if (PARTS.includes(q.type) && !q.edit) return { prompt_md: q.prompt_md, options: q.options || [], answer: q.key?.answer || {} };
  if (q.type === 'cloze') return clozeBuild(q.edit.src, prev);
  if (q.type === 'match') return { prompt_md: q.prompt_md, ...matchBuild(q.edit, prev) };
  if (q.type === 'order') return { prompt_md: q.prompt_md, ...orderBuild(q.edit, prev) };
  if (q.type === 'label') return { prompt_md: q.prompt_md, ...labelBuild(q.edit, prev) };
  const options = q.type === 'mcq' ? q.options : q.type === 'record' ? { media: q.options?.media || 'audio', max: recordMax(q.options) } : q.type === 'short' && q.options?.words ? { words: q.options.words } : [];
  return { prompt_md: q.prompt_md, options, answer: q.key?.answer || {} };
}

// Anything that would confuse a learner if posted as it is ("Question 3 …")
export function kindProblem(q, n) {
  const e = q.edit || {};
  if (q.type === 'cloze') {
    const src = e.src ?? '';
    const gaps = [...src.matchAll(GAP)].map((m) => m[1]);
    if (!gaps.length) return `${n}: put each answer in double square brackets, like [[Paris]].`;
    for (const g of gaps) {
      if (g.includes('|') && unique(g.split('|')).length < 2) return `${n}: a list to choose from needs at least two answers, like [[Paris|Lyon]].`;
      if (g.includes('|') && !clean(g.split('|')[0])) return `${n}: put the right answer first in a list, like [[Paris|Lyon|Nice]].`;
      if (!unique(g.split(/[|;]/)).length) return `${n} has an empty gap.`;
    }
  }
  if (q.type === 'match') {
    const rows = (e.rows || []).filter((r) => clean(r.item) || clean(r.match));
    if (rows.length < 2) return `${n}: add at least two things to match.`;
    if (rows.some((r) => !clean(r.item) || !clean(r.match))) return `${n}: give every item its match.`;
    if (unique(rows.map((r) => r.item)).length < rows.length) return `${n}: two items are the same.`;
  }
  if (q.type === 'order') {
    const its = (e.items || []).map(clean);
    if (its.filter(Boolean).length < 2) return `${n}: add at least two things to put in order.`;
    if (its.some((x) => !x)) return `${n} has an empty line. Fill it in or remove it.`;
    if (unique(its).length < its.length) return `${n}: two lines are the same.`;
  }
  if (q.type === 'label') {
    if (!q.image_path) return `${n}: add the picture to label.`;
    if (!(e.spots || []).length) return `${n}: click the picture to add the places to label.`;
    if ((e.spots || []).some((s) => !clean(s.label))) return `${n}: give every numbered place its label.`;
  }
  return null;
}

// Has the learner answered it?
export function answeredKind(q, a) {
  if (q.type === 'cloze') return (a.gaps || []).some((x) => clean(x));
  if (q.type === 'match') return (a.pairs || []).some((x) => x != null && x !== '');
  if (q.type === 'label') return (a.spots || []).some((x) => x != null && x !== '');
  if (q.type === 'order') return Array.isArray(a.order) && a.order.length > 0;
  if (q.type === 'record' || q.type === 'file') return (a.files || []).length > 0 || (a.links || []).length > 0;
  return null;
}

// The right answer in words (mistake cards, the bank, Prof)
export function rightText(q, key) {
  const k = key || {};
  if (q.type === 'cloze')
    return (q.options?.gaps || [])
      .map((g, i) => `${i + 1}: ${g.choices ? g.choices[Number(k.gaps?.[i]?.choice)] ?? '' : (k.gaps?.[i]?.accept || [])[0] ?? ''}`)
      .join('; ');
  if (q.type === 'match') return (q.options?.left || []).map((l, i) => `${l} → ${q.options?.right?.[Number(k.pairs?.[i])] ?? ''}`).join('; ');
  if (q.type === 'order') return (k.order || []).map((i) => q.options?.items?.[Number(i)] ?? '').join(' → ');
  if (q.type === 'label') return (k.spots || []).map((i, n) => `${n + 1}: ${q.options?.labels?.[Number(i)] ?? ''}`).join('; ');
  return '';
}
