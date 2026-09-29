// Runs supabase/setup.sql inside PGlite (real Postgres in WASM) with small
// stand-ins for Supabase's auth + storage schemas, then checks the security
// rules and every database function the app uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const SETUP = readFileSync(new URL('../supabase/setup.sql', import.meta.url), 'utf8');

const STUBS = `
create role authenticated nologin; create role anon nologin; create role service_role nologin;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}',
  encrypted_password text, email_confirmed_at timestamptz default now(), last_sign_in_at timestamptz, created_at timestamptz default now());
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
grant usage on schema auth to authenticated, anon;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema storage to authenticated, anon;
grant all on storage.objects to authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on functions to anon, authenticated;
`;

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
  await fails(as('T2', `select become_tutor('Other tutor')`), /private/);
  await fails(as('L', `select set_allow_new_tutors(true)`), /Tutors only/);
  await fails(as('T', `update app_config set allow_new_tutors = true`), /permission denied/);
  await as('T', `select set_allow_new_tutors(true)`);
  await one('T2', `select * from become_tutor('Other tutor')`);
  await as('T', `select set_allow_new_tutors(false)`);
  await fails(as('X', `select become_tutor('x')`), /private/);
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
