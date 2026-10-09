// Every board, level and subject StudyBridge offers, and each board's exam sessions, from the website's one config
// (website/site.config.json), so the app, the website and the content account always agree.
import site from '../../website/site.config.json';

const slug = (s) =>
  String(s)
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const levelName = (b, l) => (b.id === 'ib' ? (l.name === 'Core' ? 'IB Core' : 'IB Diploma') : l.name);

export const BOARDS = site.boards.map((b) => ({
  id: b.id,
  name: b.name,
  sessions: b.sessions || [],
  levels: b.levels.map((l) => ({
    id: `${b.id}:${slug(l.name)}`,
    name: levelName(b, l),
    subjects: l.subjects.map(([subject, code]) => {
      const c = b.id === 'ib' ? '' : code || '';
      return {
        key: `${b.id}:${slug(l.name)}:${c ? slug(c) : slug(subject)}`,
        board: b.name,
        level: levelName(b, l),
        subject,
        code: c,
        name: b.id === 'ib' ? `IB ${subject}` : `${b.name} ${l.name} ${subject}${c ? ` (${c})` : ''}`,
        exam: b.id === 'cambridge' && /^[0-9a-z]{4}$/i.test(c) ? `cie:${c.toLowerCase()}` : null,
      };
    }),
  })),
}));

export const CATALOGUE = BOARDS.flatMap((b) => b.levels.flatMap((l) => l.subjects));

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The next exam sessions for a board ("May/June 2027"), soonest first
export function upcomingSessions(boardId, from = new Date()) {
  const b = BOARDS.find((x) => x.id === boardId);
  if (!b) return [];
  const out = [];
  for (let y = from.getFullYear(); y <= from.getFullYear() + 2; y++) {
    for (const s of b.sessions) {
      const d = new Date(y, s.month - 1, s.day, 12);
      if (d - from > 7 * 864e5) out.push({ label: `${s.name} ${y}`, date: ymd(d) });
    }
  }
  return out.sort((a, b2) => a.date.localeCompare(b2.date)).slice(0, 4);
}
