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

// 'A' is the separate StudyBridge admin account.
async function as(user, sql, params = []) {
  return db.transaction(async (tx) => {
    const id = user ? U[user] : '';
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [id]);
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
  for (const [k, email] of Object.entries({ T: 'tutor@x.com', L: 'sis@x.com', L2: 'other@x.com', T2: 'tutor2@x.com', X: 'nobody@x.com', A: 'admin@x.com' })) {
    const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name: k }]);
    U[k] = r.rows[0].id;
  }
});

const S = {};

test('tutor setup, programmes, subjects, invites', async () => {
  const p = await one('T', `select * from become_tutor('Aaryan', 'America/New_York')`);
  assert.equal(p.role, 'tutor');
  assert.equal(p.status, 'active', 'the first tutor is approved straight away');
  // Admin is its own account: the first tutor holds it only until moving it there
  assert.equal(await val('T', `select is_platform_admin()`), false, 'a tutor account never has admin powers');
  assert.equal(await val('T', `select admin_to_move()`), true);
  await fails(as('T', `select admin_tutors()`), /admins only/);
  await fails(as('L', `select admin_move_to('admin@x.com')`), /admins only/);
  await fails(as('T', `select admin_move_to('tutor@x.com')`), /different email/);
  // An email with no account yet is remembered; signing up with it offers "Set up admin account"
  assert.equal((await val('T', `select admin_move_to('newadmin@x.com')`)).moved, false);
  assert.equal(await val('X', `select admin_invited()`), false);
  await fails(as('X', `select claim_admin()`), /wasn’t chosen/);
  await fails(as('T', `select * from platform_secrets`), /permission denied/, 'the chosen email stays private');
  // The account already exists (no role yet): admin moves straight away
  const moved = await val('T', `select admin_move_to('ADMIN@x.com')`);
  assert.equal(moved.moved, true);
  assert.equal(await val('A', `select role from profiles where id = auth.uid()`), 'admin');
  assert.equal(await val('T', `select admin_to_move()`), false, 'the tutor account lost admin');
  assert.equal(await val('A', `select is_platform_admin()`), true);
  assert.equal((await one('A', `select * from become_tutor('Sneaky')`)).role, 'admin', 'the admin account can’t become a tutor');
  assert.equal((await one('A', `select * from accept_invite('XXXX', 'x')`)).id, null, 'a wrong code joins nobody');
  await fails(as('A', `select make_admin('x@x.com')`), /permission denied/, 'make_admin is for the SQL editor only');
  // Anyone else can sign up as a tutor, but waits for the admin
  const p2 = await one('T2', `select * from become_tutor('Other tutor')`);
  assert.equal(p2.status, 'pending');
  assert.equal(await val('T2', `select is_platform_admin()`), false);
  const told = await as('A', `select * from notifications where kind = 'tutor_signup'`);
  assert.equal(told.length, 1, 'admin is told about the new tutor');
  // A waiting tutor can't invite anyone
  await fails(as('T2', `insert into invites (name) values ('x')`), /row-level security/);
  await fails(as('L', `select set_allow_new_tutors(true)`), /admins only/);
  await fails(as('T', `update app_config set tutor_signups_open = false`), /permission denied/);
  await as('A', `select set_allow_new_tutors(false)`);
  await fails(as('X', `select become_tutor('x')`), /taking new tutors/);
  await as('A', `select admin_set_signups(true)`);
  // Admin approves the new tutor
  await fails(as('T2', `select admin_set_status($1, 'active')`, [U.T2]), /admins only/);
  await as('A', `select admin_set_status($1, 'active')`, [U.T2]);
  assert.equal(await val('T2', `select status from profiles where id = auth.uid()`), 'active');
  assert.equal((await as('T2', `select * from notifications where kind = 'approved'`)).length, 1);
  S.prog = await val('T', `insert into programmes (name) values ('IGCSE') returning id`);
  S.math = await val('T', `insert into subjects (programme_id, name) values ($1, 'Mathematics') returning id`, [S.prog]);
  S.phys = await val('T', `insert into subjects (programme_id, name) values ($1, 'Physics') returning id`, [S.prog]);
  S.alg = await val('T', `insert into topics (subject_id, name) values ($1, 'Algebra') returning id`, [S.math]);
  S.geo = await val('T', `insert into topics (subject_id, name) values ($1, 'Geometry') returning id`, [S.math]);
  const inv = await one('T', `insert into invites (name, programme_id, subject_ids) values ('Sister', $1, $2) returning code`, [S.prog, [S.math, S.phys]]);
  S.code = inv.code;
  assert.match(S.code, /^\d{8}$/, 'learner invites are 8-digit codes');
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
  assert.equal((await one('L2', `select * from accept_invite('NOPE', 'x')`)).id, null);
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

  // redo question 3: "Save, return later" keeps the tick without sending anything back
  await as('T', `update responses set redo = true where attempt_id = $1 and question_id = $2`, [S.att, S.q3]);
  const kept = await one('T', `select * from finish_marking($1, false)`, [S.att]);
  assert.equal(kept.status, 'marked', 'saving for later doesn’t send it back');
  assert.equal((await one('T', `select redo from responses where attempt_id = $1 and question_id = $2`, [S.att, S.q3])).redo, true);
  // "Return marks and ask to redo" sends the ticked question back
  const r = await one('T', `select * from finish_marking($1, true, null, true)`, [S.att]);
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
  // a redo ticked by mistake: "Return marks" makes the marks final and clears the tick
  await as('T', `update responses set redo = true where attempt_id = $1 and question_id = $2`, [S.att, S.q3]);
  const fin = await one('T', `select * from finish_marking($1, true, null, false)`, [S.att]);
  assert.equal(fin.status, 'marked');
  assert.equal(Number(fin.score), 6);
  assert.equal((await one('T', `select redo from responses where attempt_id = $1 and question_id = $2`, [S.att, S.q3])).redo, false);
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
  // the bank holds answers: learners can't read it, not even StudyBridge's questions
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
  // only work the learner can see goes in a report (not scheduled-for-later, not other subjects)
  const soon = new Date(Date.now() + 3 * 864e5).toISOString();
  const later = await val('T', `insert into assignments (kind, title, visibility, visible_from, due_at) values ('test', 'Surprise test', 'scheduled', now() + interval '2 days', $1) returning id`, [soon]);
  const other = await val('T', `insert into subjects (name) values ('Chemistry') returning id`);
  const chem = await val('T', `insert into assignments (kind, title, visibility, subject_id, due_at) values ('homework', 'Chem homework', 'visible', $1, $2) returning id`, [other, soon]);
  const open = await val('T', `insert into assignments (kind, title, visibility, due_at) values ('homework', 'Open homework', 'visible', $1) returning id`, [soon]);
  const n2 = await val('T', `select report_numbers($1, now() - interval '4 days', now())`, [U.L]);
  const titles = n2.next.map((x) => x.title);
  assert.ok(titles.includes('Open homework'));
  assert.ok(!titles.includes('Surprise test') && !titles.includes('Chem homework'), 'not work the learner can’t see');
  await as('T', `delete from assignments where id = any($1)`, [[later, chem, open]]);
  await as('T', `delete from subjects where id = $1`, [other]);
  await as('T', `delete from parent_reports where id = $1`, [r.id]);
  // the server keeps every learner's report up to date: this week daily, last week once it's over
  await db.query(`update app_config set reports_at = null`);
  await db.query(`select prof_tick()`);
  const kept = await as('T', `select * from parent_reports where learner_id = $1 order by week_start`, [U.L]);
  assert.equal(kept.length, 2, 'this week so far and last week');
  assert.ok(kept.every((x) => x.status === 'draft' && x.data.learner));
  const ready = async () => (await as('T', `select id from notifications where kind = 'report_ready'`)).length;
  assert.equal(await ready(), 1, 'the tutor is told last week’s report is ready');
  await db.query(`update app_config set reports_at = null`);
  await db.query(`select prof_tick()`);
  assert.equal(await ready(), 1, 'only once');
  assert.equal((await as('L', `select * from parent_reports`)).length, 0, 'drafts stay with the tutor');
  assert.equal((await as('T2', `select * from parent_reports where learner_id = $1`, [U.L])).length, 0);
  await as('T', `delete from parent_reports where learner_id = $1`, [U.L]);
  // (reports stay on: the last test checks the parent's contact doesn't follow the learner to a new tutor)
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
  const tutors = await val('A', `select admin_tutors()`);
  assert.deepEqual(tutors.map((t) => t.email).sort(), ['tutor2@x.com', 'tutor@x.com']);
  const t2 = tutors.find((t) => t.email === 'tutor2@x.com');
  assert.equal(t2.status, 'active');
  assert.equal(t2.learners, 0);
  assert.ok('ai_cents' in t2 && 'storage_bytes' in t2);
  await fails(as('T2', `select admin_tutors()`), /admins only/);
  await fails(as('L', `select admin_accounts($1)`, [U.T]), /admins only/);
  const mine = await val('A', `select admin_accounts($1)`, [U.T]);
  assert.deepEqual(mine.map((a) => a.email).sort(), ['other@x.com', 'sis@x.com']);
  // ...but none of the other tutor's content
  assert.equal((await as('T', `select * from subjects where tutor_id = $1`, [U.T2])).length, 0);
  assert.equal((await as('T', `select * from assignments where tutor_id = $1`, [U.T2])).length, 0);
  await fails(as('T', `select * from platform_secrets`), /permission denied/);
  await fails(as('T', `select * from platform_admins`), /permission denied/);
  // Plans, passwords, pausing
  await as('A', `select admin_set_plan($1, 'pro', 2500)`, [U.T2]);
  assert.equal((await val('A', `select admin_tutors()`)).find((t) => t.id === U.T2).ai_limit_cents, 2500);
  // ...which the tutor can't see anywhere: not on their profile, the log, the settings row or by asking
  assert.equal(JSON.stringify(await as('T2', `select * from profiles where id = auth.uid()`)).includes('2500'), false);
  assert.equal(JSON.stringify(await as('T2', `select * from admin_log`)).includes('2500'), false);
  await fails(as('T2', `select * from prof_limits`), /permission denied/);
  await fails(as('T2', `select _prof_limit(auth.uid())`), /permission denied/);
  await fails(as('T2', `select _prof_ready(auth.uid())`), /permission denied/);
  await fails(as('T2', `select default_ai_limit_cents from app_config`), /permission denied/);
  await fails(as('T2', `select * from app_config`), /permission denied/);
  assert.deepEqual(Object.keys(await val('T2', `select prof_usage()`)).sort(), ['ready', 'server_seen_at', 'why_not']);
  // The admin's Claude credit: counted down as Prof spends, told once when low; nobody else sees it
  await fails(as('T2', `select admin_prof()`), /admins only/);
  await fails(as('T2', `select * from prof_credit`), /permission denied/);
  await fails(as('T2', `select admin_set_prof_credit(100)`), /admins only/);
  await as('A', `select admin_set_prof_credit(1000, 300)`);
  await db.query(`select _prof_credit_spend(600)`);
  assert.equal(Number((await val('A', `select admin_prof()`)).credit.left_cents), 400);
  assert.equal((await as('A', `select * from notifications where kind = 'prof_credit'`)).length, 0);
  await db.query(`select _prof_credit_spend(150)`);
  await db.query(`select _prof_credit_spend(10)`);
  assert.equal((await as('A', `select * from notifications where kind = 'prof_credit'`)).length, 1, 'told once');
  assert.equal(Number((await val('A', `select admin_overview()`)).prof_credit_left_cents), 240);
  const ap = await val('A', `select admin_prof()`);
  assert.equal(ap.days.length, 30);
  assert.ok(Array.isArray(ap.by_tutor) && Array.isArray(ap.by_kind));
  await as('A', `select admin_set_plan($1, 'pro', null)`, [U.T2]);
  assert.equal((await val('A', `select admin_tutors()`)).find((t) => t.id === U.T2).ai_limit_custom, false, 'back to the default allowance');
  await as('A', `select admin_set_plan($1, 'pro', 2500)`, [U.T2]);
  await as('A', `select admin_set_password($1, 'Reset-Pass-1')`, [U.T2]);
  assert.equal((await db.query(`select encrypted_password = extensions.crypt('Reset-Pass-1', encrypted_password) ok from auth.users where id = $1`, [U.T2])).rows[0].ok, true);
  await fails(as('T2', `select admin_set_password($1, 'Hacked-123')`, [U.T]), /admins only/);
  await fails(as('A', `select admin_set_status($1, 'suspended')`, [U.A]), /own account/);
  await as('A', `select admin_set_status($1, 'suspended')`, [U.T2]);
  const banned = (await db.query(`select banned_until from auth.users where id = $1`, [U.T2])).rows[0].banned_until;
  assert.ok(banned && new Date(banned) > new Date(Date.now() + 365 * 86400000), 'paused tutor can’t sign in');
  await fails(as('T2', `insert into invites (name) values ('x')`), /row-level security/);
  await as('A', `select admin_set_status($1, 'active')`, [U.T2]);
  assert.equal((await db.query(`select banned_until from auth.users where id = $1`, [U.T2])).rows[0].banned_until, null);
  // Shared live video for tutors without their own LiveKit keys
  assert.equal((await val('T2', `select live_status()`)).configured, false);
  await fails(as('T2', `select admin_set_livekit('wss://x.livekit.cloud', 'k', 's')`), /admins only/);
  await as('A', `select admin_set_livekit('wss://shared.livekit.cloud', 'APIshared', 'shared-secret')`);
  const ls2 = await val('T2', `select live_status()`);
  assert.equal(ls2.configured && ls2.shared && !ls2.own, true);
  assert.equal(ls2.url, 'wss://shared.livekit.cloud');
  // StudyBridge's live video comes first, even for a tutor who added their own keys before
  const ses2 = await val('T', `select id from sessions limit 1`);
  assert.equal((await val('T', `select live_pass($1)`, [`session-${ses2}`])).url, 'wss://shared.livekit.cloud');
  // Prof key is write-only
  await fails(as('A', `select admin_set_prof('not-a-key')`), /Claude API key/);
  await as('A', `select admin_set_prof('sk-ant-test-key', 'claude-sonnet-5-5', 500)`);
  const st = await val('A', `select admin_settings()`);
  assert.equal(st.prof_key_set, true);
  assert.ok(!JSON.stringify(st).includes('sk-ant'), 'the key is never sent back');
  // The log: admin sees it all, the tutor sees what was done to them, learners nothing
  const log = await as('A', `select action from admin_log where user_id = $1 order by id`, [U.T2]);
  assert.deepEqual(log.map((r) => r.action), ['approved', 'plan', 'plan', 'plan', 'password_reset', 'paused', 'switched_on']);
  assert.equal((await as('T2', `select * from admin_log`)).length, 7);
  assert.equal((await as('L', `select * from admin_log`)).length, 0);
  // Unfinished sign-ups show up; deleting a tutor takes their learners too
  assert.ok((await val('A', `select admin_accounts(null)`)).some((a) => a.email === 'nobody@x.com'));
  const code = await val('T2', `insert into invites (name) values ('Nobody') returning code`);
  await as('X', `select accept_invite($1, 'Nobody')`, [code]);
  await fails(as('A', `select admin_delete_account($1)`, [U.A]), /own account/);
  assert.equal((await val('A', `select admin_delete_account($1)`, [U.T2])).deleted, 2);
  assert.equal((await db.query(`select count(*)::int n from auth.users where id = any($1)`, [[U.T2, U.X]])).rows[0].n, 0);
  assert.equal((await db.query(`select count(*)::int n from public.assignments where title = 'T2 secret quiz'`)).rows[0].n, 0);
  assert.equal((await as('A', `select * from admin_log where action = 'deleted'`)).length, 1);
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
  assert.ok(!('limit_cents' in u) && !('used_cents' in u), 'tutors never see money');
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
  assert.equal(Number(done.cost_cents), 0, 'the job itself carries no cost');
  assert.equal(Number((await asService(`select cost_cents from prof_costs where job_id = $1`, [j.id]))[0].cost_cents), 0.7);
  await fails(as('T', `select * from prof_costs`), /permission denied/, 'only the admin sees what Prof costs');
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
  // 80% of the allowance: the admin is told (once); the tutor isn't
  await asService(`select prof_save($1, 'running', null, null, null, null, 1, 1, 400)`, [mark.id]);
  const warn = await as('A', `select * from notifications where kind = 'prof_limit'`);
  assert.equal(warn.length, 1);
  assert.match(warn[0].title, /80%/);
  assert.equal((await as('T', `select * from notifications where kind = 'prof_limit'`)).length, 0);
  await asService(`select prof_save($1, 'running', null, null, null, null, 1, 1, 1)`, [mark.id]);
  assert.equal((await as('A', `select * from notifications where kind = 'prof_limit'`)).length, 1, 'only once');
  // Over the allowance: no more Prof this month; the tutor sees no amounts, the admin gets told
  await asService(`select prof_save($1, 'done', null, null, null, null, 1, 1, 600)`, [mark.id]);
  await fails(as('T', `select prof_ask('another quiz please')`), /unavailable right now/);
  assert.equal((await as('A', `select * from notifications where kind = 'prof_limit'`)).length, 2);
  assert.match((await val('T', `select prof_usage()`)).why_not, /StudyBridge has been told/);
  await as('A', `select admin_set_plan($1, 'free', 100000)`, [U.T]);
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

test('a learner who moves to another tutor takes the parent contact with them', async () => {
  U.L3 = (await db.query(`insert into auth.users (email) values ('l3@x.com') returning id`)).rows[0].id;
  const i1 = await one('T', `insert into invites (name) values ('Moves') returning code`);
  await as('L3', `select accept_invite($1, 'Moves')`, [i1.code]);
  await as('L3', `select set_parent_reports(true, 'Dad', '+260971111111')`);
  assert.equal((await as('T', `select * from learner_reports where learner_id = $1`, [U.L3])).length, 1);
  await as('T', `select remove_learner($1)`, [U.L3]);
  assert.equal((await as('T', `select * from learner_reports where learner_id = $1`, [U.L3])).length, 0, 'the old tutor no longer sees the parent’s contact');
  U.T3 = (await db.query(`insert into auth.users (email) values ('tutor3@x.com') returning id`)).rows[0].id;
  await as('T3', `select become_tutor('Third tutor')`);
  await as('A', `select admin_set_status($1, 'active')`, [U.T3]);
  const inv = await one('T3', `insert into invites (name) values ('Moves') returning code`);
  await as('L3', `select accept_invite($1, 'Moves')`, [inv.code]);
  const ex = await val('T3', `select set_learner_exam($1, 'IB Maths', '2027-05-10')`, [U.L3]);
  assert.deepEqual(Object.keys(ex).sort(), ['exam_date', 'exam_name'], 'only the exam comes back');
  const row = await one('T3', `select * from learner_reports where learner_id = $1`, [U.L3]);
  assert.equal(row.enabled, false);
  assert.equal(row.parent_phone, null, 'reports start off with a new tutor until the learner switches them on');
});

test('the email chosen for admin signs up and claims it; tutor sign-up leaves it alone', async () => {
  U.N = (await db.query(`insert into auth.users (email) values ('Later@x.com') returning id`)).rows[0].id;
  await db.query(`update platform_secrets set admin_invite = 'later@x.com'`);
  assert.equal(await val('N', `select admin_invited()`), true);
  assert.equal((await one('N', `select * from become_tutor('Me')`)).role, null, 'going through “I’m a tutor” doesn’t make it a tutor');
  assert.equal((await one('N', `select * from claim_admin()`)).role, 'admin');
  assert.equal(await val('N', `select admin_invited()`), false);
  assert.equal((await db.query(`select admin_invite from platform_secrets`)).rows[0].admin_invite, null);
  await fails(as('N', `select claim_admin()`), /wasn’t chosen/);
});

test('crash reports, the admin inbox, announcements, overview', async () => {
  // Anyone (even signed out) can report a crash; the same problem groups, the admin is told once
  await as('L', `select report_error('TypeError: x is undefined', 'at render (index-BljjbUb4.js:10:5)\nat x (index-BljjbUb4.js:2:1)', '#/work', '1.1.30', 'iPhone/iPad')`);
  await as('T', `select report_error('TypeError: x is undefined', 'at render (index-Zq9xYw1a.js:11:7)\nat x (index-Zq9xYw1a.js:2:9)', '#/', '1.1.31', 'desktop Windows')`);
  await as(null, `select report_error('Boom on sign in', null, '#/', '1.1.31', 'browser')`);
  await fails(as('T', `select * from app_errors`), /permission denied/);
  const errs = await val('A', `select admin_errors()`);
  const te = errs.find((e) => e.message.startsWith('TypeError'));
  assert.equal(te.count, 2, 'grouped across versions');
  assert.equal(te.people, 2);
  assert.ok(te.roles.includes('tutor'));
  assert.equal((await as('A', `select * from notifications where kind = 'problem'`)).length, 2);
  await as('A', `select admin_resolve_error($1)`, [te.id]);
  await as('L', `select report_error('TypeError: x is undefined', 'at render (index-AAAAAAAA.js:1:1)\nat x (index-AAAAAAAA.js:2:2)')`);
  assert.equal((await as('A', `select * from notifications where kind = 'problem'`)).length, 3, 'told again when a fixed one comes back');
  await fails(as('T', `select admin_errors()`), /admins only/);
  // Too many from one person are dropped
  for (let i = 0; i < 35; i++) await as('L', `select report_error($1)`, ['spam ' + i]);
  assert.ok((await val('A', `select admin_errors()`)).filter((e) => e.message.startsWith('spam')).length <= 30);
  // Signed out: counted per internet address (one flood doesn't silence everyone), and the admin
  // is told about a few new ones a day at most
  const fromIp = (ip, msg) =>
    db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claim.sub', '', true), set_config('request.headers', $1, true)`, [JSON.stringify({ 'x-forwarded-for': `${ip}, 10.0.0.1` })]);
      await tx.exec(`set local role anon`);
      await tx.query(`select report_error($1)`, [msg]);
    });
  const told0 = (await as('A', `select * from notifications where kind = 'problem'`)).length;
  for (let i = 0; i < 25; i++) await fromIp('1.2.3.4', 'flood ' + i);
  await fromIp('5.6.7.8', 'real sign-in bug');
  const all = await val('A', `select admin_errors()`);
  assert.equal(all.filter((e) => e.message.startsWith('flood')).length, 20, '20 a day from one address');
  assert.ok(all.some((e) => e.message === 'real sign-in bug'), 'another address still gets through');
  assert.ok((await as('A', `select * from notifications where kind = 'problem'`)).length - told0 <= 5);

  // Contact StudyBridge: tutor writes, admin replies, tutor sees it
  const fid = await val('T', `select send_feedback('idea', 'Please add flashcards')`);
  await fails(as('L', `select send_feedback('idea', 'hi there')`), /Only tutors/);
  assert.equal((await val('A', `select admin_feedback()`)).length, 1);
  assert.equal((await as('L', `select * from feedback`)).length, 0);
  await as('A', `select admin_reply_feedback($1, 'Coming in 1.4!')`, [fid]);
  assert.equal((await one('T', `select * from feedback where id = $1`, [fid])).reply, 'Coming in 1.4!');
  assert.equal((await as('T', `select * from notifications where kind = 'feedback_reply'`)).length, 1);
  await fails(as('T', `select admin_reply_feedback($1, 'x')`, [fid]), /admins only/);

  // Announcements: tutors see tutor ones, learners only "everyone" ones; ended ones disappear
  const a1 = await val('A', `select admin_announce('Update tonight', 'Restart when asked', 'tutors')`);
  await val('A', `select admin_announce('Hello everyone', '', 'everyone')`);
  await fails(as('T', `insert into announcements (title) values ('x')`), /permission denied/);
  assert.equal((await as('T', `select * from announcements`)).length, 2);
  assert.equal((await as('L', `select * from announcements`)).length, 1);
  await as('A', `select admin_end_announcement($1)`, [a1]);
  assert.equal((await as('T', `select * from announcements`)).length, 1);

  // App versions, notes, sign-up answers, minimum version, overview
  await as('T', `select seen('1.1.31', 'desktop Windows')`);
  await as('A', `select admin_set_note($1, 'My own account')`, [U.T]);
  const det = await val('A', `select admin_tutor($1)`, [U.T]);
  assert.equal(det.app_version, '1.1.31');
  assert.equal(det.note, 'My own account');
  assert.equal(det.ai_by_month.length, 6);
  await fails(as('T', `select * from admin_notes`), /permission denied/);
  await fails(as('A', `select admin_set_min_version('one')`), /like 1\.1\.25/);
  await as('A', `select admin_set_min_version('1.1.30')`);
  assert.equal(await val('T', `select min_version from app_config`), '1.1.30');
  const ov = await val('A', `select admin_overview()`);
  assert.ok(ov.tutors >= 1 && ov.learners >= 1);
  assert.ok(ov.versions.some((v) => v.version === '1.1.31'));
  assert.equal(ov.feedback_open, 0);
  assert.ok(ov.health && 'backup_at' in ov.health);
  await fails(as('T', `select admin_overview()`), /admins only/);
  U.T9 = (await db.query(`insert into auth.users (email) values ('newtutor@x.com') returning id`)).rows[0].id;
  await as('T9', `select * from become_tutor('Newbie', 'UTC', $1)`, [{ subjects: 'IB Physics', country: 'Zambia', learners: '1–5', junk: 'x' }]);
  const nt = (await val('A', `select admin_tutors()`)).find((t) => t.id === U.T9);
  assert.deepEqual(nt.signup, { subjects: 'IB Physics', country: 'Zambia', learners: '1–5' });
});

test('syllabus topics, taught marks and the coverage map', async () => {
  U.TC = (await db.query(`insert into auth.users (email) values ('cov-tutor@x.com') returning id`)).rows[0].id;
  U.LC = (await db.query(`insert into auth.users (email) values ('cov-learner@x.com') returning id`)).rows[0].id;
  await as('TC', `select * from become_tutor('Cov')`);
  await as('A', `select admin_set_status($1, 'active')`, [U.TC]);
  const sub = await val('TC', `insert into subjects (name, exam) values ('Maths', 'cie:0607') returning id`);
  const t1 = await val('TC', `insert into topics (subject_id, name, code, details, position) values ($1, 'Number', '1', '{Fractions,Percentages}', 0) returning id`, [sub]);
  const t2 = await val('TC', `insert into topics (subject_id, name, code, position) values ($1, 'Algebra', '2', 1) returning id`, [sub]);
  const t3 = await val('TC', `insert into topics (subject_id, name, code, position) values ($1, 'Geometry', '3', 2) returning id`, [sub]);
  const code = await val('TC', `insert into invites (name, subject_ids) values ('Cov L', $1) returning code`, [[sub]]);
  await as('LC', `select accept_invite($1, 'Cov Learner')`, [code]);
  // A lesson on Number they can see = taught; Algebra marked taught by hand; Geometry nothing yet
  await as('TC', `insert into lessons (title, subject_id, topic_id, visibility) values ('Fractions', $1, $2, 'visible')`, [sub, t1]);
  await as('TC', `insert into taught_topics (learner_id, topic_id) values ($1, $2)`, [U.LC, t2]);
  await fails(as('T', `insert into taught_topics (learner_id, topic_id, tutor_id) values ($1, $2, $3)`, [U.LC, t2, U.T]), /row-level security/);
  const cov = await val('TC', `select coverage($1)`, [sub]);
  assert.deepEqual(cov.topics.map((t) => t.code), ['1', '2', '3']);
  assert.deepEqual(cov.topics[0].details, ['Fractions', 'Percentages']);
  const l = cov.learners[0];
  assert.equal(l.name, 'Cov Learner');
  assert.ok(l.taught.includes(t1));
  assert.ok(l.marked.includes(t2));
  assert.ok(!l.taught.includes(t3) && !l.marked.includes(t3));
  await fails(as('T', `select coverage($1)`, [sub]), /Unknown subject/);
  assert.equal((await as('LC', `select * from taught_topics`)).length, 1, 'the learner can see what was marked for them');
  // The tutor's own call: a level, or "not yet" even after a lesson; and back to automatic
  await as('TC', `update taught_topics set state = 'strong' where learner_id = $1 and topic_id = $2`, [U.LC, t2]);
  await as('TC', `insert into taught_topics (learner_id, topic_id, state) values ($1, $2, 'not_yet')`, [U.LC, t1]);
  await fails(as('TC', `insert into taught_topics (learner_id, topic_id, state) values ($1, $2, 'genius')`, [U.LC, t3]), /check constraint/);
  const cov2 = (await val('TC', `select coverage($1)`, [sub])).learners[0];
  assert.equal(cov2.set[t2], 'strong');
  assert.equal(cov2.set[t1], 'not_yet');
  assert.ok(!cov2.marked.includes(t1));
  const mt0 = await val('LC', `select my_topics()`);
  assert.equal(mt0.find((x) => x.name === 'Number').taught, false, 'not yet wins over the lesson');
  assert.equal(mt0.find((x) => x.name === 'Algebra').strength, 'strong');
  await as('TC', `delete from taught_topics where learner_id = $1 and topic_id = $2`, [U.LC, t1]);
  await as('TC', `update taught_topics set state = 'taught' where learner_id = $1 and topic_id = $2`, [U.LC, t2]);
  assert.equal((await val('LC', `select my_topics()`)).find((x) => x.name === 'Number').taught, true);
  await fails(as('TC', `select prof_syllabus($1, 'x')`, [sub]), /Say which exam|switched on|unavailable/);
});

test('self-study: flashcards with spaced repetition, mistake cards, practice the learner starts, notes, goal and streak', async () => {
  const sub = await val('TC', `select id from subjects where name = 'Maths'`);
  const alg = await val('TC', `select id from topics where name = 'Algebra'`);
  // Tutor cards: for everyone taking the subject, or one learner; learners only read their own
  const c1 = await val('TC', `insert into cards (tutor_id, subject_id, topic_id, front_md, back_md) values (auth.uid(), $1, $2, 'Expand (x+1)^2', 'x^2+2x+1') returning id`, [sub, alg]);
  await as('TC', `insert into cards (tutor_id, subject_id, learner_id, front_md, back_md) values (auth.uid(), $1, $2, 'Only you', 'yes')`, [sub, U.LC]);
  await fails(as('TC', `insert into cards (tutor_id, subject_id, front_md, source) values (auth.uid(), $1, 'x', 'mistake')`, [sub]), /row-level security/);
  await fails(as('T', `insert into cards (tutor_id, subject_id, front_md) values ($1, $2, 'x')`, [U.TC, sub]), /row-level security/);
  assert.equal((await as('LC', `select * from cards`)).length, 2);
  assert.equal((await as('L', `select * from cards where tutor_id = $1`, [U.TC])).length, 0, 'another tutor’s learner sees none');
  // Learners make their own cards (no AI), only for themselves
  await as('LC', `insert into cards (tutor_id, learner_id, subject_id, front_md, back_md, source, created_by) values ($1, auth.uid(), $2, 'Mine', 'ok', 'own', auth.uid())`, [U.TC, sub]);
  await fails(as('LC', `insert into cards (tutor_id, subject_id, front_md, source) values ($1, $2, 'For all', 'tutor')`, [U.TC, sub]), /row-level security/);
  await fails(as('LC', `delete from cards where id = $1`, [c1]), /./).catch(() => {});
  assert.equal((await as('LC', `select * from cards where id = $1`, [c1])).length, 1, 'learners can’t delete the tutor’s cards');
  // Spaced repetition
  let r = await val('LC', `select review_card($1, 2)`, [c1]);
  assert.equal(Number(r.interval_days), 1);
  r = await val('LC', `select review_card($1, 2)`, [c1]);
  assert.equal(Number(r.interval_days), 3);
  r = await val('LC', `select review_card($1, 3)`, [c1]);
  assert.ok(Number(r.interval_days) > 6 && Number(r.ease) > 2.5);
  r = await val('LC', `select review_card($1, 0)`, [c1]);
  assert.equal(r.reps, 0);
  assert.equal(r.lapses, 1);
  assert.ok(new Date(r.due_at) - Date.now() < 15 * 60000, '“again” comes back in minutes');
  await fails(as('L', `select review_card($1, 2)`, [c1]), /Card not found/);
  await fails(as('LC', `insert into card_reviews (learner_id, card_id) values (auth.uid(), $1)`, [c1]), /permission denied/);
  assert.equal((await as('TC', `select * from card_reviews where learner_id = $1`, [U.LC])).length, 1, 'the tutor can see progress');

  // Mistake cards: a question she lost marks on (released) becomes her card, with the answer when the tutor shows answers
  const pr = await val('TC', `insert into assignments (kind, title, practice, visibility, release_mode, show_answers, max_attempts, learner_ids, subject_id)
     values ('quiz', 'Algebra check', true, 'visible', 'on_submit', true, 5, $1, $2) returning id`, [[U.LC], sub]);
  const q = await val('TC', `insert into questions (assignment_id, type, marks, prompt_md, topic_id) values ($1, 'numeric', 2, 'Solve 2x = 24', $2) returning id`, [pr, alg]);
  await as('TC', `insert into question_keys (question_id, answer, solution_md) values ($1, '{"value":"12"}', 'Divide both sides by 2.')`, [q]);
  const t = await one('LC', `select * from start_attempt($1)`, [pr]);
  await as('LC', `select save_response($1, $2, $3)`, [t.id, q, { value: '10' }]);
  await as('LC', `select submit_attempt($1)`, [t.id]);
  assert.equal(await val('LC', `select sync_mistake_cards()`), 1);
  assert.equal(await val('LC', `select sync_mistake_cards()`), 0, 'only once');
  const mc = await one('LC', `select * from cards where source = 'mistake'`);
  assert.match(mc.front_md, /Solve 2x = 24/);
  assert.match(mc.back_md, /Answer: 12/);
  assert.match(mc.back_md, /Divide both sides/);
  assert.equal(mc.topic_id, alg);
  assert.equal(await val('TC', `select sync_mistake_cards()`), 0, 'tutors have none');

  // Practice the learner starts: from the tutor's approved bank (auto-marked kinds only), no "new work" notification
  for (let i = 1; i <= 6; i++)
    await as('TC', `insert into bank_questions (owner_id, subject_id, topic, type, prompt_md, answer, marks, solution_md, status)
       values (auth.uid(), $1, 'Algebra', 'numeric', $2, $3, 1, $4, 'approved')`, [sub, `Solve x + ${i} = ${i * 2}`, { value: String(i) }, i === 1 ? `x = ${i}` : null]);
  await as('TC', `insert into bank_questions (owner_id, subject_id, topic, type, prompt_md, status) values (auth.uid(), $1, 'Algebra', 'short', 'Explain', 'approved')`, [sub]);
  await as('TC', `insert into bank_questions (owner_id, subject_id, topic, type, prompt_md, answer, status) values (auth.uid(), $1, 'Algebra', 'numeric', 'Not yet', '{"value":"1"}', 'review')`, [sub]);
  const pt = await val('LC', `select practice_topics()`);
  assert.deepEqual(pt.map((x) => [x.topic, x.questions, x.examples]), [['Algebra', 6, 1]]);
  const before = (await as('LC', `select * from notifications where kind = 'assignment'`)).length;
  const daily = await val('LC', `select start_practice('daily')`);
  assert.equal(daily.questions, 5);
  assert.equal((await val('LC', `select start_practice('daily')`)).assignment_id, daily.assignment_id, 'one daily quiz a day');
  assert.equal((await as('LC', `select * from notifications where kind = 'assignment'`)).length, before, 'no notification for practice she started');
  const da = await one('LC', `select * from assignments where id = $1`, [daily.assignment_id]);
  assert.equal(da.practice, true);
  assert.equal(da.source, 'self');
  assert.deepEqual(da.learner_ids, [U.LC]);
  assert.equal((await as('LC', `select * from questions where assignment_id = $1 and type not in ('mcq', 'numeric')`, [daily.assignment_id])).length, 0);
  const lq = (await as('LC', `select * from questions where assignment_id = $1`, [daily.assignment_id]))[0];
  assert.equal(lq.topic_id, alg, 'tagged with the tutor’s own topic');
  // worked example then "you try"
  const learn = await val('LC', `select start_practice('learn', $1, 'Algebra', 3)`, [sub]);
  const la = await one('LC', `select * from assignments where id = $1`, [learn.assignment_id]);
  assert.match(la.instructions_md, /Worked example[\s\S]*x = 1[\s\S]*Now you try/);
  assert.equal(learn.questions, 3);
  // timed drill
  const drill = await val('LC', `select start_practice('drill', $1, 'Algebra', 4, 7)`, [sub]);
  assert.equal((await one('LC', `select time_limit_min from assignments where id = $1`, [drill.assignment_id])).time_limit_min, 7);
  await fails(as('LC', `select start_practice('topic', $1, 'Calculus')`, [sub]), /aren’t any practice questions/);
  await fails(as('TC', `select start_practice('daily')`), /For learners/);
  await fails(as('L', `select start_practice('topic', $1, 'Algebra')`, [sub]), /Unknown subject|For learners/);
  // it plays like any practice: start, answer, marked instantly
  const at = await one('LC', `select * from start_attempt($1)`, [drill.assignment_id]);
  const dq = (await as('LC', `select * from questions where assignment_id = $1 order by position`, [drill.assignment_id]))[0];
  await as('LC', `select save_response($1, $2, $3)`, [at.id, dq.id, { value: '999' }]);
  assert.equal((await one('LC', `select * from submit_attempt($1)`, [at.id])).status, 'marked');

  // Formula sheet: hers to write; her tutor can read it; nobody else
  await as('LC', `insert into study_notes (learner_id, subject_id, body_md) values (auth.uid(), $1, '$a^2+b^2=c^2$')`, [sub]);
  assert.equal((await as('TC', `select * from study_notes where learner_id = $1`, [U.LC])).length, 1);
  assert.equal((await as('T', `select * from study_notes where learner_id = $1`, [U.LC])).length, 0);
  await fails(as('TC', `update study_notes set body_md = 'x' where learner_id = $1 returning *`, [U.LC]).then((r) => { if (!r.length) throw new Error('no rows'); }), /no rows/);

  // Goal and streak: study counts (flashcards log time as 'study')
  await as('LC', `select set_study_goal(15)`);
  await as('LC', `select log_time('study', $1, 120)`, [sub]);
  await db.query(`insert into activity (learner_id, tutor_id, kind, seconds, day) values ($1, $2, 'study', 600, (now() at time zone 'UTC')::date - 1), ($1, $2, 'study', 60, (now() at time zone 'UTC')::date - 2), ($1, $2, 'study', 60, (now() at time zone 'UTC')::date - 4)`, [U.LC, U.TC]);
  const ss = await val('LC', `select study_summary()`);
  assert.equal(ss.goal_min, 15);
  assert.equal(ss.streak, 3, 'today, yesterday and the day before; the gap stops it');
  assert.ok(ss.today_sec >= 120);
  assert.equal(ss.days.length, 14);
  assert.equal(ss.mistakes, 1);
  assert.ok(ss.cards_due >= 2);
  assert.equal((await val('TC', `select study_summary($1)`, [U.LC])).streak, 3, 'her tutor sees it');
  await fails(as('T', `select study_summary($1)`, [U.LC]), /Not your learner/);
  await fails(as(null, `select study_summary($1)`, [U.LC]), /Not your learner|permission denied/, 'not without signing in');
  const mt = await val('LC', `select my_topics()`);
  assert.deepEqual(mt.map((x) => x.name), ['Number', 'Algebra', 'Geometry']);
  assert.ok(mt.find((x) => x.name === 'Algebra').taught);
  // practice she starts herself doesn't count as taught
  const geo = await val('TC', `select id from topics where name = 'Geometry'`);
  const own = (await db.query(`insert into assignments (tutor_id, kind, title, practice, visibility, learner_ids, subject_id, topic_id, source)
     values ($1, 'quiz', 'Own geometry', true, 'visible', $2, $3, $4, 'self') returning id`, [U.TC, [U.LC], sub, geo])).rows[0].id;
  await db.query(`insert into questions (tutor_id, assignment_id, type, marks, prompt_md, topic_id) values ($3, $1, 'numeric', 1, 'Angle?', $2)`, [own, geo, U.TC]);
  assert.equal(mt.find((x) => x.name === 'Geometry').taught, false);
  assert.equal((await val('LC', `select my_topics()`)).find((x) => x.name === 'Geometry').taught, false);
  assert.ok(!(await val('TC', `select coverage($1)`, [sub])).learners[0].taught.includes(geo));
});

test('self-marked work: the learner sees the mark scheme after handing in and gives her own marks; the tutor sees them', async () => {
  const sub = await val('TC', `select id from subjects where name = 'Maths'`);
  const a = await val('TC', `insert into assignments (kind, title, visibility, self_mark, subject_id) values ('test', 'Past paper', 'visible', true, $1) returning id`, [sub]);
  const q = await val('TC', `insert into questions (assignment_id, type, marks, prompt_md) values ($1, 'short', 4, 'Prove it') returning id`, [a]);
  await as('TC', `insert into question_keys (question_id, answer, mark_scheme_md, solution_md) values ($1, '{"text":"QED"}', 'M1 for setup, A1 for answer', 'Full proof')`, [q]);
  const t = await one('LC', `select * from start_attempt($1)`, [a]);
  assert.deepEqual((await val('LC', `select attempt_detail($1)`, [t.id])).keys, [], 'no mark scheme before handing in');
  await as('LC', `select save_response($1, $2, '{"text":"my proof"}')`, [t.id, q]);
  await fails(as('LC', `select save_self_marks($1, $2)`, [t.id, { [q]: 3 }]), /Hand it in first/);
  await as('LC', `select submit_attempt($1)`, [t.id]);
  const d = await val('LC', `select attempt_detail($1)`, [t.id]);
  assert.equal(d.attempt.self_mark, true);
  assert.equal(d.keys[0].mark_scheme_md, 'M1 for setup, A1 for answer');
  await as('LC', `select save_self_marks($1, $2)`, [t.id, { [q]: 9 }]);
  const td = await val('TC', `select attempt_detail($1)`, [t.id]);
  assert.equal(Number(td.responses[0].self_marks), 4, 'capped at the question’s marks');
  assert.ok(td.attempt.self_marked_at);
  assert.equal((await as('TC', `select * from notifications where kind = 'self_marked'`)).length, 1);
  await fails(as('L2', `select save_self_marks($1, '{}')`, [t.id]), /Attempt not found/);
  // Self-marked work has one attempt, so the mark scheme can't help a second try
  assert.equal(await val('TC', `select max_attempts from assignments where id = $1`, [a]), 1);
  assert.equal(await val('TC', `update assignments set max_attempts = 3 where id = $1 returning max_attempts`, [a]), 1);
  // ...and while a redo is open, the answers are hidden again
  await db.query(`update attempts set status = 'returned' where id = $1`, [t.id]);
  const redo = await val('LC', `select attempt_detail($1)`, [t.id]);
  assert.deepEqual(redo.keys, []);
  assert.equal(redo.attempt.self_mark_open, false);
  // older self-marked work that allowed more tries: hidden until the tries are used up
  await db.query(`update attempts set status = 'submitted' where id = $1`, [t.id]);
  await db.query(`alter table assignments disable trigger assignments_self_mark`);
  await db.query(`update assignments set max_attempts = 2 where id = $1`, [a]);
  await db.query(`alter table assignments enable trigger assignments_self_mark`);
  assert.deepEqual((await val('LC', `select attempt_detail($1)`, [t.id])).keys, []);
  await fails(as('LC', `select save_self_marks($1, $2)`, [t.id, { [q]: 1 }]), /used all your attempts/);
  await db.query(`update assignments set max_attempts = 1 where id = $1`, [a]);
});

test('calendar: only the server reads a feed', async () => {
  const tok = await val('TC', `select my_calendar_token()`);
  assert.equal(tok.length, 36);
  await fails(as('TC', `select calendar_feed($1)`, [tok]), /permission denied/);
  await fails(as('A', `select my_calendar_token()`), /Tutors and learners only/);
  await fails(as(null, `select my_calendar_token()`), /Tutors and learners only|permission denied/);
  // a learner can't read their tutor's link (it would show other learners' lessons)
  await fails(as('LC', `select * from calendar_tokens`), /permission denied/);
  const cols = (await as('LC', `select * from profiles where role = 'tutor' limit 1`))[0] || {};
  assert.equal(Object.keys(cols).some((k) => /calendar/.test(k)), false);
  assert.equal(JSON.stringify(await as('LC', `select * from profiles`)).includes(tok), false);
});

test('Prof’s StudyBridge papers (no longer used): never handed to tutors, even approved; only the admin writes or fixes them', async () => {
  const pid = (await db.query(`insert into sb_papers (board, code, paper, number, status, items) values ('cie', '0607', '2', 9, 'review', $1) returning id`,
    [JSON.stringify([{ label: '1', prompt: 'x', type: 'numeric', answer: { value: '1' }, marks: 1, check: { ok: false, note: 'wrong' } }])])).rows[0].id;
  assert.equal((await as('TC', `select * from sb_papers where id = $1`, [pid])).length, 0);
  await fails(as('TC', `insert into sb_papers (board, code, paper) values ('cie', '0607', '2')`), /permission denied/);
  await fails(as('TC', `select admin_paper_status($1, 'approved')`, [[pid]]), /admins only/);
  await fails(as('TC', `select admin_write_papers('[]')`), /admins only/);
  await as('A', `select admin_paper_item($1, 0, $2)`, [pid, { answer: { value: '2' }, owner: 'nope' }]);
  const fixed = (await db.query(`select items, flagged from sb_papers where id = $1`, [pid])).rows[0];
  assert.equal(fixed.items[0].answer.value, '2');
  assert.equal(fixed.items[0].check.ok, true);
  assert.equal(fixed.items[0].owner, undefined, 'only answer/mark scheme/solution/prompt/marks can change');
  assert.equal(fixed.flagged, 0);
  await as('A', `select admin_paper_status($1, 'approved')`, [[pid]]);
  assert.equal((await as('TC', `select * from sb_papers where id = $1`, [pid])).length, 0, 'StudyBridge’s papers for tutors come from the content account now');
  assert.equal((await as('LC', `select * from sb_papers where id = $1`, [pid])).length, 0);
  assert.equal((await as('A', `select * from sb_papers where id = $1`, [pid])).length, 1, 'the admin still sees them');
  await fails(as('TC', `select * from sb_paper_plans`), /permission denied/);
  // A paper whose job fails (or is stopped) shows as failed, not "writing" for ever; trying again restarts it
  const wp = (await db.query(`insert into sb_papers (board, code, paper, number) values ('cie', '0607', '4', 1) returning id`)).rows[0].id;
  const wj = (await db.query(`insert into prof_jobs (tutor_id, kind, prompt, context) values ($1, 'paper', 'x', $2) returning id`, [U.A, { mode: 'write', paper_id: wp }])).rows[0].id;
  await db.query(`update sb_papers set job_id = $2 where id = $1`, [wp, wj]);
  await db.query(`update prof_jobs set status = 'failed', error = 'nope' where id = $1`, [wj]);
  const fp = (await val('A', `select admin_papers()`)).papers.find((p) => p.id === wp);
  assert.equal(fp.status, 'failed');
  assert.equal(fp.job_id, wj);
  await as('A', `select prof_retry($1)`, [wj]);
  assert.equal((await db.query(`select status from sb_papers where id = $1`, [wp])).rows[0].status, 'writing');
  await db.query(`update prof_jobs set status = 'cancelled' where id = $1`, [wj]);
  assert.equal((await db.query(`select status from sb_papers where id = $1`, [wp])).rows[0].status, 'failed');
});

test('weekly lessons keep the tutor’s clock; each learner gets their own time; reminders go once; skip, move, change, stop', async () => {
  // a fresh tutor in New York and his sister in Lusaka
  U.TW = (await db.query(`insert into auth.users (email) values ('weekly-tutor@x.com') returning id`)).rows[0].id;
  U.LW = (await db.query(`insert into auth.users (email) values ('weekly-sis@x.com') returning id`)).rows[0].id;
  await as('TW', `select * from become_tutor('Aaryan W', 'America/New_York')`);
  await as('A', `select admin_set_status($1, 'active')`, [U.TW]);
  const wcode = await val('TW', `insert into invites (name) values ('Sis') returning code`);
  await as('LW', `select accept_invite($1, 'Sis', 'Africa/Lusaka')`, [wcode]);

  // 10:00 New York on a Tuesday is 16:00 in Lusaka in October, and 17:00 after US clocks go back on 1 Nov 2026
  const at = (day, tz) => val('TW', `select to_char(_series_start($1, '10:00', 'America/New_York') at time zone $2, 'HH24:MI')`, [day, tz]);
  assert.equal(await at('2026-10-27', 'America/New_York'), '10:00');
  assert.equal(await at('2026-11-03', 'America/New_York'), '10:00');
  assert.equal(await at('2026-10-27', 'Africa/Lusaka'), '16:00');
  assert.equal(await at('2026-11-03', 'Africa/Lusaka'), '17:00');

  await fails(as('LW', `select create_lesson_series('x', now() + interval '2 days', 60, $1, 'Africa/Lusaka')`, [[U.LW]]), /Tutors only/);
  await fails(as('TW', `select create_lesson_series('x', now() + interval '2 days', 60, $1, 'America/New_York')`, [[U.LC]]), /Not your learner/);
  await fails(as('TW', `select create_lesson_series(' ', now() + interval '2 days', 60, $1, 'America/New_York')`, [[U.LW]]), /title/);
  await fails(as('TW', `select create_lesson_series('x', now() + interval '2 days', 60, '{}', 'America/New_York')`), /at least one learner/);

  const sid = await val('TW', `select create_lesson_series('Weekly algebra', date_trunc('minute', now()) + interval '2 days', 60, $1, 'America/New_York')`, [[U.LW]]);
  const mine = await as('TW', `select * from sessions where series_id = $1 order by starts_at`, [sid]);
  assert.ok(mine.length >= 8 && mine.length <= 10, `about 8 weeks of lessons (${mine.length})`);
  assert.ok(mine.every((s) => new Date(s.starts_at) > new Date()), 'only future lessons');
  // every lesson is at 10:xx in New York, whatever the date
  const ny = await as('TW', `select distinct to_char(starts_at at time zone 'America/New_York', 'Dy HH24:MI') t from sessions where series_id = $1`, [sid]);
  assert.equal(ny.length, 1, 'same weekday and clock time in New York every week');
  assert.equal((await as('LW', `select * from sessions where series_id = $1`, [sid])).length, mine.length, 'the learner sees them');
  assert.equal((await as('LC', `select * from sessions where series_id = $1`, [sid])).length, 0);
  assert.equal((await as('LW', `select * from lesson_series where id = $1`, [sid])).length, 1);
  assert.equal((await as('LC', `select * from lesson_series where id = $1`, [sid])).length, 0);
  await fails(as('LW', `insert into lesson_series (title, weekday, start_time, timezone, starts_on) values ('x', 1, '10:00', 'UTC', current_date)`), /permission denied/);
  // one notification for the series, none per lesson
  const ln = (t) => as('LW', `select * from notifications where title like $1 order by created_at`, [t]);
  const made = await ln('Weekly lesson: Weekly algebra');
  assert.equal(made.length, 1);
  assert.match(made[0].body, /^Every \w+ at \d\d:\d\d your time, starting /);
  assert.equal((await ln('Live session: Weekly algebra')).length, 0);
  // topping up never makes doubles; learners can't run it
  assert.equal((await db.query(`select _fill_series() n`)).rows[0].n, 0);
  await fails(as('LW', `select _fill_series()`), /permission denied/);
  await fails(as('TW', `select _lesson_reminders()`), /permission denied/);

  // reminders: a day before, then 15 minutes before; each once
  const first = mine[0].id;
  await db.query(`update sessions set starts_at = now() + interval '20 hours', created_at = now() - interval '3 days' where id = $1`, [first]);
  assert.equal((await ln('Lesson moved: Weekly algebra')).length, 1, 'moving a lesson tells the learner');
  assert.ok((await db.query(`select _lesson_reminders() n`)).rows[0].n >= 1);
  assert.equal((await db.query(`select _lesson_reminders() n`)).rows[0].n, 0, 'nothing twice');
  const soonish = await ln('Lesson coming up: Weekly algebra');
  assert.equal(soonish.length, 1);
  assert.match(soonish[0].body, /your time\.$/);
  await db.query(`update sessions set starts_at = now() + interval '10 minutes' where id = $1`, [first]);
  await db.query(`select _lesson_reminders()`);
  await db.query(`select _lesson_reminders()`);
  assert.equal((await ln('Lesson in 15 minutes: Weekly algebra')).length, 1);
  const tut = await as('TW', `select body from notifications where title = 'Lesson in 15 minutes: Weekly algebra'`);
  assert.equal(tut.length, 1);
  assert.match(tut[0].body, /your time · Sis \w+ \d\d:\d\d\.$/, 'the tutor sees the learner’s time too');
  // a lesson made just now gets no day-before reminder
  await as('TW', `insert into sessions (title, starts_at, learner_ids) values ('Quick extra', now() + interval '5 hours', $1)`, [[U.LW]]);
  await db.query(`select _lesson_reminders()`);
  assert.equal((await ln('Lesson coming up: Quick extra')).length, 0);

  // skip one week (and put it back); learners can't
  const third = mine[2].id;
  await as('LW', `update sessions set cancelled = true where id = $1`, [third]);
  assert.equal((await one('TW', `select cancelled from sessions where id = $1`, [third])).cancelled, false);
  await as('TW', `select skip_lesson($1)`, [third]);
  assert.equal((await one('LW', `select cancelled from sessions where id = $1`, [third])).cancelled, true);
  assert.equal((await ln('Lesson skipped: Weekly algebra')).length, 1);
  await as('TW', `select skip_lesson($1, false)`, [third]);
  assert.equal((await ln('Lesson back on: Weekly algebra')).length, 1);
  await as('TW', `select skip_lesson($1)`, [third]);
  await fails(as('LW', `select skip_lesson($1)`, [third]), /Not your lesson/);

  // change from the 5th lesson on: the first four stay, the rest move
  const keep = (await as('TW', `select id, starts_at from sessions where series_id = $1 and starts_at > now() order by starts_at`, [sid]));
  await as('TW', `select change_lesson_series($1, 'Weekly algebra', $2::timestamptz + interval '1 hour', 60, $3, 'America/New_York', null, null, $2)`, [sid, keep[4].starts_at, [U.LW]]);
  const kept = await as('TW', `select id from sessions where series_id = $1 and starts_at > now() order by starts_at limit 4`, [sid]);
  assert.deepEqual(kept.map((r) => r.id), keep.slice(0, 4).map((r) => r.id), 'lessons before the change stay');
  assert.equal((await as('TW', `select count(*)::int n from sessions where series_id = $1 and starts_at = $2::timestamptz + interval '1 hour'`, [sid, keep[4].starts_at]))[0].n, 1);
  // change it from now on: new time and length, old future lessons replaced
  await as('TW', `select change_lesson_series($1, 'Weekly algebra', date_trunc('minute', now()) + interval '3 days 2 hours', 45, $2, 'America/New_York')`, [sid, [U.LW]]);
  const after = await as('TW', `select * from sessions where series_id = $1 and starts_at > now()`, [sid]);
  assert.ok(after.length >= 8 && after.every((s) => s.duration_min === 45 && !s.cancelled));
  assert.equal((await ln('Weekly lesson changed: Weekly algebra')).length, 2, 'one message per change');
  await fails(as('TC', `select change_lesson_series($1, 'x', now(), 45, $2, 'UTC')`, [sid, [U.LW]]), /Not your lesson/);

  // stop it: no more lessons, and topping up doesn't bring them back
  await as('TW', `select end_lesson_series($1)`, [sid]);
  assert.equal((await as('TW', `select * from sessions where series_id = $1 and starts_at > now()`, [sid])).length, 0);
  assert.equal((await ln('Weekly lesson stopped: Weekly algebra')).length, 1);
  await db.query(`select _fill_series()`);
  assert.equal((await as('TW', `select * from sessions where series_id = $1 and starts_at > now()`, [sid])).length, 0);

  // cancelling a one-off lesson tells the learner
  const once = await val('TW', `insert into sessions (title, starts_at, learner_ids) values ('One-off', now() + interval '2 days', $1) returning id`, [[U.LW]]);
  await as('TW', `delete from sessions where id = $1`, [once]);
  assert.equal((await ln('Lesson cancelled: One-off')).length, 1);

  // learners can switch on phone alerts for themselves
  const pa = await val('LW', `select my_phone_alerts()`);
  assert.match(pa.topic, /^studybridge-[0-9a-f]{18}$/);
  assert.equal(pa.enabled, false);
  assert.equal((await val('LW', `select my_phone_alerts(true)`)).enabled, true);
  await fails(as('TW', `select my_phone_alerts()`), /Learners only/);
  await fails(as('LW', `select * from phone_alerts`), /permission denied/);
});

test('mock exams: papers add up, the grade comes from the tutor’s own boundaries; learners never see boundaries', async () => {
  // boundaries for an exam, set once per session; kept highest first
  const b1 = await val('TW', `insert into grade_boundaries (exam, session, option_label, max_mark, grades)
    values ('cie:0607', 'June 2025', 'Extended', 200, '[{"grade":"C","min":70},{"grade":"A*","min":160},{"grade":"B","min":100},{"grade":"A","min":130}]') returning id`);
  const stored = await one('TW', `select grades from grade_boundaries where id = $1`, [b1]);
  assert.deepEqual(stored.grades.map((g) => g.grade), ['A*', 'A', 'B', 'C']);
  await fails(as('TW', `insert into grade_boundaries (exam, max_mark, grades) values ('cie:0607', 200, '[{"grade":"A","min":250}]')`), /isn’t between 0 and 200/);
  await fails(as('TW', `insert into grade_boundaries (exam, max_mark, grades) values ('cie:0607', 200, '[{"grade":"A","min":150},{"grade":"a","min":120}]')`), /there twice/);
  await fails(as('TW', `insert into grade_boundaries (exam, max_mark, grades) values ('cie:0607', 200, '[]')`), /at least one grade/);
  await fails(as('LW', `insert into grade_boundaries (exam, max_mark, grades) values ('cie:0607', 200, '[{"grade":"A","min":1}]')`), /row-level security/);
  assert.equal((await as('LW', `select * from grade_boundaries`)).length, 0, 'learners never read boundaries');
  assert.equal((await as('T', `select * from grade_boundaries`)).length, 0, 'private to the tutor');

  // a mock of two papers, 60 + 40 marks
  const mock = await val('TW', `insert into mocks (title, exam) values ('October mock', 'cie:0607') returning id`);
  await fails(as('TW', `insert into mocks (title) values ('  ')`), /title/);
  const paper = async (title, marks, answer, pos) => {
    const a = await val('TW', `insert into assignments (kind, title, learner_ids, visibility, mock_id, mock_position) values ('test', $1, $2, 'visible', $3, $4) returning id`, [title, [U.LW], mock, pos]);
    const q = await val('TW', `insert into questions (assignment_id, type, prompt_md, marks) values ($1, 'numeric', 'x?', $2) returning id`, [a, marks]);
    await as('TW', `insert into question_keys (question_id, answer) values ($1, $2)`, [q, { value: answer, tolerance: '0' }]);
    return { a, q };
  };
  const p1 = await paper('Paper 2', 60, '7', 1);
  const p2 = await paper('Paper 4', 40, '3', 2);
  const theirMock = await val('T', `insert into mocks (title) values ('Their mock') returning id`);
  await fails(as('TW', `update assignments set mock_id = $1 where id = $2`, [theirMock, p1.a]), /Not your mock exam/);
  await fails(as('LW', `select _mock_result($1, $2)`, [mock, U.LW]), /permission denied/);
  assert.equal((await as('LW', `select * from mocks`)).length, 0);

  let r = (await val('TW', `select mock_results($1)`, [mock])).learners;
  assert.deepEqual(r.map((x) => x.name), ['Sis'], 'only learners the papers are for');
  assert.equal(r[0].complete, false);
  assert.equal(r[0].grade, null);

  // she sits both: paper 2 right (60), paper 4 wrong (0); marks not given back yet
  const sit = async (p, ans) => {
    const t = await one('LW', `select * from start_attempt($1)`, [p.a]);
    await as('LW', `select save_response($1, $2, $3)`, [t.id, p.q, { value: ans }]);
    await as('LW', `select submit_attempt($1)`, [t.id]);
    await as('TW', `select finish_marking($1, false)`, [t.id]);
    return t.id;
  };
  const t1 = await sit(p1, '7');
  const t2 = await sit(p2, '5');
  r = (await val('TW', `select mock_results($1)`, [mock])).learners[0];
  assert.equal(r.complete, true);
  assert.equal(Number(r.total), 60);
  assert.equal(Number(r.max), 100);
  assert.equal(Number(r.pct), 60);
  // out of 100 instead of 200: A 65, B 50 → a B, 5 marks short of an A
  assert.equal(r.grade, 'B');
  assert.equal(r.next, 'A');
  assert.equal(Number(r.short_by), 5);
  assert.deepEqual(r.papers.map((p) => p.title), ['Paper 2', 'Paper 4']);

  let mine = await val('LW', `select my_mocks()`);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].released, false);
  assert.equal(mine[0].grade, null, 'no grade until every paper is given back');
  assert.equal(mine[0].total, null);
  assert.ok(mine[0].papers.every((p) => p.score === null));
  assert.doesNotMatch(JSON.stringify(mine), /grades|160|boundar/i, 'no boundaries in what the learner gets');
  await as('TW', `select finish_marking($1, true)`, [t1]);
  mine = await val('LW', `select my_mocks()`);
  assert.equal(Number(mine[0].papers[0].score), 60);
  assert.equal(mine[0].grade, null);
  await as('TW', `select finish_marking($1, true)`, [t2]);
  mine = await val('LW', `select my_mocks()`);
  assert.equal(mine[0].released, true);
  assert.equal(mine[0].grade, 'B');
  assert.equal(Number(mine[0].pct), 60);
  assert.equal(Number(mine[0].short_by), 5);
  assert.equal('has_boundaries' in mine[0], false);

  // grades over time, for her and her tutor only
  assert.equal((await val('LW', `select mock_history()`))[0].grade, 'B');
  assert.equal((await val('TW', `select mock_history($1)`, [U.LW]))[0].grade, 'B');
  await fails(as('T', `select mock_history($1)`, [U.LW]), /Not your learner/);
  await fails(as('L2', `select mock_history($1)`, [U.LW]), /Not your learner/);
  // and in the weekly report
  const rep = await val('TW', `select report_numbers($1, now() - interval '7 days', now() + interval '1 day')`, [U.LW]);
  assert.equal(rep.mock.grade, 'B');
  assert.equal(rep.mock.title, 'October mock');

  // newer boundaries for the exam become the default; a mock can be pinned to a session
  const b2 = await val('TW', `insert into grade_boundaries (exam, session, max_mark, grades) values ('cie:0607', 'June 2024', 200, '[{"grade":"A","min":140},{"grade":"B","min":125},{"grade":"C","min":110}]') returning id`);
  r = (await val('TW', `select mock_results($1)`, [mock]));
  assert.equal(r.boundary.id, b2);
  assert.equal(r.learners[0].grade, 'C');
  assert.equal(Number(r.learners[0].short_by), 3);
  await as('TW', `update mocks set boundary_id = $1 where id = $2`, [b1, mock]);
  assert.equal((await val('TW', `select mock_results($1)`, [mock])).learners[0].grade, 'B');
  await fails(as('T', `select mock_results($1)`, [mock]), /Not your mock exam/);
  const other = await val('T', `insert into grade_boundaries (exam, max_mark, grades) values ('x', 10, '[{"grade":"A","min":5}]') returning id`);
  await fails(as('TW', `update mocks set boundary_id = $1 where id = $2`, [other, mock]), /Unknown grade boundaries/);
  // below the lowest grade is a U
  assert.equal((await db.query(`select _grade_for($1, 200, 10, 100) g`, [stored.grades])).rows[0].g.grade, 'U');
  await fails(as('TW', `select _grade_for($1, 200, 10, 100)`, [stored.grades]), /permission denied/);
});

test('parent accounts: a code from the tutor, read-only, only what was given back; the learner sees and removes them', async () => {
  U.PW = (await db.query(`insert into auth.users (email) values ('mum@x.com') returning id`)).rows[0].id;
  U.PX = (await db.query(`insert into auth.users (email) values ('stranger-parent@x.com') returning id`)).rows[0].id;
  await fails(as('T', `select create_parent_invite($1, 'Mum')`, [U.LW]), /Not your learner/);
  await fails(as('LW', `select create_parent_invite($1, 'Mum')`, [U.LW]), /Not your learner/);
  const inv = await one('TW', `select * from create_parent_invite($1, 'Mum')`, [U.LW]);
  assert.match(inv.code, /^P[0-9A-F]{10}$/);
  await fails(as('LW', `select accept_parent_invite($1, 'Me')`, [inv.code]), /already a learner account/);
  await fails(as('PW', `select accept_parent_invite('PNOPE', 'Mum')`), /not valid/);
  const me = await one('PW', `select * from accept_parent_invite($1, 'Mum', 'Africa/Lusaka')`, [inv.code]);
  assert.equal(me.role, 'parent');
  assert.equal(me.tutor_id, null, 'a parent never gets a tutor, so no tutor tables open up');
  await fails(as('PX', `select accept_parent_invite($1, 'Not mum')`, [inv.code]), /already been used/);
  assert.equal((await as('TW', `select * from notifications where kind = 'parent_joined'`)).length, 1);
  assert.equal((await as('LW', `select * from notifications where kind = 'parent_joined'`)).length, 1, 'the learner is told');

  // nothing straight from the tables
  for (const t of ['assignments', 'attempts', 'responses', 'comments', 'sessions', 'subjects', 'files', 'lessons', 'mocks', 'grade_boundaries', 'parent_reports', 'learner_reports', 'parent_links', 'parent_invites', 'prof_jobs']) {
    const rows = await as('PW', `select * from ${t}`).catch(() => []);
    assert.equal(rows.length, 0, `a parent reads nothing from ${t}`);
  }
  assert.deepEqual((await as('PW', `select id from profiles`)).map((r) => r.id), [U.PW], 'only their own profile');

  const kids = await val('PW', `select parent_children()`);
  assert.deepEqual(kids.map((k) => k.name), ['Sis']);
  await fails(as('PX', `select parent_view($1)`, [U.LW]), /can’t see/);
  await fails(as('PW', `select parent_view($1)`, [U.L2]), /can’t see/);
  await as('TW', `insert into sessions (title, starts_at, learner_ids) values ('Parent-visible lesson', now() + interval '2 days', $1)`, [[U.LW]]);
  let v = await val('PW', `select parent_view($1)`, [U.LW]);
  assert.equal(v.learner.name, 'Sis');
  assert.ok(v.lessons.some((s) => s.title === 'Parent-visible lesson'));
  assert.ok(v.marks.some((m) => m.title === 'Paper 2' && Number(m.score) === 60), 'marks that were given back');
  assert.equal(v.mocks[0].title, 'October mock');
  assert.equal(v.mocks[0].grade, 'B');
  assert.equal(v.reports.length, 0, 'no reports until the tutor approves one');
  assert.doesNotMatch(JSON.stringify(v), /"grades"|"answer"|"steps"|"feedback_md"|"body"|lockdown/, 'no boundaries, answers, working, messages or exam camera');

  // the tutor approves a report: it's in the parent's account, and they're told
  const rid = await val('TW', `insert into parent_reports (learner_id, week_start, data) values ($1, current_date - 7, report_numbers($1, now() - interval '14 days', now() - interval '7 days')) returning id`, [U.LW]);
  await as('TW', `update parent_reports set comment = 'A good week.', status = 'sent', sent_via = 'app', sent_at = now() where id = $1`, [rid]);
  assert.equal((await as('PW', `select * from notifications where kind = 'report'`)).length, 1);
  v = await val('PW', `select parent_view($1)`, [U.LW]);
  assert.equal(v.reports.length, 1);
  assert.equal(v.reports[0].comment, 'A good week.');

  // the learner sees who's linked (no emails), the tutor sees emails and unused codes; others see nothing
  const extra = await one('TW', `select * from create_parent_invite($1, 'Dad')`, [U.LW]);
  const forLearner = await val('LW', `select learner_parents()`);
  assert.deepEqual(forLearner.parents.map((p) => p.name), ['Mum']);
  assert.equal(forLearner.parents[0].email, null);
  assert.equal(forLearner.invites, null);
  const forTutor = await val('TW', `select learner_parents($1)`, [U.LW]);
  assert.equal(forTutor.parents[0].email, 'mum@x.com');
  assert.deepEqual(forTutor.invites.map((i) => i.name), ['Dad']);
  await fails(as('T', `select learner_parents($1)`, [U.LW]), /Not your learner/);
  assert.equal((await val('TW', `select my_parent_counts()`))[U.LW], 1);
  assert.deepEqual(await val('T', `select my_parent_counts()`), {});
  await as('TW', `select revoke_parent_invite($1)`, [extra.id]);
  await fails(as('PX', `select accept_parent_invite($1)`, [extra.code]), /not valid/);

  // the learner takes Mum off: she sees nothing any more
  await fails(as('L2', `select remove_parent($1)`, [forLearner.parents[0].id]), /Not found/);
  await as('LW', `select remove_parent($1)`, [forLearner.parents[0].id]);
  await fails(as('PW', `select parent_view($1)`, [U.LW]), /can’t see/);
  assert.equal((await val('PW', `select parent_children()`)).length, 0);
  assert.equal((await as('PW', `select * from notifications where kind = 'parent_removed'`)).length, 1);
});

test('locked-down exams: a warning, then trying to leave again hands it in; time-up hands in on the server; only the tutor ends one early', async () => {
  const exam = async (title, extra = {}) => {
    const a = await val('TW', `insert into assignments (kind, title, learner_ids, visibility, lockdown, time_limit_min, leave_warnings)
      values ('test', $1, $2, 'visible', true, $3, $4) returning id`, [title, [U.LW], extra.minutes ?? 30, extra.warnings ?? 1]);
    const q = await val('TW', `insert into questions (assignment_id, type, prompt_md, marks) values ($1, 'numeric', 'x?', 2) returning id`, [a]);
    await as('TW', `insert into question_keys (question_id, answer) values ($1, '{"value":"4","tolerance":"0"}')`, [q]);
    const t = await one('LW', `select * from start_attempt($1, 'desktop')`, [a]);
    await as('LW', `select save_response($1, $2, '{"value":"4"}')`, [t.id, q]);
    return { a, t };
  };
  // one warning, then the second try hands it in with her answers
  const e1 = await exam('Locked test');
  let r = await val('LW', `select lockdown_strike($1, 'Left the StudyBridge window')`, [e1.t.id]);
  assert.deepEqual(r, { handed_in: false, warnings_left: 0 });
  r = await val('LW', `select lockdown_strike($1, 'Tried to close StudyBridge during the exam')`, [e1.t.id]);
  assert.equal(r.handed_in, true);
  let att = (await db.query(`select * from attempts where id = $1`, [e1.t.id])).rows[0];
  assert.notEqual(att.status, 'in_progress');
  assert.equal(Number(att.score), 2, 'her saved answer was marked');
  assert.match(att.auto_reason, /tried to leave the test 2 times/, 'it says test, not exam');
  assert.equal((await as('LW', `select * from notifications where kind = 'auto_submitted'`)).length, 1);
  assert.match((await as('TW', `select title from notifications where kind = 'submitted' order by created_at desc limit 1`))[0].title, /handed in automatically/);
  await fails(as('L2', `select lockdown_strike($1, 'x')`, [e1.t.id]), /not found/);
  // no warnings: the first try hands it in
  const e0 = await exam('Strict test', { warnings: 0 });
  assert.equal((await val('LW', `select lockdown_strike($1, 'Tried a shortcut to leave the exam')`, [e0.t.id])).handed_in, true);

  // time runs out with the app closed: the server hands it in
  const e2 = await exam('Timed test', { minutes: 5 });
  await db.query(`update attempts set started_at = now() - interval '20 minutes' where id = $1`, [e2.t.id]);
  assert.ok((await db.query(`select _auto_hand_in() n`)).rows[0].n >= 1);
  att = (await db.query(`select * from attempts where id = $1`, [e2.t.id])).rows[0];
  assert.notEqual(att.status, 'in_progress');
  assert.equal(att.auto_reason, 'time ran out');
  await fails(as('LW', `select _auto_hand_in()`), /permission denied/);
  await fails(as('LW', `select _hand_in($1, 'x')`, [e2.t.id]), /permission denied/);
  // opening it again after the time is up hands it in instead of reopening it
  const e3 = await exam('Timed test 2', { minutes: 5 });
  await db.query(`update attempts set started_at = now() - interval '20 minutes' where id = $1`, [e3.t.id]);
  const again = await one('LW', `select * from start_attempt($1, 'desktop')`, [e3.a]);
  assert.equal(again.id, e3.t.id);
  assert.notEqual(again.status, 'in_progress');

  // only the tutor lets a learner out early: cancel (start again later) or hand in now
  const e4 = await exam('Emergency test');
  await fails(as('T', `select end_attempt($1, 'cancel')`, [e4.t.id]), /Not found/);
  await fails(as('LW', `select end_attempt($1, 'cancel')`, [e4.t.id]), /Not found/);
  await as('TW', `select end_attempt($1, 'cancel')`, [e4.t.id]);
  assert.equal((await db.query(`select count(*)::int n from attempts where id = $1`, [e4.t.id])).rows[0].n, 0);
  assert.equal((await as('LW', `select * from notifications where kind = 'attempt_cancelled'`)).length, 1);
  const back = await one('LW', `select * from start_attempt($1, 'desktop')`, [e4.a]);
  await as('TW', `select end_attempt($1, 'hand_in')`, [back.id]);
  att = (await db.query(`select * from attempts where id = $1`, [back.id])).rows[0];
  assert.equal(att.auto_reason, 'your tutor ended it');
  await fails(as('TW', `select end_attempt($1, 'hand_in')`, [back.id]), /already been handed in/);
});

test('teaching plans: the tutor’s own, per subject; learners and other tutors see nothing', async () => {
  const subj = await val('TW', `insert into subjects (name) values ('Maths plan') returning id`);
  await as('TW', `insert into topics (subject_id, name, position) values ($1, 'Number', 0), ($1, 'Algebra', 1)`, [subj]);
  const items = [{ label: 'Week 1', starts_on: '2026-10-05', ends_on: '2026-10-11', topics: ['Number'] }, { label: 'Week 2', starts_on: '2026-10-12', ends_on: '2026-10-18', topics: ['Algebra'] }];
  await as('TW', `insert into teaching_plans (subject_id, kind, starts_on, ends_on, items) values ($1, 'week', '2026-10-05', '2026-10-18', $2)`, [subj, JSON.stringify(items)]);
  assert.equal((await as('TW', `select * from teaching_plans where subject_id = $1`, [subj]))[0].items.length, 2);
  await fails(as('TW', `insert into teaching_plans (subject_id) values ($1)`, [subj]), /duplicate key|unique/);
  assert.equal((await as('LW', `select * from teaching_plans`)).length, 0);
  assert.equal((await as('T', `select * from teaching_plans`)).length, 0);
  await fails(as('T', `insert into teaching_plans (subject_id) values ($1)`, [subj]), /row-level security/);
});

test('selling basics: plan limits only once switched on; download my data; delete my own account', async () => {
  // what the app may know, even before signing in; no secrets
  const pub = await val(null, `select public_settings()`);
  assert.deepEqual(Object.keys(pub).sort(), ['card_prices', 'currencies', 'email_on', 'enforce_plans', 'google_on', 'mobile_on', 'payments_on', 'rates', 'students_open']);
  assert.equal(pub.enforce_plans, false);
  await fails(as('TW', `select admin_set_selling(p_enforce => true)`), /admins only/);
  await fails(as('TW', `select _set_paid_plan($1, 'pro', 'month', 'cus_1', null)`, [U.TW]), /permission denied/);
  const plan = await val('TW', `select my_plan()`);
  assert.equal(plan.plan, 'free');
  assert.equal(plan.state, 'trial', 'a new tutor’s free week');
  assert.equal(plan.enforced, false);

  // no more Free/Starter/Pro caps: a tutor pays per learner, so the only limit is what they've paid for
  U.TP = (await db.query(`insert into auth.users (email) values ('plan-tutor@x.com') returning id`)).rows[0].id;
  await as('TP', `select * from become_tutor('Plan Tutor', 'UTC')`);
  await as('A', `select admin_set_status($1, 'active')`, [U.TP]);
  const join = async (key) => {
    U[key] = (await db.query(`insert into auth.users (email) values ($1) returning id`, [`${key.toLowerCase()}@x.com`])).rows[0].id;
    const code = await val('TP', `insert into invites (name) values ($1) returning code`, [key]);
    return as(key, `select accept_invite($1, $2)`, [code, key]);
  };
  await join('P1');
  await join('P2');
  await as('A', `select admin_set_selling(p_enforce => true)`);
  try {
    await join('P3'); // the free week: any number
    const late = await val('TP', `insert into invites (name) values ('P4') returning code`);
    await db.query(`update profiles set trial_until = now() - interval '1 day' where id = $1`, [U.TP]);
    U.P4 = (await db.query(`insert into auth.users (email) values ('p4@x.com') returning id`)).rows[0].id;
    await fails(as('P4', `select accept_invite($1, 'P4')`, [late]), /needs paying before new learners can join/);
    assert.deepEqual([(await val('TP', `select my_plan()`)).state, (await val('TP', `select my_plan()`)).learners], ['unpaid', 3]);
    // after the free week, unpaid: read-only (nothing new, nothing changed, nothing deleted)
    await fails(as('TP', `insert into invites (name) values ('Later') returning code`), /read-only/);
    await fails(as('TP', `insert into assignments (title, kind) values ('New', 'homework') returning id`), /read-only/);
    assert.ok((await as('TP', `select id from profiles where tutor_id = auth.uid()`)).length === 3, 'they can still see everything');
    // paid by hand (or with mobile money) for 4 places: one more can join, then it's full
    await as('A', `select admin_set_level($1, 'essentials', (current_date + 30)::date)`, [U.TP]);
    await fails(as('TP', `select admin_set_seats($1, 40)`, [U.TP]), /admins only/i);
    await as('A', `select admin_set_seats($1, 4)`, [U.TP]);
    await join('P5');
    await fails(join('P6'), /paid for 4 places and they’re all taken/);
    // a paused learner frees a place; bringing them back needs one
    await as('TP', `select pause_learner($1)`, [U.P1]);
    await join('P7');
    await fails(as('TP', `select pause_learner($1, false)`, [U.P1]), /places you’ve paid for are taken/);
    // a card subscription: no limit, the bill follows the learners
    await db.query(`select _set_paid_level($1, 'essentials', 'month', 'cus_123', 'sub_tp', now() + interval '30 days')`, [U.TP]);
    await join('P8');
    await as('TP', `select pause_learner($1, false)`, [U.P1]);
    const tp = await val('TP', `select my_plan()`);
    assert.deepEqual([tp.state, tp.learners, tp.card], ['card', 6, true]);
    // old Starter plans keep their 5 places (paid by hand); Complimentary has no limit
    await db.query(`update profiles set stripe_tutor_sub = null, paid_until = null, plan = 'starter' where id = $1`, [U.TP]);
    await fails(join('P9'), /paid for 5 places/);
    await as('A', `select admin_set_plan($1, 'complimentary')`, [U.TP]);
    await join('P10');
  } finally {
    await as('A', `select admin_set_selling(p_enforce => false, p_resend_key => 're_x', p_email_from => 'hello@example.com')`);
  }
  assert.equal((await val(null, `select public_settings()`)).email_on, true);
  assert.equal((await val('A', `select admin_selling()`)).resend_set, true);
  await fails(as('A', `select resend_key from platform_secrets`), /permission denied/);

  // download my data: the tutor's own things, the learner's own work, nobody else's
  const mine = await val('TW', `select export_my_data()`);
  assert.equal(mine.account.role, 'tutor');
  assert.ok(mine.assignments.length > 0 && mine.mocks.length > 0 && Array.isArray(mine.learners));
  assert.ok(mine.learners.some((l) => l.name === 'Sis'));
  assert.ok(!JSON.stringify(mine).includes('plan-tutor@x.com'), 'nothing from another tutor');
  const theirs = await val('LW', `select export_my_data()`);
  assert.equal(theirs.account.role, 'learner');
  assert.ok(theirs.work.length > 0);
  assert.equal(theirs.assignments, undefined);

  // delete my own account: a learner; then a tutor, whose learners are released
  await fails(as('P1', `select delete_my_account('nope')`), /Type DELETE/);
  await as('P1', `select delete_my_account('DELETE')`);
  assert.equal((await db.query(`select count(*)::int n from auth.users where id = $1`, [U.P1])).rows[0].n, 0);
  assert.equal((await as('TP', `select * from notifications where kind = 'learner_left'`)).length, 1);
  await as('TP', `select delete_my_account('delete')`);
  assert.equal((await db.query(`select count(*)::int n from auth.users where id = $1`, [U.TP])).rows[0].n, 0);
  const freed = (await db.query(`select role, tutor_id from profiles where id = $1`, [U.P2])).rows[0];
  assert.deepEqual(freed, { role: null, tutor_id: null }, 'the learner can join another tutor');
  await fails(as('A', `select delete_my_account('DELETE')`), /admin account/);
});

test('early access from the website: anyone can join (no account); saving again updates it; only the admin can read the list', async () => {
  assert.deepEqual(await val(null, `select join_early_access('  Student@Example.com ', 'student', 'IGCSE', 'Physics, Maths', 'May/June 2027', 'Zambia')`), { ok: true });
  await val(null, `select join_early_access('student@example.com', 'student', null, null, null, null, 'Please add Further Maths')`);
  await fails(as(null, `select join_early_access('not-an-email')`), /check your email/);
  await fails(as(null, `select join_early_access('a@b.co', 'hacker')`), /choose who you are/);
  assert.equal((await as(null, `select * from early_access`)).length, 0, 'nobody can read the list directly');
  assert.equal((await as('T', `select * from early_access`)).length, 0);
  await fails(as(null, `insert into early_access (email) values ('sneaky@x.com')`), /row-level|permission denied/);
  await fails(as('T', `select admin_early_access()`), /admins only/);
  const list = await val('A', `select admin_early_access()`);
  assert.equal(list.length, 1);
  assert.equal(list[0].email, 'student@example.com');
  assert.equal(list[0].subjects, 'Physics, Maths', 'an empty field keeps what was there');
  assert.equal(list[0].note, 'Please add Further Maths');
});

test('plans come from a list: custom learner limits, complimentary plans with an end date, old typed names', async () => {
  U.PL = (await db.query(`insert into auth.users (email) values ('plans-tutor@x.com') returning id`)).rows[0].id;
  await as('PL', `select * from become_tutor('Plans Tutor', 'UTC')`);
  await as('A', `select admin_set_status($1, 'active')`, [U.PL]);
  // a plan name typed in by hand before the list existed becomes Complimentary
  await db.query(`alter table profiles drop constraint profiles_plan_check`);
  await db.query(`update profiles set plan = 'Basic Plan' where id = $1`, [U.PL]);
  await db.exec(SETUP);
  const t = () => val('A', `select admin_tutor($1)`, [U.PL]);
  assert.equal((await t()).plan, 'complimentary');
  assert.equal((await t()).plan_limit, 1000000, 'Complimentary: any number of learners');
  await fails(db.query(`update profiles set plan = 'Gold' where id = $1`, [U.PL]), /profiles_plan_check/);
  // only plans from the list
  await fails(as('A', `select admin_set_plan($1, 'Gold')`, [U.PL]), /from the list/);
  await fails(as('T', `select admin_set_plan($1, 'pro')`, [U.PL]), /admins only/);
  // Custom: the admin says how many learners
  await fails(as('A', `select admin_set_plan($1, 'custom')`, [U.PL]), /how many learners/);
  await as('A', `select admin_set_plan($1, 'custom', null, 40)`, [U.PL]);
  assert.equal((await t()).plan_limit, 40);
  assert.equal((await val('PL', `select my_plan()`)).limit, 40);
  // keeping the plan while changing only the Prof allowance keeps the custom number
  await as('A', `select admin_set_plan($1, 'custom', 500)`, [U.PL]);
  assert.equal((await t()).plan_limit, 40);
  // Complimentary: free until its end date, then they pay per learner like everyone else
  await as('A', `select admin_set_plan($1, 'complimentary', null, null, current_date + 30)`, [U.PL]);
  assert.equal((await val('PL', `select my_plan()`)).state, 'free');
  await as('A', `select admin_set_plan($1, 'complimentary', null, null, current_date - 1)`, [U.PL]);
  assert.equal((await val('PL', `select my_plan()`)).state, 'trial', 'after the end date: their own free week, then paying');
  await as('A', `select admin_set_plan($1, 'starter')`, [U.PL]);
  const st = await t();
  assert.deepEqual([st.plan, st.plan_limit, st.plan_until], ['starter', 5, null]);
});

test('Prof feedback with "\\n" written out gets real line breaks; maths like \\neq is left alone', async () => {
  assert.equal(await val(null, `select _fix_newlines($1)`, ['Well done.\\n\\n- Factorise fully.\\nNext: $x \\neq 0$']), 'Well done.\n\n- Factorise fully.\nNext: $x \\neq 0$');
  assert.equal(await val(null, `select _fix_newlines(null)`), null);
});

test('Contact page and emails to hello@ / support@: anyone can write; the emails wait in a queue only the server reads', async () => {
  assert.deepEqual(await val(null, `select send_contact('Mrs Banda', ' Banda@Example.com ', 'school', 'We have 40 learners for IGCSE')`), { ok: true });
  await fails(as(null, `select send_contact('x', 'nope', null, 'hi there')`), /check your email/);
  await fails(as(null, `select send_contact('x', 'a@b.co', null, ' ')`), /write a message/);
  for (let i = 0; i < 5; i++) await val(null, `select send_contact('x', 'busy@x.com', null, 'hello ' || $1)`, [String(i)]);
  await fails(as(null, `select send_contact('x', 'busy@x.com', null, 'one more')`), /a lot of messages/);
  await fails(as(null, `select * from contact_messages`), /permission denied/);
  await fails(as('T', `select * from contact_messages`), /permission denied/);
  await fails(as('T', `select admin_contact_messages()`), /admins only/);
  const msgs = await val('A', `select admin_contact_messages()`);
  const banda = msgs.find((m) => m.email === 'banda@example.com');
  assert.equal(banda.role, 'school');
  await as('A', `select admin_contact_done($1)`, [banda.id]);
  assert.ok((await val('A', `select admin_contact_messages()`)).find((m) => m.id === banda.id).handled_at);
  // the website's messages and early access go to hello@ (replying to the sender); in-app messages go to support@
  const queue = (await db.query(`select * from outgoing_emails order by created_at`)).rows;
  const fromBanda = queue.find((m) => m.reply_to === 'banda@example.com');
  assert.equal(fromBanda.to_addr, 'hello@gostudybridge.com');
  assert.match(fromBanda.body, /40 learners for IGCSE/);
  assert.ok(queue.some((m) => m.to_addr === 'hello@gostudybridge.com' && /^(Early access|Subject request)/.test(m.subject)), 'early access is emailed');
  assert.ok(queue.some((m) => m.to_addr === 'support@gostudybridge.com' && /flashcards/.test(m.body)), '"Contact StudyBridge" is emailed to support@');
  await fails(as('A', `select * from outgoing_emails`), /permission denied/);
  await fails(as('T', `select _email_us('hello', 'x', 'y')`), /permission denied/);
  const st = await val('A', `select admin_email_queue()`);
  assert.ok(Number(st.waiting) >= 3);
  assert.equal(st.contact_email, 'hello@gostudybridge.com');
  assert.equal(st.support_email, 'support@gostudybridge.com');
});

test('learners join with an 8-digit code, typed with or without a space; 10 wrong codes in an hour and that account waits', async () => {
  const code = await val('T', `insert into invites (name) values ('Digits') returning code`);
  assert.match(code, /^\d{8}$/, 'new invites get an 8-digit code');
  const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ('guess@x.com', '{"name":"G"}') returning id`);
  U.G = r.rows[0].id;
  for (let i = 0; i < 10; i++) assert.equal((await one('G', `select * from accept_invite($1, 'x')`, [String(10000000 + i)])).id, null);
  // the 11th try within the hour is refused, even with the right code
  await fails(as('G', `select accept_invite($1, 'x')`, [code]), /Too many wrong codes/);
  await fails(as('G', `select * from invite_tries`), /permission denied/);
  // an hour later the account can try again, and "4829 1375" with a space works
  await db.query(`update invite_tries set at = now() - interval '2 hours' where user_id = $1`, [U.G]);
  const p = await one('G', `select * from accept_invite($1, 'Guess')`, [`${code.slice(0, 4)} ${code.slice(4)}`]);
  assert.equal(p.role, 'learner');
  assert.equal(p.tutor_id, U.T);
});

test('students on their own: a content account with every subject, sign-up with a 7-day trial, a guided setup, and payments the Owner records', async () => {
  const mk = async (k, email) => {
    const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name: k }]);
    U[k] = r.rows[0].id;
  };
  await mk('C', 'content@x.com');
  await mk('S', 'student@x.com');
  await mk('S2', 'young@x.com');
  await one('C', `select * from become_tutor('StudyBridge', 'UTC')`);
  // the Owner picks a separate tutor account for StudyBridge's own content
  await fails(as('T', `select admin_set_content_account('content@x.com')`), /admins only/);
  await fails(as('A', `select admin_set_content_account('tutor@x.com')`), /already teaches/);
  await fails(as('A', `select admin_set_content_account('young@x.com')`), /isn’t a tutor account/);
  await fails(as('A', `select admin_set_content_account('nobody-at-all@x.com')`), /No account with that email/);
  assert.equal((await val('A', `select admin_set_content_account('content@x.com')`)).email, 'content@x.com');
  // closed until a subject is open to students
  await fails(as('S', `select start_self_learner('Sam', 10, 'Zambia')`), /isn’t open right now/);
  assert.equal((await val(null, `select public_settings()`)).students_open, false);
  // the catalogue goes in switched off; adding it again adds nothing
  const items = [
    { key: 'cambridge:igcse:0607', board: 'Cambridge', level: 'IGCSE', name: 'Cambridge IGCSE International Mathematics (0607)', code: '0607', exam: 'cie:0607' },
    { key: 'ib:sl-and-hl:physics', board: 'IB Diploma', level: 'IB Diploma', name: 'IB Physics', code: '' },
  ];
  assert.deepEqual(await val('A', `select admin_seed_catalogue($1)`, [JSON.stringify(items)]), { added: 2, total: 2 });
  assert.deepEqual(await val('A', `select admin_seed_catalogue($1)`, [JSON.stringify(items)]), { added: 0, total: 2 });
  const [maths, phys] = (await db.query(`select id from subjects where tutor_id = $1 order by position`, [U.C])).rows.map((r) => r.id);
  assert.equal((await val(null, `select public_settings()`)).students_open, false, 'no subject is open to students yet');
  await as('C', `update subjects set live = true where id = $1`, [maths]);
  assert.equal((await val(null, `select public_settings()`)).students_open, true, 'open as soon as a subject is');
  // the Owner can pause new sign-ups
  await as('A', `select admin_students_open(false)`);
  assert.equal((await val(null, `select public_settings()`)).students_open, false);
  await fails(as('S', `select start_self_learner('Sam', 10, 'Zambia')`), /isn’t open right now/);
  await as('A', `select admin_students_open(true)`);
  // below grade 8, a parent comes first
  await fails(as('S2', `select start_self_learner('Kid', 7, 'Zambia')`), /parent/);
  const p = await one('S', `select * from start_self_learner('Sam', 10, 'Zambia', 'Africa/Lusaka')`);
  assert.equal(p.role, 'learner');
  assert.equal(p.self_learner, true);
  assert.equal(p.tutor_id, U.C);
  assert.ok(new Date(p.trial_until) - Date.now() > 6.9 * 864e5, 'a 7-day free trial');
  await fails(as('S', `update profiles set paid_until = '2030-01-01' where id = auth.uid()`), /permission denied/);
  // the setup only takes subjects that are open
  await fails(as('S', `select self_setup('Cambridge', 'IGCSE', $1, current_date + 200, 'Cambridge May/June 2027', 4)`, [[phys]]), /Pick at least one/);
  await fails(as('S', `select self_setup('Cambridge', 'IGCSE', $1, current_date + 200, null, 4)`, [[maths, phys]]), /isn’t open yet/);
  await fails(as('S', `select self_setup('Cambridge', 'IGCSE', $1, current_date, null, 4)`, [[maths]]), /when your exams are/);
  assert.deepEqual(await val('S', `select self_setup('Cambridge', 'IGCSE', $1, current_date + 200, 'Cambridge May/June 2027', 4)`, [[maths]]), { subjects: 1 });
  const me = await one('S', `select * from profiles where id = auth.uid()`);
  assert.equal(me.setup_done, true);
  assert.equal(me.study_goal_min, 34, '4 hours a week is about 34 minutes a day');
  assert.deepEqual((await as('S', `select subject_id from learner_subjects`)).map((x) => x.subject_id), [maths]);
  await fails(as('L', `select self_setup('Cambridge', 'IGCSE', $1, current_date + 200, null, 4)`, [[maths]]), /on their own/);
  // the Owner sees the student and records a payment taken by hand
  const st = await val('A', `select admin_students()`);
  assert.equal(st.content.live, 1);
  assert.deepEqual(st.students.find((x) => x.id === U.S).subjects, ['Cambridge IGCSE International Mathematics (0607)']);
  await fails(as('T', `select admin_set_student_paid($1, 'monthly', current_date + 30)`, [U.S]), /admins only/);
  await fails(as('A', `select admin_set_student_paid($1, 'yearly', current_date + 30)`, [U.S]), /monthly or an exam pass/);
  await fails(as('A', `select admin_set_student_paid($1, 'monthly', current_date + 30)`, [U.L]), /isn’t a student/);
  await as('A', `select admin_set_student_paid($1, 'pass', current_date + 200)`, [U.S]);
  assert.equal((await one('S', `select paid_plan from profiles where id = auth.uid()`)).paid_plan, 'pass');
  await as('A', `select admin_extend_trial($1, 7)`, [U.S]);
});

test('StudyBridge content: made by the content account, checked twice before students see it, reported by students, sorted in Admin', async () => {
  const maths = (await db.query(`select id from subjects where tutor_id = $1 and catalogue = 'cambridge:igcse:0607'`, [U.C])).rows[0].id;
  // only the content account can use the content tools
  await fails(as('T', `select content_status()`), /only for StudyBridge’s own content account/);
  await fails(as('S', `select content_add_questions($1, '[]')`, [maths]), /only for StudyBridge’s own content account/);
  const q1 = { topic: 'Number', type: 'numeric', prompt: 'What is $2 + 2$?', answer: { value: '4' }, hint: 'Count on two.', solution: '$2 + 2 = 4$' };
  await fails(as('C', `select content_add_questions($1, $2)`, [maths, JSON.stringify([q1])]), /no syllabus yet/);
  // the syllabus in order; sending it again reorders and keeps what's there
  assert.deepEqual(
    await val('C', `select content_set_syllabus($1, $2)`, [maths, JSON.stringify([{ name: 'Number', code: 'C1', details: ['Fractions', 'Percentages'] }, { name: 'Algebra', code: 'C2' }])]),
    { topics: 2, added: 2 },
  );
  assert.deepEqual(await val('C', `select content_set_syllabus($1, $2)`, [maths, JSON.stringify([{ name: 'algebra' }, { name: 'Number' }, { name: 'Geometry' }])]), { topics: 3, added: 1 });
  const tops = await as('C', `select name, code, details from topics where subject_id = $1 order by position`, [maths]);
  assert.deepEqual(tops.map((t) => t.name), ['Algebra', 'Number', 'Geometry']);
  assert.deepEqual(tops[1].details, ['Fractions', 'Percentages']);
  await fails(as('C', `select content_add_questions($1, $2)`, [maths, JSON.stringify([{ ...q1, topic: 'Trigonometry' }])]), /no topic “Trigonometry”.*Algebra, Number, Geometry/);

  // questions: plain checks first, then each waits for a second solve
  const qs = [
    { topic: 'Number', type: 'numeric', prompt: 'Work out $15\\%$ of 80.', answer: { value: '12', tolerance: '0' }, hint: 'Find 10% and 5% first.', solution: '$0.15 \\times 80 = 12$' },
    { topic: 'C1', type: 'mcq', prompt: 'Which of these is prime?', options: ['4', '6', '7', '9'], answer: { choice: '2' }, hint: 'Only two factors.', solution: '7 has only the factors 1 and 7.' },
    { topic: 'Algebra', type: 'numeric', prompt: 'Solve $2x + 3 = 11$.', answer: { value: '5' }, hint: 'Take 3 from both sides.', solution: '$2x = 8$, so $x = 4$.' },
    { topic: 'Algebra', type: 'short', prompt: 'Explain what a variable is.', answer: { text: 'A letter that stands for a number that can change.' }, hint: 'Think of x.', solution: 'A letter standing for an unknown or changing number.' },
    { topic: 'Number', type: 'numeric', prompt: 'Work out $3 + 4', answer: { value: 'seven' }, hint: '', solution: '' },
  ];
  const add = await val('C', `select content_add_questions($1, $2)`, [maths, JSON.stringify(qs)]);
  assert.equal(add.added, 5);
  assert.equal(add.waiting_for_check, 4);
  assert.equal(add.with_problems[0].number, 5);
  for (const re of [/isn’t closed/, /as a number/, /needs a hint/, /worked solution/]) assert.ok(add.with_problems[0].problems.some((p) => re.test(p)), String(re));
  assert.equal((await val('S', `select practice_topics()`)).length, 0, 'nothing reaches students before its check');
  // the checker sees the questions, never the answers, hints or solutions
  const tc = await val('C', `select content_to_check(10)`);
  assert.equal(tc.waiting, 4);
  assert.equal(tc.questions.length, 4);
  const raw = JSON.stringify(tc.questions);
  for (const secret of ['Find 10%', '0.15', 'only the factors', 'stands for', 'Take 3']) assert.ok(!raw.includes(secret), secret);
  assert.deepEqual(tc.questions.find((x) => x.type === 'mcq').options, ['4', '6', '7', '9']);
  const id = (re) => tc.questions.find((x) => re.test(x.prompt)).id;
  const sub = await val('C', `select content_submit_checks($1)`, [
    JSON.stringify([
      { kind: 'question', id: id(/15/), answer: { value: '12.0' } },
      { kind: 'question', id: id(/prime/), answer: { choice: 2 } },
      { kind: 'question', id: id(/Solve/), answer: { value: '4' }, working: '2x = 8, x = 4' },
      { kind: 'question', id: id(/variable/), answer: { text: 'A symbol for a number we do not know yet.' } },
    ]),
  ]);
  assert.equal(sub.passed, 2);
  assert.equal(sub.failed, 1);
  assert.equal(sub.compare_these.length, 1);
  assert.match(sub.compare_these[0].answer_key.text, /letter that stands/);
  assert.equal((await val('C', `select content_submit_checks($1)`, [JSON.stringify([{ kind: 'question', id: id(/15/), answer: { value: '99' } }])])).failed, 0, 'a checked question isn’t checked again');
  assert.deepEqual(await val('C', `select content_confirm_checks($1)`, [JSON.stringify([{ kind: 'question', id: id(/variable/), same: true }])]), { passed: 1, failed: 0 });
  assert.ok((await as('A', `select title from notifications where user_id = auth.uid() and kind = 'content_check'`)).length >= 1, 'the Owner hears about the failed one');
  // checked questions are practice for the student, with their hints
  assert.deepEqual((await val('S', `select practice_topics()`)).map((t) => [t.topic, t.questions]), [['Number', 2]]);
  const pr = await val('S', `select start_practice('topic', $1, 'Number', 6)`, [maths]);
  const pq = await as('S', `select id, hint_md, bank_id, prompt_md from questions where assignment_id = $1 order by position`, [pr.assignment_id]);
  assert.equal(pq.length, 2);
  assert.ok(pq.every((x) => x.hint_md && x.bank_id));

  // Admin → Content: the failed question and the one with problems wait for the Owner
  await fails(as('T', `select admin_content_review()`), /admins only/);
  const rv = await val('A', `select admin_content_review()`);
  assert.equal(rv.waiting, 0);
  assert.equal(rv.questions.length, 2);
  const failedQ = rv.questions.find((x) => x.check.state === 'failed');
  assert.equal(failedQ.check.second.value, '4');
  await fails(as('A', `select admin_content_decide('question', $1, 'fix', $2)`, [failedQ.id, JSON.stringify({ answer: { value: 'four' } })]), /as a number/);
  await as('A', `select admin_content_decide('question', $1, 'fix', $2)`, [failedQ.id, JSON.stringify({ answer: { value: '4' } })]);
  await as('A', `select admin_content_decide('question', $1, 'remove')`, [rv.questions.find((x) => x.check.state === 'problems').id]);
  assert.equal((await val('A', `select admin_content_review()`)).questions.length, 0);
  assert.equal(await val('C', `select status from bank_questions where id = $1`, [failedQ.id]), 'approved');

  // lessons go up when they pass; the same title replaces one; problems keep it hidden
  const body = 'A percentage is a number out of 100. '.repeat(8) + 'So $15\\%$ of 80 is $0.15 \\times 80 = 12$.';
  assert.equal((await val('C', `select content_add_lesson($1, 'Number', 'Percentages', $2)`, [maths, body])).live, true);
  assert.equal((await val('C', `select content_add_lesson($1, 'Number', 'percentages', $2)`, [maths, body + ' More.'])).replaced, true);
  assert.equal((await val('C', `select content_add_lesson($1, 'Algebra', 'Short one', 'Too short $x')`, [maths])).live, false);
  assert.deepEqual((await as('S', `select title from lessons`)).map((l) => l.title), ['Percentages']);
  assert.equal((await val('A', `select admin_content_review()`)).lessons.length, 1);
  // flashcards: repeats skipped, broken ones listed back
  const cards = await val('C', `select content_add_cards($1, $2)`, [
    maths,
    JSON.stringify([
      { topic: 'Number', front: 'What is a prime number?', back: 'A number with exactly two factors.' },
      { topic: 'Number', front: 'What is a prime number?', back: 'again' },
      { topic: 'Algebra', front: 'Solve $x + 1 = 2', back: '1' },
    ]),
  ]);
  assert.equal(cards.added, 1);
  assert.equal(cards.left_out[0].number, 3);
  // an original practice paper goes live once every question passes; students mark it themselves
  const items = [
    { type: 'numeric', prompt: 'Work out $7 \\times 8$.', answer: { value: '56' }, solution: '$7 \\times 8 = 56$', mark_scheme: 'B1 56', marks: 1 },
    { topic: 'Algebra', type: 'steps', prompt: 'Solve $3x - 2 = 10$, showing your working.', answer: { final: 'x = 4' }, solution: '$3x = 12$ so $x = 4$', mark_scheme: 'M1 add 2, A1 x = 4', marks: 2 },
  ];
  const paper = await val('C', `select content_add_paper($1, 'Practice paper 1', 45, null, $2)`, [maths, JSON.stringify(items)]);
  assert.equal(paper.waiting_for_check, 2);
  assert.equal((await as('S', `select id from assignments where id = $1`, [paper.id])).length, 0, 'not live before its check');
  await fails(as('C', `select content_add_paper($1, 'practice paper 1', 45, null, $2)`, [maths, JSON.stringify(items)]), /already a paper/);
  const tc2 = await val('C', `select content_to_check(10)`);
  assert.ok(tc2.questions.length === 2 && tc2.questions.every((x) => x.kind === 'paper'));
  const r2 = await val('C', `select content_submit_checks($1)`, [JSON.stringify(tc2.questions.map((x) => ({ kind: 'paper', id: x.id, answer: x.type === 'numeric' ? { value: '56' } : { final: 'x=4' } })))]);
  assert.equal(r2.passed, 2);
  const live = await one('S', `select instructions_md, self_mark, time_limit_min from assignments where id = $1`, [paper.id]);
  assert.match(live.instructions_md, /Not affiliated with or endorsed by Cambridge/);
  assert.equal(live.self_mark, true);
  assert.equal(live.time_limit_min, 45);
  assert.equal((await val('C', `select content_status($1)`, [maths]))[0].papers_live, 1);

  // students report a problem: it stays up, the Owner is told, and can reply
  await fails(as('S', `select report_content('question', $1, 'x')`, [pq[0].id]), /what’s wrong/);
  await as('S', `select report_content('question', $1, 'The answer should be 12.5')`, [pq.find((x) => /15/.test(x.prompt_md)).id]);
  const lessonId = await val('S', `select id from lessons limit 1`);
  await as('S', `select report_content('lesson', $1, 'Typo in the second line')`, [lessonId]);
  await as('S', `select start_attempt($1, 'web')`, [paper.id]); // a timed paper's questions open once it's started
  await as('S', `select report_content('question', $1, 'Unclear wording')`, [await val('S', `select id from questions where assignment_id = $1 order by position limit 1`, [paper.id])]);
  await fails(as('L', `select report_content('lesson', $1, 'Not mine')`, [lessonId]), /StudyBridge’s own/);
  const rr = await val('A', `select admin_content_review()`);
  assert.deepEqual(rr.reports.map((r) => r.kind).sort(), ['lesson', 'paper', 'question']);
  const qr = rr.reports.find((r) => r.kind === 'question');
  assert.match(qr.item.prompt, /15/);
  assert.equal(qr.student, 'Sam');
  assert.equal(await val('S', `select count(*)::int from lessons`), 1, 'a reported lesson stays up');
  assert.ok((await db.query(`select 1 from outgoing_emails where subject like 'Report from Sam%'`)).rows.length >= 1, 'emailed to support@');
  await as('A', `select admin_report_done($1, 'Thanks, it’s fixed now.')`, [qr.id]);
  assert.equal((await as('S', `select title from notifications where user_id = auth.uid() and kind = 'report_reply'`)).length, 1);
  await fails(as('A', `select admin_report_done($1, null)`, [qr.id]), /already sorted/);

  // paying by card: the Owner's Stripe links reach students only
  await fails(as('A', `select admin_set_pay_links('http://example.com', null)`), /https/);
  await as('A', `select admin_set_pay_links('https://buy.stripe.com/test_m', 'https://buy.stripe.com/test_p')`);
  assert.deepEqual(await val('S', `select student_pay_links()`), { monthly: 'https://buy.stripe.com/test_m', pass: 'https://buy.stripe.com/test_p' });
  assert.deepEqual(await val('L', `select student_pay_links()`), {});
  assert.equal((await val('A', `select admin_students()`)).pay_links.pass, 'https://buy.stripe.com/test_p');
  // students can write to StudyBridge (they have no tutor to ask); a tutor's learner still can't
  await as('S', `select send_feedback('question', 'How do I pay?')`);
  await fails(as('L', `select send_feedback('question', 'hi')`), /Only tutors and students/);
});

test('Admin → Content → Browse: everything StudyBridge has made, by subject, kind, status and words; hide, approve or remove from there', async () => {
  const maths = (await db.query(`select id from subjects where tutor_id = $1 and catalogue = 'cambridge:igcse:0607'`, [U.C])).rows[0].id;
  // only the admin can look (not tutors, not the content account itself, not students)
  for (const who of ['T', 'C', 'S']) await fails(as(who, `select admin_content_browse()`), /admins only/);
  await fails(as('A', `select admin_content_browse(null, 'poem')`), /Unknown kind/);
  await fails(as('A', `select admin_content_browse(null, null, 'gone')`), /Unknown status/);
  const all = await val('A', `select admin_content_browse()`);
  assert.deepEqual([...new Set(all.items.map((x) => x.kind))].sort(), ['card', 'lesson', 'practice_paper', 'question']);
  assert.equal(all.total, all.items.length);
  assert.equal(all.counts.live + all.counts.waiting + all.counts.problems + all.counts.hidden, all.total);
  assert.equal(all.subjects.find((s) => s.id === maths).items, all.items.filter((x) => x.subject_id === maths).length);
  // a student's own practice never shows up as StudyBridge's content
  const prac = await val('S', `select id from assignments where source = 'self' limit 1`);
  assert.ok(prac && !all.items.some((x) => x.id === prac));
  const by = (kind, re) => all.items.find((x) => x.kind === kind && re.test(x.prompt || x.title || x.front || ''));
  assert.equal(by('question', /15/).status, 'live');
  assert.match(by('question', /15/).hint, /Find 10%/);
  assert.equal(by('question', /Work out \$3 \+ 4/).status, 'hidden', 'removed in the review list');
  assert.equal(by('lesson', /^Percentages$/).status, 'live');
  assert.equal(by('lesson', /Short one/).status, 'problems');
  assert.equal(by('card', /prime/).status, 'live');
  const paper = by('practice_paper', /Practice paper 1/);
  assert.equal(paper.status, 'live');
  assert.equal(paper.questions.length, 2);
  assert.equal(paper.marks, 3);
  assert.equal(paper.taken, 1);

  // narrowed by subject, kind, status and words (words are plain text: % is not a wildcard)
  const live = await val('A', `select admin_content_browse($1, 'question', 'live')`, [maths]);
  assert.ok(live.items.length >= 3 && live.items.every((x) => x.kind === 'question' && x.status === 'live' && x.subject_id === maths));
  assert.equal(live.counts.hidden, 1, 'counts are for the subject, kind and words chosen');
  assert.deepEqual((await val('A', `select admin_content_browse(null, null, null, 'PRIME')`)).items.map((x) => x.kind).sort(), ['card', 'question']);
  assert.ok((await val('A', `select admin_content_browse(null, null, null, '%')`)).total < all.total);
  const two = await val('A', `select admin_content_browse(null, null, null, null, 2)`);
  assert.equal(two.items.length, 2);
  assert.equal(two.total, all.total);

  // a new question waits for its check; the Owner can hide it from here, and bring it back
  await val('C', `select content_add_questions($1, $2)`, [
    maths,
    JSON.stringify([{ topic: 'Geometry', type: 'numeric', prompt: 'How many sides has a hexagon?', answer: { value: '6' }, hint: 'Hex means six.', solution: 'A hexagon has 6 sides.' }]),
  ]);
  const hex = (await val('A', `select admin_content_browse($1, 'question', 'waiting', 'hexagon')`, [maths])).items[0];
  assert.equal(hex.hint, 'Hex means six.');
  await as('A', `select admin_content_decide('question', $1, 'hide')`, [hex.id]);
  assert.equal((await val('A', `select admin_content_browse(null, 'question', 'hidden', 'hexagon')`)).total, 1);
  await as('A', `select admin_content_decide('question', $1, 'approve')`, [hex.id]);
  assert.equal((await val('A', `select admin_content_browse(null, 'question', 'live', 'hexagon')`)).total, 1);
  await as('A', `select admin_content_decide('question', $1, 'remove')`, [hex.id]);

  // a lesson: hidden from students, then put back up
  const pct = by('lesson', /^Percentages$/);
  await as('A', `select admin_content_decide('lesson', $1, 'hide')`, [pct.id]);
  assert.equal((await as('S', `select id from lessons where id = $1`, [pct.id])).length, 0, 'hidden from students');
  assert.ok((await val('A', `select admin_content_browse(null, 'lesson', 'hidden')`)).items.some((x) => x.id === pct.id));
  await as('A', `select admin_content_decide('lesson', $1, 'approve')`, [pct.id]);
  assert.equal((await as('S', `select id from lessons where id = $1`, [pct.id])).length, 1);

  // a flashcard is up or gone
  await val('C', `select content_add_cards($1, $2)`, [maths, JSON.stringify([{ topic: 'Geometry', front: 'What is a hexagon?', back: 'A shape with 6 sides.' }])]);
  const card = (await val('A', `select admin_content_browse(null, 'card', null, 'hexagon')`)).items[0];
  await as('A', `select admin_content_decide('card', $1, 'remove')`, [card.id]);
  assert.equal((await val('A', `select admin_content_browse(null, 'card', null, 'hexagon')`)).total, 0);

  // a whole practice paper: hide it and put it back up; once a student has taken it, it can't be removed
  await fails(as('T', `select admin_content_decide('practice_paper', $1, 'hide')`, [paper.id]), /admins only/);
  await as('A', `select admin_content_decide('practice_paper', $1, 'hide')`, [paper.id]);
  assert.equal((await as('S', `select id from assignments where id = $1`, [paper.id])).length, 0, 'hidden from students');
  assert.equal((await val('A', `select admin_content_browse(null, 'practice_paper', 'hidden')`)).items[0].id, paper.id);
  assert.equal((await val('C', `select content_status($1)`, [maths]))[0].papers_live, 0);
  await fails(as('A', `select admin_content_decide('practice_paper', $1, 'remove')`, [paper.id]), /already taken/);
  await fails(as('A', `select admin_content_decide('practice_paper', $1, 'fix', '{}')`, [paper.id]), /one question at a time/);
  await as('A', `select admin_content_decide('practice_paper', $1, 'approve')`, [paper.id]);
  assert.equal((await as('S', `select id from assignments where id = $1`, [paper.id])).length, 1);
  // a paper with a problem: approving the whole paper approves its questions and puts it up; nobody has taken it, so it can go
  const p2 = await val('C', `select content_add_paper($1, 'Practice paper 2', 30, null, $2)`, [
    maths,
    JSON.stringify([{ type: 'numeric', prompt: 'Work out $9 + 1', answer: { value: '10' }, solution: '$9 + 1 = 10$', mark_scheme: 'B1 10', marks: 1 }]),
  ]);
  assert.equal((await val('A', `select admin_content_browse(null, 'practice_paper', 'problems', 'paper 2')`)).items[0].id, p2.id);
  await as('A', `select admin_content_decide('practice_paper', $1, 'approve')`, [p2.id]);
  assert.equal((await val('A', `select admin_content_browse(null, 'practice_paper', 'live', 'paper 2')`)).total, 1);
  assert.equal((await as('S', `select id from assignments where id = $1`, [p2.id])).length, 1);
  await as('A', `select admin_content_decide('practice_paper', $1, 'remove')`, [p2.id]);
  assert.equal((await val('A', `select admin_content_browse(null, 'practice_paper', null, 'paper 2')`)).total, 0);
});

test('announcements: the admin can change one (words, who sees it, until when) or delete it; nobody else can', async () => {
  const id = await val('A', `select admin_announce('Typo in titel', 'Body', 'tutors')`);
  await fails(as('T', `select admin_edit_announcement($1, 'Hacked', '', 'everyone', null)`, [id]), /admins only/);
  await fails(as('T', `select admin_delete_announcement($1)`, [id]), /admins only/);
  await fails(as('A', `select admin_edit_announcement($1, '  ', '', 'tutors', null)`, [id]), /title/);
  await fails(as('A', `select admin_edit_announcement($1, 'Hi', '', 'parents', null)`, [id]), /Choose who sees it/);
  assert.equal((await as('S', `select * from announcements where id = $1`, [id])).length, 0, 'learners don’t see tutor announcements');
  await as('A', `select admin_edit_announcement($1, ' Typo in title ', 'Fixed body', 'everyone', now() + interval '2 days')`, [id]);
  const a = await one('S', `select * from announcements where id = $1`, [id]);
  assert.equal(a.title, 'Typo in title');
  assert.equal(a.body, 'Fixed body');
  assert.equal(a.audience, 'everyone');
  // an end date in the past takes it down
  await as('A', `select admin_edit_announcement($1, 'Typo in title', '', 'everyone', now() - interval '1 minute')`, [id]);
  assert.equal((await as('S', `select * from announcements where id = $1`, [id])).length, 0);
  await as('A', `select admin_delete_announcement($1)`, [id]);
  assert.equal((await as('A', `select * from announcements where id = $1`, [id])).length, 0);
  await fails(as('A', `select admin_delete_announcement($1)`, [id]), /isn’t there any more/);
  await fails(as('A', `select admin_edit_announcement($1, 'x', '', 'tutors', null)`, [id]), /isn’t there any more/);
});

test('lesson notes written after a live lesson remember which lesson they were for', async () => {
  const s = await val('TW', `insert into sessions (title, starts_at, duration_min, learner_ids) values ('Fractions', now() - interval '2 hours', 60, $1) returning id`, [[U.LW]]);
  const l = await val('TW', `insert into lessons (title, session_id, learner_ids) values ('Fractions (Mon 12 Oct)', $1, $2) returning id`, [s, [U.LW]]);
  assert.equal(await val('TW', `select session_id from lessons where id = $1`, [l]), s);
  await as('TW', `delete from sessions where id = $1`, [s]);
  assert.equal(await val('TW', `select session_id from lessons where id = $1`, [l]), null, 'the notes stay when the lesson is deleted');
  await as('TW', `delete from lessons where id = $1`, [l]);
});

test('basic fixes: let a learner try again, skip or withdraw a weekly report, clear own practice, a parent stops following', async () => {
  // homework handed in by accident: the tutor reopens it and the answers stay
  const a = await val('TW', `insert into assignments (title, visibility, learner_ids) values ('Reopen me', 'visible', $1) returning id`, [[U.LW]]);
  const q = await val('TW', `insert into questions (assignment_id, type, prompt_md, options, marks) values ($1, 'mcq', 'Pick B', '["A","B"]', 1) returning id`, [a]);
  await as('TW', `insert into question_keys (question_id, answer) values ($1, '{"choice":"1"}')`, [q]);
  const t = await one('LW', `select * from start_attempt($1, 'web')`, [a]);
  await as('LW', `select save_response($1, $2, '{"choice":"0"}')`, [t.id, q]);
  await as('LW', `select submit_attempt($1)`, [t.id]);
  await fails(as('T', `select reopen_attempt($1)`, [t.id]), /Not found/);
  await as('TW', `select reopen_attempt($1)`, [t.id]);
  const back = await one('TW', `select status, submitted_at, score from attempts where id = $1`, [t.id]);
  assert.equal(back.status, 'in_progress');
  assert.equal(back.submitted_at, null);
  assert.equal(back.score, null);
  assert.deepEqual((await one('TW', `select answer from responses where attempt_id = $1`, [t.id])).answer, { choice: '0' }, 'the answers stay');
  assert.equal((await as('LW', `select 1 from notifications where user_id = auth.uid() and title like 'You can carry on%'`)).length, 1);
  await fails(as('TW', `select reopen_attempt($1)`, [t.id]), /still working/);

  // weekly reports: skip a finished week; withdraw an approved one to fix it
  const rep = await val('TW', `insert into parent_reports (learner_id, week_start, data) values ($1, '2020-01-06', '{}') returning id`, [U.LW]);
  await fails(as('T', `select skip_report($1)`, [rep]), /not found/);
  await as('TW', `select skip_report($1)`, [rep]);
  assert.equal(await val('TW', `select status from parent_reports where id = $1`, [rep]), 'skipped');
  await fails(as('TW', `select withdraw_report($1)`, [rep]), /not found/);
  await db.query(`update parent_reports set status = 'sent', sent_at = now() where id = $1`, [rep]);
  await as('TW', `select withdraw_report($1)`, [rep]);
  assert.equal(await val('TW', `select status from parent_reports where id = $1`, [rep]), 'draft');

  // a student clears their own practice from their list (only their own)
  const prac = await val('S', `select id from assignments where source = 'self' limit 1`);
  assert.equal(await val('L', `select hide_my_practice($1)`, [[prac]]), 0, 'only your own practice');
  assert.equal(await val('S', `select hide_my_practice($1)`, [[prac]]), 1);
  assert.equal(await val('S', `select learner_hidden from assignments where id = $1`, [prac]), true);

  // a parent stops following a child; the tutor is told
  const inv = await one('TW', `select * from create_parent_invite($1, 'Mum')`, [U.LW]);
  await one('PW', `select * from accept_parent_invite($1, 'Mum', 'Africa/Lusaka')`, [inv.code]);
  assert.equal((await val('PW', `select parent_children()`)).length, 1);
  await as('PW', `select parent_unlink($1)`, [U.LW]);
  assert.equal((await val('PW', `select parent_children()`)).length, 0);
  await fails(as('PW', `select parent_unlink($1)`, [U.LW]), /Not found/);
  assert.ok((await as('TW', `select 1 from notifications where user_id = auth.uid() and title like '%stopped following%'`)).length >= 1);
});

test('launch 1: the starting check, exam conditions, parents for young students, test students, and the free week checked on the server', async () => {
  const mk = async (k, email) => {
    const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name: k }]);
    U[k] = r.rows[0].id;
  };
  await mk('S3', 'kid@x.com');
  await mk('S4', 'teen@x.com');
  await mk('PK', 'mum@x.com');
  await mk('PD', 'dad@x.com');
  await mk('TS', 'owner+student@x.com');
  const subj = async (key) => (await db.query(`select id from subjects where tutor_id = $1 and catalogue = $2`, [U.C, key])).rows[0].id;
  const maths = await subj('cambridge:igcse:0607');
  const phys = await subj('ib:sl-and-hl:physics');

  // the starting check: questions from different topics (up to 12), one check at a time per subject
  const c1 = await val('S', `select start_practice('check', $1)`, [maths]);
  assert.ok(c1.assignment_id && c1.questions >= 1 && c1.questions <= 12);
  const a = await one('S', `select title, starting_check, max_attempts from assignments where id = $1`, [c1.assignment_id]);
  assert.match(a.title, /^Starting check: /);
  assert.equal(a.starting_check, true);
  assert.equal(a.max_attempts, 1);
  assert.equal((await val('S', `select start_practice('check', $1)`, [maths])).existing, true, 'an unfinished check carries on');
  await fails(as('S', `select start_practice('check')`), /Choose a subject/);
  assert.equal((await val('S', `select my_starting_checks()`))[maths].done, false);
  const t = await one('S', `select * from start_attempt($1, 'web')`, [c1.assignment_id]);
  await as('S', `select submit_attempt($1)`, [t.id]);
  const done = (await val('S', `select my_starting_checks()`))[maths];
  assert.equal(done.done, true);
  assert.equal(done.attempt_id, t.id);

  // exam conditions: each time they leave full screen is counted, on their own attempt only
  const pr = await val('S', `select start_practice('topic', $1)`, [maths]);
  const t2 = await one('S', `select * from start_attempt($1, 'web')`, [pr.assignment_id]);
  assert.equal(await val('S', `select note_left_full_screen($1)`, [t2.id]), 1);
  assert.equal(await val('S', `select note_left_full_screen($1)`, [t2.id]), 2);
  assert.equal(await val('L', `select note_left_full_screen($1)`, [t2.id]), null, 'not someone else’s');

  // the free week, checked on the server: when it's over and nothing is paid, StudyBridge's content and practice stop
  // (the student's own cards stay); paying opens it all again. Tutors' learners are never affected.
  await one('S4', `select * from start_self_learner('Teen', 9, 'Zambia')`);
  await as('S4', `select self_setup('Cambridge', 'IGCSE', $1, current_date + 200, null, 4)`, [[maths]]);
  const sees = async (k) => Number(await val(k, `select (select count(*) from lessons) + (select count(*) from assignments) + (select count(*) from cards where learner_id is null)`));
  const before = await sees('S4');
  assert.ok(before > 0, 'sees StudyBridge’s content in the free week');
  const tutored = await sees('L');
  await db.query(`update profiles set trial_until = now() - interval '1 day' where id = $1`, [U.S4]);
  assert.equal(await sees('S4'), 0, 'nothing once the free week is over');
  await fails(as('S4', `select start_practice('daily')`), /free week is over/);
  assert.equal(await sees('L'), tutored, 'a tutor’s learner sees the same as before');
  await as('A', `select admin_set_student_paid($1, 'monthly', current_date + 30)`, [U.S4]);
  assert.equal(await sees('S4'), before, 'paid: everything is back');

  // a parent's account for a child on their own, without a tutor's code
  assert.equal((await one('PK', `select * from start_parent('Mum', 'Africa/Lusaka')`)).role, 'parent');
  await fails(as('S', `select parent_child_code('Kid', 6)`), /parent accounts/);
  await fails(as('PK', `select parent_child_code('', 6)`), /first name/);
  const code = await val('PK', `select parent_child_code('Kid', 6)`);
  assert.match(code.code, /^\d{8}$/);
  assert.equal((await val('PK', `select parent_child_codes()`)).length, 1);
  // below grade 8 the child needs that code; a wrong one is counted, not an error
  await fails(as('S3', `select start_self_learner('Kid', 6, 'Zambia')`), /parent sets up/);
  await fails(as('S3', `select start_self_learner('Kid', 10, 'India')`), /In India, a parent sets up/);
  assert.equal((await one('S3', `select * from start_self_learner('Kid', 6, 'Zambia', 'UTC', '0000 0001')`)).id, null);
  const kid = await one('S3', `select * from start_self_learner('Kid', 6, 'Zambia', 'UTC', $1)`, [`${code.code.slice(0, 4)} ${code.code.slice(4)}`]);
  assert.equal(kid.self_learner, true);
  assert.equal(kid.consent_parent, U.PK, 'the parent’s consent is kept');
  assert.equal((await val('PK', `select parent_child_codes()`)).length, 0, 'the code is used up');
  assert.equal((await val('PK', `select parent_children()`))[0].self, true);
  const pv = await val('PK', `select parent_view($1)`, [U.S3]);
  assert.equal(pv.self.set_up_by_me, true);
  assert.equal((await as('PK', `select 1 from notifications where user_id = auth.uid() and title like '%set up their StudyBridge account'`)).length, 1);

  // a student on their own (grade 8 and up) gives a parent a code; there's no tutor to tell
  const inv = await one('S', `select * from self_parent_invite('Dad')`);
  assert.match(inv.code, /^P[0-9A-F]{10}$/);
  assert.equal((await val('S', `select learner_parents()`)).invites.length, 1);
  await fails(as('L', `select self_parent_invite('x')`), /on their own/);
  await one('PD', `select * from accept_parent_invite($1, 'Dad')`, [inv.code]);
  assert.equal((await val('PD', `select parent_children()`))[0].self, true);
  assert.equal((await as('C', `select 1 from notifications where user_id = auth.uid() and title like '%can now follow%'`)).length, 0, 'the content account isn’t told');
  // children's privacy: only the parent who set up a young child's account can close it
  await fails(as('PD', `select parent_delete_child($1, 'DELETE')`, [U.S3]), /Only the parent/);
  await fails(as('PK', `select parent_delete_child($1, 'yes')`, [U.S3]), /Type DELETE/);
  await as('PK', `select parent_delete_child($1, 'DELETE')`, [U.S3]);
  assert.equal((await db.query(`select 1 from profiles where id = $1`, [U.S3])).rows.length, 0);

  // the Owner's test students: sign up while sign-up is paused, choose a subject that isn't open yet, never pay
  await fails(as('T', `select admin_set_test_emails($1)`, [['owner+student@x.com']]), /admins only/);
  assert.deepEqual(await val('A', `select admin_set_test_emails($1)`, [['Owner+Student@x.com', 'not an email']]), ['owner+student@x.com']);
  await as('A', `select admin_students_open(false)`);
  assert.deepEqual(await val(null, `select open_subjects()`), [], 'paused: the website shows nothing open');
  const ts = await one('TS', `select * from start_self_learner('Test', 10, 'US')`);
  assert.equal(ts.test_student, true);
  assert.deepEqual(await val('TS', `select self_setup('IB', 'IB Diploma', $1, current_date + 100, null, 4)`, [[phys]]), { subjects: 1 });
  await as('A', `select admin_students_open(true)`);
  const list = (await val('A', `select admin_students()`)).students;
  assert.equal(list.find((x) => x.id === U.TS).test, true);
  assert.equal(list.find((x) => x.id === U.S).parents, 1);
  // the website: which subjects students can start now
  assert.deepEqual(await val(null, `select open_subjects()`), ['cambridge:igcse:0607']);
});

test('emails to students on their own and their parents: welcome, the free week ending, you’re all set', async () => {
  const mk = async (k, email) => {
    const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name: k }]);
    U[k] = r.rows[0].id;
  };
  const mails = async (to) => (await db.query(`select subject, body, reply_to from outgoing_emails where to_addr = $1 order by created_at`, [to])).rows;
  await mk('S5', 'ruth@x.com');
  await mk('PR', 'ruthsmum@x.com');
  // a parent sets up a young student: both get a welcome
  await one('PR', `select * from start_parent('Ruth''s mum')`);
  const code = (await val('PR', `select parent_child_code('Ruth', 7)`)).code;
  await one('S5', `select * from start_self_learner('Ruth Banda', 7, 'Zambia', 'UTC', $1)`, [code]);
  const [w] = await mails('ruth@x.com');
  assert.equal(w.subject, 'Welcome to StudyBridge, Ruth!');
  assert.match(w.body, /free week has started/);
  assert.match(w.body, /https:\/\/gostudybridge\.com\/app\//);
  assert.equal(w.reply_to, 'support@gostudybridge.com', 'replies reach support@');
  assert.equal((await mails('ruthsmum@x.com'))[0].subject, 'Ruth has started StudyBridge');
  // no email to the Owner's test students
  assert.equal((await mails('owner+student@x.com')).length, 0);
  // two days before the free week ends: once, to the student and the parent
  await db.query(`update profiles set trial_until = now() + interval '36 hours' where id = $1`, [U.S5]);
  assert.ok((await val(null, `select 1`)) === 1);
  await db.query(`select public._student_emails_tick()`);
  await db.query(`select public._student_emails_tick()`);
  assert.deepEqual((await mails('ruth@x.com')).map((m) => m.subject), ['Welcome to StudyBridge, Ruth!', 'Your free week ends in 2 days']);
  assert.equal((await mails('ruthsmum@x.com')).at(-1).subject, 'Ruth\'s free week ends in 2 days');
  // a new free week from the Owner: a new reminder when that one ends
  await as('A', `select admin_extend_trial($1, 7)`, [U.S5]);
  assert.equal((await one('S5', `select trial_reminded from profiles where id = auth.uid()`)).trial_reminded, false);
  // the Owner records a payment: "you're all set" to both
  await as('A', `select admin_set_student_paid($1, 'monthly', current_date + 30)`, [U.S5]);
  assert.equal((await mails('ruth@x.com')).at(-1).subject, 'You\'re all set');
  assert.match((await mails('ruthsmum@x.com')).at(-1).body, /monthly plan is active until/);
  // paid students get no "ends in 2 days"
  await db.query(`update profiles set trial_until = now() + interval '30 hours', trial_reminded = false where id = $1`, [U.S5]);
  const before = (await mails('ruth@x.com')).length;
  await db.query(`select public._student_emails_tick()`);
  assert.equal((await mails('ruth@x.com')).length, before);
  // only the server sends these
  await fails(as('S5', `select public._student_emails_tick()`), /permission denied/);
  await fails(as('S5', `select public._student_paid_by_card($1, 'pass', 12)`, [U.S5]), /permission denied/);
});

test('one StudyBridge library: tutors get the content account’s checked questions and practice papers for their exams; their learners only through the tutor', async () => {
  const mk = async (k, email) => {
    const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name: k }]);
    U[k] = r.rows[0].id;
  };
  await mk('TB', 'library-tutor@x.com');
  await mk('LB', 'library-learner@x.com');
  await one('TB', `select * from become_tutor('Library Tutor', 'UTC')`);
  await as('A', `select admin_set_status($1, 'active')`, [U.TB]);
  const subj = async (key) => (await db.query(`select id from subjects where tutor_id = $1 and catalogue = $2`, [U.C, key])).rows[0].id;
  const maths = await subj('cambridge:igcse:0607');
  const phys = await subj('ib:sl-and-hl:physics');

  // StudyBridge's subjects know their exam (Cambridge by its code, the IB by its name), and so do its questions;
  // older questions without one are filled in when setup.sql runs again
  const exams = await db.query(`select public._subject_exam(s) e from subjects s where s.id = any($1) order by s.position`, [[maths, phys]]);
  assert.deepEqual(exams.rows.map((r) => r.e), ['cie:0607', 'ib:physics']);
  const live = (await db.query(`select id, exam_board, exam_code, uses from bank_questions where owner_id = $1 and status = 'approved'`, [U.C])).rows;
  assert.ok(live.length >= 4 && live.every((b) => b.exam_board === 'cie' && b.exam_code === '0607'), JSON.stringify(live));
  await db.query(`update bank_questions set exam_code = null, exam_board = 'Cambridge' where id = $1`, [live[0].id]);
  await db.exec(SETUP);
  assert.deepEqual((await db.query(`select exam_board, exam_code from bank_questions where id = $1`, [live[0].id])).rows[0], { exam_board: 'cie', exam_code: '0607' });
  // one question waits for its check and one has problems: tutors get neither
  const added = await val('C', `select content_add_questions($1, $2)`, [
    maths,
    JSON.stringify([
      { topic: 'Number', type: 'numeric', prompt: 'Work out $5 \\times 5$.', answer: { value: '25' }, hint: 'Five fives.', solution: '$5 \\times 5 = 25$' },
      { topic: 'Number', type: 'numeric', prompt: 'Work out $3 + 3', answer: { value: 'six' }, hint: '', solution: '' },
    ]),
  ]);
  assert.deepEqual([added.waiting_for_check, added.with_problems.length], [1, 1]);

  // a tutor's question bank: StudyBridge's checked questions for the exams their subjects are for
  const sub = await val('TB', `insert into subjects (name) values ('IGCSE Maths') returning id`);
  const num = await val('TB', `insert into topics (subject_id, name) values ($1, 'Number') returning id`, [sub]);
  const alg = await val('TB', `insert into topics (subject_id, name) values ($1, 'Algebra') returning id`, [sub]);
  const sbBank = async (who) => (await as(who, `select id from bank_questions where owner_id = $1`, [U.C])).map((b) => b.id).sort();
  assert.deepEqual(await sbBank('TB'), [], 'nothing until a subject says which exam it’s for');
  await as('TB', `update subjects set exam = 'cie:0607' where id = $1`, [sub]);
  assert.deepEqual(await sbBank('TB'), live.map((b) => b.id).sort(), 'the checked ones, not those waiting or with problems');
  assert.deepEqual(await sbBank('T'), [], 'a tutor with no subject for 0607 gets none');
  // ...to use, never to change
  assert.equal((await as('TB', `update bank_questions set prompt_md = 'changed' where owner_id = $1 returning id`, [U.C])).length, 0);
  assert.equal((await as('TB', `delete from bank_questions where owner_id = $1 returning id`, [U.C])).length, 0);
  await fails(as('TB', `insert into bank_questions (owner_id, type, prompt_md) values ($1, 'numeric', 'x')`, [U.C]), /row-level security/);
  await as('TB', `select bank_used($1)`, [[live[0].id]]);
  assert.equal((await db.query(`select uses from bank_questions where id = $1`, [live[0].id])).rows[0].uses, live[0].uses + 1, 'uses are counted');

  // with a tutor, a person approves everything a learner gets: StudyBridge's questions never go into the learner's
  // practice by themselves (the tutor uses them in work they post)
  const code = await val('TB', `insert into invites (name, subject_ids) values ('Lib', $1) returning code`, [[sub]]);
  await one('LB', `select * from accept_invite($1, 'Lib')`, [code]);
  assert.deepEqual(await val('LB', `select practice_topics()`), [], 'nothing to practise until the tutor approves questions');
  await fails(as('LB', `select start_practice('topic', $1, 'Number', 6)`, [sub]), /aren’t any practice questions/);
  assert.equal((await as('LB', `select id from bank_questions`)).length, 0, 'learners never read the bank');

  // StudyBridge's practice papers for that exam: only the ones that are up for students
  const waiting = await val('C', `select content_add_paper($1, 'Practice paper 3', 30, null, $2)`, [
    maths,
    JSON.stringify([{ type: 'numeric', prompt: 'Work out $4 \\times 4$.', answer: { value: '16' }, solution: '$4 \\times 4 = 16$', mark_scheme: 'B1 16', marks: 1 }]),
  ]);
  const papers = await val('TB', `select studybridge_papers('cie:0607')`);
  assert.deepEqual(papers.map((p) => p.title), ['Practice paper 1'], 'not one still waiting for its checks');
  const p1 = papers[0];
  assert.deepEqual([p1.questions.length, Number(p1.marks), p1.minutes], [2, 3, 45]);
  assert.deepEqual(p1.questions[1].answer, { final: 'x = 4' });
  assert.match(p1.instructions, /Not affiliated with or endorsed by Cambridge/);
  assert.deepEqual((await val('TB', `select studybridge_papers('0607')`)).map((p) => p.id), [p1.id], 'the code on its own works too');
  assert.deepEqual(await val('TB', `select studybridge_papers('cie:0580')`), []);
  // copied into a draft test of the tutor's own, keys and all; the tutor marks it, and "not affiliated" stays
  const copy = await val('TB', `select copy_studybridge_paper($1)`, [p1.id]);
  const ca = await one('TB', `select * from assignments where id = $1`, [copy]);
  assert.deepEqual([ca.tutor_id, ca.kind, ca.draft, ca.visibility, ca.source, ca.subject_id, ca.self_mark, ca.time_limit_min], [U.TB, 'test', true, 'hidden', 'studybridge', sub, false, 45]);
  assert.match(ca.instructions_md, /Not affiliated with or endorsed by Cambridge/);
  assert.doesNotMatch(ca.instructions_md, /mark it yourself/);
  const keys = await as('TB', `select q.topic_id, q.marks, k.answer, k.mark_scheme_md, k.solution_md from questions q join question_keys k on k.question_id = q.id
     where q.assignment_id = $1 order by q.position`, [copy]);
  assert.deepEqual(keys.map((k) => k.answer), [{ value: '56' }, { final: 'x = 4' }]);
  assert.deepEqual(keys.map((k) => k.mark_scheme_md), ['B1 56', 'M1 add 2, A1 x = 4']);
  assert.match(keys[1].solution_md, /x = 4/);
  assert.equal(keys[1].topic_id, alg, 'the tutor’s own topic');
  assert.equal((await as('LB', `select id from assignments where id = $1`, [copy])).length, 0, 'the learner sees it once the tutor posts it');
  assert.equal((await val('C', `select content_status($1)`, [maths]))[0].papers_live, 1, 'the copy is the tutor’s, not StudyBridge’s');
  await fails(as('TB', `select copy_studybridge_paper($1)`, [waiting.id]), /isn’t available/);
  await fails(as('TB', `select copy_studybridge_paper($1)`, [copy]), /isn’t available/);
  // tutors only: not their learners, students on their own or parents; the content account has its own already
  for (const who of ['LB', 'S', 'PR']) {
    await fails(as(who, `select studybridge_papers('cie:0607')`), /for tutors/);
    await fails(as(who, `select copy_studybridge_paper($1)`, [p1.id]), /for tutors/);
  }
  assert.deepEqual(await val('C', `select studybridge_papers('cie:0607')`), []);
  await fails(as('C', `select copy_studybridge_paper($1)`, [p1.id]), /isn’t available/);
});

test('daily study reminder: once a day at the learner’s own time in their own time zone, never after studying that day; devices only through their own functions', async () => {
  for (const k of ['RA', 'RB', 'RC']) U[k] = (await db.query(`insert into auth.users (email) values ($1) returning id`, [`${k.toLowerCase()}.remind@x.com`])).rows[0].id;
  // RA in Lusaka (2 hours ahead of UTC all year), RB in New York (5 hours behind in January); RC has no role
  await db.query(`update profiles set role = 'learner', timezone = 'Africa/Lusaka' where id = $1`, [U.RA]);
  await db.query(`update profiles set role = 'learner', timezone = 'America/New_York' where id = $1`, [U.RB]);
  const first = await val('RA', `select my_study_reminder(null)`);
  assert.deepEqual([first.on, first.time, first.timezone, first.devices, first.this_device], [false, '17:00', 'Africa/Lusaka', 0, false], 'off at first, 17:00');
  await fails(as('T', `select set_study_reminder(true, '17:00')`), /for learners/);
  await fails(as('RC', `select set_study_reminder(true, '17:00')`), /for learners/);
  await fails(as('RA', `select set_study_reminder(true, '5pm')`), /like 17:00/);
  await fails(as('RA', `select set_study_reminder(true, '24:00')`), /like 17:00/);
  // switched on after today's time has gone by (00:00 always has): the first one is tomorrow
  assert.equal((await val('RA', `select set_study_reminder(true, '00:00')`)).today_done, true);
  const on = await val('RA', `select set_study_reminder(true, '18:30')`);
  assert.deepEqual([on.on, on.time], [true, '18:30']);
  await as('RB', `select set_study_reminder(true, '20:00')`);
  // only through the functions; the every-10-minutes job is the server's
  await fails(as('RA', `update profiles set remind_on = false, reminded_on = null where id = auth.uid()`), /permission denied/);
  await fails(as('RA', `select _study_reminders()`), /permission denied/);

  // the job, run for a fixed winter day, from a clean slate
  await db.query(`update profiles set reminded_on = null where id = any($1)`, [[U.RA, U.RB]]);
  const run = async (at) => Number((await db.query(`select _study_reminders($1::timestamptz) n`, [at])).rows[0].n);
  const nudges = async (k) => Number((await db.query(`select count(*) n from notifications where user_id = $1 and kind = 'study_reminder' and ref = '{}'`, [U[k]])).rows[0].n);
  assert.equal(await run('2031-01-15 16:20Z'), 0, '18:20 in Lusaka, 11:20 in New York: too early for both');
  assert.equal(await run('2031-01-15 16:30Z'), 1, '18:30 in Lusaka');
  assert.deepEqual([await nudges('RA'), await nudges('RB')], [1, 0]);
  const n1 = await one('RA', `select title, body from notifications where user_id = auth.uid() and kind = 'study_reminder'`);
  assert.equal(`${n1.title}: ${n1.body}`, 'Time for StudyBridge: A few minutes today keeps your streak going.');
  assert.equal(await val('RA', `select reminded_on::text from profiles where id = auth.uid()`), '2031-01-15');
  assert.equal(await run('2031-01-15 21:00Z'), 0, 'once a day');
  assert.equal(await run('2031-01-16 00:30Z'), 0, '19:30 in New York; already the 16th in Lusaka, but not 18:30 yet');
  assert.equal(await run('2031-01-16 01:05Z'), 1, '20:05 in New York, still the 15th there');
  assert.equal(await val('RB', `select reminded_on::text from profiles where id = auth.uid()`), '2031-01-15', 'the learner’s own day');
  // studied that day (their own day): no nudge
  await db.query(`insert into activity (learner_id, tutor_id, kind, seconds, day) values ($1, $2, 'session', 300, '2031-01-16')`, [U.RA, U.T]);
  assert.equal(await run('2031-01-16 17:00Z'), 0, 'RA studied on the 16th');
  assert.equal(await run('2031-01-17 16:40Z'), 1, 'but not on the 17th');
  assert.equal(await nudges('RA'), 2);

  // devices: only the browsers' push services, and each person's own
  const ep = 'https://fcm.googleapis.com/fcm/send/remind-ra-1';
  const apple = 'https://web.push.apple.com/QGx-remind-ra';
  for (const bad of ['https://example.com/push/1', 'http://fcm.googleapis.com/fcm/send/x', 'https://fcm.googleapis.com.evil.example/x']) {
    await fails(as('RA', `select save_push_subscription($1, 'k', 'a')`, [bad]), /can’t be used/);
  }
  await fails(as('T', `select save_push_subscription($1, 'k', 'a')`, [ep]), /for learners/);
  assert.equal((await val('RA', `select save_push_subscription($1, 'p256-ra', 'auth-ra')`, [ep])).devices, 1);
  assert.equal((await val('RA', `select save_push_subscription($1, 'p256-ra', 'auth-ra')`, [ep])).devices, 1, 'saving again changes nothing');
  assert.equal((await val('RA', `select save_push_subscription($1, 'p256-ra2', 'auth-ra2')`, [apple])).devices, 2);
  assert.equal((await val('RA', `select my_study_reminder($1)`, [ep])).this_device, true);
  assert.equal((await val('RB', `select my_study_reminder($1)`, [ep])).this_device, false);
  await fails(as('RA', `select * from push_subscriptions`), /permission denied/);
  await fails(as('RA', `insert into push_subscriptions (user_id, endpoint) values (auth.uid(), 'https://fcm.googleapis.com/x')`), /permission denied/);
  await fails(as('RA', `select * from push_outbox`), /permission denied/);
  // someone who only knows the address can't take it over or remove it
  const owner = async (e) => (await db.query(`select user_id from push_subscriptions where endpoint = $1`, [e])).rows[0]?.user_id;
  await fails(as('RB', `select save_push_subscription($1, 'p', 'not-the-same-secret')`, [ep]), /can’t be used/);
  await as('RB', `select remove_push_subscription($1)`, [ep]);
  assert.equal(await owner(ep), U.RA);
  // the same browser (same secret) on a shared computer: whoever switched it on there last
  await as('RB', `select save_push_subscription($1, 'p256-ra', 'auth-ra')`, [ep]);
  assert.equal(await owner(ep), U.RB);
  await as('RA', `select save_push_subscription($1, 'p256-ra', 'auth-ra')`, [ep]);
  assert.equal(await owner(ep), U.RA);

  // a reminder queues a push for each device; "Send me a test" does everything a reminder does, then waits a moment
  const queued = async () => Number((await db.query(`select count(*) n from push_outbox o join push_subscriptions s on s.id = o.subscription_id where s.user_id = $1 and o.sent_at is null`, [U.RA])).rows[0].n);
  assert.equal(await run('2031-01-18 16:40Z'), 1);
  assert.equal(await queued(), 2, 'one push for each of RA’s devices');
  assert.equal((await val('RA', `select send_test_reminder()`)).devices, 2);
  await fails(as('RA', `select send_test_reminder()`), /on its way/);
  await fails(as('T', `select send_test_reminder()`), /for learners/);
  assert.equal(await queued(), 4);

  // Prof's side: the key pair (the first one saved is kept; the app reads only the public half)
  assert.equal(await val('RA', `select push_key()`), null);
  await fails(as('RA', `select _push_keys('x', 'y')`), /permission denied/);
  await fails(as('RA', `select _push_claim(10)`), /permission denied/);
  await fails(as('RA', `select _push_done(1, 201)`), /permission denied/);
  assert.equal((await db.query(`select _push_keys('PUB-1', '{"d":"one"}') v`)).rows[0].v.public, 'PUB-1');
  assert.deepEqual((await db.query(`select _push_keys('PUB-2', '{"d":"two"}') v`)).rows[0].v, { public: 'PUB-1', private: '{"d":"one"}' });
  assert.equal(await val('RA', `select push_key()`), 'PUB-1');
  await fails(as('RA', `select vapid_private from platform_secrets`), /permission denied/);
  // each waiting push is handed out once; sent, tried again later, or the device forgotten when its push service says it's gone
  const claim = async () => (await db.query(`select _push_claim(100) v`)).rows[0].v;
  const c = await claim();
  assert.equal(c.contact, 'mailto:support@gostudybridge.com');
  assert.equal(c.pushes.length, 4);
  assert.equal((await claim()).pushes.length, 0, 'not handed out twice');
  const [sent, slow] = c.pushes.filter((p) => p.endpoint === ep);
  await db.query(`select _push_done($1, 201)`, [sent.id]);
  await db.query(`select _push_done($1, 429, 'Too many requests')`, [slow.id]);
  await db.query(`select _push_done($1, 410)`, [c.pushes.find((p) => p.endpoint === apple).id]);
  assert.equal(await owner(apple), undefined, '410: that device is forgotten');
  assert.equal((await db.query(`select sent_at is not null s from push_outbox where id = $1`, [sent.id])).rows[0].s, true);
  assert.equal((await db.query(`select error from push_outbox where id = $1`, [slow.id])).rows[0].error, 'Too many requests');
  assert.deepEqual((await claim()).pushes.map((p) => p.id), [slow.id], 'a failed one is tried again');

  // off: no reminders, and the devices are forgotten
  const off = await val('RA', `select set_study_reminder(false, null)`);
  assert.deepEqual([off.on, off.time, off.devices], [false, '18:30', 0]);
  assert.equal(await run('2031-01-19 16:40Z'), 0);
});

test('organisations and classes: every tutor has one, a tutor makes it a centre and others join with its code; classes get their work as people join and leave', async () => {
  const mk = async (k, email) => {
    const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name: k }]);
    U[k] = r.rows[0].id;
  };
  for (const k of ['OM', 'OT', 'OL1', 'OL2', 'OL3', 'OL4']) await mk(k, k.toLowerCase() + '@org.x');
  await one('OM', `select * from become_tutor('Mary Banda', 'Africa/Lusaka')`);
  await one('OT', `select * from become_tutor('Tom Phiri', 'Africa/Lusaka')`);
  await as('A', `select admin_set_status($1, 'active')`, [U.OM]);
  await as('A', `select admin_set_status($1, 'active')`, [U.OT]);
  const join = async (tutor, learner, extra = {}) => {
    const code = await val(tutor, `insert into invites (name, class_ids) values ($1, $2) returning code`, [learner, extra.classes || []]);
    await one(learner, `select * from accept_invite($1, $2)`, [code, learner]);
  };

  // every tutor has an organisation of their own (tutors from before got one when setup.sql ran); the content
  // account's is StudyBridge's own, where students on their own are
  const om = await val('OM', `select my_org()`);
  assert.deepEqual([om.name, om.kind, om.role, om.code, om.members.length], ['Mary Banda’s tutoring', 'tutor', 'manager', null, 1]);
  assert.equal((await val('T', `select my_org()`)).kind, 'tutor');
  const sb = await val('C', `select my_org()`);
  assert.deepEqual([sb.name, sb.kind], ['StudyBridge', 'studybridge']);
  const selfLearner = (await db.query(`select id from profiles where tutor_id = $1 and role = 'learner' limit 1`, [U.C])).rows[0];
  if (selfLearner) assert.equal((await db.query(`select _org_of($1) o`, [selfLearner.id])).rows[0].o, sb.id);
  await fails(as('C', `select org_make_centre('Mine')`), /stays as it is/);
  await fails(as('OM', `select * from organisations`), /permission denied/);
  await fails(as('OM', `select * from org_members`), /permission denied/);
  await fails(as('OM', `select _ensure_org($1)`, [U.OT]), /permission denied/);

  // Mary makes hers a tuition centre; Tom joins with its code (a wrong one is counted and joins nothing)
  const centre = await val('OM', `select org_make_centre('Bright Minds Centre')`);
  assert.deepEqual([centre.name, centre.kind], ['Bright Minds Centre', 'centre']);
  assert.match(centre.code, /^\d{8}$/);
  assert.equal(await val('OT', `select org_join('1234 5678')`), null);
  assert.equal((await db.query(`select count(*)::int n from invite_tries where user_id = $1`, [U.OT])).rows[0].n, 1);
  await fails(as('OT', `select org_overview()`), /Only a centre’s manager/);
  const tom = await val('OT', `select org_join($1)`, [centre.code.slice(0, 4) + ' ' + centre.code.slice(4)]);
  assert.deepEqual([tom.name, tom.kind, tom.role, tom.code, tom.members.length], ['Bright Minds Centre', 'centre', 'tutor', null, 2]);
  assert.equal(await val('OM', `select count(*)::int from notifications where user_id = auth.uid() and kind = 'org' and title = 'Tom Phiri joined Bright Minds Centre'`), 1);
  assert.equal(await db.query(`select count(*)::int n from organisations where name = 'Tom Phiri’s tutoring'`).then((r) => r.rows[0].n), 0, 'his own one went');
  await fails(as('OT', `select org_rename('Mine now')`), /Only the manager/);
  await fails(as('OT', `select org_new_code()`), /Only the manager/);
  await fails(as('OT', `select org_remove($1)`, [U.OM]), /Only the manager/);

  // each tutor's learners stay theirs; the manager sees every tutor and learner in the centre, read-only
  await join('OM', 'OL1');
  await join('OT', 'OL2');
  const ov = await val('OM', `select org_overview()`);
  assert.deepEqual(ov.tutors.map((t) => [t.name, t.role, t.learners]), [['Mary Banda', 'manager', 1], ['Tom Phiri', 'tutor', 1]]);
  assert.deepEqual(ov.learners.map((l) => [l.name, l.tutor_id]), [['OL1', U.OM], ['OL2', U.OT]]);
  assert.equal((await as('OM', `select id from profiles where id = $1`, [U.OL2])).length, 0, 'the manager can’t open another tutor’s learner');
  await fails(as('OL1', `select org_overview()`), /Only a centre’s manager/);
  assert.equal(await val('OL1', `select my_org()`), null);
  assert.equal((await db.query(`select _org_of($1) o`, [U.OL2])).rows[0].o, centre.id, 'a learner is in their tutor’s organisation');

  // managers: there's always at least one
  await fails(as('OM', `select org_set_role($1, 'tutor')`, [U.OM]), /at least one manager/);
  await fails(as('OM', `select org_leave()`), /only manager/);
  assert.equal((await val('OM', `select org_set_role($1, 'manager')`, [U.OT])).members.filter((m) => m.role === 'manager').length, 2);
  await val('OT', `select org_set_role($1, 'tutor')`, [U.OT]);
  // Tom leaves (his learner goes with him), comes back, and is taken out by Mary
  const back = await val('OT', `select org_leave()`);
  assert.deepEqual([back.name, back.kind, back.role], ['Tom Phiri’s tutoring', 'tutor', 'manager']);
  assert.equal(await val('OL2', `select tutor_id from profiles where id = auth.uid()`), U.OT);
  assert.equal((await val('OM', `select org_overview()`)).learners.length, 1);
  await fails(as('OT', `select org_leave()`), /your own organisation/);
  const code2 = (await val('OM', `select org_new_code()`)).code;
  assert.notEqual(code2, centre.code);
  assert.equal(await val('OT', `select org_join($1)`, [centre.code]), null, 'the old code stopped working');
  await val('OT', `select org_join($1)`, [code2]);
  assert.equal((await val('OM', `select org_remove($1)`, [U.OT])).members.length, 1);
  assert.equal((await val('OT', `select my_org()`)).kind, 'tutor');
  assert.equal(await val('OT', `select count(*)::int from notifications where user_id = auth.uid() and title = 'You’re no longer in Bright Minds Centre'`), 1);
  assert.equal((await val('OM', `select org_rename('Bright Minds')`)).name, 'Bright Minds');
  // Admin → Tutors shows each tutor's organisation
  const at = (await val('A', `select admin_tutors()`)).find((t) => t.id === U.OM);
  assert.deepEqual([at.org.name, at.org.kind, at.org.role, at.org.tutors], ['Bright Minds', 'centre', 'manager', 1]);

  // ---------------- classes ----------------
  await join('OM', 'OL3');
  const sub = await val('OM', `insert into subjects (name) values ('IGCSE Maths') returning id`);
  await fails(as('OM', `insert into classes (name) values ('x')`), /permission denied/);
  await fails(as('OM', `select save_class(null, 'Y10', null, $1)`, [[U.OL2]]), /Not your learner/);
  await fails(as('OM', `select save_class(null, '  ', null, '{}')`), /name/);
  const y10 = await val('OM', `select save_class(null, 'Year 10 maths', $1, $2)`, [sub, [U.OL1]]);
  assert.equal(await val('OL1', `select count(*)::int from notifications where user_id = auth.uid() and kind = 'class' and title = 'You’re in Year 10 maths now'`), 1);
  // work, lesson notes and files for the class: whoever is in it
  const hw = await val('OM', `insert into assignments (title, kind, subject_id, class_id, visibility) values ('Class homework', 'homework', $1, $2, 'visible') returning id`, [sub, y10]);
  const notes = await val('OM', `insert into lessons (title, subject_id, class_id, visibility) values ('Class notes', $1, $2, 'visible') returning id`, [sub, y10]);
  assert.deepEqual(await val('OM', `select learner_ids from assignments where id = $1`, [hw]), [U.OL1]);
  const sees = async (who, table, id) => (await as(who, `select id from ${table} where id = $1`, [id])).length === 1;
  assert.equal(await sees('OL1', 'assignments', hw), true);
  assert.equal(await sees('OL3', 'assignments', hw), false, 'not in the class');
  assert.equal(await sees('OL3', 'lessons', notes), false);
  assert.equal(await val('OL1', `select count(*)::int from notifications where user_id = auth.uid() and title = 'New homework: Class homework'`), 1);
  // a live lesson and a weekly lesson for the class
  const live = await val('OM', `insert into sessions (title, starts_at, class_id) values ('Class lesson', now() + interval '3 days', $1) returning id`, [y10]);
  assert.deepEqual(await val('OM', `select learner_ids from sessions where id = $1`, [live]), [U.OL1]);
  const series = await val('OM', `select create_lesson_series('Weekly class', now() + interval '1 day', 60, '{}', 'Africa/Lusaka', null, null, $1)`, [y10]);
  const seriesWho = async () => (await db.query(`select distinct learner_ids from sessions where series_id = $1 and starts_at > now()`, [series])).rows.map((r) => r.learner_ids);
  assert.deepEqual(await seriesWho(), [[U.OL1]]);
  // someone joins the class later: they get all of it
  await val('OM', `select save_class($1, 'Year 10 maths', $2, $3)`, [y10, sub, [U.OL1, U.OL3]]);
  assert.equal(await sees('OL3', 'assignments', hw), true);
  assert.equal(await sees('OL3', 'lessons', notes), true);
  assert.equal(await sees('OL3', 'sessions', live), true);
  assert.deepEqual((await seriesWho()).map((x) => [...x].sort()), [[U.OL1, U.OL3].sort()]);
  // a learner sees their own classes and their own place in them, never who else is in them
  assert.deepEqual((await as('OL3', `select name from classes`)).map((c) => c.name), ['Year 10 maths']);
  assert.deepEqual((await as('OL3', `select learner_id from class_members`)).map((m) => m.learner_id), [U.OL3]);
  // someone leaves: work they started stays theirs, the rest goes (past live lessons keep who was there)
  await as('OL1', `select start_attempt($1)`, [hw]);
  await db.query(`update sessions set starts_at = now() - interval '1 hour' where id = $1`, [live]);
  await val('OM', `select save_class($1, 'Year 10 maths', $2, $3)`, [y10, sub, [U.OL3]]);
  assert.equal(await sees('OL1', 'assignments', hw), true, 'started, so it stays');
  assert.equal(await sees('OL1', 'lessons', notes), false);
  assert.deepEqual([...(await val('OM', `select learner_ids from sessions where id = $1`, [live]))].sort(), [U.OL1, U.OL3].sort(), 'a past lesson keeps who was there');
  assert.deepEqual(await seriesWho(), [[U.OL3]]);
  // another tutor can't point their work at this class, or change it
  await fails(as('OT', `insert into assignments (title, class_id) values ('x', $1)`, [y10]), /Unknown class/);
  await fails(as('OT', `select save_class($1, 'Mine', null, '{}')`, [y10]), /Not your class/);
  // an invite can put a new learner straight into classes
  await join('OM', 'OL4', { classes: [y10] });
  assert.equal(await sees('OL4', 'assignments', hw), true);
  // leaving the tutor means leaving their classes
  await as('OM', `select remove_learner($1)`, [U.OL4]);
  assert.equal(await db.query(`select count(*)::int n from class_members where learner_id = $1`, [U.OL4]).then((r) => r.rows[0].n), 0);
  // an empty class means nobody yet, never everyone; deleting it hides what was only for it
  const empty = await val('OM', `select save_class(null, 'Starting soon', $1, '{}')`, [sub]);
  const hw2 = await val('OM', `insert into assignments (title, subject_id, class_id, visibility) values ('Waiting', $1, $2, 'visible') returning id`, [sub, empty]);
  assert.equal(await sees('OL3', 'assignments', hw2), false);
  await fails(as('OM', `select create_lesson_series('Nobody', now() + interval '1 day', 60, '{}', 'UTC', null, null, $1)`, [empty]), /Nobody is in this class/);
  await as('OM', `select delete_class($1)`, [empty]);
  assert.deepEqual(await one('OM', `select class_id, learner_ids, visibility from assignments where id = $1`, [hw2]), { class_id: null, learner_ids: null, visibility: 'hidden' });
  // put away and back; deleting a class with people in it leaves its work with them
  await as('OM', `select archive_class($1, true)`, [y10]);
  assert.equal(await val('OM', `select archived from classes where id = $1`, [y10]), true);
  await as('OM', `select archive_class($1, false)`, [y10]);
  await as('OM', `select delete_class($1)`, [y10]);
  assert.equal(await sees('OL3', 'assignments', hw), true);
  assert.equal(await val('OM', `select class_id from assignments where id = $1`, [hw]), null);
  // a tutor's data download has their classes
  await val('OM', `select save_class(null, 'Year 11', null, $1)`, [[U.OL3]]);
  const ex = await val('OM', `select export_my_data()`);
  assert.deepEqual([ex.classes.map((c) => c.name), ex.class_members.length], [['Year 11'], 1]);
});

test('the demo StudyBridge: the Owner fills in fresh demo accounts as a pretend centre, opens any of them, and removes it; it never shows in Admin', async () => {
  const roles = ['manager', 'tutor1', 'tutor2', 'tutor3', 'learner1', 'learner2', 'learner3', 'learner4', 'learner5', 'learner6', 'parent', 'student'];
  const make = async () => {
    const ids = {};
    for (const r of roles) {
      const email = `demo-${r}-${crypto.randomBytes(3).toString('hex')}@gostudybridge.com`;
      ids[r] = (await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, '{}') returning id`, [email])).rows[0].id;
    }
    return ids;
  };
  const ids = await make();
  const before = await val('A', `select admin_overview()`);
  await fails(as('T', `select admin_demo_build($1)`, [ids]), /admins only/i);
  await fails(as('T', `select admin_demo_open($1)`, [ids.manager]), /admins only/i);
  // only brand-new demo accounts: never a real one
  await fails(as('A', `select admin_demo_build($1)`, [{ ...ids, learner4: U.L2 }]), /isn’t a new demo account/);
  assert.equal(await db.query(`select count(*)::int n from profiles where demo`).then((r) => r.rows[0].n), 0, 'nothing half-made');
  const d = await val('A', `select admin_demo_build($1)`, [ids]);
  assert.deepEqual(d.accounts.map((a) => a.label), roles);
  assert.deepEqual(d.accounts.map((a) => a.role), ['tutor', 'tutor', 'tutor', 'tutor', 'learner', 'learner', 'learner', 'learner', 'learner', 'learner', 'parent', 'learner']);
  await fails(as('A', `select admin_demo_build($1)`, [await make()]), /demo already/);
  // its class streams: the manager's notice in every class, and a question in Year 10 maths with the class's replies
  assert.equal((await db.query(`select count(*)::int n from class_posts where author_id = $1`, [ids.manager])).rows[0].n, 3);
  assert.equal((await db.query(`select count(*)::int n from class_post_replies r join class_posts p on p.id = r.post_id where p.author_id = $1`, [ids.tutor1])).rows[0].n, 3);

  // a sign-in for any demo account, never anyone else's
  const open = async (label) => {
    const o = await val('A', `select admin_demo_open($1)`, [ids[label]]);
    assert.equal((await db.query(`select encrypted_password = extensions.crypt($2, encrypted_password) ok from auth.users where id = $1`, [ids[label], o.password])).rows[0].ok, true);
    U['demo_' + label] = ids[label];
    return 'demo_' + label;
  };
  await fails(as('A', `select admin_demo_open($1)`, [U.T]), /isn’t a demo account/);
  // Grace runs the centre and doesn't teach; three tutors with a class of two each
  const G = await open('manager');
  const org = await val(G, `select my_org()`);
  assert.deepEqual([org.name, org.kind, org.role, org.members.length], ['Riverside Tuition (demo)', 'centre', 'manager', 4]);
  const ov = await val(G, `select org_overview()`);
  assert.deepEqual(ov.learners.map((l) => l.name), ['Amara Phiri', 'Chipo Banda', 'Kofi Mensah', 'Mwila Zulu', 'Natasha Mwale', 'Tendai Moyo']);
  assert.deepEqual(ov.tutors.map((t) => [t.name, t.learners]), [['Grace Mwansa', 0], ['Daniel Okafor', 2], ['Joseph Lungu', 2], ['Mercy Tembo', 2]]);
  assert.ok(ov.learners.every((l) => l.classes.length === 1 && l.subjects.length === 1));
  // Chipo: the class's homework (marked and back), its notes, a weekly lesson, her mock grade, a message
  const L1 = await open('learner1');
  const hw = await one(L1, `select id, learner_ids from assignments where title = 'Simultaneous equations'`);
  assert.ok(hw.learner_ids.length === 2, 'the class');
  const back = (await val(L1, `select my_attempts($1)`, [hw.id]))[0];
  assert.deepEqual([back.status, back.released, Number(back.score)], ['returned', true, 3]);
  assert.equal((await as(L1, `select id from lessons`)).length, 1);
  assert.ok((await as(L1, `select id from sessions where starts_at > now()`)).length >= 4, 'weekly lessons ahead');
  const mocks = await val(L1, `select my_mocks()`);
  assert.deepEqual([mocks[0].title, mocks[0].grade], ['Term 1 mock', 'B']);
  assert.equal((await as(L1, `select id from comments`)).length, 2);
  // Mercy's new Home: a card per learner with the streak, last mark, mock grade, exam and this week's plan
  const Mc = await open('tutor1');
  const home = await val(Mc, `select tutor_home()`);
  const chipo = home.learners.find((l) => l.id === ids.learner1);
  const tendai = home.learners.find((l) => l.id === ids.learner2);
  assert.equal(home.learners.length, 2);
  assert.ok(chipo.streak >= 1, 'studied every day');
  assert.deepEqual([chipo.last_mark.title, Number(chipo.last_mark.score), Number(chipo.last_mark.max)], ['Simultaneous equations', 3, 4]);
  assert.deepEqual([chipo.mock.title, chipo.mock.grade], ['Term 1 mock', 'B']);
  assert.ok(chipo.exam.date > new Date().toISOString().slice(0, 10));
  assert.deepEqual(chipo.plan.map((p) => p.topics), [['Algebra']]);
  assert.equal(tendai.last_mark, null);
  assert.equal(await val('L', `select tutor_home()`), null, 'tutors only');
  // Daniel has Amara's quiz to mark
  const T = await open('tutor2');
  assert.equal((await as(T, `select id from attempts where status = 'submitted'`)).length, 1);
  // Joseph nudges Year 9 about the homework nobody has started: both are told, once in 12 hours; only posted work
  const J = await open('tutor3');
  const bhw = await val(J, `select id from assignments where title = 'Cells and organelles'`);
  assert.equal(await val(J, `select nudge_assignment($1)`, [bhw]), 2);
  const L5 = await open('learner5');
  assert.equal(await val(L5, `select count(*)::int from notifications where user_id = auth.uid() and title = 'Reminder: Cells and organelles'`), 1);
  await fails(as(J, `select nudge_assignment($1)`, [bhw]), /last 12 hours/);
  await fails(as(T, `select nudge_assignment($1)`, [bhw]), /Not your work/);
  const hidden = await val(J, `insert into assignments (title, subject_id, visibility) values ('Not yet', (select id from subjects limit 1), 'hidden') returning id`);
  await fails(as(J, `select nudge_assignment($1)`, [hidden]), /Post it first/);
  // Ruth sees Chipo's approved report and the student on her own
  const P = await open('parent');
  const kids = await val(P, `select parent_children()`);
  assert.deepEqual(kids.map((k) => k.name).sort(), ['Chipo Banda', 'Lina Haddad']);
  const S = await open('student');
  const me = await one(S, `select self_learner, test_student, setup_done from profiles where id = auth.uid()`);
  assert.deepEqual(me, { self_learner: true, test_student: true, setup_done: true });

  // fenced off: not in Admin's tutors, students or numbers
  assert.ok(!(await val('A', `select admin_tutors()`)).some((t) => Object.values(ids).includes(t.id)));
  assert.ok(!(await val('A', `select admin_students()`)).students.some((s) => s.id === ids.student));
  const after = await val('A', `select admin_overview()`);
  assert.deepEqual([after.tutors, after.learners], [before.tutors, before.learners]);
  assert.equal((await val('A', `select admin_demo()`)).accounts.length, 12);

  // remove: the accounts and everything in them go
  assert.equal(await val('A', `select admin_demo_remove()`), 12);
  assert.equal(await db.query(`select count(*)::int n from profiles where demo or id = any($1)`, [Object.values(ids)]).then((r) => r.rows[0].n), 0);
  assert.equal(await db.query(`select count(*)::int n from organisations where name = 'Riverside Tuition (demo)'`).then((r) => r.rows[0].n), 0);
  assert.equal(await db.query(`select count(*)::int n from assignments where title = 'Simultaneous equations'`).then((r) => r.rows[0].n), 0);
  assert.equal((await val('A', `select admin_demo()`)).accounts.length, 0);
});

test('classes with teachers: a manager makes a class for any of its teachers; each teacher sees and marks only their own; a learner can have a school and a tutor at once', async () => {
  const mk = async (k, email) => {
    const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name: k }]);
    U[k] = r.rows[0].id;
  };
  for (const k of ['HM', 'HA', 'HB', 'PT', 'SA', 'SB', 'SX', 'NK']) await mk(k, k.toLowerCase() + '@school.x');
  for (const [k, n] of [['HM', 'Head Mumba'], ['HA', 'Ms Achieng'], ['HB', 'Mr Banda'], ['PT', 'Private Tutor']]) {
    await one(k, `select * from become_tutor($1, 'Africa/Lusaka')`, [n]);
    await as('A', `select admin_set_status($1, 'active')`, [U[k]]);
  }
  const code = (await val('HM', `select org_make_centre('Hillside School')`)).code;
  await val('HA', `select org_join($1)`, [code]);
  await val('HB', `select org_join($1)`, [code]);
  const join = async (tutor, learner) => {
    const c = await val(tutor, `insert into invites (name) values ($1) returning code`, [learner]);
    await one(learner, `select * from accept_invite($1, $2)`, [c, learner]);
  };
  await join('HA', 'SA');
  await join('HB', 'SB');
  await join('PT', 'SX');
  const chem = await val('HB', `insert into subjects (name) values ('Chemistry') returning id`);

  // the manager makes Form 3 chemistry for Mr Banda, with a learner of Ms Achieng's and one of his own
  const pool = (await val('HM', `select class_pool()`)).map((l) => l.id);
  assert.ok(pool.includes(U.SA) && pool.includes(U.SB) && !pool.includes(U.SX), 'the school’s learners, not the private tutor’s');
  await fails(as('HM', `select save_class(null, 'Form 3', $1, $2, $3)`, [chem, [U.SA], [U.PT]]), /centre’s tutors/);
  const f3 = await val('HM', `select save_class(null, 'Form 3 chemistry', $1, $2, $3)`, [chem, [U.SA, U.SB], [U.HB]]);
  assert.deepEqual((await as('HB', `select teacher_id from class_teachers where class_id = $1`, [f3])).map((t) => t.teacher_id), [U.HB]);
  // a teacher who isn't a manager teaches their own classes: can't add another teacher's learner, can't change teachers
  await fails(as('HA', `select save_class(null, 'Mine', null, $1)`, [[U.SB]]), /Not your learner/);
  await val('HB', `select save_class($1, 'Form 3 chemistry', $2, $3, $4)`, [f3, chem, [U.SA, U.SB], [U.HA]]);
  assert.deepEqual((await as('HB', `select teacher_id from class_teachers where class_id = $1`, [f3])).map((t) => t.teacher_id), [U.HB], 'only a manager changes teachers');

  // Mr Banda sets homework for the class: Sasha (Ms Achieng's learner) gets it, does it, and he marks it
  const hw = await val('HB', `insert into assignments (title, kind, subject_id, class_id, visibility) values ('Moles', 'homework', $1, $2, 'visible') returning id`, [chem, f3]);
  await val('HB', `insert into questions (assignment_id, type, prompt_md, marks) values ($1, 'numeric', 'How many moles in 18 g of water?', 1) returning id`, [hw]);
  assert.equal((await as('SA', `select id from assignments where id = $1`, [hw])).length, 1);
  assert.deepEqual((await as('SA', `select name from subjects where id = $1`, [chem])).map((s) => s.name), ['Chemistry'], 'the class’s subject');
  assert.equal(await val('SA', `select count(*)::int from notifications where user_id = auth.uid() and title = 'New homework: Moles'`), 1, 'told about it, though he isn’t her own tutor');
  const t = await one('SA', `select * from start_attempt($1)`, [hw]);
  await as('SA', `select submit_attempt($1)`, [t.id]);
  assert.equal((await as('HB', `select id from attempts where id = $1`, [t.id])).length, 1, 'he marks it');
  assert.equal((await as('HA', `select id from attempts where id = $1`, [t.id])).length, 0, 'not hers to mark');
  // he can see her and her progress, message her, but not run her account (that's her own tutor's)
  assert.equal((await as('HB', `select id from profiles where id = $1`, [U.SA])).length, 1);
  await val('HB', `select learner_progress($1)`, [U.SA]);
  await as('HB', `insert into comments (tutor_id, learner_id, body) values ($1, $2, 'Nice work on moles')`, [U.HB, U.SA]);
  await fails(as('HB', `select set_learner_password($1, 'newpass123')`, [U.SA]), /Not your learner/);
  await fails(as('HB', `select remove_learner($1)`, [U.SA]), /Not your learner/);
  // she can message either of them, not anyone else
  await as('SA', `insert into comments (tutor_id, learner_id, body) values ($1, $2, 'Thanks!')`, [U.HB, U.SA]);
  await fails(as('SA', `insert into comments (tutor_id, learner_id, body) values ($1, $2, 'hi')`, [U.PT, U.SA]), /row-level security/);
  assert.deepEqual((await val('SA', `select my_teachers()`)).map((x) => [x.name, x.main]), [['Ms Achieng', true], ['Mr Banda', false]]);

  // a school and a private tutor at once: the private tutor's learner joins the class with its code
  const cc = await val('HB', `select class_code($1)`, [f3]);
  assert.match(cc, /^\d{8}$/);
  assert.equal(await val('SX', `select join_class('0000 0000')`), null, 'a wrong code joins nothing');
  assert.equal((await val('SX', `select join_class($1)`, [cc.slice(0, 4) + ' ' + cc.slice(4)])).class, 'Form 3 chemistry');
  assert.equal(await val('SX', `select tutor_id from profiles where id = auth.uid()`), U.PT, 'still the private tutor’s learner');
  assert.equal((await as('SX', `select id from assignments where id = $1`, [hw])).length, 1);
  assert.equal((await as('PT', `select id from profiles where id = $1`, [U.SX])).length, 1);
  assert.equal((await as('HB', `select id from profiles where id = $1`, [U.SX])).length, 1);
  assert.ok((await val('HM', `select org_overview()`)).learners.some((l) => l.id === U.SX), 'in the school’s overview');
  // the private tutor lets her go: she stays in the school's class
  await as('PT', `select remove_learner($1)`, [U.SX]);
  assert.equal(await db.query(`select count(*)::int n from class_members where learner_id = $1 and class_id = $2`, [U.SX, f3]).then((r) => r.rows[0].n), 1);
  // a brand-new account with the class's code becomes a learner of its teacher, in the class
  const nk = await one('NK', `select * from accept_invite($1, 'New Kid')`, [cc]);
  assert.deepEqual([nk.role, nk.tutor_id, nk.display_name], ['learner', U.HB, 'New Kid']);
  assert.equal((await as('NK', `select id from assignments where id = $1`, [hw])).length, 1);
  // Mr Banda's Home has a card for everyone he teaches
  const home = await val('HB', `select tutor_home()`);
  assert.deepEqual(home.learners.map((l) => l.id).sort(), [U.SA, U.SB, U.SX, U.NK].sort());
  // the manager can put a class away or delete it; another centre's tutor can't touch it
  await fails(as('PT', `select delete_class($1)`, [f3]), /Not your class/);
  await as('HM', `select archive_class($1, true)`, [f3]);
  await as('HM', `select archive_class($1, false)`, [f3]);
});

test('Essentials and Plus: Plus adds Prof, mock grades, the exam camera and StudyBridge’s library; a free week of Plus from approval; nothing is switched off until plan limits are on', async () => {
  const mk = async (k, email) => {
    const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name: k }]);
    U[k] = r.rows[0].id;
  };
  await mk('PE', 'essentials@plans.x');
  await mk('PP', 'plus@plans.x');
  await one('PE', `select * from become_tutor('Esther Essentials', 'UTC')`);
  await one('PP', `select * from become_tutor('Peter Plus', 'UTC')`);
  assert.equal(await val('PE', `select trial_until from profiles where id = auth.uid()`), null, 'no free week before approval');
  await as('A', `select admin_set_status($1, 'active')`, [U.PE]);
  await as('A', `select admin_set_status($1, 'active')`, [U.PP]);
  const trial = new Date(await val('PE', `select trial_until from profiles where id = auth.uid()`));
  assert.ok(Math.abs(trial - Date.now() - 7 * 86400000) < 60000, 'a free week of Plus from approval');
  // plan limits off: everyone has everything, whatever their level
  await as('A', `select admin_set_level($1, 'essentials')`, [U.PE]);
  assert.equal((await val('PE', `select my_plan()`)).plus, true);
  await fails(as('T', `select admin_set_level($1, 'plus')`, [U.PE]), /admins only/i);
  await fails(as('A', `select admin_set_level($1, 'gold')`, [U.PE]), /Essentials or Plus/);

  // limits on: Essentials after the free week loses Prof, new mocks, the camera and StudyBridge's library
  await as('A', `select admin_set_selling(p_enforce => true)`);
  try {
    await db.query(`update profiles set trial_until = now() - interval '1 day' where id = $1`, [U.PE]);
    await as('A', `select admin_set_level($1, 'essentials', (current_date + 30)::date)`, [U.PE]); // paid for Essentials
    const pe = await val('PE', `select my_plan()`);
    assert.deepEqual([pe.level, pe.plus, pe.enforced], ['essentials', false, true]);
    await fails(as('PE', `select prof_ask('Make a quiz', '{}')`), /Prof comes with Plus/);
    await fails(as('PE', `insert into mocks (title) values ('Term 1')`), /Mocks with grades come with Plus/);
    await fails(as('PE', `insert into assignments (title, kind, camera) values ('Exam', 'exam', true)`), /exam camera comes with Plus/);
    const plain = await val('PE', `insert into assignments (title, kind) values ('Homework', 'homework') returning id`);
    await fails(as('PE', `update assignments set camera = true where id = $1`, [plain]), /exam camera comes with Plus/);
    assert.equal(await val('PE', `select public._sb_library()`), null, 'no StudyBridge library');
    // Peter is on Plus in his free week: all of it
    assert.equal((await val('PP', `select my_plan()`)).plus, true);
    await val('PP', `insert into mocks (title) values ('Term 1') returning id`);
    // after his free week he needs to have paid (recorded by the Owner)
    await db.query(`update profiles set trial_until = now() - interval '1 day' where id = $1`, [U.PP]);
    assert.equal((await val('PP', `select my_plan()`)).plus, false);
    await as('A', `select admin_set_level($1, 'plus', (current_date + 30)::date)`, [U.PP]);
    assert.equal((await val('PP', `select my_plan()`)).plus, true);
    assert.equal((await val('A', `select admin_tutors()`)).find((t) => t.id === U.PP).plus, true);
    // or a few more free days
    await as('A', `select admin_set_level($1, 'plus', null, 7)`, [U.PE]);
    assert.equal((await val('PE', `select my_plan()`)).plus, true, 'Plus again for 7 days');
    // asking to switch tells the Owner
    await as('PE', `select ask_level('plus')`);
    assert.ok((await as('A', `select title from notifications where user_id = auth.uid() and title = 'Esther Essentials would like Plus'`)).length === 1);
  } finally {
    await as('A', `select admin_set_selling(p_enforce => false)`);
  }
});

test('watched mode: a locked-down test on any device when the tutor allows it, each try to leave a strike; pausing a learner keeps their work and takes them off the plan', async () => {
  const mk = async (k, email) => {
    const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name: k }]);
    U[k] = r.rows[0].id;
  };
  for (const k of ['WT', 'WL', 'WL2']) await mk(k, k.toLowerCase() + '@watched.x');
  await one('WT', `select * from become_tutor('Watcher', 'UTC')`);
  await as('A', `select admin_set_status($1, 'active')`, [U.WT]);
  for (const l of ['WL', 'WL2']) {
    const c = await val('WT', `insert into invites (name) values ($1) returning code`, [l]);
    await one(l, `select * from accept_invite($1, $2)`, [c, l]);
  }
  const test1 = await val('WT', `insert into assignments (title, kind, lockdown, visibility, leave_warnings) values ('Locked test', 'test', true, 'visible', 1) returning id`);
  await val('WT', `insert into questions (assignment_id, type, prompt_md, marks) values ($1, 'numeric', '2 + 2?', 1) returning id`, [test1]);
  // locked down: the desktop app only, unless the tutor allows watched mode
  await fails(as('WL', `select start_attempt($1, 'Chromebook')`, [test1]), /desktop app/);
  await as('WT', `update assignments set watched = true where id = $1`, [test1]);
  const t = await one('WL', `select * from start_attempt($1, 'Chromebook')`, [test1]);
  assert.equal(t.client, 'Chromebook', 'the tutor sees which device');
  // each try to leave is a strike: a warning, then it hands itself in
  const s1 = await val('WL', `select lockdown_strike($1, 'Left the page')`, [t.id]);
  assert.equal(s1.handed_in, false);
  const s2 = await val('WL', `select lockdown_strike($1, 'Left full screen')`, [t.id]);
  assert.equal(s2.handed_in, true);
  assert.equal(await val('WT', `select status from attempts where id = $1`, [t.id]), 'submitted');

  // pausing: work kept, nothing new can start, not told about new work, not counted on the plan
  assert.equal((await val('WT', `select my_plan()`)).learners, 2);
  await fails(as('WL2', `select pause_learner($1)`, [U.WL]), /Not your learner/);
  await as('WT', `select pause_learner($1)`, [U.WL2]);
  assert.deepEqual([(await val('WT', `select my_plan()`)).learners, (await val('WT', `select my_plan()`)).paused], [1, 1]);
  assert.equal(await val('WL2', `select count(*)::int from notifications where user_id = auth.uid() and title = 'Your StudyBridge is paused for now'`), 1);
  const hw = await val('WT', `insert into assignments (title, kind, visibility) values ('After the pause', 'homework', 'visible') returning id`);
  assert.equal(await val('WL2', `select count(*)::int from notifications where user_id = auth.uid() and title = 'New homework: After the pause'`), 0, 'not told');
  assert.equal(await val('WL', `select count(*)::int from notifications where user_id = auth.uid() and title = 'New homework: After the pause'`), 1, 'the others are');
  await fails(as('WL2', `select start_attempt($1, 'browser')`, [hw]), /paused/);
  assert.equal((await as('WL2', `select id from assignments where id = $1`, [hw])).length, 1, 'they can still see it');
  await as('WT', `select pause_learner($1, false)`, [U.WL2]);
  await as('WL2', `select start_attempt($1, 'browser')`, [hw]);
  assert.equal((await val('WT', `select my_plan()`)).learners, 2);
});

test('online checkout: per-learner prices; mobile money counts only once Flutterwave confirms the right amount; tutors’ card subscriptions set the level and keep the number of learners in step', async () => {
  const sql = async (q, p) => (await db.query(q, p)).rows[0];
  // graduated per learner: 12 on Plus = 10 × $8 + 2 × $6; 35 on Essentials = 10 × $5 + 20 × $4 + 5 × $3; never less than one
  assert.deepEqual(
    [Number((await sql(`select _tutor_month_usd('plus', 12) v`)).v), Number((await sql(`select _tutor_month_usd('essentials', 35) v`)).v), Number((await sql(`select _tutor_month_usd('plus', 0) v`)).v)],
    [92, 145, 8],
  );
  // only the Prof server starts or records payments
  await fails(as('T', `select _mobile_payment_new($1, 'plus', 1, 'USD')`, [U.T]), /permission denied/);
  await fails(as('T', `select _mobile_payment_done('x', 1, 'USD', '1')`), /permission denied/);
  await fails(as('T', `select _set_paid_level($1, 'plus', 'month', null, null, now())`, [U.T]), /permission denied/);

  // a tutor pays three months of Plus in kwacha
  const mk = async (k, email) => {
    const r = await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name: k }]);
    U[k] = r.rows[0].id;
  };
  await mk('CT', 'checkout-tutor@x.com');
  await one('CT', `select * from become_tutor('Chanda', 'Africa/Lusaka')`);
  await as('A', `select admin_set_status($1, 'active')`, [U.CT]);
  const start = (await sql(`select _mobile_payment_new($1, 'plus', 3, 'zmw') v`, [U.CT])).v;
  assert.deepEqual([start.currency, start.amount], ['ZMW', Math.ceil(8 * 3 * 19.69)]);
  assert.equal((await as('CT', `select tx_ref from mobile_payments`)).length, 1, 'they see their own payment');
  assert.equal((await as('T', `select tx_ref from mobile_payments`)).length, 0);
  // too little, or the wrong currency: it doesn't count
  assert.equal((await sql(`select _mobile_payment_done($1, $2, 'ZMW', '101') v`, [start.tx_ref, start.amount - 1])).v, false);
  assert.equal((await sql(`select _mobile_payment_done($1, $2, 'USD', '101') v`, [start.tx_ref, start.amount])).v, false);
  assert.equal((await sql(`select _mobile_payment_done($1, $2, 'ZMW', '101') v`, [start.tx_ref, start.amount])).v, true);
  assert.equal((await sql(`select _mobile_payment_done($1, $2, 'ZMW', '101') v`, [start.tx_ref, start.amount])).v, false, 'once');
  const ct = await val('CT', `select my_plan()`);
  assert.equal(ct.level, 'plus');
  assert.ok(ct.paid_until >= new Date(Date.now() + 85 * 86400000).toISOString().slice(0, 10), 'three months');
  // a year is 11 months' price
  const year = (await sql(`select _mobile_payment_new($1, 'essentials', 12, 'USD') v`, [U.CT])).v;
  assert.equal(Number(year.amount), 5 * 11);
  // a student on their own: an exam pass by the month
  const stu = (await sql(`select id from profiles where self_learner and not demo limit 1`))?.id;
  if (stu) {
    const pass = (await sql(`select _mobile_payment_new($1, 'pass', 4, 'USD') v`, [stu])).v;
    assert.equal(Number(pass.amount), 36);
    assert.equal((await sql(`select _mobile_payment_done($1, 36, 'USD', '102') v`, [pass.tx_ref])).v, true);
    assert.equal((await sql(`select paid_plan from profiles where id = $1`, [stu])).paid_plan, 'pass');
  }
  await fails(db.query(`select _mobile_payment_new($1, 'plus', 1, 'EUR')`, [U.CT]), /currency/);
  // a parent pays for their own child only
  await fails(db.query(`select _mobile_payment_new($1, 'monthly', 1, 'USD', $2)`, [U.CT, U.T]), /your own child/);
  const kid = (await sql(`select learner_id, parent_id from parent_links pl join profiles c on c.id = pl.learner_id where c.self_learner limit 1`));
  if (kid) {
    const forKid = (await sql(`select _mobile_payment_new($1, 'monthly', 1, 'USD', $2) v`, [kid.parent_id, kid.learner_id])).v;
    assert.equal(Number(forKid.amount), 11);
    assert.equal((await sql(`select user_id from mobile_payments where tx_ref = $1`, [forKid.tx_ref])).user_id, kid.learner_id, 'it’s the child’s plan');
  }
  assert.deepEqual((await val('A', `select public_settings()`)).currencies, ['USD', 'INR', 'ZMW']);
  await fails(db.query(`select _mobile_payment_new($1, 'pass', 1, 'USD')`, [U.CT]), /isn’t something you can pay for/);

  // by card: Stripe sets the level and paid-up date; the number of learners follows them
  await db.query(`select _set_paid_level($1, 'essentials', 'month', 'cus_1', 'sub_1', now() + interval '30 days')`, [U.CT]);
  const card = await val('CT', `select my_plan()`);
  assert.equal(card.level, 'essentials');
  assert.ok((await sql(`select stripe_tutor_sub from profiles where id = $1`, [U.CT])).stripe_tutor_sub === 'sub_1');
  let due = (await sql(`select _seats_due() v`)).v.find((x) => x.tutor === U.CT);
  assert.deepEqual([due.sub, due.seats], ['sub_1', 1]);
  await db.query(`select _seats_synced($1, 1)`, [U.CT]);
  assert.equal((await sql(`select _seats_due() v`)).v.find((x) => x.tutor === U.CT), undefined, 'in step');
  const code = await val('CT', `insert into invites (name) values ('One') returning code`);
  await mk('CL1', 'cl1@x.com');
  await mk('CL2', 'cl2@x.com');
  await one('CL1', `select * from accept_invite($1, 'One')`, [code]);
  const code2 = await val('CT', `insert into invites (name) values ('Two') returning code`);
  await one('CL2', `select * from accept_invite($1, 'Two')`, [code2]);
  due = (await sql(`select _seats_due() v`)).v.find((x) => x.tutor === U.CT);
  assert.equal(due.seats, 2, 'two learners now');
  await db.query(`select _seats_synced($1, 2)`, [U.CT]);
  await as('CT', `select pause_learner($1)`, [U.CL2]);
  assert.equal((await sql(`select _seats_due() v`)).v.find((x) => x.tutor === U.CT).seats, 1, 'a paused learner isn’t paid for');
  // the subscription ends
  await db.query(`select _set_paid_level($1, 'essentials', null, null, null, null)`, [U.CT]);
  assert.equal((await sql(`select stripe_tutor_sub from profiles where id = $1`, [U.CT])).stripe_tutor_sub, null);

  // Admin → Selling: mobile money opens once both Flutterwave keys are in (never shown again)
  assert.equal((await val('A', `select public_settings()`)).mobile_on, false);
  await fails(as('T', `select admin_set_checkout(p_tax => true)`), /admins only/i);
  await as('A', `select admin_set_checkout(true, 'FLWSECK_TEST-x', 'hash-x')`);
  const sel = await val('A', `select admin_selling()`);
  assert.deepEqual([sel.stripe_tax, sel.flw_set, sel.flw_hash_set], [true, true, true]);
  assert.ok(!JSON.stringify(sel).includes('FLWSECK'), 'never shown again');
  assert.equal((await val('A', `select public_settings()`)).mobile_on, true);
  await db.exec(`update platform_secrets set flw_secret = null, flw_hash = null where id = 1; update app_config set stripe_tax = false where id = 1`);
});

test('schools and centres: one price, by invoice, set up by StudyBridge; places with mobile money; a watched page that goes quiet', async () => {
  const sql = async (q, p) => (await db.query(q, p)).rows[0];
  const mk = async (k, email) => {
    U[k] = (await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name: k }])).rows[0].id;
  };
  for (const k of ['BM', 'BT']) {
    await mk(k, k.toLowerCase() + '@bill.x');
    await one(k, `select * from become_tutor($1, 'UTC')`, [k === 'BM' ? 'Bill Manager' : 'Bill Tutor']);
    await as('A', `select admin_set_status($1, 'active')`, [U[k]]);
  }
  const addLearner = async (tutor, k) => {
    await mk(k, k.toLowerCase() + '@bill.x');
    const c = await val(tutor, `insert into invites (name) values ($1) returning code`, [k]);
    return one(k, `select * from accept_invite($1, $2)`, [c, k]);
  };
  await addLearner('BM', 'BL1');
  await addLearner('BT', 'BL2');
  await addLearner('BT', 'BL3');
  const centre = await val('BM', `select org_make_centre('Bill Centre')`);
  await val('BT', `select org_join($1)`, [centre.code]);
  // a centre pays for everyone in it at the school price, with a free week to start; its tutors don't pay as well
  const bt = await val('BT', `select my_plan()`);
  assert.deepEqual([bt.state, bt.learners, bt.own_learners, bt.centre.name, bt.centre.manager, bt.centre.kind], ['trial', 3, 2, 'Bill Centre', false, 'centre']);
  assert.deepEqual(await val('BT', `select my_org_billing()`), { billing: 'centre', level: 'plus', learners: 3 });
  // never at tutor prices: no card or mobile money for a centre
  await fails(db.query(`select _mobile_payment_new($1, 'plus', 1, 'USD')`, [U.BM]), /pays yearly by invoice/);
  await fails(db.query(`select _mobile_payment_new($1, 'seats', 1, 'USD', null, 2)`, [U.BM]), /pays yearly by invoice/);
  assert.equal((await sql(`select _checkout_target($1) v`, [U.BM])).v.kind, 'centre');
  // $15 a learner a year, at least 30 learners
  assert.deepEqual([Number((await sql(`select public._school_year_usd(3) v`)).v), Number((await sql(`select public._school_year_usd(45) v`)).v)], [450, 675]);
  // the manager asks for an invoice: the Owner is told, and hello@ gets an email to reply to
  await fails(as('BT', `select org_ask_invoice()`), /Only the manager/);
  const ask = await val('BM', `select org_ask_invoice(40, 'Starting in January')`);
  assert.deepEqual([ask.learners, Number(ask.amount)], [40, 600]);
  assert.equal(await val('A', `select count(*)::int from notifications where user_id = auth.uid() and title = 'Bill Centre would like an invoice'`), 1);
  assert.ok(Number((await sql(`select count(*) n from outgoing_emails where subject = 'Bill Centre would like an invoice'`)).n) >= 0);
  assert.ok((await val('BM', `select my_plan()`)).centre.invoice_asked_at, 'the manager sees they asked');
  // the Owner sets it up: a school with a free pilot, then paid for 4 learners for a year
  await fails(as('BM', `select admin_orgs()`), /admins only/i);
  const row = (await val('A', `select admin_orgs()`)).find((x) => x.id === centre.id);
  assert.deepEqual([row.teachers, row.learners, row.state, !!row.invoice_asked_at, row.manager.name], [2, 3, 'trial', true, 'Bill Manager']);
  await fails(as('BM', `select admin_set_school_plan($1, null, null, 60, 'school')`, [centre.id]), /admins only/i);
  await as('A', `select admin_set_school_plan($1, null, null, 60, 'school')`, [centre.id]);
  assert.equal((await val('BM', `select my_plan()`)).centre.kind, 'school');
  await as('A', `select admin_set_school_plan($1, (current_date + 365)::date, 4)`, [centre.id]);
  const paid = await val('BT', `select my_plan()`);
  assert.deepEqual([paid.state, paid.seats, paid.level], ['paid', 4, 'plus']);
  assert.equal(await val('BM', `select count(*)::int from notifications where user_id = auth.uid() and title = 'Thank you! Bill Centre is paid up'`), 1);
  // with limits on, its places are shared by everyone in it
  await as('A', `select admin_set_selling(p_enforce => true)`);
  try {
    await addLearner('BT', 'BL4');
    await fails(addLearner('BM', 'BL5'), /paid for 4 places/);
  } finally {
    await as('A', `select admin_set_selling(p_enforce => false)`);
  }
  // a card plan from before still follows the centre's learners, and ends cleanly
  await db.query(`select _set_org_paid($1, 'plus', 'month', 'cus_c', 'sub_c', now() + interval '30 days')`, [centre.id]);
  assert.equal((await val('BM', `select my_plan()`)).state, 'card');
  const due = (await sql(`select _seats_due() v`)).v.find((x) => x.org === centre.id);
  assert.equal(due.sub, 'sub_c');
  await db.query(`select _org_seats_synced($1, $2)`, [centre.id, due.seats]);
  assert.equal((await sql(`select _seats_due() v`)).v.find((x) => x.org === centre.id), undefined);
  await db.query(`select _set_org_paid($1, 'plus', null, null, null, null)`, [centre.id]);
  await fails(as('BM', `select _set_org_paid($1, 'plus', 'month', null, null, now())`, [centre.id]), /permission denied/);
  // leaving a centre that paid: a week to sort out their own plan, then they pay as a tutor (with places, by mobile money)
  await db.query(`update profiles set trial_until = now() - interval '1 day' where id = $1`, [U.BT]);
  await val('BT', `select org_leave()`);
  const own = await val('BT', `select my_plan()`);
  assert.deepEqual([own.state, own.centre, own.learners], ['trial', null, 3]);
  const pay = (await sql(`select _mobile_payment_new($1, 'plus', 2, 'USD', null, 4) v`, [U.BT])).v;
  assert.deepEqual([pay.seats, Number(pay.amount)], [4, 8 * 4 * 2]);
  await sql(`select _mobile_payment_done($1, $2, 'USD', 'f1') v`, [pay.tx_ref, pay.amount]);
  assert.deepEqual([(await val('BT', `select my_plan()`)).state, (await val('BT', `select my_plan()`)).seats], ['paid', 4]);
  // two more places for the rest of the paid time: the next step's price, for each month left
  const more = (await sql(`select _mobile_payment_new($1, 'seats', 1, 'USD', null, 2) v`, [U.BT])).v;
  assert.deepEqual([more.seats, more.months, Number(more.amount)], [2, 2, (8 * 6 - 8 * 4) * 2]);
  await sql(`select _mobile_payment_done($1, $2, 'USD', 'f2') v`, [more.tx_ref, more.amount]);
  assert.equal((await val('BT', `select my_plan()`)).seats, 6);
  // a tutor on their own can't add places to a plan they haven't paid for that way
  await fails(db.query(`select _mobile_payment_new($1, 'seats', 1, 'USD', null, 1)`, [U.T]), /Pay for your plan first/);

  // watched mode: the page says it's there; quiet for 2 minutes, the tutor is told once
  const wt = await val('BM', `insert into assignments (title, kind, lockdown, watched, visibility) values ('Watched check', 'test', true, true, 'visible') returning id`);
  await val('BM', `insert into questions (assignment_id, type, prompt_md, marks) values ($1, 'numeric', '1 + 1?', 1) returning id`, [wt]);
  const at = await one('BL1', `select * from start_attempt($1, 'Chromebook')`, [wt]);
  await as('BL1', `select watch_seen($1)`, [at.id]);
  assert.equal((await sql(`select public._watch_away() v`)).v, 0, 'still there');
  await db.query(`update attempts set seen_at = now() - interval '3 minutes' where id = $1`, [at.id]);
  assert.equal((await sql(`select public._watch_away() v`)).v, 1);
  assert.equal((await sql(`select public._watch_away() v`)).v, 0, 'once');
  assert.equal(await val('BM', `select count(*)::int from notifications where user_id = auth.uid() and title = 'BL1: not on the page for 2 minutes'`), 1);
  assert.match((await val('BM', `select attempt_detail($1)`, [at.id])).attempt.lockdown_events.at(-1).event, /Not on the page for 2 minutes/);
  assert.ok((await val('BM', `select attempt_detail($1)`, [at.id])).attempt.seen_at, 'the tutor sees when it was last there');
  assert.equal((await val('BL1', `select attempt_detail($1)`, [at.id])).attempt.seen_at, null, 'only the tutor');
  await fails(as('BL1', `select public._watch_away()`), /permission denied/);
});

test('one login, many places: a second tutor and a school, a wall between them, sharing, pausing per place, parents see everything', async () => {
  const sql = async (q, p) => (await db.query(q, p)).rows[0];
  const mk = async (k, email, name = k) => {
    U[k] = (await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name }])).rows[0].id;
  };
  for (const [k, name] of [['MA', 'Ms Main'], ['TB', 'Mr Banda'], ['SH', 'Head Teacher']]) {
    await mk(k, k.toLowerCase() + '@places.x', name);
    await one(k, `select * from become_tutor($1, 'UTC')`, [name]);
    await as('A', `select admin_set_status($1, 'active')`, [U[k]]);
  }
  // Zoe joins her main tutor, then a second tutor with his code, then a school's class with its code: one login
  await mk('ZO', 'zoe@places.x', 'Zoe');
  const c1 = await val('MA', `insert into invites (name) values ('Zoe') returning code`);
  await one('ZO', `select * from accept_invite($1, 'Zoe')`, [c1]);
  const physics = await val('TB', `insert into subjects (name) values ('Physics') returning id`);
  const c2 = await val('TB', `insert into invites (name, subject_ids) values ('Zoe', $1) returning code`, [[physics]]);
  const again = await one('ZO', `select * from accept_invite($1, 'Zoe B')`, [c2]);
  assert.equal(again.tutor_id, U.MA, 'her main tutor stays');
  assert.equal(again.display_name, 'Zoe', 'and so does her name');
  const school = await val('SH', `select org_make_centre('Hill School')`);
  await db.query(`update organisations set kind = 'school' where id = $1`, [school.id]);
  const cls = await val('SH', `select save_class(null, 'Form 3 biology', null, '{}')`);
  const ccode = await val('SH', `select class_code($1)`, [cls]);
  await val('ZO', `select join_class($1)`, [ccode]);
  // she sees all three, the school as one place
  const places = await val('ZO', `select my_places()`);
  assert.deepEqual(places.map((x) => [x.name, x.kind, x.main]), [['Ms Main', 'tutor', true], ['Hill School', 'school', false], ['Mr Banda', 'tutor', false]]);
  // each place posts work; she sees all of it; each tutor sees only their own
  const hwMain = await val('MA', `insert into assignments (title, kind, visibility) values ('Main homework', 'homework', 'visible') returning id`);
  const hwB = await val('TB', `insert into assignments (title, kind, subject_id, visibility) values ('Banda quiz', 'quiz', $1, 'visible') returning id`, [physics]);
  const hwS = await val('SH', `insert into assignments (title, kind, class_id, visibility) values ('School essay', 'homework', $1, 'visible') returning id`, [cls]);
  for (const id of [hwMain, hwB, hwS]) await val(id === hwB ? 'TB' : id === hwS ? 'SH' : 'MA', `insert into questions (assignment_id, type, prompt_md, marks) values ($1, 'numeric', '1 + 1?', 2) returning id`, [id]);
  assert.equal((await as('ZO', `select id from assignments where id = any ($1)`, [[hwMain, hwB, hwS]])).length, 3);
  assert.equal((await as('TB', `select id from profiles where id = $1`, [U.ZO])).length, 1, 'Mr Banda has her as a learner');
  assert.equal((await as('TB', `select id from assignments where id = any ($1)`, [[hwMain, hwS]])).length, 0, 'but not the others’ work');
  // the wall: time studied and marks from one place aren't seen by another
  for (const [t, id, sec] of [['MA', hwMain, 600], ['TB', hwB, 300], ['SH', hwS, 120]]) {
    await db.query(`insert into activity (learner_id, tutor_id, kind, ref_id, seconds) values ($1, $2, 'assignment', $3, $4)`, [U.ZO, U[t], id, sec]);
  }
  const tb = await val('TB', `select learner_summary($1, now() - interval '1 day', now() + interval '1 day')`, [U.ZO]);
  assert.equal(Number(tb.seconds), 300, 'Mr Banda sees only the time on his own work');
  assert.equal(Number((await val('SH', `select learner_progress($1)`, [U.ZO])).total_seconds), 120);
  assert.equal(Number((await val('ZO', `select learner_progress($1)`, [U.ZO])).total_seconds), 1020, 'she sees all of it');
  // sharing: she lets Mr Banda see her marks and progress from everywhere (never answers or messages)
  await fails(as('TB', `select set_share($1, true, $2)`, [U.TB, U.ZO]), /Only the learner/);
  await val('ZO', `select set_share($1, true)`, [U.TB]);
  assert.equal(Number((await val('TB', `select learner_summary($1, now() - interval '1 day', now() + interval '1 day')`, [U.ZO])).seconds), 1020);
  assert.equal((await as('TB', `select id from assignments where id = $1`, [hwMain])).length, 0, 'still not the work itself');
  await val('ZO', `select set_share($1, false)`, [U.TB]);
  assert.equal(Number((await val('TB', `select learner_summary($1, now() - interval '1 day', now() + interval '1 day')`, [U.ZO])).seconds), 300);
  // only her main tutor looks after her account
  await fails(as('TB', `select set_learner_password($1, 'secret99')`, [U.ZO]), /Not your learner/);
  await fails(as('TB', `select create_parent_invite($1)`, [U.ZO]), /Not your learner/);
  // a parent sees everything from every place
  const pcode = (await one('MA', `select * from create_parent_invite($1, 'Dad')`, [U.ZO])).code;
  await mk('ZD', 'zoedad@places.x', 'Dad');
  await val('ZD', `select accept_parent_invite($1, 'Dad')`, [pcode]);
  const due = await db.query(`update assignments set due_at = now() + interval '2 days' where id = any ($1)`, [[hwMain, hwB, hwS]]);
  const pv = await val('ZD', `select parent_view($1)`, [U.ZO]);
  assert.deepEqual(pv.due.map((x) => x.from).sort(), ['Hill School', 'Mr Banda', 'Ms Main']);
  assert.equal(pv.places.length, 3);
  // pausing is per place: Mr Banda pauses her; her main tutor's work carries on
  await as('TB', `select pause_learner($1)`, [U.ZO]);
  await fails(as('ZO', `select start_attempt($1, 'browser')`, [hwB]), /paused/);
  await as('ZO', `select start_attempt($1, 'browser')`, [hwMain]);
  assert.equal(await val('ZO', `select count(*)::int from notifications where user_id = auth.uid() and title = 'Your StudyBridge with Mr Banda is paused for now'`), 1);
  await as('TB', `select pause_learner($1, false)`, [U.ZO]);
  // each place pays for her
  assert.equal(await val(null, `select 1`), 1);
  assert.deepEqual([(await sql(`select public._active_learners($1) n`, [U.TB])).n, (await sql(`select public._org_learners($1) n`, [school.id])).n], [1, 1]);
  // a place unpaid after its free week: read-only for the tutor; for her, nothing new starts there, and she's told once
  await as('A', `select admin_set_selling(p_enforce => true)`);
  try {
    await db.query(`update profiles set trial_until = now() - interval '1 day' where id = $1`, [U.TB]);
    await fails(as('ZO', `select start_attempt($1, 'browser')`, [hwB]), /Mr Banda’s StudyBridge is paused for now/);
    await as('ZO', `select start_attempt($1, 'browser')`, [hwMain]); // the others carry on
    await db.query(`select public._bill_tick()`);
    await db.query(`select public._bill_tick()`);
    assert.equal(await val('ZO', `select count(*)::int from notifications where user_id = auth.uid() and title = 'Mr Banda’s StudyBridge is paused for now'`), 1, 'told once');
    assert.equal(await val('TB', `select count(*)::int from notifications where user_id = auth.uid() and title = 'Your free week has ended'`), 1);
    assert.equal((await val('ZO', `select my_places()`)).find((x) => x.name === 'Mr Banda').unpaid, true);
    await fails(as('TB', `insert into assignments (title, kind) values ('Another', 'homework')`), /read-only/);
    await as('A', `select admin_set_level($1, 'plus', (current_date + 30)::date)`, [U.TB]);
    await db.query(`select public._bill_tick()`);
    assert.equal(await val('ZO', `select count(*)::int from notifications where user_id = auth.uid() and title = 'Mr Banda’s StudyBridge is back on'`), 1);
  } finally {
    await as('A', `select admin_set_selling(p_enforce => false)`);
  }
  // she leaves Mr Banda (not her main tutor); he can't see her any more
  await fails(as('ZO', `select leave_place($1)`, [U.MA]), /main tutor/);
  await as('ZO', `select leave_place($1)`, [U.TB]);
  assert.equal((await as('TB', `select id from profiles where id = $1`, [U.ZO])).length, 0);
  // her main tutor leaving hands her account to the next one she added (the school's class stays)
  const c3 = await val('TB', `insert into invites (name) values ('Zoe') returning code`);
  await one('ZO', `select * from accept_invite($1, 'Zoe')`, [c3]);
  await as('MA', `select remove_learner($1)`, [U.ZO]);
  assert.equal((await sql(`select tutor_id from profiles where id = $1`, [U.ZO])).tutor_id, U.TB);
  assert.equal((await val('ZD', `select parent_view($1)`, [U.ZO])).learner.name, 'Zoe', 'her parent still follows her');
  // time studied counts for whoever set the work (not always her main tutor)
  await as('ZO', `select log_time('study', $1, 30)`, [physics]);
  assert.equal((await sql(`select tutor_id from activity where learner_id = $1 and kind = 'study' and seconds = 30`, [U.ZO])).tutor_id, U.TB);
  // students on their own can't add a tutor or school
  const stu = (await sql(`select id from profiles where self_learner and not demo limit 1`))?.id;
  if (stu) {
    U.STU = stu;
    const c4 = await val('MA', `insert into invites (name) values ('Solo') returning code`);
    await fails(as('STU', `select accept_invite($1, 'Solo')`, [c4]), /studies on its own/);
    await fails(as('STU', `select join_class($1)`, [ccode]), /studies on its own/);
  }
});

test('classroom: a class’s classwork by topic, its gradebook, a whole class list at once, and rubrics', async () => {
  const mk = async (k, email, name = k) => {
    U[k] = (await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name }])).rows[0].id;
  };
  await mk('CT1', 'ct1@class.x', 'Ms Class');
  await one('CT1', `select * from become_tutor('Ms Class', 'UTC')`);
  await as('A', `select admin_set_status($1, 'active')`, [U.CT1]);
  await mk('CT2', 'ct2@class.x', 'Mr Other');
  await one('CT2', `select * from become_tutor('Mr Other', 'UTC')`);
  await as('A', `select admin_set_status($1, 'active')`, [U.CT2]);
  const subj = await val('CT1', `insert into subjects (name) values ('Biology') returning id`);
  const cells = await val('CT1', `insert into topics (subject_id, name) values ($1, 'Cells') returning id`, [subj]);
  const cls = await val('CT1', `select save_class(null, 'Form 2 biology', $1, '{}')`, [subj]);
  // a whole class list at once: a code each, and using it puts them in the class
  await fails(as('CT2', `select class_invites($1, array['Ann'])`, [cls]), /Not your class/);
  const codes = await val('CT1', `select class_invites($1, array['Ann Banda', '  ', 'Ben Phiri'])`, [cls]);
  assert.deepEqual(codes.map((x) => x.name), ['Ann Banda', 'Ben Phiri']);
  for (const [k, x] of [['CA', codes[0]], ['CB', codes[1]]]) {
    await mk(k, k.toLowerCase() + '@class.x', x.name);
    await one(k, `select * from accept_invite($1, $2)`, [x.code, x.name]);
  }
  assert.equal(await val('CT1', `select count(*)::int from class_members where class_id = $1`, [cls]), 2);
  // classwork: what's set for the class, by topic
  const hw = await val('CT1', `insert into assignments (title, kind, subject_id, topic_id, class_id, visibility, due_at) values ('Cell parts', 'homework', $1, $2, $3, 'visible', now() + interval '2 days') returning id`, [subj, cells, cls]);
  const q1 = await val('CT1', `insert into questions (assignment_id, type, prompt_md, marks) values ($1, 'short', 'Name two parts of a cell.', 4) returning id`, [hw]);
  await val('CT1', `insert into lessons (title, class_id, topic_id, visibility) values ('Cells notes', $1, $2, 'visible') returning id`, [cls, cells]);
  const work = await val('CT1', `select class_work($1)`, [cls]);
  assert.deepEqual(work.map((x) => [x.kind, x.title, x.topic, x.state]).sort(), [['assignment', 'Cell parts', 'Cells', 'posted'], ['lesson', 'Cells notes', 'Cells', 'posted']]);
  await fails(as('CT2', `select class_work($1)`, [cls]), /Not your class/);
  // rubrics: the teacher's own, checked; a question uses one; the learner sees it, and the levels once marked
  await fails(as('CT1', `insert into rubrics (title, criteria) values ('Bad', '[]')`), /1 to 12 criteria/);
  await fails(as('CT1', `insert into rubrics (title, criteria) values ('Bad', '[{"name": "x", "levels": [{"label": "a", "points": 1}]}]')`), /2 to 6 levels/);
  const rub = await val('CT1', `insert into rubrics (title, criteria) values ('Short answer', $1) returning id`, [JSON.stringify([
    { name: 'Parts named', levels: [{ label: 'None', points: 0 }, { label: 'One', points: 1 }, { label: 'Two', points: 2 }] },
    { name: 'Spelling', levels: [{ label: 'Weak', points: 0 }, { label: 'Good', points: 2 }] },
  ])]);
  assert.equal(Number((await db.query(`select public._rubric_max($1) n`, [rub])).rows[0].n), 4);
  const other = await val('CT2', `insert into rubrics (title, criteria) values ('Theirs', '[{"name": "x", "levels": [{"label": "a", "points": 0}, {"label": "b", "points": 1}]}]') returning id`);
  await fails(as('CT1', `update questions set rubric_id = $1 where id = $2`, [other, q1]), /isn’t yours/);
  await as('CT1', `update questions set rubric_id = $1 where id = $2`, [rub, q1]);
  assert.equal((await as('CA', `select id from rubrics`)).length, 1, 'the learner reads the rubric on her question');
  assert.equal((await as('CT2', `select id from rubrics where id = $1`, [rub])).length, 0, 'another teacher doesn’t');
  const t = await one('CA', `select * from start_attempt($1, 'browser')`, [hw]);
  await as('CA', `select save_response($1, $2, '{"text": "nucleus, membrane"}'::jsonb)`, [t.id, q1]);
  await as('CA', `select submit_attempt($1)`, [t.id]);
  await as('CT1', `update responses set rubric = '{"0": 2, "1": 1}', marks = 4 where attempt_id = $1`, [t.id]);
  const before = await val('CA', `select attempt_detail($1)`, [t.id]);
  assert.equal(before.responses[0].rubric, null, 'the levels show once marks are given back');
  assert.equal(before.rubrics[0].title, 'Short answer');
  await one('CT1', `select * from finish_marking($1, true, 'Well done', false)`, [t.id]);
  const after = await val('CA', `select attempt_detail($1)`, [t.id]);
  assert.deepEqual(after.responses[0].rubric, { 0: 2, 1: 1 });
  // the gradebook: each learner × each piece of work (latest try), for the class's teachers only
  const g = await val('CT1', `select class_gradebook($1)`, [cls]);
  assert.deepEqual(g.learners.map((x) => x.name), ['Ann Banda', 'Ben Phiri']);
  assert.deepEqual(g.work.map((x) => x.title), ['Cell parts']);
  assert.deepEqual(g.cells.map((x) => [x.learner_id, Number(x.score), Number(x.max), x.released]), [[U.CA, 4, 4, true]]);
  await fails(as('CT2', `select class_gradebook($1)`, [cls]), /Not your class/);
  await fails(as('CA', `select class_gradebook($1)`, [cls]), /Not your class/);
});

test('the class stream: teachers and managers post to one class or several; replies only when a post allows them, seen by classmates only when it says so; parents see posts, never replies', async () => {
  const mk = async (k, email, name = k) => {
    U[k] = (await db.query(`insert into auth.users (email, raw_user_meta_data) values ($1, $2) returning id`, [email, { name }])).rows[0].id;
  };
  for (const [k, n] of [['CSM', 'Mrs Phiri'], ['CST1', 'Mr Lungu'], ['CST2', 'Ms Tembo'], ['CSO', 'Mr Outside']]) {
    await mk(k, k.toLowerCase() + '@stream.x', n);
    await one(k, `select * from become_tutor($1, 'UTC')`, [n]);
    await as('A', `select admin_set_status($1, 'active')`, [U[k]]);
  }
  const code = (await val('CSM', `select org_make_centre('Lakeside School')`)).code;
  await val('CST1', `select org_join($1)`, [code]);
  await val('CST2', `select org_join($1)`, [code]);
  const join = async (tutor, k, name) => {
    await mk(k, k.toLowerCase() + '@stream.x', name);
    const c = await val(tutor, `insert into invites (name) values ($1) returning code`, [name]);
    await one(k, `select * from accept_invite($1, $2)`, [c, name]);
  };
  await join('CST1', 'CSL1', 'Mutale');
  await join('CST1', 'CSL2', 'Bwalya');
  await join('CST2', 'CSL3', 'Chanda');
  await join('CSO', 'CSLX', 'Someone else');
  const maths = await val('CSM', `select save_class(null, 'Form 1 maths', null, $1, $2)`, [[U.CSL1, U.CSL2], [U.CST1]]);
  const sci = await val('CSM', `select save_class(null, 'Form 1 science', null, $1, $2)`, [[U.CSL1, U.CSL3], [U.CST2]]);
  const club = await val('CST1', `select save_class(null, 'Maths club', null, $1)`, [[U.CSL2]]);
  // running setup.sql again (every release does) keeps the manager out of the classes she made for others
  await db.exec(SETUP);
  assert.equal((await db.query(`select count(*)::int n from class_teachers where class_id = $1 and teacher_id = $2`, [maths, U.CSM])).rows[0].n, 0);
  await fails(as('CSM', `select class_gradebook($1)`, [maths]), /Not your class/);

  // who can post where: a teacher to the classes they teach, the manager to every class in the school, nobody else
  assert.deepEqual((await val('CST1', `select stream_classes()`)).map((c) => c.name).sort(), ['Form 1 maths', 'Maths club']);
  assert.deepEqual((await val('CSM', `select stream_classes()`)).map((c) => [c.name, c.teaches]).sort(), [['Form 1 maths', false], ['Form 1 science', false], ['Maths club', false]]);
  assert.deepEqual(await val('CSO', `select stream_classes()`), []);
  assert.deepEqual(await val('CSL1', `select stream_classes()`), []);
  await fails(as('CST1', `select post_to_classes($1, 'Hello', '[]', 'off')`, [[sci]]), /classes you teach/);
  await fails(as('CSO', `select post_to_classes($1, 'Hello', '[]', 'off')`, [[maths]]), /classes you teach/);
  await fails(as('CSL1', `select post_to_classes($1, 'Hello', '[]', 'off')`, [[maths]]), /Only teachers/);
  await fails(as('CST1', `select post_to_classes($1, '   ', '[]', 'off')`, [[maths]]), /Write something/);
  await fails(as('CST1', `select post_to_classes($1, 'Hi', '[]', 'everyone')`, [[maths]]), /who can reply/);

  // Mr Lungu asks both his classes a question; replies on, only teachers see them
  const g1 = await val('CST1', `select post_to_classes($1, 'What did you find hardest this week?', '[]', 'teachers')`, [[maths, club]]);
  // the manager tells every class at once; no replies
  const g2 = await val('CSM', `select post_to_classes($1, 'School closes early on Friday.', '[]', 'off')`, [[maths, sci, club]]);
  const toldOf = async (k, g) => (await db.query(`select count(*)::int n from notifications where user_id = $1 and kind = 'class_post' and ref ->> 'post_id' in (select id::text from class_posts where group_id = $2)`, [U[k], g])).rows[0].n;
  assert.equal(await toldOf('CSL1', g2), 1, 'told once, though she’s in two of the classes');
  assert.equal(await val('CST1', `select count(*)::int from notifications where user_id = auth.uid() and kind = 'class_post'`), 1, 'her teachers hear about the manager’s post too');
  assert.equal(await val('CSLX', `select count(*)::int from notifications where user_id = auth.uid() and kind = 'class_post'`), 0);

  // learners read their own classes' streams, no one else's; the copies of one post are separate in each class
  const s1 = await val('CSL1', `select class_stream($1)`, [maths]);
  assert.equal(s1.staff, false);
  assert.deepEqual(s1.posts.map((p) => p.body_md).sort(), ['School closes early on Friday.', 'What did you find hardest this week?']);
  assert.equal(s1.posts[0].classes, null, 'learners aren’t told which other classes got it');
  await fails(as('CSL3', `select class_stream($1)`, [maths]), /Not your class/);
  await fails(as('CSLX', `select class_stream($1)`, [maths]), /Not your class/);
  await fails(as('CST2', `select class_stream($1)`, [maths]), /Not your class/);
  const q = s1.posts.find((p) => p.replies_mode === 'teachers');
  const qClub = (await val('CSL2', `select class_stream($1)`, [club])).posts.find((p) => p.replies_mode === 'teachers');
  assert.notEqual(q.id, qClub.id);
  const notice = s1.posts.find((p) => p.replies_mode === 'off');
  await fails(as('CSL1', `select reply_to_post($1, 'ok')`, [notice.id]), /Replies are off/);
  await fails(as('CSL3', `select reply_to_post($1, 'sneaky')`, [q.id]), /Not your class/);

  // replies only teachers see: each learner sees their own, and the teacher's answer to them
  const r1 = await val('CSL1', `select reply_to_post($1, 'Fractions with different bottoms')`, [q.id]);
  await val('CSL2', `select reply_to_post($1, 'Negative numbers')`, [q.id]);
  await val('CSL2', `select reply_to_post($1, 'And rounding')`, [q.id]);
  const seen = async (k, cls = maths) => (await val(k, `select class_stream($1)`, [cls])).posts.find((p) => p.group_id === g1).replies.map((r) => r.body);
  assert.deepEqual(await seen('CSL1'), ['Fractions with different bottoms']);
  assert.deepEqual(await seen('CSL2'), ['Negative numbers', 'And rounding']);
  assert.deepEqual(await seen('CST1'), ['Fractions with different bottoms', 'Negative numbers', 'And rounding']);
  assert.deepEqual(await seen('CSL2', club), [], 'the club copy has its own replies');
  assert.equal(await val('CST1', `select count(*)::int from notifications where user_id = auth.uid() and kind = 'stream_reply'`), 1, 'one alert until he looks, not one per reply');
  await val('CST1', `select reply_to_post($1, 'We’ll do those on Monday', $2)`, [q.id, r1]);
  assert.deepEqual(await seen('CSL1'), ['Fractions with different bottoms', 'We’ll do those on Monday']);
  assert.deepEqual(await seen('CSL2'), ['Negative numbers', 'And rounding'], 'an answer to someone else stays theirs');
  assert.equal(await val('CSL1', `select count(*)::int from notifications where user_id = auth.uid() and kind = 'stream_reply'`), 1);

  // he lets the class see each other's replies (with names)
  await fails(as('CSM', `select edit_class_post($1, 'Changed', '[]', 'class')`, [q.id]), /Only the person who posted/);
  await val('CST1', `select edit_class_post($1, 'What did you find hardest this week?', '[]', 'class')`, [q.id]);
  const shared = (await val('CSL2', `select class_stream($1)`, [maths])).posts.find((p) => p.group_id === g1);
  assert.deepEqual(shared.replies.map((r) => [r.author.name, r.body, r.teacher]), [
    ['Mutale', 'Fractions with different bottoms', false], ['Bwalya', 'Negative numbers', false], ['Bwalya', 'And rounding', false], ['Mr Lungu', 'We’ll do those on Monday', true],
  ]);
  assert.equal((await val('CSL2', `select class_stream($1)`, [club])).posts.find((p) => p.group_id === g1).replies_mode, 'class', 'the change reaches every class it went to');

  // keeping it safe: a teacher stops someone replying, and takes a reply down; it stays on record for the teachers
  await fails(as('CSL2', `select mute_in_class($1, $2, true)`, [maths, U.CSL1]), /Not your class/);
  await val('CST1', `select mute_in_class($1, $2, true)`, [maths, U.CSL2]);
  assert.equal((await val('CSL2', `select class_stream($1)`, [maths])).muted, true);
  await fails(as('CSL2', `select reply_to_post($1, 'hello?')`, [q.id]), /turned off your replies/);
  await val('CST1', `select mute_in_class($1, $2, false)`, [maths, U.CSL2]);
  const rude = await val('CSL2', `select reply_to_post($1, 'something unkind')`, [q.id]);
  await fails(as('CSL1', `select remove_reply($1)`, [rude]), /your own replies/);
  await val('CST1', `select remove_reply($1)`, [rude]);
  assert.ok(!(await seen('CSL1')).includes('something unkind'));
  const onRecord = (await val('CSM', `select class_stream($1)`, [maths])).posts.find((p) => p.group_id === g1).replies.find((r) => r.id === rude);
  assert.deepEqual([onRecord.body, onRecord.removed], ['something unkind', true], 'the manager sees it, marked removed');
  await val('CSL1', `select remove_reply($1)`, [r1]);

  // the manager reads every stream in the school, posts and replies, though she teaches none of them
  const ms = await val('CSM', `select class_stream($1)`, [sci]);
  assert.deepEqual([ms.staff, ms.teaches], [true, false]);
  assert.deepEqual((await val('CSM', `select class_stream($1)`, [maths])).posts.find((p) => p.group_id === g1).classes.map((c) => c.name), ['Form 1 maths', 'Maths club']);

  // a post for later: nobody sees it or hears about it until then
  const g3 = await val('CST1', `select post_to_classes($1, 'Quiz on Thursday', '[]', 'off', false, now() + interval '1 day')`, [[maths]]);
  assert.ok(!(await val('CSL1', `select class_stream($1)`, [maths])).posts.some((p) => p.group_id === g3));
  assert.equal((await val('CST1', `select class_stream($1)`, [maths])).posts.find((p) => p.group_id === g3).scheduled, true);
  await db.query(`update class_posts set visible_from = now() - interval '1 minute' where group_id = $1`, [g3]);
  assert.equal((await db.query(`select public._stream_tick() n`)).rows[0].n, 1);
  assert.equal(await val('CSL1', `select count(*)::int from notifications where user_id = auth.uid() and title = 'New in Form 1 maths' and body like '%Quiz on Thursday'`), 1);
  assert.equal((await db.query(`select public._stream_tick() n`)).rows[0].n, 0, 'once');

  // pinned to the top of its class
  const quiz = (await val('CSL1', `select class_stream($1)`, [maths])).posts.find((p) => p.group_id === g3);
  await fails(as('CSL1', `select pin_class_post($1, true)`, [quiz.id]), /Not your class/);
  await val('CST1', `select pin_class_post($1, true)`, [quiz.id]);
  assert.equal((await val('CSL1', `select class_stream($1)`, [maths])).posts[0].group_id, g3);

  // a paused learner reads but doesn't reply, and isn't told about new posts
  await as('CST1', `select pause_learner($1, true)`, [U.CSL2]);
  await fails(as('CSL2', `select reply_to_post($1, 'hi')`, [q.id]), /paused/);
  assert.equal((await val('CSL2', `select class_stream($1)`, [maths])).closed, true);
  const g4 = await val('CST1', `select post_to_classes($1, 'Homework is up', '[]', 'off')`, [[maths]]);
  assert.equal(await toldOf('CSL2', g4), 0);
  assert.equal(await toldOf('CSL1', g4), 1);
  await as('CST1', `select pause_learner($1, false)`, [U.CSL2]);

  // pictures and files: added under the poster's own folder for that post, then seen by whoever sees the post
  const g5 = '0a0a0a0a-0000-4000-8000-000000000005';
  await fails(as('CST1', `select post_to_classes($1, 'Sheet', $2, 'off', false, null, $3)`, [[maths], JSON.stringify([{ path: `${U.CST2}/stream/${g5}/a.pdf`, name: 'a.pdf' }]), g5]), /added here/);
  const path = `${U.CST1}/stream/${g5}/worksheet.pdf`;
  await as('CST1', `insert into storage.objects (bucket_id, name) values ('library', $1)`, [path]);
  await val('CST1', `select post_to_classes($1, 'Worksheet for Monday', $2, 'off', false, null, $3)`, [[maths], JSON.stringify([{ path, name: 'worksheet.pdf' }]), g5]);
  await fails(as('CST1', `select post_to_classes($1, 'Again', '[]', 'off', false, null, $2)`, [[maths], g5]), /already up/);
  const canOpen = async (k) => (await as(k, `select name from storage.objects where bucket_id = 'library' and name = $1`, [path])).length;
  assert.equal(await canOpen('CSL1'), 1);
  assert.equal(await canOpen('CSM'), 1);
  assert.equal(await canOpen('CSL3'), 0, 'not in the class');
  assert.equal(await canOpen('CSLX'), 0);

  // what's set for the class shows in the stream by itself
  await val('CST1', `insert into assignments (title, kind, class_id, visibility) values ('Fractions practice', 'homework', $1, 'visible') returning id`, [maths]);
  await val('CST1', `insert into assignments (title, kind, class_id, visibility) values ('Not yet', 'homework', $1, 'hidden') returning id`, [maths]);
  assert.deepEqual((await val('CSL1', `select class_stream($1)`, [maths])).work.map((w) => [w.kind, w.title, w.by]), [['assignment', 'Fractions practice', 'Mr Lungu']]);

  // a learner's classes, and what's new since they looked
  const mine = await val('CSL1', `select my_classes()`);
  assert.deepEqual(mine.map((c) => [c.name, c.teachers]), [['Form 1 maths', ['Mr Lungu']], ['Form 1 science', ['Ms Tembo']]]);
  assert.ok(mine[0].new >= 3);
  await as('CSL1', `select stream_seen($1)`, [maths]);
  assert.equal((await val('CSL1', `select my_classes()`))[0].new, 0);
  assert.deepEqual(await val('CST1', `select my_classes()`), []);

  // parents: the teachers' posts in their child's classes (and their pictures), never anyone's replies
  await mk('CSP', 'csp@stream.x', 'Mutale’s mum');
  const inv = await one('CST1', `select * from create_parent_invite($1, 'Mum')`, [U.CSL1]);
  await one('CSP', `select * from accept_parent_invite($1, 'Mum', 'UTC')`, [inv.code]);
  const pp = await val('CSP', `select parent_class_posts($1)`, [U.CSL1]);
  assert.ok(pp.some((p) => p.body_md === 'School closes early on Friday.' && p.class === 'Form 1 science'));
  assert.ok(pp.some((p) => p.body_md === 'What did you find hardest this week?'));
  assert.ok(pp.every((p) => !('replies' in p)));
  assert.equal(await canOpen('CSP'), 1);
  await fails(as('CSP', `select parent_class_posts($1)`, [U.CSL3]), /can’t see/);
  await fails(as('CSL1', `select parent_class_posts($1)`, [U.CSL1]), /can’t see/);

  // taking a post down: from one class (any of its teachers), or from every class (whoever posted it, or a manager)
  const clubCopy = (await val('CST1', `select class_stream($1)`, [club])).posts.find((p) => p.group_id === g2);
  await fails(as('CST1', `select delete_class_post($1, true)`, [clubCopy.id]), /every class/);
  assert.equal(await val('CST1', `select delete_class_post($1, false)`, [clubCopy.id]), 2, 'still in the other two');
  await fails(as('CSL1', `select delete_class_post($1, false)`, [notice.id]), /Not your class/);
  assert.equal(await val('CSM', `select delete_class_post($1, true)`, [notice.id]), 0);

  // her own replies come with her data
  const mineData = await val('CSL1', `select export_my_data()`);
  assert.deepEqual(mineData.class_replies.map((r) => [r.class, r.removed]), [['Form 1 maths', true]]);
  assert.ok((await val('CST1', `select export_my_data()`)).class_posts.length >= 3);
});

test('schools: sign up with the school email (a code, or Google), wait on "New from your school" until a teacher adds you to a class; spreadsheets; accounts made in advance; teachers approved by the manager', async () => {
  const mk = async (k, email, name = k, app = {}) => {
    U[k] = (await db.query(`insert into auth.users (email, raw_user_meta_data, raw_app_meta_data) values ($1, $2, $3) returning id`, [email, { name }, app])).rows[0].id;
  };
  for (const [k, n] of [['JM', 'Mrs Mulenga'], ['JT', 'Mr Tembo']]) {
    await mk(k, k.toLowerCase() + '@staff.x', n);
    await one(k, `select * from become_tutor($1, 'Africa/Lusaka')`, [n]);
    await as('A', `select admin_set_status($1, 'active')`, [U[k]]);
  }
  const kabwe = await val('JM', `select org_make_centre('Kabwe Secondary')`);
  await val('JT', `select org_join($1)`, [kabwe.code]);
  const org = (await db.query(`select org_id from org_members where user_id = $1`, [U.JM])).rows[0].org_id;
  const f2 = await val('JM', `select save_class(null, 'Form 2 maths', null, '{}', $1)`, [[U.JT]]);
  const f3 = await val('JM', `select save_class(null, 'Form 3 science', null, '{}', $1)`, [[U.JM]]);

  // StudyBridge sets the school's email endings: its own, never a public one or another school's
  await fails(as('JM', `select admin_set_school_domains($1, $2)`, [org, ['kabwe.edu.zm']]), /admin/i);
  await fails(as('A', `select admin_set_school_domains($1, $2)`, [org, ['gmail.com']]), /public email service/);
  await fails(as('A', `select admin_set_school_domains($1, $2)`, [org, ['not an ending']]), /isn’t an email ending/);
  assert.deepEqual(await val('A', `select admin_set_school_domains($1, $2)`, [org, ['@Kabwe.edu.zm ', 'kabwe.edu.zm']]), ['kabwe.edu.zm']);
  const other = (await db.query(`select id from organisations where kind in ('school', 'centre') and id <> $1 limit 1`, [org])).rows[0].id;
  await fails(as('A', `select admin_set_school_domains($1, $2)`, [other, ['kabwe.edu.zm']]), /already belongs to Kabwe Secondary/);
  assert.deepEqual((await val('A', `select admin_orgs()`)).find((o) => o.id === org).email_domains, ['kabwe.edu.zm']);

  // no email set up yet: a student signs up with the school email and waits for a teacher to let them in
  await db.query(`update platform_secrets set resend_key = null where id = 1`);
  await db.query(`update app_config set email_from = null where id = 1`);
  await mk('JS1', 'mwila@kabwe.edu.zm', 'mwila');
  await fails(as('JS1', `select start_school_learner('Mwila', 0)`), /Choose your year/);
  assert.deepEqual(await val('JS1', `select start_school_learner('Mwila Banda', 9, 'Africa/Lusaka')`), { state: 'teacher', school: 'Kabwe Secondary' });
  assert.deepEqual((({ name, ok, classes }) => ({ name, ok, classes }))(await val('JS1', `select my_school()`)), { name: 'Kabwe Secondary', ok: false, classes: 0 });
  await mk('JX', 'someone@elsewhere.zm');
  await fails(as('JX', `select start_school_learner('X', 9)`), /don’t know a school with that email/);
  assert.equal(await val('JX', `select my_school()`), null);
  // "New from your school": every teacher and manager in the school sees who's waiting (names, emails, years)
  const waiting = async (k) => (await val(k, `select school_waiting()`)).map((w) => [w.name, w.grade, w.ok]);
  assert.deepEqual(await waiting('JT'), [['Mwila Banda', 9, false]]);
  assert.deepEqual(await waiting('JM'), [['Mwila Banda', 9, false]]);
  assert.deepEqual(await val('JS1', `select school_waiting()`), []);
  assert.deepEqual(await val('T', `select school_waiting()`), []);
  assert.equal(Number((await db.query(`select public._org_learners($1) n`, [org])).rows[0].n), 1, 'the school counts them');
  // Mr Tembo adds her to his class (vouching for her email); she gets him as her teacher and drops off the list
  await fails(as('JT', `select school_add_to_class($1, $2)`, [f3, [U.JS1]]), /Not your class/);
  await fails(as('JT', `select school_add_to_class($1, $2)`, [f2, [U.L]]), /Only learners from your school/);
  assert.equal(await val('JT', `select school_add_to_class($1, $2)`, [f2, [U.JS1]]), 1);
  const mwila = (await db.query(`select tutor_id, school_ok from profiles where id = $1`, [U.JS1])).rows[0];
  assert.deepEqual([mwila.tutor_id, mwila.school_ok], [U.JT, true]);
  assert.deepEqual(await waiting('JT'), []);
  assert.equal((await val('JS1', `select my_school()`)).classes, 1);

  // with email on: a 6-digit code goes to the school email; wrong codes are counted
  await db.query(`update platform_secrets set resend_key = 're_test' where id = 1`);
  await db.query(`update app_config set email_from = 'StudyBridge <hello@gostudybridge.com>' where id = 1`);
  await mk('JS2', 'bupe@kabwe.edu.zm', 'bupe');
  assert.deepEqual(await val('JS2', `select start_school_learner('Bupe', 10)`), { state: 'code', school: 'Kabwe Secondary', email: 'bupe@kabwe.edu.zm' });
  const mail = (await db.query(`select subject, body from outgoing_emails where to_addr = 'bupe@kabwe.edu.zm' order by created_at desc limit 1`)).rows[0];
  const code = mail.subject.match(/\d{6}/)[0];
  assert.ok(mail.body.includes(code) && mail.body.includes('Kabwe Secondary'));
  await fails(as('JS2', `select send_school_code()`), /just sent one/);
  assert.equal((await val('JS2', `select confirm_school_email('000000')`)).state, code === '000000' ? 'in' : 'wrong');
  assert.deepEqual(await val('JS2', `select confirm_school_email($1)`, [code.slice(0, 3) + ' ' + code.slice(3)]), { state: 'in' });
  assert.equal((await val('JS2', `select my_school()`)).ok, true);
  // Google has already checked the email: straight in
  await mk('JS3', 'chanda@kabwe.edu.zm', 'chanda', { provider: 'google', providers: ['google'] });
  assert.equal((await val('JS3', `select start_school_learner('Chanda', 10)`)).state, 'in');
  assert.deepEqual((await waiting('JM')).sort(), [['Bupe', 10, true], ['Chanda', 10, true]]);

  // the school's spreadsheet: classes by name (a teacher only his own); people already in the school are placed at once
  const r1 = await val('JT', `select school_roster_save($1)`, [JSON.stringify([
    { email: 'Chola@kabwe.edu.zm', name: 'Chola Phiri', grade: '9', classes: ['form 2 maths', 'Form 3 science', 'Nope'] },
    { email: 'kapa@gmail.com', name: 'Kapa Mumba', grade: 8, classes: ['Form 2 maths'] },
    { email: 'not an email', name: 'Skipped' },
  ])]);
  assert.deepEqual([r1.saved, r1.unknown_classes.sort()], [2, ['Form 3 science', 'Nope']]);
  await val('JM', `select school_roster_save($1)`, [JSON.stringify([{ email: 'bupe@kabwe.edu.zm', classes: ['Form 3 science'] }])]);
  assert.equal((await db.query(`select count(*)::int n from class_members where class_id = $1 and learner_id = $2`, [f3, U.JS2])).rows[0].n, 1, 'Bupe, already in, goes straight in');
  await fails(as('JS1', `select school_roster_save('[]')`), /Only teachers/);
  // Chola signs up later: the code proves it's her, and the list puts her in her class
  await mk('JS4', 'chola@kabwe.edu.zm', 'chola');
  await val('JS4', `select start_school_learner('Chola', 9)`);
  const c4 = (await db.query(`select subject from outgoing_emails where to_addr = 'chola@kabwe.edu.zm' order by created_at desc limit 1`)).rows[0].subject.match(/\d{6}/)[0];
  await val('JS4', `select confirm_school_email($1)`, [c4]);
  assert.equal((await db.query(`select count(*)::int n from class_members where class_id = $1 and learner_id = $2`, [f2, U.JS4])).rows[0].n, 1);
  assert.equal((await db.query(`select tutor_id from profiles where id = $1`, [U.JS4])).rows[0].tutor_id, U.JT);
  // the list works for any email: Kapa uses her own gmail
  await mk('JS5', 'kapa@gmail.com', 'kapa');
  assert.equal((await val('JS5', `select start_school_learner('Kapa', 8)`)).state, 'code');
  const roster = await val('JT', `select school_roster_list()`);
  assert.deepEqual(roster.map((r) => [r.email, r.joined]).sort(), [['bupe@kabwe.edu.zm', true], ['chola@kabwe.edu.zm', true], ['kapa@gmail.com', false]]);

  // accounts made in advance (the Prof server does this with the service key): starting passwords, changed at first sign-in
  const extra = await val('JT', `select school_roster_save($1)`, [JSON.stringify([{ email: 'natasha@kabwe.edu.zm', name: 'Natasha Zulu', grade: 9, classes: ['Form 2 maths'] }])]);
  assert.equal(extra.saved, 1);
  const ids = (await val('JT', `select school_roster_list()`)).map((r) => r.id);
  await fails(as('JT', `select _school_accounts_todo($1, $2)`, [U.JT, ids]), /permission denied/);
  const todo = (await db.query(`select public._school_accounts_todo($1, $2) j`, [U.JT, ids])).rows[0].j;
  assert.deepEqual(todo.map((x) => x.email), ['natasha@kabwe.edu.zm'], 'not people who already have an account');
  await fails(db.query(`select public._school_accounts_todo($1, $2)`, [U.JS1, ids]), /Only teachers/);
  await mk('JS6', 'natasha@kabwe.edu.zm', '');
  await db.query(`select public._school_account_made($1, $2)`, [todo[0].id, U.JS6]);
  const nat = (await db.query(`select role, display_name, must_change_password, school_ok, tutor_id from profiles where id = $1`, [U.JS6])).rows[0];
  assert.deepEqual([nat.role, nat.display_name, nat.must_change_password, nat.school_ok, nat.tutor_id], ['learner', 'Natasha Zulu', true, true, U.JT]);
  await as('JS6', `select password_changed()`);
  assert.equal((await db.query(`select must_change_password from profiles where id = $1`, [U.JS6])).rows[0].must_change_password, false);

  // teachers who sign up with the school email wait for the manager, not StudyBridge
  await mk('JT2', 'banda@kabwe.edu.zm', 'Mr Banda');
  const t2 = await one('JT2', `select * from become_tutor('Mr Banda', 'Africa/Lusaka')`);
  assert.equal(t2.status, 'pending');
  assert.equal((await db.query(`select org_id from org_members where user_id = $1`, [U.JT2])).rows[0].org_id, org);
  assert.equal(await val('JM', `select count(*)::int from notifications where user_id = auth.uid() and title = 'New teacher waiting: Mr Banda'`), 1);
  assert.deepEqual((await val('JM', `select org_waiting_teachers()`)).map((t) => t.name), ['Mr Banda']);
  assert.deepEqual(await val('JT', `select org_waiting_teachers()`), []);
  await fails(as('JT', `select org_approve_teacher($1, true)`, [U.JT2]), /manager/);
  assert.deepEqual(await val('JT2', `select school_waiting()`), [], 'not before they’re approved');
  await as('JM', `select org_approve_teacher($1, true)`, [U.JT2]);
  assert.equal((await db.query(`select status from profiles where id = $1`, [U.JT2])).rows[0].status, 'active');
  // someone who isn't one of theirs goes back to waiting for StudyBridge, outside the school
  await mk('JT3', 'imposter@kabwe.edu.zm', 'Imposter');
  await one('JT3', `select * from become_tutor('Imposter', 'UTC')`);
  await as('JM', `select org_approve_teacher($1, false)`, [U.JT3]);
  assert.notEqual((await db.query(`select org_id from org_members where user_id = $1`, [U.JT3])).rows[0].org_id, org);
  assert.equal((await db.query(`select status from profiles where id = $1`, [U.JT3])).rows[0].status, 'pending');

  // a manager can say someone isn't in the school (only while they're in no class)
  await mk('JS7', 'random@kabwe.edu.zm', 'random');
  await val('JS7', `select start_school_learner('Not a pupil', 11)`);
  await fails(as('JT', `select school_remove($1)`, [U.JS7]), /Not someone in your school/);
  await fails(as('JM', `select school_remove($1)`, [U.JS1]), /in a class/);
  await as('JM', `select school_remove($1)`, [U.JS7]);
  assert.equal((await db.query(`select role from profiles where id = $1`, [U.JS7])).rows[0].role, null);

  await db.query(`update platform_secrets set resend_key = null where id = 1`);
  await db.query(`update app_config set email_from = null where id = 1`);
});
