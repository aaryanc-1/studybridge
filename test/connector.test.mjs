// The tutor's Claude connector, driven through a real MCP client against the fake server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { Client } from '../connector/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { InMemoryTransport } from '../connector/node_modules/@modelcontextprotocol/sdk/dist/esm/inMemory.js';
import { createStudyBridgeServer } from '../connector/server/tools.js';
import { startFakeSupabase } from './fake-supabase.mjs';

let srv, tutor, learner, mcp, learnerId;
const sb = () => createClient(srv.url, srv.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const call = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return r;
};
const data = (r) => JSON.parse(r.content[0].text);

test.before(async () => {
  srv = await startFakeSupabase();
  tutor = sb();
  await tutor.auth.signUp({ email: 'tutor@example.com', password: 'secret123' });
  await tutor.rpc('become_tutor', { p_name: 'Aaryan' });
  const s = (await tutor.from('subjects').insert({ name: 'Mathematics' }).select().single()).data;
  await tutor.from('topics').insert([{ subject_id: s.id, name: 'Algebra' }]);
  const inv = (await tutor.from('invites').insert({ name: 'Anaya', subject_ids: [s.id] }).select().single()).data;
  learner = sb();
  await learner.auth.signUp({ email: 'anaya@example.com', password: 'secret123' });
  learnerId = (await learner.rpc('accept_invite', { p_code: inv.code, p_name: 'Anaya' })).data.id;
  const tu = (await tutor.auth.getUser()).data.user;
  await tutor.storage.from('library').upload(`${tu.id}/files/ch3.pdf`, readFileSync(new URL('./fixtures/algebra-chapter-3.pdf', import.meta.url)), { contentType: 'application/pdf' });
  await tutor.from('files').insert({ name: 'Algebra chapter 3.pdf', storage_path: `${tu.id}/files/ch3.pdf`, mime: 'application/pdf' });

  const server = createStudyBridgeServer({ url: srv.url, key: srv.anonKey, email: 'tutor@example.com', password: 'secret123' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  mcp = new Client({ name: 'test', version: '1' });
  await mcp.connect(b);
});
test.after(async () => {
  await mcp?.close();
  await srv.close();
});

test('lists its tools', async () => {
  const { tools } = await mcp.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['overview', 'get_submission', 'create_assignment_draft', 'draft_marking', 'read_pdf']) assert.ok(names.includes(n), n);
});

test('refuses learner accounts and bad passwords', async () => {
  for (const [email, password, re] of [
    ['anaya@example.com', 'secret123', /isn’t a tutor/],
    ['tutor@example.com', 'wrong', /Couldn’t sign in/],
  ]) {
    const s = createStudyBridgeServer({ url: srv.url, key: srv.anonKey, email, password });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await s.connect(a);
    const c = new Client({ name: 't', version: '1' });
    await c.connect(b);
    const r = await c.callTool({ name: 'overview', arguments: {} });
    assert.ok(r.isError);
    assert.match(r.content[0].text, re);
    await c.close();
  }
});

test('reads a PDF from the library', async () => {
  const r = await call('read_pdf', { file: 'chapter 3' });
  assert.match(r.content[0].text, /2 pages/);
  assert.match(r.content[0].text, /subtract 3 from both sides/);
});

test('drafts an assignment the learner cannot see until approved', async () => {
  const r = await call('create_assignment_draft', {
    title: 'Linear equations quiz',
    kind: 'quiz',
    subject: 'maths',
    topic: 'algebra',
    questions: [
      { type: 'mcq', prompt: 'Solve $x+5=9$', options: ['3', '4', '5'], correct: [1] },
      { type: 'numeric', prompt: 'Solve $4x=50$', answer: '12.5', tolerance: 0 },
      { type: 'steps', prompt: 'Solve $3x-1=11$', answer: 'x=4', marks: 3, mark_scheme: 'M1 add 1, A1 x=4' },
    ],
  });
  assert.match(r.content[0].text, /Draft saved/);
  assert.equal((await learner.from('assignments').select('*')).data.length, 0, 'drafts hidden from learners');
  const a = data(await call('get_assignment', { assignment: 'Linear equations quiz' }));
  assert.equal(a.draft, true);
  assert.equal(a.kind, 'quiz');
  assert.equal(a.questions.length, 3);
  assert.deepEqual(a.questions[0].key.answer, { choice: '1' });
  assert.equal(a.questions[2].key.answer.final, 'x=4');
  // Tutor approves in the app
  await tutor.from('assignments').update({ draft: false }).eq('id', a.id);
  assert.equal((await learner.from('assignments').select('*')).data.length, 1);
});

test('reads a submission (with photos) and drafts marking the tutor applies', async () => {
  const a = (await learner.from('assignments').select('*')).data[0];
  const qs = (await learner.from('questions').select('*').eq('assignment_id', a.id).order('position')).data;
  const t = (await learner.rpc('start_attempt', { p_assignment: a.id, p_client: 'web' })).data;
  const photo = `${learnerId}/${t.id}/${qs[2].id}-p.png`;
  await learner.storage.from('work').upload(photo, readFileSync(new URL('../build/icon.png', import.meta.url)), { contentType: 'image/png' });
  await learner.rpc('save_response', { p_attempt: t.id, p_question: qs[0].id, p_answer: { choice: '1' } });
  await learner.rpc('save_response', { p_attempt: t.id, p_question: qs[1].id, p_answer: { value: '12' } });
  await learner.rpc('save_response', { p_attempt: t.id, p_question: qs[2].id, p_answer: { steps: ['3x-1=11', '3x=10', 'x=10/3'], files: [{ path: photo }] } });
  await learner.rpc('submit_attempt', { p_attempt: t.id });

  const o = data(await call('overview'));
  assert.equal(o.waiting_to_mark.length, 1);
  const subs = data(await call('list_submissions'));
  assert.equal(subs[0].learner, 'Anaya');
  const r = await call('get_submission', { attempt_id: subs[0].attempt_id });
  const s = data(r);
  assert.deepEqual(s.questions[2].learner_answer.working_lines_latex, ['3x-1=11', '3x=10', 'x=10/3']);
  assert.equal(s.questions[0].auto_marks, 1);
  assert.equal(s.questions[2].mark_scheme, 'M1 add 1, A1 x=4');
  assert.ok(r.content.some((c) => c.type === 'image' && c.data.length > 100), 'photo of work included');

  await call('draft_marking', {
    attempt_id: t.id,
    summary: 'Arithmetic slip in Q3',
    overall_feedback: 'Good start. Check your adding.',
    questions: [
      { number: 2, marks: 0, feedback: '$50 \\div 4 = 12.5$', mistake: 'Rounded too early' },
      { number: 3, marks: 1, feedback: '$11 + 1 = 12$, not 10', mistake: 'Arithmetic slip', correct_steps: [true, false, false], redo: true },
    ],
  });
  assert.equal((await learner.from('claude_drafts').select('*')).data.length, 0, 'learner never sees drafts');
  const d = (await tutor.from('claude_drafts').select('*').eq('status', 'pending')).data[0];
  assert.equal(d.payload.marks.length, 2);
  await tutor.rpc('apply_draft', { p_draft: d.id });
  const back = (await tutor.rpc('attempt_detail', { p_attempt: t.id })).data;
  const r3 = back.responses.find((x) => x.question_id === qs[2].id);
  assert.equal(Number(r3.marks), 1);
  assert.equal(r3.mistake, 'Arithmetic slip');
  assert.equal(r3.redo, true);
  assert.deepEqual(r3.step_marks, [{ ok: true }, { ok: false }, { ok: false }]);
});

test('progress, messages and lessons', async () => {
  const p = data(await call('learner_progress'));
  assert.equal(p.learner, 'Anaya');
  assert.ok(p.this_week.assignments.length >= 1);
  await call('draft_message', { message: 'Nice work this week!' });
  const d = (await tutor.from('claude_drafts').select('*').eq('kind', 'message')).data[0];
  assert.equal(d.payload.body, 'Nice work this week!');
  await call('create_lesson', { title: 'Balancing equations', body: 'Do the same to both sides: $2x=8 \\Rightarrow x=4$', subject: 'Mathematics' });
  const l = (await tutor.from('lessons').select('*')).data[0];
  assert.equal(l.visibility, 'hidden');
  assert.equal((await learner.from('lessons').select('*')).data.length, 0);
  await assert.rejects(call('draft_message', { learner: 'Nobody', message: 'x' }), /No learner called/);
});

test('StudyBridge content tools: only the content account; made, checked without seeing the answers, then up for students', async () => {
  await assert.rejects(call('content_overview'), /only for StudyBridge’s own content account/);
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
  const server = createStudyBridgeServer({ url: srv.url, key: srv.anonKey, email: 'content@example.com', password: 'secret123' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const mc = new Client({ name: 'content', version: '1' });
  await mc.connect(b);
  const use = async (name, args = {}) => {
    const r = await mc.callTool({ name, arguments: args });
    if (r.isError) throw new Error(r.content[0].text);
    return r.content[0].text;
  };
  const prompts = (await mc.listPrompts()).prompts.map((p) => p.name);
  assert.ok(prompts.includes('make_subject') && prompts.includes('check_waiting'));

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
    /Saved “Practice paper 1 · Set A”.*1 wait/s,
  );
  const paperQ = JSON.parse(await use('questions_to_check')).questions[0];
  assert.equal(paperQ.kind, 'paper');
  assert.match(await use('submit_checks', { answers: [{ id: paperQ.id, kind: 'paper', value: '54' }] }), /1 passed/);
  assert.equal(JSON.parse(await use('content_overview', { subject: '0607' })).subjects[0].papers_live, 1);
  assert.equal(await use('questions_to_check'), 'Nothing is waiting for its check.');
  await mc.close();
});
