// Everything the app asks the server, in one place.
import { sb, run, isOffline } from './supabase.js';
import { sendOrQueue } from './outbox.js';
import * as store from './store.js';
import { timezone } from './config.js';

let me = null;
export const setMe = (p) => (me = p);
export const getMe = () => me;
const uid = () => me?.id;

const uuid = () => crypto.randomUUID();
const safeName = (n) => String(n || 'file').replace(/[^\w.\- ]+/g, '').replace(/\s+/g, '-').slice(-80) || 'file';

// ---------------- account ----------------
export async function signUp(email, password, name) {
  const d = await run(sb().auth.signUp({ email: email.trim(), password, options: { data: { name } } }));
  if (!d.session) {
    throw new Error('Account created, but Supabase wants the email confirmed first. Turn off “Confirm email” in Supabase → Authentication → Sign In / Providers → Email, then sign in.');
  }
  return d;
}
export const signIn = (email, password) => run(sb().auth.signInWithPassword({ email: email.trim(), password }));
export async function signOut() {
  try {
    await sb().auth.signOut({ scope: 'local' });
  } catch {}
}
export async function session() {
  const { data } = await sb().auth.getSession();
  return data.session;
}
export const getProfile = (id) => run(sb().from('profiles').select('*').eq('id', id).maybeSingle());
export const becomeTutor = (name) => run(sb().rpc('become_tutor', { p_name: name, p_timezone: timezone() }));
export const acceptInvite = (code, name) => run(sb().rpc('accept_invite', { p_code: code, p_name: name, p_timezone: timezone() }));
export const updateProfile = (patch) => run(sb().from('profiles').update(patch).eq('id', uid()).select().maybeSingle());
export const changePassword = (password) => run(sb().auth.updateUser({ password }));

// ---------------- structure ----------------
export const listProgrammes = () => run(sb().from('programmes').select('*').order('created_at'));
export const listSubjects = () => run(sb().from('subjects').select('*').order('position').order('name'));
export const listTopics = () => run(sb().from('topics').select('*').order('position').order('name'));
export async function save(table, row) {
  if (row.id) {
    const { id, ...patch } = row;
    return run(sb().from(table).update(patch).eq('id', id).select().maybeSingle());
  }
  return run(sb().from(table).insert(row).select().maybeSingle());
}
export const remove = (table, id) => run(sb().from(table).delete().eq('id', id));

// ---------------- learners ----------------
export const listLearners = () => run(sb().from('profiles').select('*').eq('role', 'learner').order('display_name'));
export const listLearnerSubjects = () => run(sb().from('learner_subjects').select('*'));
export const setLearner = (id, name, programme, subjects) =>
  run(sb().rpc('set_learner', { p_learner: id, p_name: name, p_programme: programme || null, p_subject_ids: subjects }));
export const removeLearner = (id) => run(sb().rpc('remove_learner', { p_learner: id }));
export const listInvites = () => run(sb().from('invites').select('*').order('created_at', { ascending: false }));
export const createInvite = (inv) => run(sb().from('invites').insert(inv).select().maybeSingle());
export const revokeInvite = (id) => run(sb().from('invites').update({ revoked: true }).eq('id', id));

// ---------------- files ----------------
export const listFiles = () => run(sb().from('files').select('*').order('created_at', { ascending: false }));

export async function uploadFile(file, meta = {}) {
  const path = `${uid()}/files/${uuid()}-${safeName(file.name)}`;
  const bytes = await file.arrayBuffer();
  await run(sb().storage.from('library').upload(path, bytes, { contentType: file.type || 'application/octet-stream' }));
  await store.blobs.set(`library/${path}`, new Blob([bytes], { type: file.type }));
  return run(
    sb()
      .from('files')
      .insert({ name: file.name, mime: file.type || null, size: file.size, storage_path: path, visibility: 'hidden', ...meta })
      .select()
      .maybeSingle(),
  );
}
export async function deleteFile(f) {
  await run(sb().from('files').delete().eq('id', f.id));
  await sb().storage.from('library').remove([f.storage_path]);
  await store.blobs.del(`library/${f.storage_path}`);
}
// Images inside questions and lessons (always readable by the tutor's learners)
export async function uploadImage(file, kind = 'questions') {
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const path = `${uid()}/${kind}/${uuid()}.${ext}`;
  const bytes = await file.arrayBuffer();
  await run(sb().storage.from('library').upload(path, bytes, { contentType: file.type }));
  await store.blobs.set(`library/${path}`, new Blob([bytes], { type: file.type }));
  return path;
}

// Download once, keep on this device (offline), hand back a Blob
export async function getBlob(bucket, path, { fresh = false } = {}) {
  const key = `${bucket}/${path}`;
  if (!fresh) {
    const hit = await store.blobs.get(key);
    if (hit) return hit;
  }
  const { data, error } = await sb().storage.from(bucket).download(path);
  if (error) {
    const hit = await store.blobs.get(key);
    if (hit) return hit;
    throw new Error(isOffline(error) ? 'This file isn’t saved on this device yet. Open it once while online.' : 'Couldn’t open this file.');
  }
  await store.blobs.set(key, data);
  return data;
}
export async function isSavedOffline(bucket, path) {
  return !!(await store.blobs.get(`${bucket}/${path}`));
}

// ---------------- lessons ----------------
export const listLessons = () => run(sb().from('lessons').select('*').order('created_at', { ascending: false }));

// ---------------- assignments ----------------
export const listAssignments = () => run(sb().from('assignments').select('*').order('created_at', { ascending: false }));
export const getAssignment = (id) => run(sb().from('assignments').select('*').eq('id', id).maybeSingle());
export const listQuestions = (aid) => run(sb().from('questions').select('*').eq('assignment_id', aid).order('position'));
export const listKeys = (qids) => (qids.length ? run(sb().from('question_keys').select('*').in('question_id', qids)) : []);
export const saveKey = (key) => run(sb().from('question_keys').upsert(key, { onConflict: 'question_id' }));

export async function duplicateAssignment(a) {
  const { id, created_at, updated_at, ...rest } = a;
  const copy = await save('assignments', { ...rest, title: a.title + ' (copy)', visibility: 'hidden', draft: false });
  const qs = await listQuestions(id);
  const keys = await listKeys(qs.map((q) => q.id));
  for (const q of qs) {
    const { id: qid, created_at: _c, assignment_id, ...qr } = q;
    const nq = await save('questions', { ...qr, assignment_id: copy.id });
    const k = keys.find((x) => x.question_id === qid);
    if (k) await saveKey({ question_id: nq.id, answer: k.answer, mark_scheme_md: k.mark_scheme_md, solution_md: k.solution_md });
  }
  return copy;
}

// ---------------- attempts (tutor) ----------------
export const listAttempts = () => run(sb().from('attempts').select('*').order('started_at', { ascending: false }).limit(500));
export const attemptDetail = (id) => run(sb().rpc('attempt_detail', { p_attempt: id }));
export const updateResponse = (id, patch) => run(sb().from('responses').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id));
export const finishMarking = (id, release, feedback) => run(sb().rpc('finish_marking', { p_attempt: id, p_release: release, p_feedback: feedback ?? null }));
export async function uploadAnnotation(learnerId, attemptId, questionId, blob) {
  const path = `${learnerId}/${attemptId}/${questionId}-marked-${Date.now()}.png`;
  await run(sb().storage.from('work').upload(path, await blob.arrayBuffer(), { contentType: 'image/png', upsert: true }));
  await store.blobs.set(`work/${path}`, blob);
  return path;
}

// ---------------- attempts (learner) ----------------
export const myAttempts = (aid = null) => run(sb().rpc('my_attempts', { p_assignment: aid }));
export const startAttempt = (aid) => run(sb().rpc('start_attempt', { p_assignment: aid, p_client: window.studybridge ? 'desktop' : 'web' }));

export async function saveAnswer(attemptId, questionId, answer) {
  const local = (await store.get(`ans:${attemptId}`)) || {};
  local[questionId] = answer;
  await store.set(`ans:${attemptId}`, local);
  return sendOrQueue({ kind: 'rpc', fn: 'save_response', args: { p_attempt: attemptId, p_question: questionId, p_answer: answer }, dedupe: `ans:${attemptId}:${questionId}` });
}
export const localAnswers = async (attemptId) => (await store.get(`ans:${attemptId}`)) || {};

// Learner photo / drawing: keep it locally first, upload when possible
export async function saveWorkImage(attemptId, questionId, blob, name = 'work.png') {
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  const path = `${uid()}/${attemptId}/${questionId}-${uuid()}.${ext}`;
  await store.blobs.set(`work/${path}`, blob);
  await sendOrQueue({ kind: 'upload', bucket: 'work', path, blobKey: `work/${path}`, contentType: blob.type || 'image/png' });
  return { path, name, type: blob.type };
}

export async function submitAttempt(attemptId) {
  const r = await sendOrQueue({ kind: 'rpc', fn: 'submit_attempt', args: { p_attempt: attemptId } });
  await store.set(`submitted:${attemptId}`, { at: Date.now(), queued: !!r.queued });
  return r;
}
export const logTime = (kind, ref, seconds) =>
  sendOrQueue({ kind: 'rpc', fn: 'log_time', args: { p_kind: kind, p_ref: ref, p_seconds: Math.round(seconds) } }).catch(() => {});
export const logLockdown = (attemptId, event) =>
  sendOrQueue({ kind: 'rpc', fn: 'log_lockdown_event', args: { p_attempt: attemptId, p_event: event } }).catch(() => {});

// ---------------- notes & messages ----------------
export const listComments = () => run(sb().from('comments').select('*').order('created_at', { ascending: true }).limit(2000));
export async function sendComment(row) {
  const full = { author_id: uid(), ...row };
  if (me.role === 'learner') return sendOrQueue({ kind: 'insert', table: 'comments', row: full });
  return run(sb().from('comments').insert(full));
}
export const markCommentsRead = (ids) => (ids.length ? run(sb().rpc('mark_comments_read', { p_ids: ids })) : null);

// ---------------- notifications ----------------
export const listNotifications = () => run(sb().from('notifications').select('*').order('created_at', { ascending: false }).limit(100));
export const markNotificationsRead = (ids) =>
  ids.length ? run(sb().from('notifications').update({ read_at: new Date().toISOString() }).in('id', ids)) : null;

// ---------------- sessions / live ----------------
export const listSessions = () => run(sb().from('sessions').select('*').order('starts_at'));
export const livePass = (room) => run(sb().rpc('live_pass', { p_room: room }));
export const liveStatus = () => run(sb().rpc('live_status'));
export const setLiveKeys = (url, key, secret) => run(sb().rpc('set_live_keys', { p_url: url, p_key: key, p_secret: secret }));

// ---------------- progress ----------------
export const learnerProgress = (id) => run(sb().rpc('learner_progress', { p_learner: id }));
export const learnerSummary = (id, from, to) => run(sb().rpc('learner_summary', { p_learner: id, p_from: from.toISOString(), p_to: to.toISOString() }));
export const listActivity = () => run(sb().from('activity').select('learner_id,seconds,day,subject_id').order('day', { ascending: false }).limit(5000));

// ---------------- Claude drafts ----------------
export const listDrafts = () => run(sb().from('claude_drafts').select('*').eq('status', 'pending').order('created_at', { ascending: false }));
export const applyDraft = (id, payload) => run(sb().rpc('apply_draft', { p_draft: id, p_payload: payload ?? null }));
export const discardDraft = (id) => run(sb().from('claude_drafts').update({ status: 'discarded' }).eq('id', id));

// ---------------- settings ----------------
export const getSettings = () => run(sb().from('tutor_settings').select('*').eq('tutor_id', uid()).maybeSingle());
export const saveSettings = (patch) => run(sb().from('tutor_settings').update(patch).eq('tutor_id', uid()));

// ---------------- tutor admin ----------------
export const learnerAccounts = () => run(sb().rpc('learner_accounts'));
export const setLearnerPassword = (id, password) => run(sb().rpc('set_learner_password', { p_learner: id, p_password: password }));
export async function deleteLearnerAccount(id) {
  // Their uploaded work first (storage rules only let you remove it while they're still your learner)
  const paths = (await run(sb().rpc('learner_work_paths', { p_learner: id }))) || [];
  for (let i = 0; i < paths.length; i += 100) await sb().storage.from('work').remove(paths.slice(i, i + 100));
  await run(sb().rpc('delete_learner_account', { p_learner: id }));
}
