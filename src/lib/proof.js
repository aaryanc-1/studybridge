// Report polish: plain checks on a term-report comment before it goes out (no AI). The proofreaders' page and the
// teacher's own writing page show them; "Fix the small things" (tidyComment) mends the ones that are safe to mend.

const first = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const norm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const esc = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Each issue: { kind, text }. learner: their name; others: everyone else in the class (names); twins: other learners'
// comments [{ name, comment }] to catch the same comment twice; grade: false when a grade is expected but missing.
export function proofIssues(comment, { learner = '', others = [], twins = [], grade = true } = {}) {
  const out = [];
  const add = (kind, text) => out.push({ kind, text });
  const c = String(comment || '').trim();
  if (grade === false) add('grade', 'No grade yet');
  if (!c) {
    add('empty', 'No comment yet');
    return out;
  }
  // another learner's name: usually a comment copied from someone else's
  const me = first(learner).toLowerCase();
  const named = new Set();
  for (const o of others) {
    const f = first(o);
    if (f.length < 3 || f.toLowerCase() === me || named.has(f.toLowerCase())) continue;
    if (new RegExp(`(?<![\\p{L}])${esc(f)}(?![\\p{L}])`, 'iu').test(c)) {
      named.add(f.toLowerCase());
      add('name', `Mentions ${f}: is this the right learner?`);
    }
  }
  for (const t of twins) {
    if (t.comment && norm(t.comment) === norm(c)) add('same', `The same as ${first(t.name)}’s comment`);
  }
  if (/\[[^\]]*\]|\{[^}]*\}|<[^>]*>|\bXX+\b|\bTBC\b|\bTBD\b|\binsert (name|here)\b|\blorem ipsum\b/i.test(c)) add('placeholder', 'Something to fill in is still there');
  const twice = c.match(/(?<![\p{L}])(\p{L}+)\s+\1(?![\p{L}])/iu);
  if (twice) add('repeat', `“${twice[1]} ${twice[1]}”: a word twice`);
  if (/^\p{Ll}/u.test(c) || /[.!?]\s+\p{Ll}/u.test(c)) add('capital', 'A sentence starts with a small letter');
  if (!/[.!?…]["”’)]?$/.test(c)) add('stop', 'No full stop at the end');
  if (/ {2,}/.test(c)) add('spaces', 'Two spaces together');
  if (/\s[,.;:!?](?!\.)/.test(c)) add('space', 'A space before a full stop or comma');
  if (/(^|\s)i(?=\s|['’])/.test(c)) add('i', '“i” on its own should be “I”');
  const pairs = [['(', ')'], ['“', '”']];
  if (pairs.some(([a, b]) => c.split(a).length !== c.split(b).length) || (c.match(/"/g) || []).length % 2) add('bracket', 'A bracket or quote isn’t closed');
  if (c.length < 25) add('short', 'Very short');
  return out;
}

// The issues it's safe to mend by itself: spaces, a capital at the start of each sentence, "i", the full stop at the end
export const TIDY = ['capital', 'stop', 'spaces', 'space', 'i'];
export function tidyComment(text) {
  let s = String(text || '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([,.;:!?])(?!\.)/g, '$1')
    .replace(/(^|\s)i(?=\s|['’])/g, '$1I')
    .trim();
  s = s.replace(/^\p{Ll}/u, (x) => x.toUpperCase()).replace(/([.!?]\s+)(\p{Ll})/gu, (_, a, b) => a + b.toUpperCase());
  if (s && !/[.!?…]["”’)]?$/.test(s)) s += '.';
  return s;
}

// The colours a place can give its reports: each dark enough for white writing on it (a test checks)
export const BRAND_COLOURS = [
  { hex: '#0E6B6B', name: 'Teal' },
  { hex: '#1F3A5F', name: 'Navy' },
  { hex: '#1E40AF', name: 'Royal blue' },
  { hex: '#14532D', name: 'Forest green' },
  { hex: '#7A1F2B', name: 'Maroon' },
  { hex: '#4C1D95', name: 'Purple' },
  { hex: '#9A3412', name: 'Burnt orange' },
  { hex: '#374151', name: 'Charcoal' },
];
