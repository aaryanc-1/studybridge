// School office basics (5 Nov 2026): the words for absences parents report (the reasons are the same as setup.sql's
// _absence_reason; db.test checks), the parts of a learner's record, and the staff roles in a centre or school.
export const REASONS = {
  ill: 'Ill',
  medical: 'A medical or dental appointment',
  family: 'Family reasons',
  religious: 'A religious festival or observance',
  holiday: 'A holiday',
  other: 'Another reason',
};
export const PARTS = { day: 'All day', am: 'The morning', pm: 'The afternoon', late: 'Coming in late', early: 'Leaving early' };
export const ABSENCE_STATUS = { waiting: 'Waiting', accepted: 'Accepted', not_accepted: 'Not accepted', withdrawn: 'Taken back' };
export const statusTone = (s) => (s === 'accepted' ? 'good' : s === 'not_accepted' ? 'bad' : s === 'waiting' ? 'warn' : '');

const short = (d) => new Date(d + 'T12:00').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
// "Tue 10 Nov", "Tue 10 Nov to Thu 12 Nov", "Tue 10 Nov, the morning", "Tue 10 Nov, in by 10:30", "Tue 10 Nov, leaving at 14:00"
export function absenceWhen(a) {
  if (!a?.starts) return '';
  if (a.ends && a.ends > a.starts) return `${short(a.starts)} to ${short(a.ends)}`;
  const d = short(a.starts);
  if (a.part === 'am') return `${d}, the morning`;
  if (a.part === 'pm') return `${d}, the afternoon`;
  if (a.part === 'late') return `${d}, in by ${a.at_time}`;
  if (a.part === 'early') return `${d}, leaving at ${a.at_time}`;
  return d;
}

// Grade 9 is Year 10 (as the rest of the app says it)
export const yearName = (g) => (g == null ? 'No year set' : g >= 13 ? 'Finished school' : `Grade ${g} (Year ${g + 1})`);
export const YEARS = Array.from({ length: 12 }, (_, i) => i + 1);

// Staff in a centre or school: a manager, a teacher, or the office; anyone can also be head of one or more years
export const ROLES = { manager: 'Manager', tutor: 'Teacher', office: 'Office' };

// A learner's record, in the order the form shows it. office: only the office (and managers, heads of year) change it
export const RECORD_GROUPS = [
  {
    title: 'About them',
    fields: [
      { key: 'preferred_name', label: 'The name they go by', max: 60 },
      { key: 'student_no', label: 'Student number', max: 30, office: true },
      { key: 'birth_date', label: 'Date of birth', type: 'date' },
      { key: 'home_language', label: 'Languages at home', max: 60 },
      { key: 'address', label: 'Home address', max: 300, area: true },
    ],
  },
  {
    title: 'Health',
    fields: [
      { key: 'allergies', label: 'Allergies', max: 300, hint: 'What they’re allergic to and what to do' },
      { key: 'medical', label: 'Health and medicines', max: 1000, area: true, hint: 'Conditions, medicines, and where they’re kept' },
      { key: 'dietary', label: 'Diet', max: 300 },
      { key: 'doctor', label: 'Their doctor', max: 200, hint: 'Name and phone number' },
    ],
  },
  {
    title: 'Learning',
    fields: [{ key: 'support', label: 'Learning support', max: 1000, area: true, hint: 'What they need, and what helps them' }],
  },
  {
    title: 'Permissions and going home',
    fields: [
      { key: 'photos', label: 'Photos', type: 'yesno', yes: 'They can be in the school’s photos', no: 'No photos of them, please' },
      { key: 'going_home', label: 'Going home', max: 300, hint: 'How they get home, and who collects them' },
    ],
  },
];
// The parts teachers see (the rest stays with the office and the family)
export const TEACHER_KEYS = ['preferred_name', 'student_no', 'allergies', 'medical', 'dietary', 'support', 'photos', 'going_home', 'contacts'];
