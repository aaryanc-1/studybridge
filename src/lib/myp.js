// The IB MYP's subject groups and their criteria A to D (the same names are in setup.sql's _myp_criteria; a test checks
// they match), the achievement levels 0 to 8, and the 1–7 grade from the four criteria added up.
export const MYP_GROUPS = {
  language_literature: { name: 'Language and literature', criteria: { A: 'Analysing', B: 'Organizing', C: 'Producing text', D: 'Using language' } },
  language_acquisition: { name: 'Language acquisition', criteria: { A: 'Listening', B: 'Reading', C: 'Speaking', D: 'Writing' } },
  individuals_societies: { name: 'Individuals and societies', criteria: { A: 'Knowing and understanding', B: 'Investigating', C: 'Communicating', D: 'Thinking critically' } },
  sciences: { name: 'Sciences', criteria: { A: 'Knowing and understanding', B: 'Inquiring and designing', C: 'Processing and evaluating', D: 'Reflecting on the impacts of science' } },
  mathematics: { name: 'Mathematics', criteria: { A: 'Knowing and understanding', B: 'Investigating patterns', C: 'Communicating', D: 'Applying mathematics in real-life contexts' } },
  arts: { name: 'Arts', criteria: { A: 'Investigating', B: 'Developing', C: 'Creating or performing', D: 'Evaluating' } },
  physical_health: { name: 'Physical and health education', criteria: { A: 'Knowing and understanding', B: 'Planning for performance', C: 'Applying and performing', D: 'Reflecting and improving performance' } },
  design: { name: 'Design', criteria: { A: 'Inquiring and analysing', B: 'Developing ideas', C: 'Creating the solution', D: 'Evaluating' } },
};
export const LETTERS = ['A', 'B', 'C', 'D'];

// What a level means (the usual bands)
export const band = (n) => (n == null || n === '' ? '' : n <= 0 ? 'Not reached yet' : n <= 2 ? 'Limited' : n <= 4 ? 'Adequate' : n <= 6 ? 'Substantial' : 'Excellent');

// The 1–7 grade from all four criteria added up (0–32); null until all four are given
export function mypGrade(levels) {
  const vals = LETTERS.map((k) => levels?.[k]).filter((v) => v != null && v !== '');
  if (vals.length < 4) return null;
  const t = vals.reduce((s, v) => s + Number(v), 0);
  return t <= 5 ? 1 : t <= 9 ? 2 : t <= 14 ? 3 : t <= 18 ? 4 : t <= 23 ? 5 : t <= 27 ? 6 : 7;
}

// "A5 · C6"
export const levelsText = (levels) =>
  LETTERS.filter((k) => levels?.[k] != null)
    .map((k) => `${k}${levels[k]}`)
    .join(' · ');
