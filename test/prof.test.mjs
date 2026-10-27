// Prof end to end: the real edge function code, the real database rules (fake
// Supabase), and a stand-in for the Claude API that answers like Claude would.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { startFakeSupabase } from './fake-supabase.mjs';
import { startFakeClaude, setMode, seen, outside } from './fake-claude.mjs';
import crypto from 'node:crypto';

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
// The separate StudyBridge admin account. The first tutor moves admin to it.
let A;
async function admin() {
  if (A) return A;
  const T = client();
  await q(T.auth.signInWithPassword({ email: 'tutor@x.com', password: 'secret123' }));
  A = client();
  await q(A.auth.signUp({ email: 'admin@x.com', password: 'secret123' }));
  const before = await A.rpc('admin_settings');
  assert.match(before.error.message, /admins only/, 'no admin powers before the move');
  await q(T.rpc('admin_move_to', { p_email: 'admin@x.com' }));
  return A;
}

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
  await q((await admin()).rpc('admin_set_prof', { p_key: 'sk-ant-fake-key' }));

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
  const spent = await srv.db.query(`select cost_cents from prof_costs where job_id = $1`, [job.id]);
  assert.ok(Number(spent.rows[0].cost_cents) > 0, 'what it cost is kept where only the admin sees it');
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
  await q((await admin()).rpc('admin_delete_account', { p_user: learner }));
  const left = await srv.db.query(`select count(*)::int n from storage.objects where name like $1`, [`${learner}/%`]);
  assert.ok(left.rows[0].n > 0);
  const tried = await fetch(`${srv.url}/functions/v1/prof`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${(await T.auth.getSession()).data.session.access_token}` }, body: '{"action":"cleanup"}' });
  assert.equal(tried.status, 403, 'a tutor account can’t');
  const { data } = await (await admin()).auth.getSession();
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
  await q((await admin()).rpc('admin_set_plan', { p_user: me, p_plan: 'free', p_ai_limit_cents: 100000 }));
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

  // Prof saved notes on the pages it read; next time it reads the notes instead of asking for pictures
  const notes = await q(T.from('book_notes').select('page,notes').eq('file_id', book.id).order('page'));
  assert.deepEqual(notes.map((n) => n.page), [1, 2]);
  const again = await q(T.rpc('prof_ask', { p_prompt: 'Another homework from the same chapter', p_context: { books: [{ file_id: book.id, name: book.name, pages: 120, outline: 'Linear equations → 45' }] } }));
  await kick(T);
  const aj = await q(T.from('prof_jobs').select('*').eq('id', again.id).single());
  assert.equal(aj.status, 'done', aj.error || 'no waiting for pictures: the notes were enough');
  const usedNotes = seen.filter((x) => x.body.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'tool_result' && typeof b.content === 'string' && b.content.includes('Your notes from reading these pages before'))));
  assert.ok(usedNotes.length > 0);
  await q(T.from('prof_jobs').delete().eq('id', again.id)).catch(() => {});

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
  const notTutor = await T.rpc('prof_bank', { p_board: 'cie', p_code: '0607', p_topic: 'Number', p_count: 10, p_shared: true });
  assert.match(notTutor.error.message, /Only the StudyBridge admin/, 'not from a tutor account');
  const Ad = await admin();
  const job = await q(Ad.rpc('prof_bank', { p_board: 'cie', p_code: '0607', p_topic: 'Number', p_count: 10, p_shared: true }));
  for (let i = 0; i < 4; i++) await kick(Ad);
  const j = await q(Ad.from('prof_jobs').select('*').eq('id', job.id).single());
  assert.equal(j.status, 'done', j.error || '');
  assert.equal(j.result.bank.count, 10);
  assert.equal(j.result.bank.flagged, 1, 'the deliberately wrong answer is flagged');
  const rows = await q(Ad.from('bank_questions').select('*').eq('job_id', job.id).order('created_at'));
  assert.equal(rows.length, 10);
  assert.ok(rows.every((r) => r.owner_id === null && r.status === 'review' && r.exam_code === '0607' && r.topic === 'Number' && r.source === 'studybridge'));
  const bad = rows.filter((r) => r.check_result && !r.check_result.ok);
  assert.equal(bad.length, 1);
  assert.match(bad[0].check_result.note, /should be 14/);
  assert.ok(seen.some((x) => x.body.tools?.[0]?.name === 'submit_checks'), 'a second, independent check ran');

  // Another tutor: can't ask for shared questions, and never gets them, even approved: StudyBridge's questions for
  // tutors now come from the content account, checked twice (test/db.test.mjs, "one StudyBridge library")
  const T2 = client();
  await q(T2.auth.signUp({ email: 'tutor2@x.com', password: 'secret123' }));
  await q(T2.rpc('become_tutor', { p_name: 'Maria' }));
  const t2 = (await T2.auth.getUser()).data.user.id;
  await q(Ad.rpc('admin_set_status', { p_user: t2, p_status: 'active' }));
  const no = await T2.rpc('prof_bank', { p_board: 'cie', p_code: '0607', p_topic: 'Number', p_count: 5, p_shared: true });
  assert.match(no.error.message, /Only the StudyBridge admin/);
  assert.equal((await q(T2.from('bank_questions').select('id'))).length, 0);
  await q(Ad.from('bank_questions').update({ status: 'approved' }).in('id', rows.filter((r) => r.check_result?.ok).map((r) => r.id)));
  assert.equal((await q(T2.from('bank_questions').select('id'))).length, 0, 'the old shared bank no longer reaches tutors');
  const tried = await T2.from('bank_questions').update({ prompt_md: 'changed' }).eq('id', rows[0].id).select();
  assert.equal(tried.data.length, 0, 'tutors can’t change them');
  await q(T2.rpc('bank_used', { p_ids: [rows[0].id] }));
  assert.equal((await q(Ad.from('bank_questions').select('uses').eq('id', rows[0].id).single())).uses, 0);

  // A tutor's own bank questions from Prof wait for that tutor
  const mine = await q(T.rpc('prof_bank', { p_board: 'cie', p_code: '0607', p_topic: 'Algebra', p_count: 3 }));
  for (let i = 0; i < 3; i++) await kick(T);
  const own = await q(T.from('bank_questions').select('*').eq('job_id', mine.id));
  assert.equal(own.length, 3);
  assert.ok(own.every((r) => r.owner_id === me && r.status === 'review' && r.source === 'prof'));
  assert.equal((await q(T2.from('bank_questions').select('id').in('id', own.map((r) => r.id)))).length, 0, 'never another tutor');
});

test('Prof drafts a weekly parent report; the tutor sends it', async () => {
  const T = client();
  await q(T.auth.signInWithPassword({ email: 'tutor@x.com', password: 'secret123' }));
  const inv = await q(T.from('invites').insert({ name: 'Sis2' }).select().single());
  const L = client();
  await q(L.auth.signUp({ email: 'sis2@x.com', password: 'secret123' }));
  await q(L.rpc('accept_invite', { p_code: inv.code, p_name: 'Sis' }));
  const learner = (await L.auth.getUser()).data.user.id;
  await q(L.rpc('set_parent_reports', { p_on: true, p_name: 'Mum', p_phone: '+260971234567' }));
  const data = await q(T.rpc('report_numbers', { p_learner: learner, p_from: new Date(Date.now() - 7 * 864e5).toISOString(), p_to: new Date().toISOString() }));
  assert.equal(data.parent, 'Mum');
  const rep = await q(T.from('parent_reports').insert({ learner_id: learner, week_start: '2026-09-28', data }).select().single());
  // A model that won't accept "you must call this tool" (and answers in text first): Prof still gets the report
  setMode('no-forced-lazy');
  const job = await q(T.rpc('prof_report', { p_report: rep.id }));
  await kick(T);
  setMode('ok');
  assert.ok(seen.some((x) => x.body.tool_choice?.type === 'auto' && x.body.tools?.[0]?.name === 'write_report' && x.body.messages.length === 3), 'asked again without forcing, then nudged');
  const j = await q(T.from('prof_jobs').select('*').eq('id', job.id).single());
  assert.equal(j.status, 'done', j.error || '');
  const after = await q(T.from('parent_reports').select('*').eq('id', rep.id).single());
  assert.match(after.summary, /A steady week for Sis/);
  assert.equal(after.prof, true);
  assert.equal(after.status, 'draft', 'Prof never sends it');
  assert.ok(seen.some((x) => x.body.model === 'claude-haiku-5-5' && x.body.tools?.[0]?.name === 'write_report'), 'a small job: the cheaper model');
  await q(T.from('parent_reports').update({ status: 'sent', sent_via: 'whatsapp', sent_at: new Date().toISOString() }).eq('id', rep.id));
  const seenByLearner = await q(L.from('parent_reports').select('summary'));
  assert.equal(seenByLearner.length, 1);
  // a sent report can't be redrafted by Prof
  const again = await T.rpc('prof_report', { p_report: rep.id });
  assert.match(again.error.message, /Report not found/);
});

test('Prof sets out a syllabus; nothing changes until the tutor uses it', async () => {
  const T = client();
  await q(T.auth.signInWithPassword({ email: 'tutor@x.com', password: 'secret123' }));
  const subj = await q(T.from('subjects').insert({ name: 'Maths 0607', exam: 'cie:0607' }).select().single());
  const job = await q(T.rpc('prof_syllabus', { p_subject: subj.id, p_label: 'Cambridge IGCSE International Mathematics (0607)' }));
  await kick(T);
  const j = await q(T.from('prof_jobs').select('status,result,error').eq('id', job.id).single());
  assert.equal(j.status, 'done', j.error || '');
  assert.equal(j.result.syllabus.topics.length, 5);
  assert.equal(j.result.syllabus.topics[1].code, '2');
  assert.equal((await q(T.from('topics').select('id').eq('subject_id', subj.id))).length, 0, 'drafts only: the tutor chooses to use it');
  const other = client();
  await q(other.auth.signUp({ email: 'stranger@x.com', password: 'secret123' }));
  const bad = await other.rpc('prof_syllabus', { p_subject: subj.id, p_label: 'x y z' });
  assert.ok(bad.error);
});

test('Prof reads a grade-threshold PDF; nothing is saved until the tutor checks it', async () => {
  const T = client();
  await q(T.auth.signInWithPassword({ email: 'tutor@x.com', password: 'secret123' }));
  const me = (await T.auth.getUser()).data.user.id;
  const page = `${me}/prof/gt-1.jpg`;
  await q(T.storage.from('library').upload(page, new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7]), { contentType: 'image/jpeg' }));
  const bad = await T.rpc('prof_boundaries', { p_exam: 'cie:0607', p_label: '0607', p_pages: [{ path: 'someone-else/prof/x.jpg' }] });
  assert.match(bad.error.message, /Unknown page/);
  const none = await T.rpc('prof_boundaries', { p_exam: 'cie:0607', p_label: '0607', p_pages: [] });
  assert.match(none.error.message, /grade-threshold PDF/);
  const job = await q(T.rpc('prof_boundaries', { p_exam: 'cie:0607', p_label: 'Cambridge IGCSE 0607 June 2025', p_pages: [{ path: page, label: 'page 1' }] }));
  await kick(T);
  const j = await q(T.from('prof_jobs').select('status,result,error').eq('id', job.id).single());
  assert.equal(j.status, 'done', j.error || '');
  const b = j.result.boundaries;
  assert.equal(b.exam, 'cie:0607');
  assert.equal(b.session, 'June 2025');
  assert.deepEqual(b.options.map((o) => o.max_mark), [160, 200], 'a row with impossible numbers is left out');
  assert.equal(b.options[1].grades[0].grade, 'A*');
  assert.equal((await q(T.from('grade_boundaries').select('id'))).length, 0, 'nothing saved until the tutor checks it');
  assert.equal((await T.storage.from('library').download(page)).data, null, 'the page pictures are tidied away');
  // the tutor saves the one they want
  const saved = await q(T.from('grade_boundaries').insert({ exam: b.exam, session: b.session, option_label: b.options[1].option, max_mark: b.options[1].max_mark, grades: b.options[1].grades, source: 'prof' }).select().single());
  assert.equal(saved.grades.length, 4);
});

test('Prof reads the tutor’s syllabus PDF, then plans the course week by week; nothing changes until the tutor uses it', async () => {
  const T = client();
  await q(T.auth.signInWithPassword({ email: 'tutor@x.com', password: 'secret123' }));
  const me = (await T.auth.getUser()).data.user.id;
  const subj = await q(T.from('subjects').insert({ name: 'Maths from PDF' }).select().single());
  const text = `${me}/prof/syllabus.txt`;
  await q(T.storage.from('library').upload(text, new TextEncoder().encode('Subject content\nC1 Number\nC1.1 Types of number\nC2 Algebra'), { contentType: 'text/plain' }));
  const bad = await T.rpc('prof_syllabus', { p_subject: subj.id, p_label: '', p_source: { text_path: 'someone/prof/x.txt' } });
  assert.match(bad.error.message, /Unknown file/);
  const job = await q(T.rpc('prof_syllabus', { p_subject: subj.id, p_label: '', p_source: { text_path: text, name: '0607 syllabus.pdf' } }));
  await kick(T);
  let j = await q(T.from('prof_jobs').select('status,result,error').eq('id', job.id).single());
  assert.equal(j.status, 'done', j.error || '');
  assert.deepEqual(j.result.syllabus.topics.map((t) => t.code), ['C1', 'C2']);
  assert.equal((await T.storage.from('library').download(text)).data, null, 'the document text is tidied away');
  assert.equal((await q(T.from('topics').select('id').eq('subject_id', subj.id))).length, 0, 'nothing until the tutor uses it');

  // a plan needs topics first
  const none = await T.rpc('prof_plan', { p_subject: subj.id, p_kind: 'week', p_start: '2026-10-05', p_end: '2026-12-20' });
  assert.match(none.error.message, /syllabus first/);
  await q(T.from('topics').insert([{ subject_id: subj.id, name: 'Number', position: 0 }, { subject_id: subj.id, name: 'Algebra', position: 1 }]));
  const wrong = await T.rpc('prof_plan', { p_subject: subj.id, p_kind: 'week', p_start: '2026-12-20', p_end: '2026-10-05' });
  assert.match(wrong.error.message, /end date after/);
  const pj = await q(T.rpc('prof_plan', { p_subject: subj.id, p_kind: 'week', p_start: '2026-10-05', p_end: '2026-12-20', p_lessons: 2 }));
  await kick(T);
  j = await q(T.from('prof_jobs').select('status,result,error').eq('id', pj.id).single());
  assert.equal(j.status, 'done', j.error || '');
  const plan = j.result.plan;
  assert.equal(plan.kind, 'week');
  assert.deepEqual(plan.items.slice(0, 2).map((x) => x.topics), [['Number'], ['Algebra']]);
  assert.deepEqual(plan.items.at(-1).topics, [], 'topics that aren’t in the syllabus are dropped');
  assert.equal((await q(T.from('teaching_plans').select('id').eq('subject_id', subj.id))).length, 0, 'saved only when the tutor uses it');
});

test('Prof writes flashcards for the tutor to pick from; learners get nothing until then', async () => {
  const T = client();
  await q(T.auth.signInWithPassword({ email: 'tutor@x.com', password: 'secret123' }));
  const subj = (await q(T.from('subjects').select('id').eq('name', 'Maths 0607')))[0];
  const job = await q(T.rpc('prof_cards', { p_subject: subj.id, p_topic: 'Algebra', p_count: 6 }));
  await kick(T);
  const j = await q(T.from('prof_jobs').select('status,result,error').eq('id', job.id).single());
  assert.equal(j.status, 'done', j.error || '');
  assert.equal(j.result.cards.list.length, 6);
  assert.match(j.result.cards.list[0].front, /what is/);
  assert.equal((await q(T.from('cards').select('id').eq('subject_id', subj.id))).length, 0);
  const tooMany = await T.rpc('prof_cards', { p_subject: subj.id, p_topic: 'Algebra', p_count: 99 });
  assert.match(tooMany.error.message, /1 to 40/);
});

test('calendar link: lessons and due dates as a calendar feed; private per person; can be reset', async () => {
  const T = client();
  await q(T.auth.signInWithPassword({ email: 'tutor@x.com', password: 'secret123' }));
  const me = (await T.auth.getUser()).data.user.id;
  const inv = await q(T.from('invites').insert({ name: 'Cal' }).select().single());
  const L = client();
  await q(L.auth.signUp({ email: 'cal@x.com', password: 'secret123' }));
  await q(L.rpc('accept_invite', { p_code: inv.code, p_name: 'Cal Learner' }));
  const learner = (await L.auth.getUser()).data.user.id;
  const soon = new Date(Date.now() + 2 * 86400000).toISOString();
  await q(T.from('sessions').insert({ title: 'Algebra; lesson, part 1', starts_at: soon, duration_min: 45, learner_ids: [learner] }));
  await q(T.from('sessions').insert({ title: 'Someone else', starts_at: soon, learner_ids: [] }));
  const longTitle = 'Révision: équations du second degré ✏️ — '.repeat(4) + 'line one\rline two';
  await q(T.from('sessions').insert({ title: longTitle, starts_at: soon, duration_min: 30, learner_ids: [learner] }));
  await q(T.from('assignments').insert({ title: 'Homework 7', kind: 'homework', visibility: 'visible', due_at: soon, learner_ids: [learner] }));
  await q(T.from('assignments').insert({ title: 'Secret draft', kind: 'homework', visibility: 'visible', draft: true, due_at: soon }));
  const lt = await q(L.rpc('my_calendar_token'));
  assert.equal(await q(L.rpc('my_calendar_token')), lt, 'same link each time');
  const get = (tok) => fetch(`${srv.url}/functions/v1/prof?calendar=${tok}`);
  const r = await get(lt);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/calendar/);
  const ics = await r.text();
  assert.match(ics, /BEGIN:VCALENDAR[\s\S]*END:VCALENDAR/);
  assert.ok(ics.includes('SUMMARY:Algebra\\; lesson\\, part 1'), 'commas and semicolons escaped');
  assert.match(ics, /SUMMARY:Due: Homework 7/);
  assert.ok(!ics.includes('Someone else') && !ics.includes('Secret draft'), 'only hers, and no drafts');
  assert.match(ics, /DTSTART:\d{8}T\d{6}Z/);
  // lines at most 75 bytes, no stray carriage returns, and the long title survives unfolding
  const raw = ics.split('\r\n');
  assert.ok(raw.every((l) => Buffer.byteLength(l, 'utf8') <= 75), 'folded by bytes');
  assert.ok(raw.every((l) => !l.includes('\r') && !l.includes('\n')));
  const unfolded = ics.replace(/\r\n /g, '');
  assert.ok(unfolded.includes('SUMMARY:' + longTitle.replace(/\r/g, '\\n').replace(/,/g, '\\,')), 'nothing lost or split mid-character');
  const tt = await q(T.rpc('my_calendar_token'));
  const tics = await (await get(tt)).text();
  assert.match(tics, /Someone else/);
  assert.equal((await get('not-a-real-token-at-all-123')).status, 404);
  const fresh = await q(L.rpc('my_calendar_token', { p_reset: true }));
  assert.notEqual(fresh, lt);
  assert.equal((await get(lt)).status, 404, 'the old link stops working');
  void me;
});

test('Prof’s StudyBridge practice papers (no longer used by the app): Prof works out the papers, writes them in the background, checks them; tutors never get them', async () => {
  const A = await admin();
  const T = client();
  await q(T.auth.signInWithPassword({ email: 'tutor@x.com', password: 'secret123' }));
  const no = await T.rpc('admin_paper_plan', { p_board: 'cie', p_codes: ['0607'], p_labels: ['International Mathematics'] });
  assert.match(no.error.message, /admins only/);
  await q(A.rpc('admin_paper_plan', { p_board: 'cie', p_codes: ['0607'], p_labels: ['International Mathematics'] }));
  await kick(A);
  let all = await q(A.rpc('admin_papers'));
  const plan = all.plans.find((p) => p.code === '0607');
  assert.equal(plan.components.length, 3);
  assert.equal(plan.components.find((c) => c.paper === '6').writable, false);
  // write 2 of Paper 2 (one job per paper; tutors' jobs would go first)
  const n = await q(A.rpc('admin_write_papers', { p_slots: [{ board: 'cie', code: '0607', label: 'International Mathematics', paper: '2', name: 'Paper 2 (Core)', count: 2, structure: 'Short answers' }] }));
  assert.equal(n, 2);
  for (let i = 0; i < 14; i++) await kick(A);
  all = await q(A.rpc('admin_papers'));
  const ps = all.papers.filter((p) => p.code === '0607' && p.paper === '2');
  assert.deepEqual(ps.map((p) => p.number), [1, 2]);
  assert.ok(ps.every((p) => p.status === 'review' && p.items === 8), JSON.stringify(ps));
  assert.equal(ps[0].flagged, 1, 'the deliberately wrong answer is flagged');
  assert.match(ps[0].check_note, /^3:/);
  assert.ok(Number(all.avg_cents) > 0, 'what a paper costs, for the next estimate');
  // tutors get nothing, even approved: StudyBridge's papers for tutors now come from the content account
  assert.equal((await q(T.from('sb_papers').select('id'))).length, 0);
  await q(A.rpc('admin_paper_status', { p_ids: [ps[0].id], p_status: 'approved' }));
  assert.equal((await q(T.from('sb_papers').select('*'))).length, 0);
  const seen = await q(A.from('sb_papers').select('*').eq('id', ps[0].id));
  assert.equal(seen[0].items.length, 8);
  assert.equal(seen[0].items[0].answer.value, '7');
  await q(T.rpc('paper_used', { p_id: ps[0].id }));
  const bad = await T.from('sb_papers').update({ status: 'approved' }).eq('id', ps[1].id).select();
  assert.ok(bad.error || !bad.data.length, 'tutors can’t approve');
});

test('payments and email: closed until the admin adds keys; Stripe checkout, signed webhooks set the plan; reports by email', async () => {
  const T = client();
  await q(T.auth.signInWithPassword({ email: 'tutor@x.com', password: 'secret123' }));
  const me = (await T.auth.getUser()).data.user.id;
  const call = async (body, c = T) => {
    const { data } = await c.auth.getSession();
    const r = await fetch(`${srv.url}/functions/v1/prof`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: srv.anonKey, authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify(body),
    });
    return [r.status, await r.json()];
  };
  let [st, r] = await call({ action: 'checkout', level: 'essentials', period: 'month' });
  assert.equal(st, 400);
  assert.match(r.error, /isn’t open yet/);

  const A = await admin();
  await q(A.rpc('admin_set_selling', { p_stripe_secret: 'sk_test_x', p_stripe_webhook: 'whsec_test', p_prices: { essentials_month: 'price_e_m', plus_year: 'price_p_y' }, p_resend_key: 're_test', p_email_from: 'StudyBridge <hello@example.com>' }));
  assert.equal((await q(T.rpc('public_settings'))).payments_on, true);
  [st, r] = await call({ action: 'checkout', level: 'essentials', period: 'month', return_url: 'javascript:alert(1)' });
  assert.equal(st, 200, JSON.stringify(r));
  assert.match(r.url, /checkout\.stripe\.test/);
  let co = outside.findLast((x) => x.url.startsWith('/v1/checkout/sessions'));
  assert.equal(co.auth, 'Bearer sk_test_x');
  assert.equal(co.body['line_items[0][price]'], 'price_e_m');
  const active = Number((await srv.db.query(`select public._active_learners($1) n`, [me])).rows[0].n);
  assert.equal(co.body['line_items[0][quantity]'], String(Math.max(1, active)), 'one for each learner');
  assert.equal(co.body['metadata[tutor]'], me);
  assert.equal(co.body['metadata[level]'], 'essentials');
  assert.equal(co.body.mode, 'subscription');
  assert.equal(co.body['automatic_tax[enabled]'], undefined, 'tax only when the Owner switches it on');
  assert.doesNotMatch(co.body.success_url, /javascript/, 'only safe return links');
  [st, r] = await call({ action: 'checkout', level: 'plus', period: 'month' });
  assert.equal(st, 400, 'no price for Plus monthly yet');
  await q(A.rpc('admin_set_checkout', { p_tax: true }));
  [st, r] = await call({ action: 'checkout', level: 'plus', period: 'year' });
  assert.equal(st, 200, JSON.stringify(r));
  co = outside.findLast((x) => x.url.startsWith('/v1/checkout/sessions'));
  assert.deepEqual([co.body['line_items[0][price]'], co.body['automatic_tax[enabled]']], ['price_p_y', 'true']);
  await q(A.rpc('admin_set_checkout', { p_tax: false }));

  // Stripe's webhook, signed; a bad signature changes nothing
  const hook = async (event, secret = 'whsec_test') => {
    const raw = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
    const res = await fetch(`${srv.url}/functions/v1/prof?stripe=webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': `t=${t},v1=${sig}` }, body: raw });
    return res.status;
  };
  const paid = { type: 'checkout.session.completed', data: { object: { customer: 'cus_42', metadata: { tutor: me, plan: 'starter', period: 'month' } } } };
  assert.equal(await hook(paid, 'wrong'), 400);
  assert.equal((await q(T.rpc('my_plan'))).plan, 'free');
  assert.equal(await hook(paid), 200);
  let plan = await q(T.rpc('my_plan'));
  assert.equal(plan.plan, 'starter');
  assert.equal(plan.has_billing, true);
  [st, r] = await call({ action: 'billing' });
  assert.equal(st, 200);
  assert.equal(outside.findLast((x) => x.url.startsWith('/v1/billing_portal')).body.customer, 'cus_42');
  assert.equal(await hook({ type: 'customer.subscription.deleted', data: { object: { customer: 'cus_42', metadata: { tutor: me, plan: 'starter' } } } }), 200);
  assert.equal((await q(T.rpc('my_plan'))).plan, 'free');

  // Essentials or Plus by card: the level and paid-up date come from the subscription, and the number of learners
  // follows the tutor (kick updates Stripe)
  assert.equal(await hook({ type: 'checkout.session.completed', data: { object: { customer: 'cus_42', subscription: 'sub_lvl', metadata: { tutor: me, level: 'plus', period: 'month' } } } }), 200);
  plan = await q(T.rpc('my_plan'));
  assert.equal(plan.level, 'plus');
  assert.ok(plan.paid_until >= new Date(Date.now() + 29 * 86400000).toISOString().slice(0, 10), 'paid to the end of the period');
  await srv.db.query(`update public.profiles set stripe_seats = 99 where id = $1`, [me]);
  [st] = await call({ action: 'kick' });
  for (let i = 0; i < 50 && !outside.some((x) => x.url.startsWith('/v1/subscription_items/')); i++) await new Promise((res) => setTimeout(res, 100));
  const seats = outside.findLast((x) => x.url.startsWith('/v1/subscription_items/si_1'));
  assert.ok(seats, 'Stripe was told the new number of learners');
  assert.equal(seats.body.quantity, String(Math.max(1, active)));
  assert.equal(seats.body.proration_behavior, 'create_prorations');
  assert.equal(await hook({ type: 'customer.subscription.deleted', data: { object: { id: 'sub_lvl', customer: 'cus_42', status: 'canceled', metadata: { tutor: me, level: 'plus', period: 'month' } } } }), 200);
  assert.equal((await srv.db.query(`select stripe_tutor_sub from public.profiles where id = $1`, [me])).rows[0].stripe_tutor_sub, null, 'ended');
  await srv.db.query(`update public.profiles set level = 'essentials', paid_until = null, plan_period = null, plan_renews_at = null where id = $1`, [me]);

  // mobile money: closed until both Flutterwave keys are in; a payment only counts once Flutterwave confirms it
  [st, r] = await call({ action: 'mobile_pay', what: 'plus', months: 3, currency: 'ZMW' });
  assert.equal(st, 400);
  assert.match(r.error, /isn’t open yet/);
  await q(A.rpc('admin_set_checkout', { p_flw_secret: 'FLWSECK_TEST-x', p_flw_hash: 'flw-hash' }));
  [st, r] = await call({ action: 'mobile_pay', what: 'plus', months: 3, currency: 'ZMW', return_url: 'javascript:alert(1)' });
  assert.equal(st, 200, JSON.stringify(r));
  assert.match(r.url, /flutterwave\.test/);
  const fp = outside.findLast((x) => x.url === '/v3/payments');
  assert.equal(fp.auth, 'Bearer FLWSECK_TEST-x');
  assert.equal(fp.body.currency, 'ZMW');
  assert.equal(fp.body.amount, r.amount);
  assert.doesNotMatch(fp.body.redirect_url, /javascript/);
  const flw = async (id, hash = 'flw-hash') => (await fetch(`${srv.url}/functions/v1/prof?flutterwave=webhook`, { method: 'POST', headers: { 'content-type': 'application/json', 'verif-hash': hash }, body: JSON.stringify({ event: 'charge.completed', data: { id, tx_ref: fp.body.tx_ref, status: 'successful', amount: 1e9 } }) })).status;
  assert.equal(await flw(8, 'wrong'), 401, 'not from Flutterwave');
  assert.equal(await flw(9), 200);
  assert.equal((await q(T.rpc('my_plan'))).paid_until, null, 'Flutterwave says it was short: it doesn’t count (the event’s own amount is never trusted)');
  assert.equal(await flw(8), 200);
  assert.ok(outside.some((x) => x.url === '/v3/transactions/8/verify' && x.auth === 'Bearer FLWSECK_TEST-x'), 'checked with Flutterwave');
  plan = await q(T.rpc('my_plan'));
  assert.equal(plan.level, 'plus');
  assert.ok(plan.paid_until >= new Date(Date.now() + 85 * 86400000).toISOString().slice(0, 10), 'three months');
  await srv.db.query(`update public.profiles set level = 'essentials', paid_until = null where id = $1`, [me]);
  await srv.db.query(`update public.platform_secrets set flw_secret = null, flw_hash = null where id = 1`);
  // a centre or school pays yearly by invoice (never at tutor prices): no card checkout for it
  await q(T.rpc('org_make_centre', { p_name: 'Card Centre' }));
  [st, r] = await call({ action: 'checkout', level: 'essentials', period: 'month' });
  assert.equal(st, 400);
  assert.match(r.error, /pays yearly by invoice/);
  [st, r] = await call({ action: 'mobile_pay', what: 'plus', months: 1, currency: 'USD' });
  assert.equal(st, 400);
  await q(T.rpc('org_leave'));

  // a student pays through the Owner's Pay by card links: recorded straight away, and "you're all set" is emailed
  const S = client();
  await q(S.auth.signUp({ email: 'card-student@x.com', password: 'secret123' }));
  const sid = (await S.auth.getUser()).data.user.id;
  await srv.db.query(`update public.profiles set role = 'learner', tutor_id = $2, self_learner = true, trial_until = now() + interval '7 days', exam_date = current_date + 200 where id = $1`, [sid, me]);
  await srv.db.query(`update public.app_config set pay_link_monthly = 'https://buy.stripe.com/plink_month', pay_link_pass = 'https://buy.stripe.com/plink_pass?locale=en' where id = 1`);
  const student = async () => (await srv.db.query(`select paid_plan, paid_until::text, stripe_student_sub from public.profiles where id = $1`, [sid])).rows[0];
  const day = async (sql) => (await srv.db.query(`select (${sql})::date::text d`)).rows[0].d;
  const session = (o) => ({ type: 'checkout.session.completed', data: { object: { client_reference_id: sid, payment_status: 'paid', metadata: {}, ...o } } });
  // a link that isn't one of the Owner's: nothing changes
  assert.equal(await hook(session({ id: 'cs_other', payment_link: 'plink_other', mode: 'payment' })), 200);
  assert.equal((await student()).paid_plan, null);
  // an exam pass for 3 months (the exams are about 7 months away): 3 months
  assert.equal(await hook(session({ id: 'cs_pass_q3', payment_link: 'plink_pass', mode: 'payment' })), 200);
  assert.deepEqual([(await student()).paid_plan, (await student()).paid_until], ['pass', await day(`current_date + interval '3 months'`)]);
  assert.ok(outside.some((x) => x.url.startsWith('/v1/payment_links/plink_pass') && x.auth === 'Bearer sk_test_x'));
  // enough months for the exams: until about 60 days after them
  assert.equal(await hook(session({ id: 'cs_pass_q8', payment_link: 'plink_pass', mode: 'payment' })), 200);
  assert.equal((await student()).paid_until, await day(`current_date + 200 + 60`));
  // monthly by card subscription: a month on, and each renewal another month
  await srv.db.query(`update public.profiles set paid_plan = null, paid_until = null where id = $1`, [sid]);
  assert.equal(await hook(session({ id: 'cs_month', payment_link: 'plink_month', mode: 'subscription', subscription: 'sub_9' })), 200);
  assert.deepEqual(await student(), { paid_plan: 'monthly', paid_until: await day(`current_date + interval '1 month'`), stripe_student_sub: 'sub_9' });
  assert.equal(await hook({ type: 'invoice.paid', data: { object: { subscription: 'sub_9', billing_reason: 'subscription_cycle' } } }), 200);
  assert.equal((await student()).paid_until, await day(`current_date + interval '2 months'`));
  assert.equal(await hook({ type: 'invoice.paid', data: { object: { subscription: 'sub_9', billing_reason: 'subscription_create' } } }), 200);
  assert.equal((await student()).paid_until, await day(`current_date + interval '2 months'`), 'the first invoice is the checkout itself');
  const mails = (await srv.db.query(`select subject from public.outgoing_emails where to_addr = 'card-student@x.com'`)).rows.map((r) => r.subject);
  assert.ok(mails.filter((s) => s === 'You\'re all set').length >= 3, 'an email each time it was paid');
  // a student can't record their own payment
  const { error: selfPay } = await S.rpc('_student_paid_by_card', { p_user: sid, p_plan: 'pass', p_months: 12 });
  assert.ok(selfPay, 'only the server may call it');

  // an approved report by email, from StudyBridge itself
  const inv = await q(T.from('invites').insert({ name: 'Pay learner' }).select().single());
  const L = client();
  await q(L.auth.signUp({ email: 'pay-learner@x.com', password: 'secret123' }));
  await q(L.rpc('accept_invite', { p_code: inv.code, p_name: 'Sis' }));
  const lid = (await L.auth.getUser()).data.user.id;
  await q(L.rpc('set_parent_reports', { p_on: true, p_name: 'Mum', p_phone: null, p_email: 'mum@example.com' }));
  const rep = await q(T.from('parent_reports').insert({ learner_id: lid, week_start: '2026-08-03', data: { learner: 'Sis', tutor: 'Aaryan', lessons: 2, avg_pct: 70, work: [{ title: 'Algebra', score: 7, max: 10 }] }, comment: 'Factorise **fully**: $x^2-25$' }).select().single());
  [st, r] = await call({ action: 'email_report', report_id: rep.id });
  assert.match(r.error, /Approve the report first/);
  await q(T.from('parent_reports').update({ status: 'sent', sent_via: 'email', sent_at: new Date().toISOString() }).eq('id', rep.id));
  [st, r] = await call({ action: 'email_report', report_id: rep.id });
  assert.equal(st, 200, JSON.stringify(r));
  const mail = outside.findLast((x) => x.url.startsWith('/emails'));
  assert.deepEqual(mail.body.to, ['mum@example.com']);
  assert.equal(mail.auth, 'Bearer re_test');
  assert.match(mail.body.html, /Factorise fully: x²-25/);
  assert.doesNotMatch(mail.body.html, /\$|\*\*/);
  assert.match(String(mail.body.reply_to), /@/, 'a parent’s reply goes to the tutor, not StudyBridge');
  // messages to StudyBridge's own inboxes go out once email is set up: a website message to hello@, replying to the sender
  await q(client().rpc('send_contact', { p_name: 'Mrs Banda', p_email: 'banda@example.com', p_role: 'school', p_message: 'Do you do IGCSE Physics?' }));
  [st] = await call({ action: 'kick' });
  const hello = outside.findLast((x) => x.url.startsWith('/emails') && x.body.to?.[0] === 'hello@gostudybridge.com' && /Banda/.test(x.body.subject));
  assert.ok(hello, 'the website message was emailed to hello@');
  assert.equal(hello.body.reply_to, 'banda@example.com');
  assert.match(hello.body.text, /IGCSE Physics/);
  [st] = await call({ action: 'checkout', plan: 'pro', period: 'month' }, L);
  assert.equal(st, 403, 'learners can’t buy plans');
});

test('study reminders as browser notifications: Prof signs each push with StudyBridge’s own key (made once, never pasted) and forgets a device that’s gone', async () => {
  // a stand-in push service: one device takes the push, the other has gone (410)
  const http = await import('node:http');
  const got = [];
  const push = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      got.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
      res.writeHead(req.url.startsWith('/gone') ? 410 : 201);
      res.end();
    });
  });
  await new Promise((r) => push.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${push.address().port}`;
  try {
    const L = client();
    await q(L.auth.signUp({ email: 'push-learner@x.com', password: 'secret123' }));
    const lid = (await L.auth.getUser()).data.user.id;
    await srv.db.query(`update public.profiles set role = 'learner', timezone = 'Africa/Lusaka' where id = $1`, [lid]);

    // the app asks for the public key; Prof makes the pair the first time and keeps it
    assert.equal(await q(L.rpc('push_key')), null, 'no key until Prof makes one');
    const { data: s } = await L.auth.getSession();
    const askKey = async () => {
      const r = await fetch(`${srv.url}/functions/v1/prof`, { method: 'POST', headers: { 'content-type': 'application/json', apikey: srv.anonKey, authorization: `Bearer ${s.session.access_token}` }, body: '{"action":"push_key"}' });
      return [r.status, await r.json()];
    };
    const [st, made] = await askKey();
    assert.equal(st, 200, JSON.stringify(made));
    assert.equal(Buffer.from(made.key, 'base64url').length, 65, 'a P-256 public key');
    assert.equal(await q(L.rpc('push_key')), made.key);
    assert.equal((await askKey())[1].key, made.key, 'made once');
    const secret = (await srv.db.query(`select vapid_private, hook_secret from public.platform_secrets where id = 1`)).rows[0];
    assert.equal(JSON.parse(secret.vapid_private).kty, 'EC', 'the private half stays in the database');

    // two devices (the stand-in isn't a real push service, so it goes straight into the table), then a test
    for (const path of ['/device-1', '/gone-1']) {
      await srv.db.query(`insert into public.push_subscriptions (user_id, endpoint, p256dh, auth) values ($1, $2, 'p', 'a')`, [lid, origin + path]);
    }
    await q(L.rpc('set_study_reminder', { p_on: true, p_time: '17:00' }));
    assert.equal((await q(L.rpc('send_test_reminder'))).devices, 2);
    // the database wakes Prof (with its shared secret) to send them
    const wake = () => fetch(`${srv.url}/functions/v1/prof`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-prof-secret': secret.hook_secret }, body: '{"action":"kick"}' }).then((r) => r.status);
    assert.equal(await wake(), 200);
    assert.equal(got.length, 2);
    for (const g of got) {
      assert.equal(g.method, 'POST');
      assert.equal(g.body, '', 'an empty push: nothing to encrypt');
      assert.equal(g.headers['content-length'], '0');
      assert.equal(g.headers.ttl, '14400');
      const m = g.headers.authorization.match(/^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/);
      assert.ok(m, g.headers.authorization);
      const [, head, body, sig, k] = m;
      assert.equal(k, made.key);
      assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { typ: 'JWT', alg: 'ES256' });
      const claims = JSON.parse(Buffer.from(body, 'base64url'));
      assert.equal(claims.aud, origin, 'for this push service only');
      assert.equal(claims.sub, 'mailto:support@gostudybridge.com');
      const now = Date.now() / 1000;
      assert.ok(claims.exp > now && claims.exp <= now + 12 * 3600 + 5, 'good for 12 hours at most');
      // signed with the private half of the public key the app subscribed with
      const pub = await crypto.webcrypto.subtle.importKey('raw', Buffer.from(k, 'base64url'), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      assert.ok(await crypto.webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(sig, 'base64url'), Buffer.from(`${head}.${body}`)), 'the signature checks out');
    }
    // the device that took it is done; the one that's gone (410) is forgotten
    const subs = (await srv.db.query(`select endpoint from public.push_subscriptions where user_id = $1`, [lid])).rows.map((r) => r.endpoint);
    assert.deepEqual(subs, [origin + '/device-1']);
    const left = (await srv.db.query(`select count(*)::int n from public.push_outbox where sent_at is null`)).rows[0].n;
    assert.equal(left, 0);
    // nothing waiting: the next wake-up sends nothing
    assert.equal(await wake(), 200);
    assert.equal(got.length, 2);
  } finally {
    push.close();
  }
});

test('Change this part: Prof changes one question, or just its mark scheme, only in work learners can’t see yet', async () => {
  const T = client();
  await q(T.auth.signInWithPassword({ email: 'tutor@x.com', password: 'secret123' }));
  const a = await q(T.from('assignments').insert({ title: 'Times tables', kind: 'quiz', visibility: 'hidden' }).select().single());
  const qn = await q(T.from('questions').insert({ assignment_id: a.id, type: 'numeric', prompt_md: 'Work out $3 \\times 7$.', marks: 1 }).select().single());
  await q(T.from('question_keys').insert({ question_id: qn.id, answer: { value: '21' }, mark_scheme_md: 'B1' }));
  let job = await q(T.rpc('prof_revise', { p_question: qn.id, p_part: 'question', p_instruction: 'Make it a bit harder' }));
  await kick(T);
  let j = await q(T.from('prof_jobs').select('*').eq('id', job.id).single());
  assert.equal(j.status, 'done', j.error || '');
  assert.match(j.result.reply, /a little harder/);
  let now = await q(T.from('questions').select('prompt_md, marks').eq('id', qn.id).single());
  assert.deepEqual([now.prompt_md, Number(now.marks)], ['Work out $6 \\times 7$.', 2]);
  let k = await q(T.from('question_keys').select('answer, mark_scheme_md').eq('question_id', qn.id).single());
  assert.deepEqual([k.answer.value, k.mark_scheme_md], ['42', 'M1 A1']);
  assert.equal((await q(T.from('assignments').select('draft').eq('id', a.id).single())).draft, true, 'a draft again until the tutor checks it');
  // just the mark scheme: the question stays as it is
  job = await q(T.rpc('prof_revise', { p_question: qn.id, p_part: 'scheme', p_instruction: 'Give a method mark' }));
  await kick(T);
  j = await q(T.from('prof_jobs').select('*').eq('id', job.id).single());
  assert.equal(j.status, 'done', j.error || '');
  now = await q(T.from('questions').select('prompt_md').eq('id', qn.id).single());
  k = await q(T.from('question_keys').select('answer, mark_scheme_md').eq('question_id', qn.id).single());
  assert.deepEqual([now.prompt_md, k.answer.value, k.mark_scheme_md], ['Work out $6 \\times 7$.', '42', 'M1 for multiplying, A1 for 42.']);
  assert.ok(seen.some((x) => x.body.tools?.[0]?.name === 'save_question' && JSON.stringify(x.body.messages).includes('Give a method mark')), 'only the one question is sent');
  // once learners can see it, Prof leaves it alone
  await q(T.from('assignments').update({ visibility: 'visible', draft: false }).eq('id', a.id));
  const r = await T.rpc('prof_revise', { p_question: qn.id, p_part: 'question', p_instruction: 'Easier' });
  assert.match(r.error.message, /Learners can already see this/);
});

test('a school makes its learners’ accounts in advance from its spreadsheet: starting passwords, changed at first sign-in; only its teachers can', async () => {
  const A = await admin();
  const H = client();
  await q(H.auth.signUp({ email: 'head@kalulu.x', password: 'secret123' }));
  const head = (await H.auth.getUser()).data.user.id;
  await q(H.rpc('become_tutor', { p_name: 'Mrs Kalulu', p_timezone: 'Africa/Lusaka' }));
  await q(A.rpc('admin_set_status', { p_user: head, p_status: 'active' }));
  await q(H.rpc('org_make_centre', { p_name: 'Kalulu School' }));
  const cls = await q(H.rpc('save_class', { p_id: null, p_name: 'Grade 9 maths', p_subject: null, p_learner_ids: [] }));
  await q(H.rpc('school_roster_save', { p_rows: [{ email: 'mutinta@kalulu.x', name: 'Mutinta Hamoonga', grade: 9, classes: ['Grade 9 maths'] }, { email: 'tutor@x.com', name: 'Has one already' }] }));
  const ids = (await q(H.rpc('school_roster_list'))).map((r) => r.id);
  const call = async (body, c = H) => {
    const { data } = await c.auth.getSession();
    const r = await fetch(`${srv.url}/functions/v1/prof`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', apikey: srv.anonKey, authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify(body),
    });
    return [r.status, await r.json()];
  };
  // another school's (or no school's) teacher can't make them
  const T = client();
  await q(T.auth.signInWithPassword({ email: 'tutor@x.com', password: 'secret123' }));
  let [st, r] = await call({ action: 'school_accounts', ids }, T);
  assert.equal(st, 400);
  assert.match(r.error, /Only teachers in a school/);
  [st, r] = await call({ action: 'school_accounts', ids });
  assert.equal(st, 200, JSON.stringify(r));
  assert.deepEqual(r.made.map((m) => [m.name, m.email]), [['Mutinta Hamoonga', 'mutinta@kalulu.x']], 'not someone who already has an account');
  assert.match(r.made[0].password, /^[a-z]{4}-\d{4}$/);
  // she signs in with it, is in her class, and is asked to choose her own password
  const M = client();
  await q(M.auth.signInWithPassword({ email: 'mutinta@kalulu.x', password: r.made[0].password }));
  const me = await q(M.from('profiles').select('role, display_name, must_change_password').eq('id', (await M.auth.getUser()).data.user.id).single());
  assert.deepEqual([me.role, me.display_name, me.must_change_password], ['learner', 'Mutinta Hamoonga', true]);
  assert.equal((await q(M.rpc('my_school'))).classes, 1);
  assert.deepEqual((await q(H.rpc('school_roster_list'))).find((x) => x.email === 'mutinta@kalulu.x').joined, true);
  // asking again makes nothing twice
  [st, r] = await call({ action: 'school_accounts', ids });
  assert.deepEqual(r.made, []);
  void cls;
});
