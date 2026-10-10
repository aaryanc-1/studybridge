// The Owner's Claude connector (StudyBridge's own content), driven through a real MCP client against the fake server.
// It signs in only as the content account: tutors use Prof inside StudyBridge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { Client } from '../connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../connector/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { createStudyBridgeServer } from '../connector/server/tools.js';
import { startFakeSupabase } from './fake-supabase.mjs';

let srv, mcp;
const sb = () => createClient(srv.url, srv.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
async function connect(email, password) {
  const server = createStudyBridgeServer({ url: srv.url, key: srv.anonKey, email, password });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: 'test', version: '1' });
  await c.connect(b);
  return c;
}
// a tool's reply as text; a tool error becomes a thrown error
const use = async (name, args = {}, client = mcp) => {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return r.content[0].text;
};

test.before(async () => {
  srv = await startFakeSupabase();
  const tutor = sb();
  await tutor.auth.signUp({ email: 'tutor@example.com', password: 'secret123' });
  await tutor.rpc('become_tutor', { p_name: 'Aaryan' });
  // StudyBridge's content account, with two catalogue subjects and a syllabus PDF in its library
  const cc = sb();
  await cc.auth.signUp({ email: 'content@example.com', password: 'secret123' });
  await cc.rpc('become_tutor', { p_name: 'StudyBridge' });
  const cid = (await cc.auth.getUser()).data.user.id;
  await srv.db.query(`update profiles set is_studybridge = true where id = $1`, [cid]);
  await srv.db.query(
    `insert into subjects (tutor_id, name, catalogue, board, level, code, position) values
       ($1, 'Cambridge IGCSE International Mathematics (0607)', 'cambridge:igcse:0607', 'Cambridge', 'IGCSE', '0607', 1),
       ($1, 'Cambridge IGCSE Mathematics (0580)', 'cambridge:igcse:0580', 'Cambridge', 'IGCSE', '0580', 2)`,
    [cid],
  );
  await cc.storage.from('library').upload(`${cid}/files/ch3.pdf`, readFileSync(new URL('./fixtures/algebra-chapter-3.pdf', import.meta.url)), { contentType: 'application/pdf' });
  await cc.from('files').insert({ name: 'Algebra chapter 3.pdf', storage_path: `${cid}/files/ch3.pdf`, mime: 'application/pdf' });
  mcp = await connect('content@example.com', 'secret123');
});
test.after(async () => {
  await mcp?.close();
  await srv.close();
});

test('has only the content tools: nothing that reads learners’ work or drafts for tutors', async () => {
  const names = (await mcp.listTools()).tools.map((t) => t.name);
  for (const n of ['content_overview', 'set_syllabus', 'add_questions', 'add_lesson', 'add_flashcards', 'add_practice_paper', 'questions_to_check', 'submit_checks', 'confirm_checks', 'read_pdf']) {
    assert.ok(names.includes(n), n);
  }
  for (const n of ['overview', 'get_submission', 'draft_marking', 'create_assignment_draft', 'draft_message', 'learner_progress']) assert.ok(!names.includes(n), n);
  const prompts = (await mcp.listPrompts()).prompts.map((p) => p.name);
  assert.deepEqual(prompts.sort(), ['check_waiting', 'make_subject']);
});

test('signs in only as the content account: tutors, other accounts and wrong passwords are refused', async () => {
  const someone = sb();
  await someone.auth.signUp({ email: 'someone@example.com', password: 'secret123' });
  for (const [email, password, re] of [
    ['tutor@example.com', 'secret123', /only for StudyBridge’s own content account. Tutors use Prof/],
    ['someone@example.com', 'secret123', /only for StudyBridge’s own content account/],
    ['content@example.com', 'wrong', /Couldn’t sign in/],
  ]) {
    const c = await connect(email, password);
    await assert.rejects(use('content_overview', {}, c), re);
    await c.close();
  }
});

test('reads a syllabus PDF from the content account’s library', async () => {
  const t = await use('read_pdf', { file: 'chapter 3' });
  assert.match(t, /2 pages/);
  assert.match(t, /subtract 3 from both sides/);
});

test('makes a subject’s content; each question is checked without seeing its answer, then it’s up for students', async () => {
  assert.equal(JSON.parse(await use('content_overview')).not_started_yet, 2);
  await assert.rejects(use('set_syllabus', { subject: 'Mathematics', topics: [{ name: 'Number' }] }), /could be/);
  assert.match(await use('set_syllabus', { subject: '0607', topics: [{ name: 'Number', code: 'C1', subtopics: ['Fractions'] }, { name: 'Algebra', code: 'C2' }] }), /2 topics \(2 new\)/);
  const added = await use('add_questions', {
    subject: '0607',
    questions: [
      { topic: 'Number', type: 'numeric', prompt: 'Work out $3 \\times 7$.', answer: '21', hint: 'Count in threes.', solution: '$3 \\times 7 = 21$' },
      { topic: 'C2', type: 'mcq', prompt: 'Which is equal to $2x$ when $x = 3$?', options: ['5', '6', '8'], correct: [1], hint: 'Replace x with 3.', solution: '$2 \\times 3 = 6$' },
      { topic: 'Algebra', type: 'mcq', prompt: 'Pick the even number.', options: ['3', '4'], hint: 'Even numbers end in 0, 2, 4, 6 or 8.', solution: '4 is even.' },
    ],
  });
  assert.match(added, /Saved 3 questions/);
  assert.match(added, /2 wait for their check.*NEW chat/s);
  assert.match(added, /3: The correct option doesn’t match/);
  // the check never sees answers
  const waiting = JSON.parse(await use('questions_to_check'));
  assert.equal(waiting.questions.length, 2);
  assert.ok(!/Count in threes|21\$|Replace x/.test(JSON.stringify(waiting.questions)));
  const ans = waiting.questions.map((x) => (x.type === 'mcq' ? { id: x.id, kind: x.kind, choice: 1 } : { id: x.id, kind: x.kind, value: 21 }));
  assert.match(await use('submit_checks', { answers: ans }), /2 passed/);
  const ov = JSON.parse(await use('content_overview', { subject: '0607' }));
  assert.equal(ov.subjects[0].questions_live, 2);
  assert.equal(ov.needing_the_owner, 1);
  const body = 'Fractions show parts of a whole. '.repeat(10) + 'For example $\\frac{1}{2} + \\frac{1}{4} = \\frac{3}{4}$.';
  assert.match(await use('add_lesson', { subject: '0607', topic: 'Number', title: 'Adding fractions', body }), /is up for/);
  assert.match(await use('add_flashcards', { subject: '0607', cards: [{ topic: 'Number', front: 'What is a fraction?', back: 'Part of a whole.' }] }), /Added 1 flashcard/);
  assert.match(
    await use('add_practice_paper', {
      subject: '0607',
      title: 'Practice paper 1 · Set A',
      minutes: 45,
      questions: [{ type: 'numeric', prompt: 'Work out $9 \\times 6$.', answer: '54', solution: '$9 \\times 6 = 54$', mark_scheme: 'B1 54' }],
    }),
    /Saved “Practice paper 1 · Set A”.*\(1 question\).*1 wait/s,
  );
  const paperQ = JSON.parse(await use('questions_to_check')).questions[0];
  assert.equal(paperQ.kind, 'paper');
  assert.match(await use('submit_checks', { answers: [{ id: paperQ.id, kind: 'paper', value: '54' }] }), /1 passed/);
  assert.equal(JSON.parse(await use('content_overview', { subject: '0607' })).subjects[0].papers_live, 1);
  assert.equal(await use('questions_to_check'), 'Nothing is waiting for its check.');
});
