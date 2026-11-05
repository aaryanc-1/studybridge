// Maths written for the screen ($x^2-25$, **bold**) turned into plain text for WhatsApp, email and notifications
import test from 'node:test';
import assert from 'node:assert/strict';
import { plainMaths } from '../src/lib/plain.js';
import { mainScript } from '../src/lib/autoupdate.js';
import { parseTable, parseTimetable, weekdayOf } from '../src/lib/roster.js';
import { SCALES, assessmentOf, scaleGrade, scaleProblem, pctText } from '../src/lib/grading.js';

test('plain maths: no dollar signs, stars or LaTeX left', () => {
  const fb = 'Good start: taking out the common factor 3 to get $3(x^2-25)$ is right. Factorise **fully**: $a^2-b^2=(a+b)(a-b)$ gives $3(x+5)(x-5)$.';
  const out = plainMaths(fb);
  assert.equal(out, 'Good start: taking out the common factor 3 to get 3(x² − 25) is right. Factorise fully: a² − b²=(a+b)(a − b) gives 3(x+5)(x − 5).');
  assert.doesNotMatch(out, /[$*\\]/);
  assert.equal(plainMaths('$\\frac{1}{2} \\times 6 \\le 3$'), '(1)/(2) × 6 ≤ 3');
  assert.equal(plainMaths('$\\sqrt{x}$ and $\\left(x\\right)^{3}$'), '√(x) and (x)³');
  assert.equal(plainMaths(''), '');
});

// The phone / browser app knows a new version by the name of its main script (a new build, a new name)
test('updates: the main script of the web app', () => {
  const html = '<script>inline()</script><link rel="modulepreload" href="./assets/x.js"><script type="module" crossorigin src="./assets/index-B1x2.js"></script>';
  assert.equal(mainScript(html), './assets/index-B1x2.js');
  assert.equal(mainScript('<script src="a.js"></script>'), null);
  assert.equal(mainScript(''), null);
});

test('class lists from a spreadsheet: which column is which, and years vs grades', () => {
  const g = (rows) => parseTable(rows.join('\n')).map((r) => [r.email, r.grade, r.classes.join('|')]);
  // a Year column: "Year 10" and a plain 10 are both Year 10 = Grade 9
  assert.deepEqual(g(['Email\tName\tYear\tClasses', 'ama@s.test\tAma\tYear 10\tYear 10 maths; Year 10 science', 'kofi@s.test\tKofi\t10\tYear 10 maths']), [
    ['ama@s.test', 9, 'Year 10 maths|Year 10 science'],
    ['kofi@s.test', 9, 'Year 10 maths'],
  ]);
  // a Grade or Form column: plain numbers are grades; "Year 8" written out still counts as a year
  assert.deepEqual(g(['email,name,grade', 'a@s.test,A,9', 'b@s.test,B,Year 8']), [['a@s.test', 9, ''], ['b@s.test', 7, '']]);
  assert.deepEqual(g(['Email;Form;Class', 'c@s.test;10A;Form 2 maths']), [['c@s.test', 10, 'Form 2 maths']]);
  // a singular Class column is the classes, not the year
  assert.deepEqual(g(['Email\tYear\tClass', 'd@s.test\tYear 9\tYear 9 English']), [['d@s.test', 8, 'Year 9 English']]);
  // no header: email, name, year, classes; rows without an email are skipped
  assert.deepEqual(g(['e@s.test,Esi,Year 11,"Maths; Physics"', 'not an email,X,9']), [['e@s.test', 10, 'Maths|Physics']]);
});

test('a timetable from a spreadsheet: class, day, period, room, teacher, with or without a header', () => {
  assert.deepEqual(['Monday', 'tue', 'WE', '4', 'Friday ', 'Saturday', 'Sun', 'Funday', ''].map(weekdayOf), [1, 2, 3, 4, 5, 6, 7, null, null]);
  const rows = ['Teacher\tRoom\tDay\tPeriod\tClass', 'Grace Mwansa\t12\tMonday\tPeriod 1\tYear 10 maths', '\tLab\tWed\t09:00\tYear 11 physics'];
  assert.deepEqual(parseTimetable(rows.join('\n')).map((r) => [r.class, r.weekday, r.period, r.room, r.teacher]), [
    ['Year 10 maths', 1, 'Period 1', '12', 'Grace Mwansa'],
    ['Year 11 physics', 3, '09:00', 'Lab', ''],
  ]);
  // no header: in that order; rows with only a class are skipped
  assert.deepEqual(parseTimetable('Year 9 art,Fri,P3\nJust a name').map((r) => [r.class, r.weekday, r.period]), [['Year 9 art', 5, 'P3']]);
  // a two-week timetable: a Week column (A or B; empty for every week)
  assert.deepEqual(parseTimetable('Class\tDay\tPeriod\tWeek\nYear 7 art\tMon\tP1\tWeek B\nYear 7 art\tTue\tP2\t').map((r) => [r.weekday, r.week]), [[1, 'Week B'], [2, '']]);
});

test('gradebook depth: the starting grade scales are valid, a percentage gets the right grade, tests and exams are summative', () => {
  for (const sc of SCALES) {
    assert.equal(scaleProblem(sc.grades), '', sc.name);
    assert.deepEqual(sc.grades.map((g) => g.min), [...sc.grades.map((g) => g.min)].sort((a, b) => b - a), `${sc.name} highest first`);
    assert.equal(sc.grades.at(-1).min, 0, `${sc.name} has a grade for everyone`);
  }
  const ib = SCALES.find((s) => s.id === 'ib').grades;
  assert.deepEqual([scaleGrade(ib, 80), scaleGrade(ib, 79.9), scaleGrade(ib, 65), scaleGrade(ib, 0), scaleGrade(ib, null)], ['7', '6', '5', '1', null]);
  assert.match(scaleProblem([{ grade: 'A', min: 70 }, { grade: 'a', min: 60 }]), /there twice/);
  assert.match(scaleProblem([{ grade: 'A', min: 70 }, { grade: 'B', min: 70 }]), /same percentage/);
  assert.match(scaleProblem([{ grade: 'A', min: '' }]), /from 0 to 100/);
  assert.deepEqual(['homework', 'quiz', 'test', 'exam'].map((k) => assessmentOf(k)), ['formative', 'formative', 'summative', 'summative']);
  assert.equal(assessmentOf('homework', 'summative'), 'summative');
  assert.deepEqual([pctText(65), pctText(70.85), pctText(null)], ['65%', '70.9%', '—']);
});
