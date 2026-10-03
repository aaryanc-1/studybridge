// Runs supabase/setup.sql inside PGlite (real Postgres in WASM) with small
// stand-ins for Supabase's auth + storage schemas, then checks the security
// rules and every database function the app uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { STUBS } from './fake-supabase.mjs';

const SETUP = readFileSync(new URL('../supabase/setup.sql', import.meta.url), 'utf8');


let db;
const U = {};

async function as(user, sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [user ? U[user] : '']);
    await tx.exec(`set local role ${user ? 'authenticated' : 'anon'}`);
    const r = await tx.query(sql, params);
    return r.rows;
  });
}
const one = async (user, sql, params) => (await as(user, sql, params))[0];
const val = async (user, sql, params) => Object.values(await one(user, sql, params))[0];
async function fails(p, re) {
  await assert.rejects(p, (e) => (re ? re.test(e.message) : true));
}

test.before(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(STUBS);
  await db.exec(SETUP);
  await db.exec(SETUP); // safe to re-run
  for (const [k, email] of Object.entries({ T: 'tutor@x.com', L: 'sis@x.com', L2: 'other@x.com', T2: 'tutor2@x.com', X: 'nobody@x.com' })) {
    const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name: k }]);
    U[k] = r.rows[0].id;
  }
});

const S = {};

test('tutor setup, programmes, subjects, invites', async () => {
  const p = await one('T', `select * from become_tutor('Aaryan', 'America/New_York')`);
  assert.equal(p.role, 'tutor');
  assert.equal(p.status, 'active', 'the first tutor is approved straight away');
  assert.equal(await val('T', `select is_platform_admin()`), true, 'and is the StudyBridge admin');
  // Anyone else can sign up as a tutor, but waits for the admin
  const p2 = await one('T2', `select * from become_tutor('Other tutor')`);
  assert.equal(p2.status, 'pending');
  assert.equal(await val('T2', `select is_platform_admin()`), false);
  const told = await as('T', `select * from notifications where kind = 'tutor_signup'`);
  assert.equal(told.length, 1, 'admin is told about the new tutor');
  // A waiting tutor can't invite anyone
  await fails(as('T2', `insert into invites (name) values ('x')`), /row-level security/);
  await fails(as('L', `select set_allow_new_tutors(true)`), /admins only/);
  await fails(as('T', `update app_config set tutor_signups_open = false`), /permission denied/);
  await as('T', `select set_allow_new_tutors(false)`);
  await fails(as('X', `select become_tutor('x')`), /taking new tutors/);
  await as('T', `select admin_set_signups(true)`);
  // Admin approves the new tutor
  await fails(as('T2', `select admin_set_status($1, 'active')`, [U.T2]), /admins only/);
  await as('T', `select admin_set_status($1, 'active')`, [U.T2]);
  assert.equal(await val('T2', `select status from profiles where id = auth.uid()`), 'active');
  assert.equal((await as('T2', `select * from notifications where kind = 'approved'`)).length, 1);
  S.prog = await val('T', `insert into programmes (name) values ('IGCSE') returning id`);
  S.math = await val('T', `insert into subjects (programme_id, name) values ($1, 'Mathematics') returning id`, [S.prog]);
  S.phys = await val('T', `insert into subjects (programme_id, name) values ($1, 'Physics') returning id`, [S.prog]);
  S.alg = await val('T', `insert into topics (subject_id, name) values ($1, 'Algebra') returning id`, [S.math]);
  S.geo = await val('T', `insert into topics (subject_id, name) values ($1, 'Geometry') returning id`, [S.math]);
  const inv = await one('T', `insert into invites (name, programme_id, subject_ids) values ('Sister', $1, $2) returning code`, [S.prog, [S.math, S.phys]]);
  S.code = inv.code;
  assert.match(S.code, /^[0-9A-F]{10}$/);
  // Another tutor sees none of it
  assert.equal((await as('T2', `select * from subjects`)).length, 0);
  assert.equal((await as('T2', `select * from invites`)).length, 0);
  // Someone with no role can't create programmes for another tutor
  await fails(as('X', `insert into programmes (tutor_id, name) values ($1, 'x')`, [U.T]));
});

test('learner joins with an invite code', async () => {
  const p = await one('L', `select * from accept_invite($1, 'Sis', 'Africa/Lusaka')`, [S.code.toLowerCase()]);
  assert.equal(p.role, 'learner');
  assert.equal(p.tutor_id, U.T);
  assert.equal(p.display_name, 'Sis');
  assert.equal((await as('L', `select * from learner_subjects`)).length, 2);
  await fails(as('L2', `select accept_invite($1, 'x')`, [S.code]), /already been used/);
  await fails(as('L2', `select accept_invite('NOPE', 'x')`), /not valid/);
  await fails(as('T2', `select accept_invite($1, 'x')`, [S.code]));
  // second learner gets Physics only, via a fresh invite
  const code2 = await val('T', `insert into invites (name, subject_ids) values ('Other', $1) returning code`, [[S.phys]]);
  await as('L2', `select accept_invite($1, 'Other')`, [code2]);
  const n = await as('T', `select * from notifications where kind = 'joined'`);
  assert.equal(n.length, 2);
  // Learners see their tutor's structure but not the other tutor's, and not invites
  assert.equal((await as('L', `select * from subjects`)).length, 2);
  assert.equal((await as('L', `select * from invites`)).length, 0);
  // Tutor sees both learners; learner sees self + tutor only
  assert.equal((await as('T', `select * from profiles where role = 'learner'`)).length, 2);
  assert.deepEqual((await as('L', `select id from profiles order by id`)).map((r) => r.id).sort(), [U.T, U.L].sort());
  // Learner can rename themself but not change role or tutor
  await as('L', `update profiles set display_name = 'Sister' where id = auth.uid()`);
  await fails(as('L', `update profiles set role = 'tutor' where id = auth.uid()`), /permission denied/);
  await fails(as('L', `update profiles set tutor_id = $1 where id = auth.uid()`, [U.T2]), /permission denied/);
  // set_learner: tutor adjusts subjects
  await as('T', `select set_learner($1, 'Sis', $2, $3)`, [U.L, S.prog, [S.math, S.phys]]);
  await fails(as('T2', `select set_learner($1, 'x', null, '{}')`, [U.L]), /Not your learner/);
});

test('library visibility: hidden, visible, scheduled, audience', async () => {
  const ins = (name, vis, from, learners, subject = S.math) =>
    val('T', `insert into files (name, storage_path, visibility, visible_from, learner_ids, subject_id) values ($1, $2, $3, $4, $5, $6) returning id`,
      [name, `${U.T}/files/${name}`, vis, from, learners, subject]);
  S.fVisible = await ins('visible.pdf', 'visible', null, null);
  S.fHidden = await ins('hidden.pdf', 'hidden', null, null);
  await ins('future.pdf', 'scheduled', new Date(Date.now() + 86400e3).toISOString(), null);
  await ins('past.pdf', 'scheduled', new Date(Date.now() - 60e3).toISOString(), null);
  await ins('only-other.pdf', 'visible', null, [U.L2]);
  await ins('physics.pdf', 'visible', null, null, S.phys);
  const seen = (await as('L', `select name from files order by name`)).map((r) => r.name);
  assert.deepEqual(seen, ['past.pdf', 'physics.pdf', 'visible.pdf']);
  const seen2 = (await as('L2', `select name from files order by name`)).map((r) => r.name);
  assert.deepEqual(seen2, ['only-other.pdf', 'physics.pdf']); // L2 only has Physics
  assert.equal((await as('T', `select * from files`)).length, 6);
  assert.equal((await as('T2', `select * from files`)).length, 0);
  await fails(as('L', `insert into files (tutor_id, name, storage_path) values ($1, 'x', 'x')`, [U.T]));
  // lessons follow the same rules
  await as('T', `insert into lessons (title, visibility, subject_id) values ('Hidden lesson', 'hidden', $1), ('Quadratics', 'visible', $1)`, [S.math]);
  assert.deepEqual((await as('L', `select title from lessons`)).map((r) => r.title), ['Quadratics']);
});

test('past papers: kept on the tutor\'s computer until shared; links; exam subjects', async () => {
  const f = await one('T', `insert into files (name, storage_path, cloud, sha256, exam_board, exam_code, exam_year, exam_session, exam_kind, exam_paper)
    values ('0607_s23_qp_41.pdf', 'local/x/abc.pdf', false, 'abc', 'cie', '0607', 2023, 's', 'qp', '41') returning *`);
  assert.equal(f.visibility, 'hidden');
  // A paper that only lives on the tutor's computer can't be shown to learners
  await fails(as('T', `update files set visibility = 'visible' where id = $1`, [f.id]), /files_local_hidden/);
  await as('T', `update files set storage_path = $2, cloud = true, visibility = 'visible', subject_id = $3 where id = $1`, [f.id, `${U.T}/files/p.pdf`, S.math]);
  assert.equal((await as('L', `select * from files where id = $1`, [f.id])).length, 1, 'shared papers reach learners like any file');
  assert.equal((await as('T2', `select * from files where id = $1`, [f.id])).length, 0, 'never another tutor');
  // Links must be web addresses
  await fails(as('T', `insert into files (name, storage_path, link_url) values ('x', 'link/a/b', 'javascript:alert(1)')`), /files_link_http/);
  const l = await one('T', `insert into files (name, storage_path, link_url, exam_board, exam_code) values ('x', 'link/a/c', 'https://example.org/p.pdf', 'cie', '0607') returning *`);
  assert.equal(l.visibility, 'hidden');
  // Pinned exam subjects
  await as('T', `insert into tutor_settings (tutor_id, exam_subjects) values (auth.uid(), '{cie:0607}')
    on conflict (tutor_id) do update set exam_subjects = excluded.exam_subjects`);
  assert.deepEqual(await val('T', `select exam_subjects from tutor_settings where tutor_id = auth.uid()`), ['cie:0607']);
  await as('T', `delete from files where id = any($1)`, [[f.id, l.id]]);
});

test('storage rules for PDFs and learner work', async () => {
  await as('T', `insert into storage.objects (bucket_id, name) values ('library', $1), ('library', $2), ('library', $3)`,
    [`${U.T}/files/visible.pdf`, `${U.T}/files/hidden.pdf`, `${U.T}/questions/q1.png`]);
  await fails(as('T', `insert into storage.objects (bucket_id, name) values ('library', $1)`, [`${U.T2}/files/x.pdf`]));
  const names = (await as('L', `select name from storage.objects where bucket_id = 'library' order by name`)).map((r) => r.name);
  assert.deepEqual(names, [`${U.T}/files/visible.pdf`, `${U.T}/questions/q1.png`]);
  await fails(as('L', `insert into storage.objects (bucket_id, name) values ('library', $1)`, [`${U.T}/files/sneaky.pdf`]));
  await as('L', `insert into storage.objects (bucket_id, name) values ('work', $1)`, [`${U.L}/a1/q1.png`]);
  await fails(as('L', `insert into storage.objects (bucket_id, name) values ('work', $1)`, [`${U.L2}/a1/q1.png`]));
  assert.equal((await as('T', `select * from storage.objects where bucket_id = 'work'`)).length, 1);
  assert.equal((await as('T2', `select * from storage.objects where bucket_id = 'work'`)).length, 0);
  assert.equal((await as('L2', `select * from storage.objects`)).length, 1); // only the question image
  await as('T', `insert into storage.objects (bucket_id, name) values ('work', $1)`, [`${U.L}/a1/q1-marked.png`]);
});

test('assignments: drafts hidden, keys hidden, exams need the desktop app', async () => {
  S.hw = await val('T', `insert into assignments (kind, title, subject_id, topic_id, visibility, due_at)
    values ('homework', 'Algebra HW 1', $1, $2, 'visible', now() + interval '2 days') returning id`, [S.math, S.alg]);
  S.q1 = await val('T', `insert into questions (assignment_id, position, type, prompt_md, options, marks) values ($1, 1, 'mcq', '2+2?', '["3","4","5"]', 1) returning id`, [S.hw]);
  S.q2 = await val('T', `insert into questions (assignment_id, position, type, prompt_md, marks, topic_id) values ($1, 2, 'numeric', '25/2', 2, $2) returning id`, [S.hw, S.geo]);
  S.q3 = await val('T', `insert into questions (assignment_id, position, type, prompt_md, marks) values ($1, 3, 'steps', 'Solve 2x+3=7', 3) returning id`, [S.hw]);
  await as('T', `insert into question_keys (question_id, answer, solution_md) values ($1, '{"choice":"1"}', 'four'), ($2, '{"value":"12.5","tolerance":"0.01"}', null), ($3, '{}', 'x = 2')`, [S.q1, S.q2, S.q3]);

  await as('T', `insert into assignments (title, visibility, draft, source) values ('Claude draft', 'visible', true, 'claude')`);
  S.exam = await val('T', `insert into assignments (kind, title, visibility, lockdown, camera, time_limit_min, subject_id)
    values ('exam', 'Mock exam', 'visible', true, true, 60, $1) returning id`, [S.math]);
  await as('T', `insert into questions (assignment_id, type, prompt_md) values ($1, 'short', 'Exam Q')`, [S.exam]);

  const told = (await as('L', `select title from notifications where kind = 'assignment' order by title`)).map((r) => r.title);
  assert.deepEqual(told, ['New exam: Mock exam', 'New homework: Algebra HW 1'], 'learner told about new visible work, not drafts');
  assert.equal((await as('L2', `select * from notifications where kind = 'assignment'`)).length, 0, 'L2 does not take Maths');
  const titles = (await as('L', `select title from assignments order by title`)).map((r) => r.title);
  assert.deepEqual(titles, ['Algebra HW 1', 'Mock exam']);
  assert.equal((await as('L2', `select * from assignments`)).length, 0); // L2 has no Maths
  assert.equal((await as('L', `select * from questions where assignment_id = $1`, [S.hw])).length, 3);
  assert.equal((await as('L', `select * from questions where assignment_id = $1`, [S.exam])).length, 0, 'exam questions hidden before start');
  assert.equal((await as('L', `select * from question_keys`)).length, 0);
  await fails(as('L', `select start_attempt($1, 'web')`, [S.exam]), /desktop app/);
  await as('L', `select start_attempt($1, 'desktop')`, [S.exam]);
  assert.equal((await as('L', `select * from questions where assignment_id = $1`, [S.exam])).length, 1, 'exam questions visible once started');
  assert.equal((await as('L', `update assignments set lockdown = false where id = $1 returning id`, [S.exam])).length, 0);
  const still = await val('T', `select lockdown from assignments where id = $1`, [S.exam]);
  assert.equal(still, true);
});

test('doing homework: save, submit, auto-mark, hidden until released', async () => {
  const t = await one('L', `select * from start_attempt($1)`, [S.hw]);
  S.att = t.id;
  assert.equal(Number(t.max_score), 6);
  const again = await one('L', `select * from start_attempt($1)`, [S.hw]);
  assert.equal(again.id, t.id, 'resumes the open attempt');
  await as('L', `select save_response($1, $2, '{"choice":"1"}')`, [S.att, S.q1]);
  await as('L', `select save_response($1, $2, '{"value":"12.50"}')`, [S.att, S.q2]);
  await as('L', `select save_response($1, $2, $3)`, [S.att, S.q3, { steps: ['2x+3=7', '2x=4', 'x=2'] }]);
  await fails(as('L2', `select save_response($1, $2, '{}')`, [S.att, S.q1]), /not found/);
  // learners can't read or change attempts/responses directly
  assert.equal((await as('L', `select * from attempts`)).length, 0);
  assert.equal((await as('L', `update responses set marks = 99 returning id`)).length, 0);

  const sub = await one('L', `select * from submit_attempt($1)`, [S.att]);
  assert.equal(sub.status, 'submitted', 'steps question still needs the tutor');
  await fails(as('L', `select save_response($1, $2, '{"choice":"0"}')`, [S.att, S.q1]), /already been submitted/);
  const n = await as('T', `select * from notifications where kind = 'submitted'`);
  assert.equal(n.length, 1);
  assert.match(n[0].title, /Sis submitted Algebra HW 1/);

  const d = await val('L', `select attempt_detail($1)`, [S.att]);
  assert.equal(d.attempt.released, false);
  assert.equal(d.attempt.score, null);
  assert.ok(d.responses.every((r) => r.marks === null), 'marks hidden before release');
  assert.deepEqual(d.keys, []);
  const dt = await val('T', `select attempt_detail($1)`, [S.att]);
  assert.equal(dt.responses.find((r) => r.question_id === S.q1).marks, 1);
  assert.equal(dt.responses.find((r) => r.question_id === S.q2).marks, 2);
  assert.equal(dt.keys.length, 3);
});

test('tutor marks, releases, sends back for redo', async () => {
  await as('T', `update responses set marks = 2, mistake = 'Dropped a sign', feedback_md = 'Check line 2', step_marks = '[{"step":1,"ok":true},{"step":2,"ok":false}]'
                 where attempt_id = $1 and question_id = $2`, [S.att, S.q3]);
  const f = await one('T', `select * from finish_marking($1, true, 'Good work')`, [S.att]);
  assert.equal(f.status, 'marked');
  assert.equal(Number(f.score), 5);
  const d = await val('L', `select attempt_detail($1)`, [S.att]);
  assert.equal(d.attempt.score, 5);
  assert.equal(d.attempt.feedback_md, 'Good work');
  assert.equal(d.responses.find((r) => r.question_id === S.q3).mistake, 'Dropped a sign');
  assert.deepEqual(d.keys, [], 'answers not shown unless the tutor allows it');
  const mine = await val('L', `select my_attempts($1)`, [S.hw]);
  assert.equal(mine[0].score, 5);
  assert.equal((await as('L', `select * from notifications where kind = 'marked'`)).length, 1);

  // redo question 3
  await as('T', `update responses set redo = true where attempt_id = $1 and question_id = $2`, [S.att, S.q3]);
  const r = await one('T', `select * from finish_marking($1, false)`, [S.att]);
  assert.equal(r.status, 'returned');
  const back = await one('L', `select * from start_attempt($1)`, [S.hw]);
  assert.equal(back.id, S.att);
  assert.equal(back.status, 'in_progress');
  await fails(as('L', `select save_response($1, $2, '{"choice":"0"}')`, [S.att, S.q1]), /redo/);
  await as('L', `select save_response($1, $2, $3)`, [S.att, S.q3, { steps: ['2x=4', 'x=2'] }]);
  const re = await one('L', `select * from submit_attempt($1)`, [S.att]);
  assert.equal(re.status, 'submitted');
  const dt = await val('T', `select attempt_detail($1)`, [S.att]);
  const q3 = dt.responses.find((x) => x.question_id === S.q3);
  assert.equal(q3.marks, null, 'redo answer waits for marking again');
  assert.equal(q3.redo, false);
  assert.equal(dt.responses.find((x) => x.question_id === S.q1).marks, 1, 'other marks kept');
  assert.match((await as('T', `select title from notifications where kind = 'submitted' order by created_at desc limit 1`))[0].title, /resubmitted/);
  await as('T', `update responses set marks = 3, mistake = null where attempt_id = $1 and question_id = $2`, [S.att, S.q3]);
  const fin = await one('T', `select * from finish_marking($1, true)`, [S.att]);
  assert.equal(Number(fin.score), 6);
  await fails(as('L', `select start_attempt($1)`, [S.hw]), /used all your attempts/);
});

test('quiz released on submit, answers shown when allowed', async () => {
  const qz = await val('T', `insert into assignments (kind, title, visibility, release_mode, show_answers, subject_id, topic_id)
     values ('quiz', 'Quick quiz', 'visible', 'on_submit', true, $1, $2) returning id`, [S.math, S.alg]);
  const q = await val('T', `insert into questions (assignment_id, type, options, marks) values ($1, 'mcq', '["a","b"]', 1) returning id`, [qz]);
  await as('T', `insert into question_keys (question_id, answer, solution_md) values ($1, '{"choice":"0"}', 'It is a')`, [q]);
  const t = await one('L', `select * from start_attempt($1)`, [qz]);
  await as('L', `select save_response($1, $2, '{"choice":"1"}')`, [t.id, q]);
  const s = await one('L', `select * from submit_attempt($1)`, [t.id]);
  assert.equal(s.status, 'marked');
  const d = await val('L', `select attempt_detail($1)`, [t.id]);
  assert.equal(d.attempt.score, 0);
  assert.equal(d.keys[0].solution_md, 'It is a');
});

test('practice: any number of tries, marked instantly, the tutor isn\'t pinged; learners never read the bank', async () => {
  const pr = await val('T', `insert into assignments (kind, title, practice, visibility, release_mode, show_answers, max_attempts, learner_ids)
     values ('quiz', 'Practice: Number', true, 'visible', 'on_submit', true, 50, $1) returning id`, [[U.L]]);
  const q = await val('T', `insert into questions (assignment_id, type, marks) values ($1, 'numeric', 1) returning id`, [pr]);
  await as('T', `insert into question_keys (question_id, answer) values ($1, '{"value":"21","tolerance":"0"}')`, [q]);
  const before = (await as('T', `select id from notifications where kind = 'submitted'`)).length;
  for (const [ans, score] of [['20', 0], ['21', 1]]) {
    const t = await one('L', `select * from start_attempt($1)`, [pr]);
    await as('L', `select save_response($1, $2, $3)`, [t.id, q, { value: ans }]);
    const s = await one('L', `select * from submit_attempt($1)`, [t.id]);
    assert.equal(s.status, 'marked');
    assert.equal(Number(s.score), score);
    assert.equal(s.released, true);
  }
  assert.equal((await as('T', `select id from notifications where kind = 'submitted'`)).length, before, 'no ping per practice try');
  // the bank holds answers: learners can't read it, even shared questions
  await as('T', `insert into bank_questions (owner_id, type, prompt_md, answer) values (auth.uid(), 'numeric', 'x', '{"value":"1"}')`);
  assert.equal((await as('L', `select id from bank_questions`)).length, 0);
  await fails(as('L', `insert into bank_questions (owner_id, type, prompt_md) values (auth.uid(), 'numeric', 'x')`), /row-level security/);
  await as('T', `delete from assignments where id = $1`, [pr]);
});

test('time, lockdown events, progress and summaries', async () => {
  await as('L', `select log_time('assignment', $1, 500)`, [S.att]);
  await as('L', `select log_time('file', $1, 60)`, [S.fVisible]);
  await as('L', `select log_time('assignment', $1, 30)`, [S.att]); // not hers? it is hers
  await as('L2', `select log_time('assignment', $1, 30)`, [S.att]); // not L2's: ignored
  const spent = await val('T', `select time_spent_sec from attempts where id = $1`, [S.att]);
  assert.equal(spent, 150);
  assert.equal((await as('L2', `select * from activity`)).length, 0);

  const ex = await val('T', `select id from attempts where assignment_id = $1`, [S.exam]);
  await as('L', `select log_lockdown_event($1, 'Left the exam window')`, [ex]);
  assert.equal((await as('T', `select * from notifications where kind = 'lockdown'`)).length, 1);
  const detailL = await val('L', `select attempt_detail($1)`, [ex]);
  assert.deepEqual(detailL.attempt.lockdown_events, []);

  const prog = await val('T', `select learner_progress($1)`, [U.L]);
  const alg = prog.topics.find((x) => x.topic === 'Algebra');
  const geo = prog.topics.find((x) => x.topic === 'Geometry');
  assert.ok(alg && geo);
  assert.equal(geo.strength, 'strong');
  assert.equal(prog.total_seconds, 210);
  assert.equal(prog.time_by_subject[0].subject, 'Mathematics');
  await fails(as('T2', `select learner_progress($1)`, [U.L]), /Not allowed/);
  await fails(as('L2', `select learner_progress($1)`, [U.L]), /Not allowed/);
  const own = await val('L', `select learner_progress($1)`, [U.L]);
  assert.ok(own.topics.length >= 2);

  const sum = await val('T', `select learner_summary($1, now() - interval '7 days', now() + interval '1 minute')`, [U.L]);
  assert.equal(sum.seconds, 210);
  assert.ok(sum.assignments.length >= 2);
  assert.equal(sum.by_day.length, 1);
});

test('weekly parent reports: the learner switches them on; drafts; sent only when on; learner sees what was sent', async () => {
  await fails(as('T', `select set_parent_reports(true, 'Mum', '+260971234567')`), /Only learners/);
  await fails(as('L', `select set_parent_reports(true, 'Mum')`), /WhatsApp number or email/);
  await fails(as('L', `select set_parent_reports(true, 'Mum', '12')`), /doesn’t look right/);
  await fails(as('L', `insert into learner_reports (learner_id, tutor_id, enabled) values (auth.uid(), $1, true)`, [U.T]), /permission denied/);
  await as('T', `select set_learner_exam($1, 'IGCSE 0607', '2027-05-01')`, [U.L]);
  await fails(as('T2', `select set_learner_exam($1, 'x', '2027-05-01')`, [U.L]), /Not your learner/);
  // a draft can be written while reports are off, but not sent
  const from = '2026-09-28T00:00:00Z', to = '2026-10-05T00:00:00Z';
  const nums = await val('T', `select report_numbers($1, $2, $3)`, [U.L, from, to]);
  assert.equal(nums.exam.name, 'IGCSE 0607');
  assert.ok(Array.isArray(nums.work) && Array.isArray(nums.topics) && 'avg_pct' in nums);
  await fails(as('T2', `select report_numbers($1, $2, $3)`, [U.L, from, to]), /Not your learner/);
  const r = await one('T', `insert into parent_reports (learner_id, week_start, data, summary) values ($1, '2026-09-28', $2, 'A good week') returning *`, [U.L, nums]);
  await fails(as('T', `update parent_reports set status = 'sent' where id = $1`, [r.id]), /row-level security/);
  assert.equal((await as('L', `select * from parent_reports`)).length, 0, 'drafts are the tutor’s');
  const on = await one('L', `select * from set_parent_reports(true, 'Mum', '+260 97 123 4567', 'mum@example.com')`);
  assert.equal(on.parent_phone, '+260971234567');
  assert.equal(on.exam_name, 'IGCSE 0607', 'the tutor’s exam date is kept');
  assert.equal((await as('T', `select * from notifications where kind = 'reports_on'`)).length, 1);
  assert.equal((await one('T', `select parent_name from learner_reports where learner_id = $1`, [U.L])).parent_name, 'Mum');
  await as('T', `update parent_reports set status = 'sent', sent_at = now(), sent_via = 'whatsapp' where id = $1`, [r.id]);
  assert.equal((await as('L', `select * from parent_reports`)).length, 1, 'the learner sees what was sent');
  assert.equal((await as('T2', `select * from parent_reports`)).length, 0);
  await as('L', `select set_parent_reports(false)`);
  await as('T', `delete from parent_reports where id = $1`, [r.id]);
});

test('notes and messages notify instantly; read receipts', async () => {
  const c = await val('L', `insert into comments (tutor_id, learner_id, assignment_id, question_id, body)
     values ($1, $2, $3, $4, 'I am stuck on Q3') returning id`, [U.T, U.L, S.hw, S.q3]);
  const n = await as('T', `select * from notifications where kind = 'note'`);
  assert.equal(n.length, 1);
  assert.match(n[0].title, /Sis · Algebra HW 1/);
  await fails(as('L', `insert into comments (tutor_id, learner_id, body) values ($1, $2, 'x')`, [U.T2, U.L]));
  await fails(as('L', `insert into comments (tutor_id, learner_id, body) values ($1, $2, 'x')`, [U.T, U.L2]));
  await as('T', `insert into comments (tutor_id, learner_id, body) values ($1, $2, 'Look at step 2')`, [U.T, U.L]);
  assert.equal((await as('L', `select * from notifications where kind = 'message'`)).length, 1);
  assert.equal((await as('L2', `select * from comments`)).length, 0);
  await as('T', `select mark_comments_read($1)`, [[c]]);
  assert.ok(await val('T', `select read_at from comments where id = $1`, [c]));
  // learner can't edit tutor's messages
  assert.equal((await as('L', `update comments set body = 'hacked' returning id`)).length, 0);
  // notifications: each person only sees their own
  const all = await as('L', `select distinct user_id from notifications`);
  assert.deepEqual(all.map((r) => r.user_id), [U.L]);
});

test('Claude drafts reach the learner only when applied', async () => {
  const d = await val('T', `insert into claude_drafts (kind, learner_id, attempt_id, payload) values ('marking', $1, $2, $3) returning id`,
    [U.L, S.att, { marks: [{ question_id: S.q3, marks: 2.5, feedback_md: 'Nearly', mistake: 'Arithmetic slip' }], feedback_md: 'From Claude' }]);
  assert.equal((await as('L', `select * from claude_drafts`)).length, 0);
  await fails(as('T2', `select apply_draft($1)`, [d]), /not found/);
  await as('T', `select apply_draft($1)`, [d]);
  const r = await one('T', `select marks, mistake from responses where attempt_id = $1 and question_id = $2`, [S.att, S.q3]);
  assert.equal(Number(r.marks), 2.5);
  assert.equal(r.mistake, 'Arithmetic slip');
  await fails(as('T', `select apply_draft($1)`, [d]), /not found/, 'applies once');
  const m = await val('T', `insert into claude_drafts (kind, learner_id, payload) values ('message', $1, '{"body":"Well done this week"}') returning id`, [U.L]);
  await as('T', `select apply_draft($1, '{"body":"Well done this week!"}')`, [m]);
  assert.ok((await as('L', `select body from comments`)).some((x) => x.body === 'Well done this week!'));
});

test('live video passes are signed in the database', async () => {
  await fails(as('L', `select set_live_keys('wss://x', 'k', 's')`), /Tutors only/);
  assert.equal((await val('L', `select live_status()`)).configured, false);
  await as('T', `select set_live_keys('wss://demo.livekit.cloud', 'APIkey123', 'supersecret')`);
  await fails(as('T', `select * from tutor_secrets`), /permission denied/);
  await fails(as('L', `select * from tutor_secrets`), /permission denied/);
  await fails(as(null, `select * from tutor_secrets`), /permission denied/);
  assert.equal((await val('L', `select live_status()`)).configured, true);
  // updating URL/key without a secret keeps the saved secret
  await as('T', `select set_live_keys('wss://demo.livekit.cloud', 'APIkey123', '')`);

  const ses = await val('T', `insert into sessions (title, starts_at, learner_ids) values ('Algebra live', now() + interval '1 hour', $1) returning id`, [[U.L]]);
  assert.equal((await as('L', `select * from notifications where kind = 'session'`)).length, 1);
  assert.equal((await as('L', `select * from sessions`)).length, 1);
  assert.equal((await as('L2', `select * from sessions`)).length, 0);
  await fails(as('L2', `select live_pass($1)`, [`session-${ses}`]), /not part/);
  await fails(as('L', `select live_pass('garbage')`), /Unknown room|not part/);

  const verify = (tok) => {
    const [h, b, sig] = tok.split('.');
    const expect = crypto.createHmac('sha256', 'supersecret').update(`${h}.${b}`).digest('base64url');
    assert.equal(sig, expect, 'signature matches LiveKit secret');
    return JSON.parse(Buffer.from(b, 'base64url').toString());
  };
  const p = await val('L', `select live_pass($1)`, [`session-${ses}`]);
  assert.equal(p.url, 'wss://demo.livekit.cloud');
  const claims = verify(p.token);
  assert.equal(claims.iss, 'APIkey123');
  assert.equal(claims.sub, U.L);
  assert.equal(claims.video.room, `session-${ses}`);
  assert.equal(claims.video.canPublish, true);
  assert.ok(claims.exp > Date.now() / 1000);

  const ex = await val('T', `select id from attempts where assignment_id = $1`, [S.exam]);
  const learnerCam = verify((await val('L', `select live_pass($1)`, [`attempt-${ex}`])).token);
  assert.equal(learnerCam.video.canPublish, true);
  const tutorWatch = verify((await val('T', `select live_pass($1)`, [`attempt-${ex}`])).token);
  assert.equal(tutorWatch.video.room, `attempt-${ex}`, 'tutor can watch the exam camera');
  await fails(as('L2', `select live_pass($1)`, [`attempt-${ex}`]), /not part/);
});

test('anonymous visitors see nothing and can not call internals', async () => {
  for (const t of ['profiles', 'subjects', 'files', 'assignments', 'questions', 'comments', 'notifications']) {
    assert.equal((await as(null, `select * from ${t}`)).length, 0, t);
  }
  await fails(as(null, `select notify_user($1, 'x', 'x', 'x')`, [U.T]), /permission denied/);
  await fails(as('L', `select notify_user($1, 'x', 'x', 'x')`, [U.T]), /permission denied/);
  await fails(as(null, `select become_tutor('x')`), /Not signed in/);
});

test('tutor admin: accounts, password reset, delete account', async () => {
  const accts = await as('T', `select * from learner_accounts()`);
  assert.deepEqual(accts.map((a) => a.email).sort(), ['other@x.com', 'sis@x.com']);
  assert.equal((await as('T2', `select * from learner_accounts()`)).length, 0, 'other tutors see none');
  assert.equal((await as('L', `select * from learner_accounts()`)).length, 0, 'learners see none');
  await as('T', `select set_learner_password($1, 'NewPass1#')`, [U.L]);
  const ok = await db.query(`select encrypted_password = extensions.crypt('NewPass1#', encrypted_password) as ok from auth.users where id = $1`, [U.L]);
  assert.equal(ok.rows[0].ok, true);
  await fails(as('T', `select set_learner_password($1, '123')`, [U.L]), /at least 6/);
  await fails(as('T2', `select set_learner_password($1, 'Hacked123')`, [U.L]), /Not your learner/);
  await fails(as('L', `select set_learner_password($1, 'Hacked123')`, [U.L2]), /Not your learner/);
  const paths = await val('T', `select learner_work_paths($1)`, [U.L]);
  assert.ok(Array.isArray(paths));
  await fails(as('T2', `select delete_learner_account($1)`, [U.L2]), /Not your learner/);
});

async function asService(sql, params = []) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', '', true)`);
    await tx.exec(`set local role service_role`);
    return (await tx.query(sql, params)).rows;
  });
}

test('StudyBridge admin: accounts and access, never anyone’s work', async () => {
  // The other tutor has their own work
  const subj = await val('T2', `insert into subjects (name) values ('Chemistry') returning id`);
  await as('T2', `insert into assignments (title, subject_id) values ('T2 secret quiz', $1)`, [subj]);
  const tutors = await val('T', `select admin_tutors()`);
  assert.deepEqual(tutors.map((t) => t.email).sort(), ['tutor2@x.com', 'tutor@x.com']);
  const t2 = tutors.find((t) => t.email === 'tutor2@x.com');
  assert.equal(t2.status, 'active');
  assert.equal(t2.learners, 0);
  assert.ok('ai_cents' in t2 && 'storage_bytes' in t2);
  await fails(as('T2', `select admin_tutors()`), /admins only/);
  await fails(as('L', `select admin_accounts($1)`, [U.T]), /admins only/);
  const mine = await val('T', `select admin_accounts($1)`, [U.T]);
  assert.deepEqual(mine.map((a) => a.email).sort(), ['other@x.com', 'sis@x.com']);
  // ...but none of the other tutor's content
  assert.equal((await as('T', `select * from subjects where tutor_id = $1`, [U.T2])).length, 0);
  assert.equal((await as('T', `select * from assignments where tutor_id = $1`, [U.T2])).length, 0);
  await fails(as('T', `select * from platform_secrets`), /permission denied/);
  await fails(as('T', `select * from platform_admins`), /permission denied/);
  // Plans, passwords, pausing
  await as('T', `select admin_set_plan($1, 'Pro', 2500)`, [U.T2]);
  assert.equal((await val('T', `select admin_tutors()`)).find((t) => t.id === U.T2).ai_limit_cents, 2500);
  await as('T', `select admin_set_password($1, 'Reset-Pass-1')`, [U.T2]);
  assert.equal((await db.query(`select encrypted_password = extensions.crypt('Reset-Pass-1', encrypted_password) ok from auth.users where id = $1`, [U.T2])).rows[0].ok, true);
  await fails(as('T2', `select admin_set_password($1, 'Hacked-123')`, [U.T]), /admins only/);
  await fails(as('T', `select admin_set_status($1, 'suspended')`, [U.T]), /own account/);
  await as('T', `select admin_set_status($1, 'suspended')`, [U.T2]);
  const banned = (await db.query(`select banned_until from auth.users where id = $1`, [U.T2])).rows[0].banned_until;
  assert.ok(banned && new Date(banned) > new Date(Date.now() + 365 * 86400000), 'paused tutor can’t sign in');
  await fails(as('T2', `insert into invites (name) values ('x')`), /row-level security/);
  await as('T', `select admin_set_status($1, 'active')`, [U.T2]);
  assert.equal((await db.query(`select banned_until from auth.users where id = $1`, [U.T2])).rows[0].banned_until, null);
  // Shared live video for tutors without their own LiveKit keys
  assert.equal((await val('T2', `select live_status()`)).configured, false);
  await fails(as('T2', `select admin_set_livekit('wss://x.livekit.cloud', 'k', 's')`), /admins only/);
  await as('T', `select admin_set_livekit('wss://shared.livekit.cloud', 'APIshared', 'shared-secret')`);
  const ls2 = await val('T2', `select live_status()`);
  assert.equal(ls2.configured && ls2.shared && !ls2.own, true);
  assert.equal(ls2.url, 'wss://shared.livekit.cloud');
  // Prof key is write-only
  await fails(as('T', `select admin_set_prof('not-a-key')`), /Claude API key/);
  await as('T', `select admin_set_prof('sk-ant-test-key', 'claude-sonnet-5-5', 500)`);
  const st = await val('T', `select admin_settings()`);
  assert.equal(st.prof_key_set, true);
  assert.ok(!JSON.stringify(st).includes('sk-ant'), 'the key is never sent back');
  // The log: admin sees it all, the tutor sees what was done to them, learners nothing
  const log = await as('T', `select action from admin_log where user_id = $1 order by id`, [U.T2]);
  assert.deepEqual(log.map((r) => r.action), ['approved', 'plan', 'password_reset', 'paused', 'switched_on']);
  assert.equal((await as('T2', `select * from admin_log`)).length, 5);
  assert.equal((await as('L', `select * from admin_log`)).length, 0);
  // Unfinished sign-ups show up; deleting a tutor takes their learners too
  assert.ok((await val('T', `select admin_accounts(null)`)).some((a) => a.email === 'nobody@x.com'));
  const code = await val('T2', `insert into invites (name) values ('Nobody') returning code`);
  await as('X', `select accept_invite($1, 'Nobody')`, [code]);
  await fails(as('T', `select admin_delete_account($1)`, [U.T]), /own account/);
  assert.equal((await val('T', `select admin_delete_account($1)`, [U.T2])).deleted, 2);
  assert.equal((await db.query(`select count(*)::int n from auth.users where id = any($1)`, [[U.T2, U.X]])).rows[0].n, 0);
  assert.equal((await db.query(`select count(*)::int n from public.assignments where title = 'T2 secret quiz'`)).rows[0].n, 0);
  assert.equal((await as('T', `select * from admin_log where action = 'deleted'`)).length, 1);
});

test('Prof: asking, limits, auto-marking, weekly work, drafts only', async () => {
  // Learners can't use Prof; the tutor can, within their allowance
  await fails(as('L', `select prof_ask('make a quiz')`), /approved tutors/);
  await fails(as('T', `select prof_ask('make a quiz', $1)`, [{ pages: [{ path: `${U.L}/prof/x.jpg` }] }]), /Unknown page/);
  const j = await val('T', `select prof_ask('Make a 5 question quiz on algebra for Sis', $1)`, [{ learner_ids: [U.L], pages: [{ path: `${U.T}/prof/p1.jpg`, label: 'Book p.12' }] }]);
  assert.ok(j.id);
  await fails(as('T', `insert into prof_jobs (tutor_id, prompt, kind) values (auth.uid(), 'x', 'ask')`), /permission denied/);
  assert.equal((await as('T', `select * from prof_jobs`)).length, 1);
  assert.equal((await as('L', `select * from prof_jobs`)).length, 0);
  const u = await val('T', `select prof_usage()`);
  assert.equal(u.ready, true);
  assert.equal(u.limit_cents, 500);
  // Only the server can claim and run jobs
  await fails(as('T', `select * from prof_claim()`), /permission denied/);
  const claimed = await asService(`select * from prof_claim()`);
  assert.equal(claimed[0].id, j.id);
  assert.equal((await asService(`select * from prof_claim()`)).length, 0, 'a running job isn’t taken twice');
  const ctx = (await asService(`select prof_context($1) c`, [U.T]))[0].c;
  assert.ok(ctx.subjects.length >= 2 && ctx.learners.some((l) => l.id === U.L));
  assert.ok(Array.isArray(ctx.learners[0].topics_needing_work));
  // Drafts only, even with the server key
  await fails(asService(`insert into assignments (tutor_id, title, draft) values ($1, 'Live!', false)`, [U.T]), /only save drafts/);
  const aid = (await asService(`insert into assignments (tutor_id, title, draft, visibility, source) values ($1, 'Prof quiz', true, 'visible', 'prof') returning id`, [U.T]))[0].id;
  const qid = (await asService(`insert into questions (tutor_id, assignment_id, type, prompt_md) values ($1, $2, 'short', 'Explain') returning id`, [U.T, aid]))[0].id;
  await asService(`insert into question_keys (tutor_id, question_id, answer) values ($1, $2, '{}')`, [U.T, qid]);
  await fails(asService(`update assignments set draft = false where id = $1`, [aid]), /only save drafts/);
  await fails(asService(`update responses set marks = 99`), /can’t change marks/);
  await fails(asService(`insert into comments (tutor_id, learner_id, author_id, body) values ($1, $2, $1, 'hi')`, [U.T, U.L]), /can’t change marks or send/);
  assert.equal((await as('L', `select * from assignments where id = $1`, [aid])).length, 0, 'learner can’t see the draft');
  await asService(`select prof_save($1, 'done', null, $2, 'Finished', null, 1000, 500, 0.7, 'claude-sonnet-5-5', null, $3)`,
    [j.id, { assignment_ids: [aid] }, { title: 'Prof made: Prof quiz', body: 'Review it', ref: { assignment_id: aid } }]);
  const done = await one('T', `select * from prof_jobs where id = $1`, [j.id]);
  assert.equal(done.status, 'done');
  assert.equal(Number(done.cost_cents), 0.7);
  assert.equal((await as('T', `select * from notifications where kind = 'prof'`)).length, 1);
  // Tutor approves it: now the learner sees it
  await as('T', `update assignments set draft = false, learner_ids = $2 where id = $1`, [aid, [U.L]]);
  assert.equal((await as('L', `select * from assignments where id = $1`, [aid])).length, 1);
  // Auto-marking when a learner hands in
  await as('T', `insert into prof_settings (tutor_id, auto_mark) values (auth.uid(), true)`);
  const t = await one('L', `select * from start_attempt($1, 'desktop')`, [aid]);
  await as('L', `select save_response($1, $2, '{"text":"Because"}')`, [t.id, qid]);
  await as('L', `select submit_attempt($1)`, [t.id]);
  const mark = await one('T', `select * from prof_jobs where kind = 'mark'`);
  assert.equal(mark.attempt_id, t.id);
  const mc = (await asService(`select prof_mark_context($1) c`, [t.id]))[0].c;
  assert.equal(mc.questions[0].learner_answer.text, 'Because');
  assert.equal(mc.learner, 'Sis');
  // Over the allowance: no more Prof this month
  await asService(`select prof_save($1, 'done', null, null, null, null, 1, 1, 600)`, [mark.id]);
  await fails(as('T', `select prof_ask('another quiz please')`), /allowance/);
  await as('T', `select admin_set_plan($1, 'free', 100000)`, [U.T]);
  // Weekly auto-created work: one job per learner, once a week
  const dow = await val('T', `select extract(dow from now() at time zone 'America/New_York')::int`);
  await as('T', `update prof_settings set auto_create = true, auto_day = $1, auto_hour = 0`, [dow]);
  await asService(`select prof_tick()`);
  await asService(`select prof_tick()`);
  const auto = await as('T', `select * from prof_jobs where kind = 'auto'`);
  assert.equal(auto.length, 2, 'one for each learner, only once');
  assert.match(auto[0].prompt, /next week/);
});

test('removing a learner cuts access', async () => {
  await as('T', `select remove_learner($1)`, [U.L2]);
  assert.equal((await as('L2', `select * from subjects`)).length, 0);
  assert.equal((await as('L2', `select * from files`)).length, 0);
  // Deleting an account removes the person and all their records
  await as('T', `select delete_learner_account($1)`, [U.L]);
  assert.equal((await db.query(`select count(*)::int n from auth.users where id = $1`, [U.L])).rows[0].n, 0);
  assert.equal((await db.query(`select count(*)::int n from public.attempts where learner_id = $1`, [U.L])).rows[0].n, 0);
  assert.equal((await db.query(`select count(*)::int n from public.comments where learner_id = $1`, [U.L])).rows[0].n, 0);
  assert.equal((await db.query(`select count(*)::int n from public.profiles where id = $1`, [U.T])).rows[0].n, 1, 'tutor untouched');
});
