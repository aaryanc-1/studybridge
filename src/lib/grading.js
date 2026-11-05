// Gradebook depth: formative and summative work, and the grade scales a class can start from. A scale gives the lowest
// percentage for each grade, highest first. These are starting points only: a teacher changes them to fit the class
// (real exam boundaries change every session, and a teacher's own grade boundaries for the exam are better still).

// Formative: practice and feedback. Summative: it counts for grades. Tests and exams are summative unless the teacher
// says otherwise (the same rule as setup.sql's _assessment).
export const assessmentOf = (kind, set) => set || (kind === 'test' || kind === 'exam' ? 'summative' : 'formative');
export const ASSESSMENT = {
  formative: { label: 'Formative', short: 'F', sub: 'Practice and feedback' },
  summative: { label: 'Summative', short: 'S', sub: 'Counts for grades' },
};

export const SCALES = [
  { id: 'ib', name: 'IB 1 to 7', grades: [['7', 80], ['6', 70], ['5', 60], ['4', 50], ['3', 40], ['2', 25], ['1', 0]] },
  { id: 'gcse', name: 'GCSE 9 to 1', grades: [['9', 90], ['8', 80], ['7', 70], ['6', 60], ['5', 50], ['4', 40], ['3', 30], ['2', 20], ['1', 10], ['U', 0]] },
  { id: 'igcse', name: 'IGCSE A* to G', grades: [['A*', 90], ['A', 80], ['B', 70], ['C', 60], ['D', 50], ['E', 40], ['F', 30], ['G', 20], ['U', 0]] },
  { id: 'alevel', name: 'A Level A* to E', grades: [['A*', 90], ['A', 80], ['B', 70], ['C', 60], ['D', 50], ['E', 40], ['U', 0]] },
  { id: 'letters', name: 'Letters A to F', grades: [['A', 90], ['B', 80], ['C', 70], ['D', 60], ['F', 0]] },
].map((s) => ({ ...s, grades: s.grades.map(([grade, min]) => ({ grade, min })) }));

// The grade a percentage gets on a scale (the best one whose lowest percentage it reaches), like setup.sql's _scale_grade
export function scaleGrade(scale, pct) {
  if (pct == null || !scale?.length) return null;
  const hit = [...scale].sort((a, b) => b.min - a.min).find((g) => Number(pct) >= Number(g.min));
  return hit ? hit.grade : null;
}

// What's wrong with a scale before saving it (the server checks the same), or ''
export function scaleProblem(scale) {
  const seen = new Set();
  const mins = new Set();
  for (const g of scale) {
    const name = String(g.grade || '').trim();
    if (!name) return 'Every grade needs a name, like A* or 7.';
    const n = Number(g.min);
    if (g.min === '' || g.min == null || !Number.isFinite(n) || n < 0 || n > 100) return `Grade ${name}: give the lowest percentage for it, from 0 to 100.`;
    if (seen.has(name.toUpperCase())) return `Grade ${name} is there twice.`;
    if (mins.has(n)) return `Two grades can’t start at the same percentage (${n}).`;
    seen.add(name.toUpperCase());
    mins.add(n);
  }
  return '';
}

// "65%" or "65.5%" (one decimal only when it matters)
export const pctText = (n) => (n == null ? '—' : `${Math.round(Number(n) * 10) / 10}%`);
