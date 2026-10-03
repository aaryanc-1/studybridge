// Prof end to end: the real edge function code, the real database rules (fake
// Supabase), and a stand-in for the Claude API that answers like Claude would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { startFakeSupabase } from './fake-supabase.mjs';
import { startFakeClaude, setMode, seen } from './fake-claude.mjs';

// ---------------- the test ----------------
let srv, claude;
const client = () => createClient(srv.url, srv.anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
test.before(async () => {
  claude = await startFakeClaude();
  srv = await startFakeSupabase({ anthropicUrl: claude.url });
});
test.after(async () => {
  await srv.close();
  await claude.close();
});

async function kick(c) {
  const { data } = await c.auth.getSession();
  const r = await fetch(`${srv.url}/functions/v1/prof`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: srv.anonKey, ...(data.session ? { authorization: `Bearer ${data.session.access_token}` } : {}) },
    body: '{"action":"kick"}',
  });
  return [r.status, await r.json()];
}
const q = async (p) => {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data;
};

test('Prof makes a draft quiz from a request and pages, then marks the hand-in', async () => {
  const T = client();
  await q(T.auth.signUp({ email: 'tutor@x.com', password: 'secret123' }));
  await q(T.rpc('become_tutor', { p_name: 'Aaryan', p_timezone: 'America/New_York' }));
  const me = (await T.auth.getUser()).data.user.id;
  const maths = await q(T.from('subjects').insert({ name: 'Mathematics' }).select().single());
  const inv = await q(T.from('invites').insert({ name: 'Sis', subject_ids: [maths.id] }).select().single());
  const L = client();
  await q(L.auth.signUp({ email: 'sis@x.com', password: 'secret123' }));
  await q(L.rpc('accept_invite', { p_code: inv.code, p_name: 'Sis', p_timezone: 'Africa/Lusaka' }));
  const learner = (await L.auth.getUser()).data.user.id;

  // Not switched on until the admin adds the Claude key
  const off = await T.rpc('prof_ask', { p_prompt: 'Make a quiz' });
  assert.match(off.error.message, /isn’t switched on/);
  await q(T.rpc('admin_set_prof', { p_key: 'sk-ant-fake-key' }));

  // Signed-out and learner calls are refused
  assert.equal((await kick(client()))[0], 401);
  assert.equal((await kick(L))[0], 403);

  // The tutor attaches a page from their book (the app renders PDF pages to images)
  const page = `${me}/prof/page-12.jpg`;
  await q(T.storage.from('library').upload(page, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), { contentType: 'image/jpeg' }));
  const job = await q(T.rpc('prof_ask', { p_prompt: 'Make a 5 question quiz on linear equations for Sis, due Friday', p_context: { learner_ids: [learner], pages: [{ path: page, label: 'Book p.12' }] } }));
  const [st] = await kick(T);
  assert.equal(st, 200);

  const j = await q(T.from('prof_jobs').select('*').eq('id', job.id).single());
  assert.equal(j.status, 'done', j.error || '');
  assert.equal(j.steps, 4);
  assert.ok(Number(j.cost_cents) > 0);
  assert.equal(j.result.assignments[0].questions, 5);
  assert.match(j.result.reply, /5-question quiz/);

  // What Claude was sent: the key, the learner's context, the page image, caching
  const first = seen[0];
  assert.equal(first.headers['x-api-key'], 'sk-ant-fake-key');
  assert.equal(first.body.model, 'claude-sonnet-5-5');
  assert.match(first.body.system[0].text, /Sis/);
  assert.ok(first.body.system[0].cache_control);
  const img = first.body.messages[0].content.find((b) => b.type === 'image');
  assert.equal(img.source.media_type, 'image/jpeg');
  assert.ok(first.body.messages[0].content.at(-1).cache_control);
  assert.ok(!JSON.stringify(seen.at(-1).body).includes('sb_image'));

  // A draft only: the learner can't see it; it has questions with answers and mark schemes
  const a = await q(T.from('assignments').select('*').eq('id', j.result.assignments[0].id).single());
  assert.equal(a.draft, true);
  assert.equal(a.source, 'prof');
  assert.equal(a.kind, 'quiz');
  assert.deepEqual(a.learner_ids, [learner]);
  assert.equal(a.due_at.slice(0, 16), '2026-10-09T18:00');
  assert.equal((await q(L.from('assignments').select('*'))).length, 0);
  const qs = await q(T.from('questions').select('*').eq('assignment_id', a.id).order('position'));
  assert.deepEqual(qs.map((x) => x.type), ['mcq', 'numeric', 'steps', 'short', 'upload']);
  const keys = await q(T.from('question_keys').select('*').in('question_id', qs.map((x) => x.id)));
  assert.equal(keys.find((k) => k.question_id === qs[0].id).answer.choice, '1');
  assert.equal(keys.find((k) => k.question_id === qs[1].id).answer.value, '6');
  assert.match(keys.find((k) => k.question_id === qs[2].id).mark_scheme_md, /M1/);
  // The tutor was told, and the page image was tidied away
  assert.ok((await q(T.from('notifications').select('*').eq('kind', 'prof'))).some((x) => /Linear equations quiz/.test(x.title)));
  assert.equal((await T.storage.from('library').download(page)).data, null);

  // Tutor approves and posts; learner hands in; Prof marks it (auto-mark on)
  await q(T.from('assignments').update({ draft: false }).eq('id', a.id));
  await q(T.from('prof_settings').insert({ tutor_id: me, auto_mark: true }));
  const t = await q(L.rpc('start_attempt', { p_assignment: a.id, p_client: 'desktop' }));
  const photo = `${learner}/${t.id}/work.jpg`;
  await q(L.storage.from('work').upload(photo, new Uint8Array([0xff, 0xd8, 0xff, 9, 9]), { contentType: 'image/jpeg' }));
  const ans = [{ choice: '1' }, { value: '6' }, { steps: ['3x = 15', 'x = 5'] }, { text: 'Because' }, { files: [{ path: photo, name: 'work.jpg', type: 'image/jpeg' }] }];
  for (const [i, x] of qs.entries()) await q(L.rpc('save_response', { p_attempt: t.id, p_question: x.id, p_answer: ans[i] }));
  setMode('busy-once');
  await q(L.rpc('submit_attempt', { p_attempt: t.id }));
  const mj = await q(T.from('prof_jobs').select('*').eq('kind', 'mark').single());
  assert.equal(mj.status, 'queued');
  await kick(T);
  const busy = await q(T.from('prof_jobs').select('*').eq('id', mj.id).single());
  assert.equal(busy.status, 'queued', 'Claude busy: Prof waits and tries again');
  assert.match(busy.progress, /busy/);
  await srv.db.query(`update public.prof_jobs set lease_until = now() - interval '1 second' where id = $1`, [mj.id]);
  await kick(T);
  const done = await q(T.from('prof_jobs').select('*').eq('id', mj.id).single());
  assert.equal(done.status, 'done', done.error || '');
  const mreq = seen.at(-1).body;
  assert.deepEqual(mreq.tool_choice, { type: 'tool', name: 'submit_marking' });
  assert.ok(mreq.messages[0].content.some((b) => b.type === 'image'), 'Prof sees the photo of the working');

  const drafts = await q(T.from('claude_drafts').select('*').eq('attempt_id', t.id));
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0].source, 'prof');
  // Marks aren't the learner's until the tutor applies and returns them
  const before = await q(L.rpc('attempt_detail', { p_attempt: t.id }));
  assert.equal(before.responses.find((r) => r.question_id === qs[3].id).marks, null, 'Prof’s suggestion isn’t a mark yet');
  await q(T.rpc('apply_draft', { p_draft: drafts[0].id, p_payload: null }));
  await q(T.rpc('finish_marking', { p_attempt: t.id, p_release: true, p_feedback: null }));
  const after = await q(L.rpc('attempt_detail', { p_attempt: t.id }));
  assert.equal(Number(after.attempt.score), 2 + 3 + 1 + 1);

  // A refused key fails the job with a clear message
  setMode('bad-key');
  const j2 = await q(T.rpc('prof_ask', { p_prompt: 'Another quiz please' }));
  await kick(T);
  const failed = await q(T.from('prof_jobs').select('*').eq('id', j2.id).single());
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /key was refused/);
  setMode('ok');
});

test('Prof tidies files left behind by deleted accounts', async () => {
  const T = client();
  await q(T.auth.signInWithPassword({ email: 'tutor@x.com', password: 'secret123' }));
  const L = client();
  await q(L.auth.signInWithPassword({ email: 'sis@x.com', password: 'secret123' }));
  const learner = (await L.auth.getUser()).data.user.id;
  await q(T.rpc('admin_delete_account', { p_user: learner }));
  const left = await srv.db.query(`select count(*)::int n from storage.objects where name like $1`, [`${learner}/%`]);
  assert.ok(left.rows[0].n > 0);
  const { data } = await T.auth.getSession();
  const r = await fetch(`${srv.url}/functions/v1/prof`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session.access_token}` }, body: '{"action":"cleanup"}' });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).removed > 0);
  const now = await srv.db.query(`select count(*)::int n from storage.objects where name like $1`, [`${learner}/%`]);
  assert.equal(now.rows[0].n, 0);
});

test('Prof reads a whole book (asks the app for pages) and takes replies', async () => {
  const T = client();
  await q(T.auth.signInWithPassword({ email: 'tutor@x.com', password: 'secret123' }));
  const me = (await T.auth.getUser()).data.user.id;
  await q(T.rpc('admin_set_plan', { p_user: me, p_plan: 'free', p_ai_limit_cents: 100000 }));
  const path = `${me}/files/book.pdf`;
  await q(T.storage.from('library').upload(path, new Uint8Array([37, 80, 68, 70]), { contentType: 'application/pdf' }));
  const book = await q(T.from('files').insert({ name: 'Algebra book.pdf', storage_path: path, mime: 'application/pdf' }).select().single());
  const bad = await T.rpc('prof_ask', { p_prompt: 'quiz', p_context: { books: [{ file_id: '00000000-0000-0000-0000-000000000000', name: 'x', pages: 3 }] } });
  assert.match(bad.error.message, /Unknown book/);
  const job = await q(T.rpc('prof_ask', { p_prompt: 'Homework from the linear equations chapter', p_context: { books: [{ file_id: book.id, name: book.name, pages: 120, outline: 'Linear equations → 45\nQuadratics → 60' }] } }));
  await kick(T);
  let j = await q(T.from('prof_jobs').select('*').eq('id', job.id).single());
  assert.equal(j.status, 'waiting', j.error || '');
  assert.deepEqual(j.result.need_pages.pages, [1, 2]);
  assert.match(j.progress, /Reading Algebra book\.pdf, pages 1–2/);
  const first = seen.at(-1).body;
  assert.ok(first.tools.some((t) => t.name === 'look_at_pages'));
  assert.match(first.messages[0].content[0].text, /Linear equations → 45/);
  // the tutor's app sends the pages (pictures it rendered)
  const pages = [];
  for (const n of [1, 2]) {
    const p = `${me}/prof/look-${n}.jpg`;
    await q(T.storage.from('library').upload(p, new Uint8Array([0xff, 0xd8, 0xff, n]), { contentType: 'image/jpeg' }));
    pages.push({ path: p, label: `Algebra book.pdf, PDF page ${n}` });
  }
  const notMine = await T.rpc('prof_pages', { p_job: job.id, p_pages: [{ path: 'someone-else/prof/x.jpg' }] });
  assert.match(notMine.error.message, /Unknown page/);
  await q(T.rpc('prof_pages', { p_job: job.id, p_pages: pages }));
  await kick(T);
  j = await q(T.from('prof_jobs').select('*').eq('id', job.id).single());
  assert.equal(j.status, 'done', j.error || '');
  assert.equal(j.result.assignments[0].questions, 5);
  const afterPages = seen.find((x) => x.body.messages.length === 3 && x.body.tools.some((t) => t.name === 'look_at_pages')).body;
  const tr = afterPages.messages[2].content.find((b) => b.type === 'tool_result');
  assert.equal(tr.content.filter((b) => b.type === 'image').length, 2, 'the pages reach Prof as pictures');
  for (const p of pages) assert.equal((await T.storage.from('library').download(p.path)).data, null, 'page pictures are tidied away');

  // A reply carries the earlier request and answer
  const reply = await q(T.rpc('prof_ask', { p_prompt: 'Make questions 4 and 5 harder', p_context: { reply_to: job.id } }));
  await kick(T);
  const rj = await q(T.from('prof_jobs').select('*').eq('id', reply.id).single());
  assert.equal(rj.status, 'done', rj.error || '');
  assert.equal(rj.context.reply_to, job.id);
  const text = seen.at(-4).body.messages[0].content[0].text;
  assert.match(text, /This is a reply to an earlier request/);
  assert.match(text, /Homework from the linear equations chapter/);
  assert.match(text, /Make questions 4 and 5 harder/);
});

test('Prof writes question-bank questions, checks them, and they wait for approval', async () => {
  const T = client();
  await q(T.auth.signInWithPassword({ email: 'tutor@x.com', password: 'secret123' }));
  const me = (await T.auth.getUser()).data.user.id;
  // Shared StudyBridge questions: admin only
  const job = await q(T.rpc('prof_bank', { p_board: 'cie', p_code: '0607', p_topic: 'Number', p_count: 10, p_shared: true }));
  for (let i = 0; i < 4; i++) await kick(T);
  const j = await q(T.from('prof_jobs').select('*').eq('id', job.id).single());
  assert.equal(j.status, 'done', j.error || '');
  assert.equal(j.result.bank.count, 10);
  assert.equal(j.result.bank.flagged, 1, 'the deliberately wrong answer is flagged');
  const rows = await q(T.from('bank_questions').select('*').eq('job_id', job.id).order('created_at'));
  assert.equal(rows.length, 10);
  assert.ok(rows.every((r) => r.owner_id === null && r.status === 'review' && r.exam_code === '0607' && r.topic === 'Number' && r.source === 'studybridge'));
  const bad = rows.filter((r) => r.check_result && !r.check_result.ok);
  assert.equal(bad.length, 1);
  assert.match(bad[0].check_result.note, /should be 14/);
  assert.ok(seen.some((x) => x.body.tools?.[0]?.name === 'submit_checks'), 'a second, independent check ran');

  // Another tutor: can't ask for shared questions, can't see them until approved
  const T2 = client();
  await q(T2.auth.signUp({ email: 'tutor2@x.com', password: 'secret123' }));
  await q(T2.rpc('become_tutor', { p_name: 'Maria' }));
  const t2 = (await T2.auth.getUser()).data.user.id;
  await q(T.rpc('admin_set_status', { p_user: t2, p_status: 'active' }));
  const no = await T2.rpc('prof_bank', { p_board: 'cie', p_code: '0607', p_topic: 'Number', p_count: 5, p_shared: true });
  assert.match(no.error.message, /Only the StudyBridge admin/);
  assert.equal((await q(T2.from('bank_questions').select('id'))).length, 0);
  // The admin approves the good ones and rejects the flagged one
  await q(T.from('bank_questions').update({ status: 'approved' }).in('id', rows.filter((r) => r.check_result?.ok).map((r) => r.id)));
  await q(T.from('bank_questions').update({ status: 'rejected' }).eq('id', bad[0].id));
  assert.equal((await q(T2.from('bank_questions').select('id'))).length, 9, 'every tutor can use approved shared questions');
  const tried = await T2.from('bank_questions').update({ prompt_md: 'changed' }).eq('id', rows[0].id).select();
  assert.equal(tried.data.length, 0, 'tutors can’t change shared questions');
  await q(T2.rpc('bank_used', { p_ids: [rows[0].id] }));
  assert.equal((await q(T.from('bank_questions').select('uses').eq('id', rows[0].id).single())).uses, 1);

  // A tutor's own bank questions from Prof wait for that tutor
  const mine = await q(T.rpc('prof_bank', { p_board: 'cie', p_code: '0607', p_topic: 'Algebra', p_count: 3 }));
  for (let i = 0; i < 3; i++) await kick(T);
  const own = await q(T.from('bank_questions').select('*').eq('job_id', mine.id));
  assert.equal(own.length, 3);
  assert.ok(own.every((r) => r.owner_id === me && r.status === 'review' && r.source === 'prof'));
  assert.equal((await q(T2.from('bank_questions').select('id').in('id', own.map((r) => r.id)))).length, 0, 'never another tutor');
});
