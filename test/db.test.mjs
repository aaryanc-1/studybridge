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

test('StudyBridge papers: only approved ones reach tutors; only the admin writes or fixes them', async () => {
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
  assert.equal((await as('TC', `select * from sb_papers where id = $1`, [pid])).length, 1);
  assert.equal((await as('LC', `select * from sb_papers where id = $1`, [pid])).length, 0, 'learners get papers only through their tutor');
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
  assert.deepEqual(Object.keys(pub).sort(), ['email_on', 'enforce_plans', 'google_on', 'payments_on', 'students_open']);
  assert.equal(pub.enforce_plans, false);
  await fails(as('TW', `select admin_set_selling(p_enforce => true)`), /admins only/);
  await fails(as('TW', `select _set_paid_plan($1, 'pro', 'month', 'cus_1', null)`, [U.TW]), /permission denied/);
  const plan = await val('TW', `select my_plan()`);
  assert.equal(plan.plan, 'free');
  assert.equal(plan.limit, 1);
  assert.equal(plan.enforced, false);

  // a fresh tutor on the Free plan: limits off, a second learner can join; on, the next one can't
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
  await fails(join('P3'), /plan is full/);
  assert.equal((await val('TP', `select my_plan()`)).learners, 2);
  await db.query(`select _set_paid_plan($1, 'starter', 'month', 'cus_123', now() + interval '30 days')`, [U.TP]);
  await join('P4');
  assert.equal((await val('TP', `select my_plan()`)).limit, 5);
  assert.equal((await as('TP', `select * from notifications where kind = 'plan'`)).length, 1);
  await as('A', `select admin_set_selling(p_enforce => false, p_resend_key => 're_x', p_email_from => 'hello@example.com')`);
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
  assert.equal((await t()).plan_limit, 25);
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
  // Complimentary: Pro-sized until its end date, then Free
  await as('A', `select admin_set_plan($1, 'complimentary', null, null, current_date + 30)`, [U.PL]);
  assert.equal((await val('PL', `select my_plan()`)).limit, 25);
  await as('A', `select admin_set_plan($1, 'complimentary', null, null, current_date - 1)`, [U.PL]);
  assert.equal((await val('PL', `select my_plan()`)).limit, 1, 'after the end date it is the Free plan');
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
  // closed until the Owner opens it
  await fails(as('S', `select start_self_learner('Sam', 10, 'Zambia')`), /isn’t open yet/);
  assert.equal((await val(null, `select public_settings()`)).students_open, false);
  // the catalogue goes in switched off; adding it again adds nothing
  const items = [
    { key: 'cambridge:igcse:0607', board: 'Cambridge', level: 'IGCSE', name: 'Cambridge IGCSE International Mathematics (0607)', code: '0607', exam: 'cie:0607' },
    { key: 'ib:sl-and-hl:physics', board: 'IB Diploma', level: 'IB Diploma', name: 'IB Physics', code: '' },
  ];
  assert.deepEqual(await val('A', `select admin_seed_catalogue($1)`, [JSON.stringify(items)]), { added: 2, total: 2 });
  assert.deepEqual(await val('A', `select admin_seed_catalogue($1)`, [JSON.stringify(items)]), { added: 0, total: 2 });
  await as('A', `select admin_students_open(true)`);
  assert.equal((await val(null, `select public_settings()`)).students_open, true);
  // below grade 8, a parent comes first
  await fails(as('S2', `select start_self_learner('Kid', 7, 'Zambia')`), /parent/);
  const p = await one('S', `select * from start_self_learner('Sam', 10, 'Zambia', 'Africa/Lusaka')`);
  assert.equal(p.role, 'learner');
  assert.equal(p.self_learner, true);
  assert.equal(p.tutor_id, U.C);
  assert.ok(new Date(p.trial_until) - Date.now() > 6.9 * 864e5, 'a 7-day free trial');
  await fails(as('S', `update profiles set paid_until = '2030-01-01' where id = auth.uid()`), /permission denied/);
  // the setup only takes subjects that are open
  const [maths, phys] = (await db.query(`select id from subjects where tutor_id = $1 order by position`, [U.C])).rows.map((r) => r.id);
  await fails(as('S', `select self_setup('Cambridge', 'IGCSE', $1, current_date + 200, 'Cambridge May/June 2027', 4)`, [[maths]]), /Pick at least one/);
  await as('C', `update subjects set live = true where id = $1`, [maths]);
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
