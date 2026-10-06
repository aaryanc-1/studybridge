// Teaching plans spread by plain maths (src/lib/plan.js)
import test from 'node:test';
import assert from 'node:assert/strict';
import { spreadEvenly } from '../src/lib/plan.js';

const topics = [
  { name: 'Number', code: '1', details: ['a', 'b', 'c', 'd', 'e', 'f'] },
  { name: 'Algebra', code: '2', details: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
  { name: 'Geometry', code: '3', details: ['a', 'b'] },
  { name: 'Statistics', code: '4', details: [] },
];

test('week by week: every topic is planned, in order, with revision before the exam', () => {
  const items = spreadEvenly(topics, 'week', '2026-10-05', '2027-01-31');
  assert.equal(items.at(-1).label, 'Revision');
  assert.deepEqual(items.at(-1).topics, []);
  const weeks = items.slice(0, -1);
  assert.ok(weeks.every((w) => w.label.startsWith('Week ')));
  assert.equal(weeks[0].starts_on, '2026-10-05');
  assert.equal(weeks[0].ends_on, '2026-10-11');
  // each week follows the last, and the plan ends on the exam day
  for (let i = 1; i < items.length; i++) assert.ok(items[i].starts_on > items[i - 1].ends_on);
  assert.equal(items.at(-1).ends_on, '2027-01-31');
  // every topic appears, in syllabus order
  const firsts = topics.map((t) => weeks.findIndex((w) => w.topics.includes(t.name)));
  assert.ok(firsts.every((i) => i >= 0), 'all planned');
  assert.deepEqual([...firsts].sort((a, b) => a - b), firsts, 'in order');
  // bigger topics get more weeks
  const weeksFor = (n) => weeks.filter((w) => w.topics.includes(n)).length;
  assert.ok(weeksFor('Algebra') > weeksFor('Statistics'));
});

test('month by month follows the calendar; chapter by chapter gives each topic its own dates', () => {
  const months = spreadEvenly(topics, 'month', '2026-10-15', '2027-03-31', { revision: false });
  assert.equal(months[0].label, 'October 2026');
  assert.equal(months[0].ends_on, '2026-10-31');
  assert.equal(months[1].starts_on, '2026-11-01');
  assert.equal(months.at(-1).ends_on, '2027-03-31');
  const chapters = spreadEvenly(topics, 'chapter', '2026-10-05', '2026-12-20');
  assert.deepEqual(chapters.slice(0, 4).map((c) => c.topics[0]), ['Number', 'Algebra', 'Geometry', 'Statistics']);
  assert.equal(chapters[0].label, '1 Number');
  assert.ok(chapters.every((c) => c.ends_on >= c.starts_on));
  assert.equal(spreadEvenly([], 'week', '2026-10-05', '2026-12-20').length, 0);
});
