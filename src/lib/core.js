// IB core and the PYP: the kinds of project (the same as setup.sql's _core_kind), the learning outcomes CAS and Service as
// Action use (in our own words), the deadlines a new cohort starts with, and the PYP's themes, key concepts, Learner
// Profile and ATL skills (the same lists as setup.sql). The wording is ours: no IB forms, titles or prompts.
export const KINDS = {
  cas: { name: 'CAS', long: 'Creativity, activity, service', programme: 'DP', lead: 'CAS adviser', adds: ['experience', 'reflection'], staff: ['interview', 'meeting'], outcomes: true },
  ee: { name: 'Extended Essay', long: 'Extended Essay', programme: 'DP', lead: 'Supervisor', adds: ['reflection', 'journal', 'draft', 'final'], staff: ['meeting'] },
  tok: { name: 'TOK', long: 'Theory of Knowledge', programme: 'DP', lead: 'TOK teacher', adds: ['journal', 'draft', 'final'], staff: ['meeting'] },
  pp: { name: 'Personal Project', long: 'MYP Personal Project', programme: 'MYP', lead: 'Supervisor', adds: ['journal', 'reflection', 'draft', 'final'], staff: ['meeting'], criteria: true },
  cp: { name: 'Community Project', long: 'MYP Community Project', programme: 'MYP', lead: 'Supervisor', adds: ['journal', 'reflection', 'draft', 'final'], staff: ['meeting'], criteria: true, teams: true },
  sa: { name: 'Service as Action', long: 'MYP Service as Action', programme: 'MYP', lead: 'Adviser', adds: ['experience', 'reflection'], staff: ['meeting'], outcomes: true },
  exhibition: { name: 'PYP Exhibition', long: 'PYP Exhibition', programme: 'PYP', lead: 'Mentor', adds: ['journal', 'reflection', 'final'], staff: ['meeting'], teams: true },
};

export const ENTRY = {
  experience: { name: 'Experience', add: 'Add an experience', icon: 'flag' },
  reflection: { name: 'Reflection', add: 'Write a reflection', icon: 'pen' },
  journal: { name: 'Journal entry', add: 'Write in your journal', icon: 'book' },
  draft: { name: 'Draft', add: 'Hand in a draft', icon: 'file' },
  final: { name: 'Final piece', add: 'Hand in the final piece', icon: 'send' },
  meeting: { name: 'Meeting', add: 'Write up a meeting', icon: 'users' },
  interview: { name: 'CAS interview', add: 'Write up an interview', icon: 'message' },
};

// CAS and Service as Action: seven learning outcomes, in our own words
export const OUTCOMES = {
  1: 'Knowing my strengths and where to grow',
  2: 'Taking on challenges and new skills',
  3: 'Starting and planning something',
  4: 'Keeping going and committing',
  5: 'Working with others',
  6: 'Issues that matter around the world',
  7: 'Thinking about the ethics of choices',
};
export const STRANDS = { C: 'Creativity', A: 'Activity', S: 'Service' };

// MYP projects are marked on three criteria, 0 to 8 each
export const PROJECT_CRITERIA = { A: 'Planning', B: 'Applying skills', C: 'Reflecting' };

// The deadlines a new cohort starts with (the coordinator changes them)
export const STARTER_DEADLINES = {
  cas: ['First interview', 'CAS project plan', 'Second interview', 'Third interview', 'CAS finished'],
  ee: ['Research question', 'First reflection', 'First draft', 'Halfway reflection', 'Final essay', 'Final reflection'],
  tok: ['Exhibition draft', 'Exhibition', 'Essay draft', 'Essay'],
  pp: ['Goal and plan', 'Journal check', 'Report draft', 'Final report'],
  cp: ['Goal and plan', 'Journal check', 'Report draft', 'Final report'],
  sa: ['Halfway check', 'End of year'],
  exhibition: ['Central idea', 'Research', 'Exhibition day', 'Reflection'],
};

// The PYP
export const THEMES = {
  who_we_are: 'Who we are',
  place_time: 'Where we are in place and time',
  express: 'How we express ourselves',
  world_works: 'How the world works',
  organize: 'How we organize ourselves',
  planet: 'Sharing the planet',
};
export const KEY_CONCEPTS = ['Form', 'Function', 'Causation', 'Change', 'Connection', 'Perspective', 'Responsibility'];
export const LEARNER_PROFILE = ['Inquirers', 'Knowledgeable', 'Thinkers', 'Communicators', 'Principled', 'Open-minded', 'Caring', 'Risk-takers', 'Balanced', 'Reflective'];
export const ATL_SKILLS = ['Thinking', 'Research', 'Communication', 'Social', 'Self-management'];
export const PYP_WORDS = ['Beginning', 'Developing', 'Consolidating', 'Extending'];

// One line about how a project is going
export function progressLine(kind, p) {
  if (!p) return '';
  const k = KINDS[kind] || {};
  const bits = [];
  if (k.outcomes) bits.push(`${(p.outcomes || []).length} of 7 outcomes`, `${p.approved || 0} approved experience${p.approved === 1 ? '' : 's'}`);
  else bits.push(`${p.entries || 0} entr${p.entries === 1 ? 'y' : 'ies'}`);
  if (kind === 'cas') bits.push(`${p.interviews || 0} of 3 interviews`);
  else if (p.meetings) bits.push(`${p.meetings} meeting${p.meetings === 1 ? '' : 's'}`);
  return bits.join(' · ');
}
export const lateCount = (p) => (p?.deadlines || []).filter((d) => d.state === 'late').length;
export const nextDeadline = (p) => (p?.deadlines || []).find((d) => d.state === 'open' && d.due);
// "supervisor", "mentor", but "CAS adviser" and "TOK teacher" keep their capitals
export const leadWord = (kind) => (KINDS[kind]?.lead || 'Supervisor').replace(/^([A-Z])([a-z])/, (_, a, b) => a.toLowerCase() + b);
