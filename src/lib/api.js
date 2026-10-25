// Everything the app asks the server, in one place.
import { sb, run, isOffline, sideClient, friendly } from './supabase.js';
import { asLearner, previewOpen } from './data.js';
import { switchToSession } from './accounts.js';
import { sendOrQueue } from './outbox.js';
import * as store from './store.js';
import { timezone, getServer, desktop } from './config.js';
import { parseOfficialPage, officialPage } from './exams.js';

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
    throw new Error('Nearly there: we’ve emailed you a link to confirm your address. Open it, then come back here and choose “I already have one” to sign in. Your invite is kept.');
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
export const becomeTutor = (name, signup = null) => run(sb().rpc('become_tutor', { p_name: name, p_timezone: timezone(), p_signup: signup }));
export async function acceptInvite(code, name) {
  const p = await run(sb().rpc('accept_invite', { p_code: code, p_name: name, p_timezone: timezone() }));
  if (!p?.id) throw new Error('That code isn’t right. Check it with your tutor and try again.');
  return p;
}
export const updateProfile = (patch) => run(sb().from('profiles').update(patch).eq('id', uid()).select().maybeSingle());
export const changePassword = (password) => run(sb().auth.updateUser({ password }));
// Where links in StudyBridge's emails open (the phone/web version; set as Supabase's Site URL too)
export const WEB_APP = 'https://gostudybridge.com/app/';
const webHome = () => (typeof location !== 'undefined' && location.protocol.startsWith('http') && !window.studybridge ? location.origin + location.pathname : WEB_APP);
export const sendPasswordReset = (email) => run(sb().auth.resetPasswordForEmail(email.trim(), { redirectTo: webHome() }));
// "Continue with Google". On the web the page goes to Google and comes back signed in (sessionFromLink). In the
// desktop app Google opens in the normal browser and the sign-in comes back to the app (electron/main.cjs).
export async function signInWithGoogle() {
  const g = window.studybridge?.google;
  if (!g) return run(sb().auth.signInWithOAuth({ provider: 'google', options: { redirectTo: webHome() } }));
  const d = await run(sb().auth.signInWithOAuth({ provider: 'google', options: { redirectTo: await g.redirect(), skipBrowserRedirect: true } }));
  const r = await g.signIn(d.url);
  if (r?.error) throw new Error(r.error);
  const s = await run(sb().auth.setSession({ access_token: r.access_token, refresh_token: r.refresh_token }));
  return { user: s.user };
}
// Is Google switched on in Supabase itself (Admin → Selling shows it)?
export async function googleReady() {
  const s = getServer();
  const r = await fetch(`${s.url}/auth/v1/settings`, { headers: { apikey: s.key } });
  return !!(await r.json())?.external?.google;
}
// What a new account will be, kept while the page is away at Google (who they said they are, a grade, a code)
const SETUP = 'sb.pendingSetup';
export function savePendingSetup(o) {
  try {
    localStorage.setItem(SETUP, JSON.stringify({ ...o, at: Date.now() }));
  } catch {}
}
export function takePendingSetup() {
  try {
    const o = JSON.parse(localStorage.getItem(SETUP) || 'null');
    localStorage.removeItem(SETUP);
    return o && Date.now() - o.at < 30 * 60 * 1000 ? o : null;
  } catch {
    return null;
  }
}
// After a link in an email (password reset) or Google sign-in: the sign-in arrives in the address
export async function sessionFromLink() {
  const h = typeof location !== 'undefined' ? location.hash || '' : '';
  if (!/access_token=/.test(h)) return null;
  const q = new URLSearchParams(h.replace(/^#\/?/, '').replace(/^.*?(access_token=)/, '$1'));
  const access_token = q.get('access_token');
  const refresh_token = q.get('refresh_token');
  const type = q.get('type');
  history.replaceState(null, '', location.pathname + location.search + '#/');
  if (!access_token || !refresh_token) return null;
  const d = await run(sb().auth.setSession({ access_token, refresh_token }));
  return { user: d.user, recovery: type === 'recovery' };
}
export const publicSettings = () => run(sb().rpc('public_settings')).catch(() => ({}));
// Plans, payments, your data, deleting your account
export const myPlan = () => run(sb().rpc('my_plan'));
// Essentials or Plus: the Owner sets a tutor's level and what they've paid up to (or more free days); a tutor asks to switch
export const adminSetLevel = (userId, level, paidUntil = null, trialDays = null) =>
  run(sb().rpc('admin_set_level', { p_user: userId, p_level: level, p_paid_until: paidUntil || null, p_trial_days: trialDays }));
export const askLevel = (level) => run(sb().rpc('ask_level', { p_level: level }));
// The Owner: a tutor's plan as it stands (theirs or their centre's), the places they've paid for, a centre's plan
export const adminBill = (userId) => run(sb().rpc('admin_bill', { p_tutor: userId }));
export const adminSetSeats = (userId, seats) => run(sb().rpc('admin_set_seats', { p_user: userId, p_seats: seats }));
// Admin → Schools and centres: every centre and school, and setting one up (paid up to, learners paid for, pilot days)
export const adminOrgs = () => run(sb().rpc('admin_orgs'));
export const adminSetSchoolPlan = (orgId, paidUntil = null, seats = null, pilotDays = null, kind = null) =>
  run(sb().rpc('admin_set_school_plan', { p_org: orgId, p_paid_until: paidUntil || null, p_seats: seats, p_pilot_days: pilotDays, p_kind: kind }));
export const exportMyData = () => run(sb().rpc('export_my_data'));
export const deleteMyAccount = (confirm) => run(sb().rpc('delete_my_account', { p_confirm: confirm }));
export const adminSelling = () => run(sb().rpc('admin_selling'));
export const adminEarlyAccess = () => run(sb().rpc('admin_early_access'));
export const adminContactMessages = () => run(sb().rpc('admin_contact_messages'));
export const adminContactDone = (id, done = true) => run(sb().rpc('admin_contact_done', { p_id: id, p_done: done }));
export const adminEmailQueue = () => run(sb().rpc('admin_email_queue'));
export const adminSetSelling = (patch) =>
  run(sb().rpc('admin_set_selling', {
    p_enforce: patch.enforce ?? null, p_google: patch.google ?? null, p_email_from: patch.email_from ?? null, p_resend_key: patch.resend_key || null,
    p_stripe_secret: patch.stripe_secret || null, p_stripe_webhook: patch.stripe_webhook || null, p_prices: patch.prices ?? null,
  }));
// Pay by card (Essentials or Plus, monthly or yearly, for each active learner) or by mobile money (what: essentials |
// plus for tutors, monthly | pass for students; a parent passes their child as forId)
export const checkout = (level, period) => callProf('checkout', { level, period, return_url: webHome() });
export const mobilePay = (what, months, currency, forId = null, seats = null) => callProf('mobile_pay', { what, months, currency, for: forId, seats, return_url: webHome() });
export const adminSetCheckout = (patch) =>
  run(sb().rpc('admin_set_checkout', { p_tax: patch.tax ?? null, p_flw_secret: patch.flw_secret || null, p_flw_hash: patch.flw_hash || null }));
// Stripe's page for a card plan: the centre's (for its manager) or, with own, the tutor's own
export const billingPortal = (own = false) => callProf('billing', { own, return_url: webHome() });
export const emailReport = (reportId) => callProf('email_report', { report_id: reportId });
export const profUrl = () => (getServer()?.url ? `${getServer().url}/functions/v1/prof` : null);

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
export const listLearnerSubjects = () => {
  const as = asLearner();
  return run(as ? sb().from('learner_subjects').select('*').eq('learner_id', as) : sb().from('learner_subjects').select('*'));
};

// ---------------- "See it as …" (a tutor sees one learner's own screens) ----------------
// The same rule the server uses for what a learner can see (can_learner_see): posted (or its time has come), not a
// draft, and for them: chosen learners include them (a class is its learners), else the subject is one of theirs,
// else everyone. Built from what the tutor can already read; nothing is done as the learner.
async function seenBy(learner, rows) {
  const mine = new Set(((await run(sb().from('learner_subjects').select('subject_id').eq('learner_id', learner))) || []).map((x) => x.subject_id));
  const now = Date.now();
  return (rows || []).filter(
    (x) =>
      !x.draft &&
      (x.visibility === 'visible' || (x.visibility === 'scheduled' && x.visible_from && new Date(x.visible_from).getTime() <= now)) &&
      (x.learner_ids?.length ? x.learner_ids.includes(learner) : x.subject_id ? mine.has(x.subject_id) : true),
  );
}
// Their attempts as they see them (my_attempts): marks and feedback only once given back
async function attemptsSeenBy(learner, aid) {
  let q = sb().from('attempts').select('*').eq('learner_id', learner).order('started_at', { ascending: false });
  if (aid) q = q.eq('assignment_id', aid);
  const rows = (await run(q)) || [];
  const ids = [...new Set(rows.map((t) => t.assignment_id))];
  const as = ids.length ? (await run(sb().from('assignments').select('id,release_mode,release_at').in('id', ids))) || [] : [];
  const byId = Object.fromEntries(as.map((a) => [a.id, a]));
  return rows.map((t) => {
    const a = byId[t.assignment_id];
    const released = t.released || (a?.release_mode === 'at' && a.release_at && new Date(a.release_at) <= new Date() && ['marked', 'returned'].includes(t.status));
    return {
      id: t.id, assignment_id: t.assignment_id, number: t.number, status: t.status, started_at: t.started_at, submitted_at: t.submitted_at,
      time_spent_sec: t.time_spent_sec, released, released_at: released ? t.released_at : null, score: released ? t.score : null,
      max_score: t.max_score, feedback_md: released ? t.feedback_md : null,
    };
  });
}
export const setLearner = (id, name, programme, subjects) =>
  run(sb().rpc('set_learner', { p_learner: id, p_name: name, p_programme: programme || null, p_subject_ids: subjects }));
export const removeLearner = (id) => run(sb().rpc('remove_learner', { p_learner: id }));
export const listInvites = () => run(sb().from('invites').select('*').order('created_at', { ascending: false }));

// ---------------- the demo StudyBridge (Admin → Demo, the Owner only) ----------------
export const DEMO_ACCOUNTS = ['manager', 'tutor1', 'tutor2', 'tutor3', 'learner1', 'learner2', 'learner3', 'learner4', 'learner5', 'learner6', 'parent', 'student'];
export const adminDemo = () => run(sb().rpc('admin_demo'));
// The demo's accounts are plain sign-ups made on a side connection (the Owner stays signed in here) with passwords
// nobody keeps; then the server fills them in as a pretend centre
export async function makeDemo({ student = true } = {}) {
  const side = sideClient();
  const tag = Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) => b.toString(16).padStart(2, '0')).join('');
  const ids = {};
  for (const who of DEMO_ACCOUNTS) {
    if (who === 'student' && !student) continue;
    const password = Array.from(crypto.getRandomValues(new Uint8Array(18)), (b) => b.toString(16).padStart(2, '0')).join('');
    const { data, error } = await side.auth.signUp({ email: `demo-${who}-${tag}@gostudybridge.com`, password });
    if (error || !data?.user?.id) throw new Error(error ? friendly(error) : 'StudyBridge couldn’t make the demo’s accounts.');
    ids[who] = data.user.id;
  }
  return run(sb().rpc('admin_demo_build', { p_accounts: ids }));
}
// "Open as": a fresh sign-in for that demo account (the server only makes one for a demo account), then switch to it
export async function openDemo(currentId, userId) {
  const a = await run(sb().rpc('admin_demo_open', { p_user: userId }));
  const { data, error } = await sideClient().auth.signInWithPassword({ email: a.email, password: a.password });
  if (error || !data?.session) throw new Error(error ? friendly(error) : 'That demo account wouldn’t open.');
  switchToSession(currentId, { id: a.id, email: a.email, name: a.name, role: a.role }, data.session);
}
export const removeDemo = () => run(sb().rpc('admin_demo_remove'));

// ---------------- the tutor's Home ----------------
// One card per learner: streak, last mark back, latest mock grade, exam, and this week in the teaching plan
export const tutorHome = () => run(sb().rpc('tutor_home'));
// A reminder to everyone it's for who hasn't handed it in (once in 12 hours); returns how many were told
export const nudgeAssignment = (id) => run(sb().rpc('nudge_assignment', { p_assignment: id }));

// ---------------- organisations and classes ----------------
// Every tutor is in an organisation (their own, or a tuition centre they joined with its code)
export const myOrg = () => run(sb().rpc('my_org'));
// A centre or school pays for everyone in it, yearly by invoice: its manager asks StudyBridge for one
export const myOrgBilling = () => run(sb().rpc('my_org_billing'));
export const orgAskInvoice = (learners = null, note = null) => run(sb().rpc('org_ask_invoice', { p_learners: learners, p_note: note }));
export const orgRename = (name) => run(sb().rpc('org_rename', { p_name: name }));
export const orgMakeCentre = (name = null) => run(sb().rpc('org_make_centre', { p_name: name }));
export const orgNewCode = () => run(sb().rpc('org_new_code'));
export async function orgJoin(code) {
  const r = await run(sb().rpc('org_join', { p_code: code }));
  if (!r) throw new Error('That code isn’t right. Check it with the centre and try again.');
  return r;
}
export const orgLeave = () => run(sb().rpc('org_leave'));
export const orgRemove = (userId) => run(sb().rpc('org_remove', { p_user: userId }));
export const orgSetRole = (userId, role) => run(sb().rpc('org_set_role', { p_user: userId, p_role: role }));
export const orgOverview = () => run(sb().rpc('org_overview'));
// Classes: a tutor's teaching groups (empty until the server has them)
export const listClasses = () => run(sb().from('classes').select('*').order('name')).catch((e) => (e.offline ? Promise.reject(e) : []));
export const listClassMembers = () => run(sb().from('class_members').select('*')).catch((e) => (e.offline ? Promise.reject(e) : []));
// teacher_ids: only a centre's manager chooses them (everyone else teaches their own classes)
export const saveClass = (c) =>
  run(sb().rpc('save_class', { p_id: c.id || null, p_name: c.name, p_subject: c.subject_id || null, p_learner_ids: c.learner_ids || [], p_teacher_ids: c.teacher_ids || null }));
export const listClassTeachers = () => run(sb().from('class_teachers').select('*')).catch((e) => (e.offline ? Promise.reject(e) : []));
// Who can be put in a class: a manager, everyone in the centre; anyone else, their own learners and their classes'
export const classPool = () => run(sb().rpc('class_pool'));
// A class's code (made the first time; renew: a new one, the old one stops working)
export const classCode = (id, renew = false) => run(sb().rpc('class_code', { p_class: id, p_new: renew }));
export async function joinClass(code) {
  const r = await run(sb().rpc('join_class', { p_code: code }));
  if (!r) throw new Error('That code isn’t right. Check it with your teacher and try again.');
  return r;
}
// A learner's teachers (their own tutor first), for Messages
export const myTeachers = () => run(sb().rpc('my_teachers'));
// A class's page: its classwork by topic, its gradebook, and a whole class list at once (an invite each)
export const classWork = (classId) => run(sb().rpc('class_work', { p_class: classId }));
export const classGradebook = (classId) => run(sb().rpc('class_gradebook', { p_class: classId }));
export const classInvites = (classId, names) => run(sb().rpc('class_invites', { p_class: classId, p_names: names }));
// The class stream: posts to one class or several at once, replies when a post allows them
export const streamClasses = () => run(sb().rpc('stream_classes'));
export const classStream = (classId) => run(sb().rpc('class_stream', { p_class: classId }));
export const postToClasses = ({ classes, body, files = [], replies = 'off', pinned = false, at = null, group = null }) =>
  run(sb().rpc('post_to_classes', { p_classes: classes, p_body: body, p_files: files, p_replies: replies, p_pinned: pinned, p_at: at, p_group: group }));
export const editClassPost = (postId, { body, files = [], replies = 'off', at = null }) =>
  run(sb().rpc('edit_class_post', { p_post: postId, p_body: body, p_files: files, p_replies: replies, p_at: at }));
export const deleteClassPost = (postId, everywhere = false) => run(sb().rpc('delete_class_post', { p_post: postId, p_everywhere: everywhere }));
export const pinClassPost = (postId, on) => run(sb().rpc('pin_class_post', { p_post: postId, p_on: on }));
export const replyToPost = (postId, body, replyTo = null) => run(sb().rpc('reply_to_post', { p_post: postId, p_body: body, p_reply_to: replyTo }));
export const removeReply = (replyId) => run(sb().rpc('remove_reply', { p_reply: replyId }));
export const muteInClass = (classId, learnerId, on) => run(sb().rpc('mute_in_class', { p_class: classId, p_learner: learnerId, p_on: on }));
export const myClasses = () => run(sb().rpc('my_classes'));
export const streamSeen = (classId) => run(sb().rpc('stream_seen', { p_class: classId }));
export const parentClassPosts = (learnerId) => run(sb().rpc('parent_class_posts', { p_learner: learnerId }));
// A picture or file for a post, put in the poster's own folder for that post before it goes up
export async function uploadStreamFile(file, group) {
  const safe = (file.name || 'file').replace(/[^\w.() -]+/g, '_').slice(-80) || 'file';
  const path = `${uid()}/stream/${group}/${uuid().slice(0, 8)}-${safe}`;
  const bytes = await file.arrayBuffer();
  await run(sb().storage.from('library').upload(path, bytes, { contentType: file.type || 'application/octet-stream' }));
  await store.blobs.set(`library/${path}`, new Blob([bytes], { type: file.type || 'application/octet-stream' }));
  return { path, name: file.name || safe, type: file.type || '', size: file.size || bytes.byteLength };
}
export const removeStreamFiles = (paths) => (paths.length ? sb().storage.from('library').remove(paths).catch(() => {}) : Promise.resolve());
// Rubrics (a teacher's own; a learner reads the ones on their questions)
export const listRubrics = () => run(sb().from('rubrics').select('*').order('title'));
// A learner's places (main tutor, other tutors, schools and centres): or, for a parent, their child's
export const myPlaces = (learnerId = null) => run(sb().rpc('my_places', { p_learner: learnerId }));
export const setShare = (placeId, on, learnerId = null) => run(sb().rpc('set_share', { p_place: placeId, p_on: on, p_learner: learnerId }));
export const leavePlace = (placeId) => run(sb().rpc('leave_place', { p_place: placeId }));
// A tutor's learners who added them with a code (their main tutor is someone else)
export const myLinkedLearners = () => run(sb().rpc('my_linked_learners'));
export const archiveClass = (id, archived = true) => run(sb().rpc('archive_class', { p_id: id, p_archived: archived }));
export const deleteClass = (id) => run(sb().rpc('delete_class', { p_id: id }));
export const createInvite = (inv) => run(sb().from('invites').insert(inv).select().maybeSingle());
export const revokeInvite = (id) => run(sb().from('invites').update({ revoked: true }).eq('id', id));

// ---------------- files ----------------
export const listFiles = () => {
  const as = asLearner();
  const rows = run(sb().from('files').select('*').order('created_at', { ascending: false }));
  return as ? rows.then((r) => seenBy(as, r)) : rows;
};

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
// ---------------- past papers ----------------
const EXAM_COLS = ['exam_board', 'exam_code', 'exam_year', 'exam_session', 'exam_kind', 'exam_paper', 'exam_level', 'exam_tz'];
const examMeta = (x) => Object.fromEntries(EXAM_COLS.map((k) => [k, x[k] ?? null]));

export async function sha256(blob) {
  const buf = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// A paper kept on this computer only: listed in the library, opened from this device, never uploaded
// until the tutor shares it with learners.
export async function importPaper(blob, name, meta, { hash, subject_id = null } = {}) {
  const sha = hash || (await sha256(blob));
  const path = `local/${uid()}/${sha}${/\.pdf$/i.test(name) || /pdf/.test(blob.type) ? '.pdf' : ''}`;
  await store.blobs.set(`library/${path}`, blob);
  const existing = await run(sb().from('files').select('*').eq('storage_path', path).maybeSingle());
  if (existing && !('exam_board' in existing)) throw new Error('The StudyBridge server needs its latest update before past papers work. (Admin: run the new setup.sql.)');
  if (existing) return { ...existing, duplicate: true };
  return run(
    sb()
      .from('files')
      .insert({ name, mime: blob.type || 'application/pdf', size: blob.size, storage_path: path, visibility: 'hidden', cloud: false, sha256: sha, subject_id, ...examMeta(meta) })
      .select()
      .maybeSingle(),
  ).catch((e) => {
    if (/exam_|sha256|cloud|column/i.test(e.message)) throw new Error('The StudyBridge server needs its latest update before past papers work. (Admin: run the new setup.sql.)');
    throw e;
  });
}

// Before learners can open a paper kept on this computer, a copy goes to the tutor's private storage.
export async function ensureCloud(f) {
  if (!f || f.cloud !== false) return f;
  const blob = await store.blobs.get(`library/${f.storage_path}`);
  if (!blob) throw new Error(`“${f.name}” is saved on the computer it was imported on. Share it from there.`);
  const path = `${uid()}/files/${uuid()}-${safeName(f.name)}`;
  await run(sb().storage.from('library').upload(path, await blob.arrayBuffer(), { contentType: f.mime || 'application/pdf' }));
  await store.blobs.set(`library/${path}`, blob);
  const row = await run(sb().from('files').update({ storage_path: path, cloud: true }).eq('id', f.id).select().maybeSingle());
  await store.blobs.del(`library/${f.storage_path}`);
  return row;
}
export async function ensureCloudIds(ids, files) {
  for (const id of ids || []) {
    const f = (files || []).find((x) => x.id === id);
    if (f && f.cloud === false) await ensureCloud(f);
  }
}

// The tutor's own link for a paper (private, opened in the browser)
export const addPaperLink = (url, name, meta) =>
  run(
    sb()
      .from('files')
      .insert({ name, mime: 'text/uri-list', size: 0, storage_path: `link/${uid()}/${uuid()}`, link_url: url, visibility: 'hidden', ...examMeta(meta) })
      .select()
      .maybeSingle(),
  );

export const setExamSubjects = (codes) =>
  run(sb().from('tutor_settings').upsert({ tutor_id: uid(), exam_subjects: codes }, { onConflict: 'tutor_id' }).select().maybeSingle());

// The papers an exam board publishes itself, read from its own website (desktop app). Kept on this
// device for a week; nothing is stored on StudyBridge's servers.
export const canReachBoards = () => !!desktop?.webFetch;
export async function officialPapers(code, { refresh = false } = {}) {
  const key = `official:cie:${code}`;
  const hit = await store.get(key);
  if (hit && !refresh && Date.now() - hit.at < 7 * 864e5) return hit;
  const url = officialPage(code);
  if (!url || !desktop?.webFetch) return hit || { at: 0, items: [], page: url, unavailable: true };
  const r = await desktop.webFetch(url, 'text');
  if (r.error) {
    if (hit) return { ...hit, stale: true };
    throw new Error(r.error);
  }
  const out = { at: Date.now(), items: parseOfficialPage(code, r.text), page: url };
  await store.set(key, out);
  return out;
}
export async function officialBlob(url) {
  const key = `official/${url}`;
  const hit = await store.blobs.get(key);
  if (hit) return hit;
  if (!desktop?.webFetch) throw new Error('Open this one in your browser.');
  const r = await desktop.webFetch(url, 'bytes');
  if (r.error) throw new Error(r.error);
  const blob = new Blob([r.bytes], { type: r.type || 'application/pdf' });
  await store.blobs.set(key, blob);
  return blob;
}

// ---------------- question bank ----------------
export const listBank = () => run(sb().from('bank_questions').select('*').neq('status', 'rejected').order('created_at', { ascending: false }).limit(2000));
export const saveBank = (row) => save('bank_questions', row);
export const setBankStatus = (ids, status) => run(sb().from('bank_questions').update({ status, updated_at: new Date().toISOString() }).in('id', ids));
export const profBank = ({ board = null, code = null, topic, count = 10, difficulty = null, subject = null, shared = false }) =>
  run(sb().rpc('prof_bank', { p_board: board, p_code: code, p_topic: topic, p_count: count, p_difficulty: difficulty, p_subject: subject, p_shared: shared })).then((r) => {
    callProf().catch(() => {});
    return r;
  });
// A bank question as an assignment question (the editor's shape)
export const bankToQuestion = (b) => ({
  type: b.type,
  prompt_md: b.prompt_md,
  image_path: b.image_path || null,
  options: b.options || [],
  marks: b.marks,
  topic_id: null,
  key: { answer: b.answer || {}, mark_scheme_md: b.mark_scheme_md || '', solution_md: b.solution_md || '' },
  _bank: b.id,
});
export async function addQuestionsToAssignment(assignmentId, questions, start = 0) {
  let i = start;
  for (const q of questions) {
    const saved = await save('questions', { assignment_id: assignmentId, position: i++, type: q.type, prompt_md: q.prompt_md || '', image_path: q.image_path || null, options: q.type === 'mcq' ? q.options : [], marks: Number(q.marks) || 0, topic_id: q.topic_id || null });
    await saveKey({ question_id: saved.id, answer: q.key?.answer || {}, solution_md: q.key?.solution_md || null, mark_scheme_md: q.key?.mark_scheme_md || null });
  }
}
// topicIdFor(name) maps a bank topic ("Algebra") to the tutor's own topic in that subject, for progress
export async function assignmentFromBank(rows, { title, kind = 'homework', subject_id = null, topicIdFor = () => null }) {
  const a = await save('assignments', { title, kind, subject_id, visibility: 'hidden' });
  await addQuestionsToAssignment(a.id, rows.map((b) => ({ ...bankToQuestion(b), topic_id: topicIdFor(b.topic) })));
  await sb().rpc('bank_used', { p_ids: rows.map((r) => r.id) });
  return a;
}
export const bankUsed = (ids) => sb().rpc('bank_used', { p_ids: ids });
// Practice for one learner: auto-marked questions, any number of tries, answers shown straight away
export async function practiceFromBank(rows, { learnerId, title, subject_id = null, topicIdFor = () => null }) {
  const a = await save('assignments', {
    title, kind: 'quiz', practice: true, subject_id, learner_ids: [learnerId], visibility: 'hidden',
    max_attempts: 50, release_mode: 'on_submit', show_answers: true, time_limit_min: null, lockdown: false, camera: false, allow_notes: true,
  });
  await addQuestionsToAssignment(a.id, rows.map((b) => ({ ...bankToQuestion(b), topic_id: topicIdFor(b.topic) })));
  await sb().rpc('bank_used', { p_ids: rows.map((r) => r.id) });
  // only now does the learner see it, complete
  return save('assignments', { id: a.id, visibility: 'visible' });
}
export async function saveQuestionsToBank(qs, { subject_id = null, topicName = () => null, ref = null } = {}) {
  const rows = qs.map((q) => ({
    owner_id: uid(),
    status: 'approved',
    subject_id,
    topic: topicName(q.topic_id) || null,
    type: q.type,
    prompt_md: q.prompt_md || '',
    image_path: q.image_path || null,
    options: q.type === 'mcq' ? q.options : [],
    marks: Number(q.marks) || 0,
    answer: q.key?.answer || {},
    mark_scheme_md: q.key?.mark_scheme_md || null,
    solution_md: q.key?.solution_md || null,
    source: 'tutor',
    source_ref: ref,
  }));
  return run(sb().from('bank_questions').insert(rows).select());
}

// ---------------- parent accounts (read-only) ----------------
// Parent codes are 'P' + 10 letters/numbers; learner codes are 10. One "join with a code" for both.
export const isParentCode = (code) => /^P[0-9A-F]{10}$/i.test(String(code || '').trim());
export const acceptParentInvite = (code, name) => run(sb().rpc('accept_parent_invite', { p_code: code, p_name: name, p_timezone: timezone() }));
export const joinWithCode = (code, name) => (isParentCode(code) ? acceptParentInvite(code, name) : acceptInvite(code, name));

// Students on their own (launch 1): a 7-day trial, a guided setup, and the Owner's tools for them
export async function startSelfLearner(name, grade, country, parentCode = null) {
  const p = await run(sb().rpc('start_self_learner', { p_name: name, p_grade: grade, p_country: country, p_timezone: timezone(), p_parent_code: parentCode || null }));
  // a wrong code from a parent is counted on the server, so it comes back empty rather than as an error
  if (!p?.id) throw new Error('That code from your parent isn’t right. Check it with them: it’s 8 digits.');
  return p;
}
// Launch 1, part 3: the starting check, exam conditions, parents for children studying on their own, test students
export const startCheck = (subjectId) => run(sb().rpc('start_practice', { p_mode: 'check', p_subject: subjectId }));
export const myStartingChecks = () => run(sb().rpc('my_starting_checks'));
export const noteLeftFullScreen = (attemptId) => run(sb().rpc('note_left_full_screen', { p_attempt: attemptId }));
export const startParent = (name) => run(sb().rpc('start_parent', { p_name: name, p_timezone: timezone() }));
export const parentChildCode = (name, grade) => run(sb().rpc('parent_child_code', { p_name: name, p_grade: grade }));
export const parentChildCodes = () => run(sb().rpc('parent_child_codes'));
export const parentCancelChildCode = (id) => run(sb().rpc('parent_cancel_child_code', { p_id: id }));
export const parentDeleteChild = (learnerId, confirm) => run(sb().rpc('parent_delete_child', { p_learner: learnerId, p_confirm: confirm }));
export const selfParentInvite = (name) => run(sb().rpc('self_parent_invite', { p_name: name || null }));
export const adminSetTestEmails = (emails) => run(sb().rpc('admin_set_test_emails', { p_emails: emails }));
// Daily study reminder (learners): the time, and this device's browser notifications (web push)
export const myStudyReminder = (endpoint = null) => run(sb().rpc('my_study_reminder', { p_endpoint: endpoint }));
export const setStudyReminder = (on, time) => run(sb().rpc('set_study_reminder', { p_on: on, p_time: time || null }));
export const savePushSubscription = (s) => run(sb().rpc('save_push_subscription', { p_endpoint: s.endpoint, p_p256dh: s.keys?.p256dh || null, p_auth: s.keys?.auth || null }));
export const sendTestReminder = () => run(sb().rpc('send_test_reminder'));
// StudyBridge's public push key; Prof makes it the first time anyone needs it
export async function pushKey() {
  const k = await run(sb().rpc('push_key'));
  return k || (await callProf('push_key'))?.key || null;
}
export const selfSetup = (o) =>
  run(sb().rpc('self_setup', { p_board: o.board, p_level: o.level, p_subjects: o.subjects, p_exam_date: o.examDate, p_exam_label: o.examLabel || null, p_hours: o.hours }));
export const setSubjectLive = (id, live) => run(sb().from('subjects').update({ live }).eq('id', id));
export const adminStudents = () => run(sb().rpc('admin_students'));
export const adminSetContentAccount = (email) => run(sb().rpc('admin_set_content_account', { p_email: email }));
export const adminSeedCatalogue = (items) => run(sb().rpc('admin_seed_catalogue', { p_items: items }));
export const adminStudentsOpen = (open) => run(sb().rpc('admin_students_open', { p_open: open }));
export const adminSetStudentPaid = (id, plan, until) => run(sb().rpc('admin_set_student_paid', { p_user: id, p_plan: plan, p_until: until }));
export const adminExtendTrial = (id, days = 7) => run(sb().rpc('admin_extend_trial', { p_user: id, p_days: days }));
// StudyBridge's own content: students report problems, the Owner sorts them (Admin → Content), pay-by-card links
export const reportContent = (kind, id, message) => run(sb().rpc('report_content', { p_kind: kind, p_id: id, p_message: message }));
export const adminContentReview = () => run(sb().rpc('admin_content_review'));
export const adminContentDecide = (kind, id, action, fix = null) => run(sb().rpc('admin_content_decide', { p_kind: kind, p_id: id, p_action: action, p_fix: fix }));
// Everything StudyBridge has made: kind 'question' | 'lesson' | 'card' | 'practice_paper'; status 'live' | 'waiting' | 'problems' | 'hidden'
export const adminContentBrowse = ({ subject = null, kind = null, status = null, search = '', limit = 100 } = {}) =>
  run(sb().rpc('admin_content_browse', { p_subject: subject || null, p_kind: kind || null, p_status: status || null, p_search: search.trim() || null, p_limit: limit }));
export const adminReportDone = (id, reply = null) => run(sb().rpc('admin_report_done', { p_report: id, p_reply: reply }));
export const adminSetPayLinks = (monthly, pass) => run(sb().rpc('admin_set_pay_links', { p_monthly: monthly, p_pass: pass }));
export const studentPayLinks = () => run(sb().rpc('student_pay_links'));
// Basic fixes: let a learner carry on after handing in, skip or withdraw a weekly report, clear own practice, a parent unlinks
export const reopenAttempt = (id) => run(sb().rpc('reopen_attempt', { p_attempt: id }));
export const skipReport = (id) => run(sb().rpc('skip_report', { p_report: id }));
export const withdrawReport = (id) => run(sb().rpc('withdraw_report', { p_report: id }));
export const hideMyPractice = (ids) => run(sb().rpc('hide_my_practice', { p_ids: ids }));
export const parentUnlink = (learnerId) => run(sb().rpc('parent_unlink', { p_learner: learnerId }));
export const learnerMistakeCards = (learnerId) =>
  run(sb().from('cards').select('id,front_md,created_at').eq('learner_id', learnerId).eq('source', 'mistake').order('created_at', { ascending: false }).limit(60));
export const createParentInvite = (learnerId, name) => run(sb().rpc('create_parent_invite', { p_learner: learnerId, p_name: name || null }));
export const revokeParentInvite = (id) => run(sb().rpc('revoke_parent_invite', { p_invite: id }));
export const learnerParents = (learnerId = null) => run(sb().rpc('learner_parents', { p_learner: learnerId }));
export const removeParent = (linkId) => run(sb().rpc('remove_parent', { p_link: linkId }));
export const myParentCounts = () => run(sb().rpc('my_parent_counts')).catch((e) => (e.offline ? Promise.reject(e) : {}));
export const parentChildren = () => run(sb().rpc('parent_children'));
export const parentView = (learnerId) => run(sb().rpc('parent_view', { p_learner: learnerId }));

// ---------------- weekly parent reports ----------------
export const listLearnerReports = () => run(sb().from('learner_reports').select('*'));
export const listParentReports = () => run(sb().from('parent_reports').select('*').order('week_start', { ascending: false }).limit(500));
export const setParentReports = (on, name, phone, email) => run(sb().rpc('set_parent_reports', { p_on: on, p_name: name || null, p_phone: phone || null, p_email: email || null }));
export const setLearnerExam = (learner, name, date) => run(sb().rpc('set_learner_exam', { p_learner: learner, p_name: name || null, p_date: date || null }));
// Draft (or refresh the numbers of) a learner's report for one week
export async function draftReport(learnerId, from, to) {
  const data = await run(sb().rpc('report_numbers', { p_learner: learnerId, p_from: from.toISOString(), p_to: to.toISOString() }));
  const week = ymdLocal(from);
  const existing = await run(sb().from('parent_reports').select('*').eq('learner_id', learnerId).eq('week_start', week).maybeSingle());
  if (existing) {
    if (existing.status === 'sent') return existing;
    return run(sb().from('parent_reports').update({ data, updated_at: new Date().toISOString() }).eq('id', existing.id).select().maybeSingle());
  }
  return run(sb().from('parent_reports').insert({ learner_id: learnerId, week_start: week, data }).select().maybeSingle());
}
const ymdLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export async function profReport(id) {
  const r = await run(sb().rpc('prof_report', { p_report: id }));
  callProf().catch(() => {});
  return r;
}
export const saveReport = (id, patch) => run(sb().from('parent_reports').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select().maybeSingle());
export const markReportSent = (id, via) => saveReport(id, { status: 'sent', sent_via: via, sent_at: new Date().toISOString() });

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
  if (path.startsWith('local/')) throw new Error('This paper is kept on the computer it was imported on. Open it there, or import it on this device too.');
  if (path.startsWith('link/')) throw new Error('This is a saved link, not a file.');
  const { data, error } = await sb().storage.from(bucket).download(path);
  if (error) {
    const hit = await store.blobs.get(key);
    if (hit) return hit;
    throw new Error(isOffline(error) ? 'This file isn’t saved on this device yet. Open it once while online.' : 'Couldn’t open this file.');
  }
  await store.blobs.set(key, data);
  return data;
}
// A short-lived link to a stored file (data saver reads PDFs from it a page at a time)
export const signedUrl = (bucket, path) => run(sb().storage.from(bucket).createSignedUrl(path, 3600)).then((d) => d?.signedUrl);
export async function isSavedOffline(bucket, path) {
  return !!(await store.blobs.get(`${bucket}/${path}`));
}

// ---------------- lessons ----------------
export const listLessons = () => {
  const as = asLearner();
  const rows = run(sb().from('lessons').select('*').order('created_at', { ascending: false }));
  return as ? rows.then((r) => seenBy(as, r)) : rows;
};

// ---------------- assignments ----------------
export const listAssignments = () => {
  const as = asLearner();
  const rows = run(sb().from('assignments').select('*').order('created_at', { ascending: false }));
  return as ? rows.then((r) => seenBy(as, r)) : rows;
};
export const getAssignment = (id) => run(sb().from('assignments').select('*').eq('id', id).maybeSingle());
export const listQuestions = (aid) => run(sb().from('questions').select('*').eq('assignment_id', aid).order('position'));
export const listKeys = (qids) => (qids.length ? run(sb().from('question_keys').select('*').in('question_id', qids)) : []);
export const saveKey = (key) => run(sb().from('question_keys').upsert(key, { onConflict: 'question_id' }));

export async function duplicateAssignment(a) {
  // a copy never joins the original's mock exam
  const { id, created_at, updated_at, mock_id, mock_position, ...rest } = a;
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

// ---------------- mock exams and grade boundaries ----------------
// Boundaries are private to the tutor; learners only ever get their grade from the server.
export const listMocks = () => run(sb().from('mocks').select('*').order('created_at', { ascending: false }));
export const saveMock = (row) => save('mocks', row);
export const deleteMock = (id) => remove('mocks', id);
export const mockResults = (id) => run(sb().rpc('mock_results', { p_mock: id }));
export const myMocks = () => run(sb().rpc('my_mocks'));
export const mockHistory = (learnerId = null) => run(sb().rpc('mock_history', { p_learner: learnerId }));
export const setMockPapers = async (mockId, ids, removed = []) => {
  for (const [i, id] of ids.entries()) await run(sb().from('assignments').update({ mock_id: mockId, mock_position: i + 1 }).eq('id', id));
  for (const id of removed) await run(sb().from('assignments').update({ mock_id: null }).eq('id', id));
};
export const listBoundaries = () => run(sb().from('grade_boundaries').select('*').order('created_at', { ascending: false }));
export const saveBoundaries = (row) => save('grade_boundaries', row);
export const deleteBoundaries = (id) => remove('grade_boundaries', id);
// Pictures of the tutor's own grade-threshold PDF go to their private folder; Prof copies the numbers out
export async function profBoundaries(exam, label, blob) {
  const { renderPdfPages } = await import('../ui/PdfViewer.jsx');
  const r = await renderPdfPages(blob, [1, 2, 3, 4], { maxSide: 1700, quality: 0.85 });
  if (!r.pages.length) throw new Error('Couldn’t open that PDF.');
  const pages = [];
  for (const p of r.pages) {
    const path = `${uid()}/prof/${uuid()}.jpg`;
    await run(sb().storage.from('library').upload(path, await p.blob.arrayBuffer(), { contentType: 'image/jpeg' }));
    pages.push({ path, label: `page ${p.page}` });
  }
  const job = await run(sb().rpc('prof_boundaries', { p_exam: exam, p_label: label || '', p_pages: pages }));
  callProf().catch(() => {});
  return job;
}

// ---------------- attempts (tutor) ----------------
export const listAttempts = () => run(sb().from('attempts').select('*').order('started_at', { ascending: false }).limit(500));
export const attemptDetail = (id) => run(sb().rpc('attempt_detail', { p_attempt: id }));
export const updateResponse = (id, patch) => run(sb().from('responses').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id));
// Drawings handed in without a picture (older apps, or handed in automatically): make the pictures here
export async function ensureDrawingPictures(detail, questions) {
  const { strokesPicture } = await import('../ui/DrawingPad.jsx');
  let made = 0;
  for (const r of detail?.responses || []) {
    const q = (questions || []).find((x) => x.id === r.question_id);
    if (q?.type !== 'drawing' || !r.answer?.strokes?.length || r.answer.image || r.answer.blank) continue;
    const pic = await strokesPicture(r.answer.strokes);
    if (!pic) {
      // nothing really drawn: mark it blank so it shows as no answer and Prof isn't asked about it
      await run(sb().from('responses').update({ answer: { ...r.answer, blank: true } }).eq('id', r.id));
      made++;
      continue;
    }
    const path = `${detail.attempt.learner_id}/${detail.attempt.id}/${q.id}-drawing.png`;
    await run(sb().storage.from('work').upload(path, await pic.arrayBuffer(), { contentType: 'image/png', upsert: true }));
    await run(sb().from('responses').update({ answer: { ...r.answer, image: path } }).eq('id', r.id));
    made++;
  }
  return made;
}
export const finishMarking = (id, release, feedback, redo = false) =>
  run(sb().rpc('finish_marking', { p_attempt: id, p_release: release, p_feedback: feedback ?? null, p_redo: !!redo }));
export async function uploadAnnotation(learnerId, attemptId, questionId, blob) {
  const path = `${learnerId}/${attemptId}/${questionId}-marked-${Date.now()}.png`;
  await run(sb().storage.from('work').upload(path, await blob.arrayBuffer(), { contentType: 'image/png', upsert: true }));
  await store.blobs.set(`work/${path}`, blob);
  return path;
}

// ---------------- attempts (learner) ----------------
export const myAttempts = (aid = null) => {
  const as = asLearner();
  return as ? attemptsSeenBy(as, aid) : run(sb().rpc('my_attempts', { p_assignment: aid }));
};
// which device it's done on (the tutor sees it; watched mode on anything that isn't the desktop app)
export function deviceName() {
  if (window.studybridge) return 'desktop';
  const ua = navigator.userAgent || '';
  const ipad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); // (iPads say they're Macs)
  return /CrOS/.test(ua) ? 'Chromebook' : ipad ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? 'Android' : 'browser';
}
export const startAttempt = (aid) => run(sb().rpc('start_attempt', { p_assignment: aid, p_client: deviceName() }));
// A tutor pauses (or unpauses) one of their own learners: their work stays, they don't count on the plan
export const pauseLearner = (id, paused = true) => run(sb().rpc('pause_learner', { p_learner: id, p_paused: paused }));

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
  previewOpen() ? Promise.resolve(null) : sendOrQueue({ kind: 'rpc', fn: 'log_time', args: { p_kind: kind, p_ref: ref, p_seconds: Math.round(seconds) } }).catch(() => {});
// A try to leave a locked-down exam: the server counts it, and hands the exam in after the tutor's warnings
export const lockdownStrike = (attemptId, event) => run(sb().rpc('lockdown_strike', { p_attempt: attemptId, p_event: event }));
// Watched mode: the page is still there (every 30 seconds)
export const watchSeen = (attemptId) => run(sb().rpc('watch_seen', { p_attempt: attemptId }));
// The tutor ends an exam early: 'hand_in' now, or 'cancel' so it can be started again
export const endAttempt = (attemptId, mode) => run(sb().rpc('end_attempt', { p_attempt: attemptId, p_mode: mode }));
export const logLockdown = (attemptId, event) =>
  sendOrQueue({ kind: 'rpc', fn: 'log_lockdown_event', args: { p_attempt: attemptId, p_event: event } }).catch(() => {});

// ---------------- notes & messages ----------------
// (seen as a learner: their messages stay private, so none)
export const listComments = () => (asLearner() ? Promise.resolve([]) : run(sb().from('comments').select('*').order('created_at', { ascending: true }).limit(2000)));
export async function sendComment(row) {
  const full = { author_id: uid(), ...row };
  if (me.role === 'learner') return sendOrQueue({ kind: 'insert', table: 'comments', row: full });
  return run(sb().from('comments').insert(full));
}
export const markCommentsRead = (ids) => (ids.length && !previewOpen() ? run(sb().rpc('mark_comments_read', { p_ids: ids })) : null);

// ---------------- notifications ----------------
export const listNotifications = () => run(sb().from('notifications').select('*').order('created_at', { ascending: false }).limit(100));
export const markNotificationsRead = (ids) =>
  ids.length ? run(sb().from('notifications').update({ read_at: new Date().toISOString() }).in('id', ids)) : null;

// ---------------- sessions / live ----------------
// Skipped lessons are left out everywhere except the tutor's Live page (sessions:all)
export const listSessions = () => {
  const as = asLearner();
  return run(sb().from('sessions').select('*').order('starts_at')).then((rows) => (rows || []).filter((s) => !s.cancelled && (!as || (s.learner_ids || []).includes(as))));
};
export const listAllSessions = () => run(sb().from('sessions').select('*').order('starts_at'));
// Weekly lessons (empty until the 1.6 server update is in)
export const listSeries = () => run(sb().from('lesson_series').select('*').order('created_at')).catch((e) => (e.offline ? Promise.reject(e) : []));
const seriesArgs = (s) => ({
  p_title: s.title,
  p_first: s.starts_at,
  p_duration: Number(s.duration_min) || 60,
  p_learner_ids: s.learner_ids,
  p_timezone: timezone(),
  p_until: s.until || null,
  p_notes: s.notes_md || null,
  p_class: s.class_id || null,
});
export const createSeries = (s) => run(sb().rpc('create_lesson_series', seriesArgs(s)));
export const changeSeries = (id, s, from = null) => run(sb().rpc('change_lesson_series', { p_series: id, ...seriesArgs(s), p_from: from }));
export const endSeries = (id) => run(sb().rpc('end_lesson_series', { p_series: id }));
export const skipLesson = (id, skip = true) => run(sb().rpc('skip_lesson', { p_session: id, p_skip: skip }));
export const myPhoneAlerts = (enabled = null) => run(sb().rpc('my_phone_alerts', { p_enabled: enabled }));
export const livePass = (room) => run(sb().rpc('live_pass', { p_room: room }));
export const liveStatus = () => run(sb().rpc('live_status'));
export const setLiveKeys = (url, key, secret) => run(sb().rpc('set_live_keys', { p_url: url, p_key: key, p_secret: secret }));

// ---------------- progress ----------------
export const learnerProgress = (id) => run(sb().rpc('learner_progress', { p_learner: id }));
export const learnerSummary = (id, from, to) => run(sb().rpc('learner_summary', { p_learner: id, p_from: from.toISOString(), p_to: to.toISOString() }));
export const listActivity = () => {
  const as = asLearner();
  let q = sb().from('activity').select('learner_id,seconds,day,subject_id').order('day', { ascending: false }).limit(5000);
  if (as) q = q.eq('learner_id', as);
  return run(q);
};

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

// ---------------- StudyBridge admin (account details only) ----------------
export const isAdmin = () => run(sb().rpc('is_platform_admin'));
export const adminToMove = () => run(sb().rpc('admin_to_move'));
export const adminMoveTo = (email) => run(sb().rpc('admin_move_to', { p_email: email }));
export const adminInvited = () => run(sb().rpc('admin_invited'));
export const claimAdmin = () => run(sb().rpc('claim_admin'));

export const adminTutors = () => run(sb().rpc('admin_tutors'));
export const adminAccounts = (tutorId) => run(sb().rpc('admin_accounts', { p_tutor: tutorId || null }));
export const adminSetStatus = (id, status) => run(sb().rpc('admin_set_status', { p_user: id, p_status: status }));
export const adminSetPlan = (id, plan, limitCents, learners = null, until = null) =>
  run(sb().rpc('admin_set_plan', { p_user: id, p_plan: plan, p_ai_limit_cents: limitCents ?? null, p_learners: learners ?? null, p_until: until || null }));
export const adminSetPassword = (id, password) => run(sb().rpc('admin_set_password', { p_user: id, p_password: password }));
export async function adminDeleteAccount(id) {
  const r = await run(sb().rpc('admin_delete_account', { p_user: id }));
  // the server removes the files that belonged to the account
  callProf('cleanup').catch(() => {});
  return r;
}
export const adminSettings = () => run(sb().rpc('admin_settings'));
export const adminOverview = () => run(sb().rpc('admin_overview'));
export const adminProf = () => run(sb().rpc('admin_prof'));
export const adminSetProfSmallModel = (model) => run(sb().rpc('admin_set_prof_small_model', { p_model: model }));
// "Change this part": Prof changes one question, or just its mark scheme ('question' | 'scheme')
export const profRevise = (questionId, part, instruction) => run(sb().rpc('prof_revise', { p_question: questionId, p_part: part, p_instruction: instruction }));
export const adminSetProfCredit = (balanceCents, lowCents = null) => run(sb().rpc('admin_set_prof_credit', { p_balance_cents: balanceCents, p_low_cents: lowCents }));
export const adminTutor = (id) => run(sb().rpc('admin_tutor', { p_user: id }));
export const adminSetNote = (id, body) => run(sb().rpc('admin_set_note', { p_user: id, p_body: body }));
export const adminErrors = () => run(sb().rpc('admin_errors'));
export const adminResolveError = (id, resolved = true) => run(sb().rpc('admin_resolve_error', { p_id: id, p_resolved: resolved }));
export const adminFeedback = () => run(sb().rpc('admin_feedback'));
export const adminReplyFeedback = (id, reply, close = true) => run(sb().rpc('admin_reply_feedback', { p_id: id, p_reply: reply, p_close: close }));
export const adminAnnounce = (title, body, audience, until) => run(sb().rpc('admin_announce', { p_title: title, p_body: body, p_audience: audience, p_until: until || null }));
export const adminEndAnnouncement = (id) => run(sb().rpc('admin_end_announcement', { p_id: id }));
export const adminEditAnnouncement = (id, title, body, audience, until) =>
  run(sb().rpc('admin_edit_announcement', { p_id: id, p_title: title, p_body: body, p_audience: audience, p_until: until || null }));
export const adminDeleteAnnouncement = (id) => run(sb().rpc('admin_delete_announcement', { p_id: id }));
export const adminSetMinVersion = (v) => run(sb().rpc('admin_set_min_version', { p_version: v || null }));
export const listAnnouncements = () => run(sb().from('announcements').select('*').order('created_at', { ascending: false }).limit(50));
export const sendFeedback = (kind, body) => run(sb().rpc('send_feedback', { p_kind: kind, p_body: body, p_version: appVersion() }));
export const myFeedback = () => run(sb().from('feedback').select('*').order('created_at', { ascending: false }).limit(30));
export const appConfig = () => run(sb().from('app_config').select('min_version').eq('id', 1).maybeSingle());
export function appVersion() {
  return import.meta.env?.VITE_APP_VERSION || desktop?.version || null;
}
export function platformName() {
  if (desktop) return `desktop ${navigator.userAgent.includes('Mac') ? 'Mac' : navigator.userAgent.includes('Windows') ? 'Windows' : 'Linux'}`;
  const ua = navigator.userAgent;
  return /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Android/.test(ua) ? 'Android' : 'browser';
}
export const markSeen = () => run(sb().rpc('seen', { p_version: appVersion() || 'dev', p_platform: platformName() }));
export const adminSetSignups = (open) => run(sb().rpc('admin_set_signups', { p_open: open }));
export const adminSetProf = ({ key, model, defaultLimitCents }) =>
  run(sb().rpc('admin_set_prof', { p_key: key || null, p_model: model || null, p_default_limit_cents: defaultLimitCents ?? null }));
export const adminSetLivekit = (url, key, secret) => run(sb().rpc('admin_set_livekit', { p_url: url, p_key: key, p_secret: secret }));
export const adminLog = () => run(sb().from('admin_log').select('*').order('at', { ascending: false }).limit(200));

// ---------------- Prof (the AI assistant, tutors only) ----------------
// Wakes the Prof server. The database also does this by itself; this makes it instant.
export async function callProf(action = 'kick', extra = {}) {
  const s = getServer();
  const { data } = await sb().auth.getSession();
  const token = data.session?.access_token;
  if (!s || !token) return null;
  const r = await fetch(`${s.url}/functions/v1/prof`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', apikey: s.key, authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...extra }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || (r.status === 404 ? 'The Prof server isn’t installed yet.' : `Prof server error ${r.status}`));
  return body;
}
const JOB_COLS = 'id,kind,status,prompt,attempt_id,result,progress,error,created_at,updated_at,finished_at,context';
export const profJobs = () => run(sb().from('prof_jobs').select(JOB_COLS).order('created_at', { ascending: false }).limit(40));
export const profJob = (id) => run(sb().from('prof_jobs').select(JOB_COLS).eq('id', id).maybeSingle());
// Every request ever made, newest first, a page at a time (Prof → History)
export function profHistory({ kinds = null, text = '', before = null, limit = 30 } = {}) {
  let q = sb().from('prof_jobs').select(JOB_COLS).order('created_at', { ascending: false }).limit(limit);
  if (kinds?.length) q = q.in('kind', kinds);
  const words = text.replace(/[%_*,()]/g, ' ').trim();
  if (words) q = q.ilike('prompt', `%${words}%`);
  if (before) q = q.lt('created_at', before);
  return run(q);
}
export const profUsage = () => run(sb().rpc('prof_usage'));

// ---------------- self-study: flashcards, practice, notes, goal ----------------
export const listCards = () => run(sb().from('cards').select('*').order('created_at', { ascending: true }).limit(5000));
export const myReviews = () => run(sb().from('card_reviews').select('*').eq('learner_id', uid()).limit(5000));
export const reviewCard = (cardId, grade) => run(sb().rpc('review_card', { p_card: cardId, p_grade: grade }));
export const syncMistakeCards = () => run(sb().rpc('sync_mistake_cards'));
export const addCards = (rows) => run(sb().from('cards').insert(rows.map((r) => ({ tutor_id: uid(), source: 'tutor', ...r }))).select());
export const addOwnCard = (row) => run(sb().from('cards').insert({ ...row, source: 'own', learner_id: uid(), created_by: uid(), tutor_id: me?.tutor_id }).select().maybeSingle());
export const profCards = (subjectId, topic, count = 12, note = '') =>
  run(sb().rpc('prof_cards', { p_subject: subjectId, p_topic: topic, p_count: count, p_note: note || null })).then((r) => (callProf().catch(() => {}), r));
export const startPractice = (mode, { subject = null, topic = null, count = 5, minutes = null } = {}) =>
  run(sb().rpc('start_practice', { p_mode: mode, p_subject: subject, p_topic: topic, p_count: count, p_minutes: minutes }));
export const practiceTopics = () => run(sb().rpc('practice_topics'));
export const studySummary = (learnerId = null) => run(sb().rpc('study_summary', { p_learner: learnerId || asLearner() }));
export const setStudyGoal = (minutes) => run(sb().rpc('set_study_goal', { p_minutes: minutes }));
export const myTopics = () => run(sb().rpc('my_topics'));
export const getStudyNotes = (learnerId = null) => run(sb().from('study_notes').select('*').eq('learner_id', learnerId || uid()));
export const saveStudyNotes = (subjectId, body) =>
  run(sb().from('study_notes').upsert({ learner_id: uid(), subject_id: subjectId, body_md: body, updated_at: new Date().toISOString() }, { onConflict: 'learner_id,subject_id' }));
export const logStudy = (seconds, subjectId = null) => logTime('study', subjectId, seconds);
export async function calendarLink(reset = false) {
  const token = await run(sb().rpc('my_calendar_token', { p_reset: reset }));
  const s = getServer();
  return s && token ? `${s.url}/functions/v1/prof?calendar=${token}` : null;
}
// ---------------- StudyBridge practice papers (made on the content account, checked twice) ----------------
// For one exam ('cie:0607'): the papers that are up, with their questions, answers and mark schemes (tutors only)
export const studybridgePapers = (exam) => run(sb().rpc('studybridge_papers', { p_exam: exam }));
// A copy as a draft test of the tutor's own (they check it, then give it to learners); gives the new test's id
export const copyStudybridgePaper = (id) => run(sb().rpc('copy_studybridge_paper', { p_assignment: id }));
export const saveSelfMarks = (attemptId, marks) => run(sb().rpc('save_self_marks', { p_attempt: attemptId, p_marks: marks }));

// ---------------- syllabus & coverage ----------------
export const profSyllabus = (subjectId, label, note = '') => run(sb().rpc('prof_syllabus', { p_subject: subjectId, p_label: label, p_note: note || null })).then((r) => (callProf().catch(() => {}), r));
// Prof reads the tutor's own syllabus PDF: its text (or, for a scanned one, pictures of its pages)
export async function profSyllabusFromPdf(subjectId, blob, name, label = '', note = '') {
  const { pdfAllText, renderPdfPages } = await import('../ui/PdfViewer.jsx');
  const { text } = await pdfAllText(blob);
  let source;
  if (text.replace(/\[page \d+\]|\s/g, '').length > 800) {
    const path = `${uid()}/prof/${uuid()}.txt`;
    await run(sb().storage.from('library').upload(path, new Blob([text], { type: 'text/plain' }), { contentType: 'text/plain' }));
    source = { text_path: path, name };
  } else {
    // no text in it (a scan): pictures of its first pages
    const r = await renderPdfPages(blob, Array.from({ length: 16 }, (_, i) => i + 1), { maxSide: 1500, quality: 0.8 });
    const pages = [];
    for (const p of r.pages) {
      const path = `${uid()}/prof/${uuid()}.jpg`;
      await run(sb().storage.from('library').upload(path, await p.blob.arrayBuffer(), { contentType: 'image/jpeg' }));
      pages.push({ path, label: `page ${p.page}` });
    }
    if (!pages.length) throw new Error('Couldn’t open that PDF.');
    source = { pages, name };
  }
  const r = await run(sb().rpc('prof_syllabus', { p_subject: subjectId, p_label: label || '', p_note: note || null, p_source: source }));
  callProf().catch(() => {});
  return r;
}
// Teaching plans: one per subject, by week, month or chapter
export const getPlan = (subjectId) => run(sb().from('teaching_plans').select('*').eq('subject_id', subjectId).maybeSingle());
export const savePlan = (row) => run(sb().from('teaching_plans').upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'subject_id' }).select().maybeSingle());
export const deletePlan = (subjectId) => run(sb().from('teaching_plans').delete().eq('subject_id', subjectId));
export const profPlan = (subjectId, kind, start, end, lessons = null, note = '') =>
  run(sb().rpc('prof_plan', { p_subject: subjectId, p_kind: kind, p_start: start, p_end: end, p_lessons: lessons, p_note: note || null })).then((r) => (callProf().catch(() => {}), r));
export const coverage = (subjectId) => run(sb().rpc('coverage', { p_subject: subjectId }));
// The tutor's own call on a topic for a learner: 'taught' | 'not_yet' | 'weak' | 'developing' | 'strong',
// or null to go back to what lessons, work and marked answers say
export async function setTopicState(learnerId, topicId, state) {
  if (state) return run(sb().from('taught_topics').upsert({ learner_id: learnerId, topic_id: topicId, tutor_id: uid(), state }, { onConflict: 'learner_id,topic_id' }));
  return run(sb().from('taught_topics').delete().eq('learner_id', learnerId).eq('topic_id', topicId));
}
export const setTaught = (learnerId, topicId, on) => setTopicState(learnerId, topicId, on ? 'taught' : null);
// Put a list of topics into a subject: adds the new ones, updates codes/details of ones with the same name.
// With reorder, the subject's topics then follow the list's order (the syllabus order); topics not in the
// list keep their order after them. Matching topics keep their id, so questions, flashcards and coverage stay.
export const topicKey = (name) => String(name || '').toLowerCase().replace(/^\s*(?:[a-z]{1,3}\s?)?\d+(?:\.\d+)*[a-z]?[.):]?\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
export async function applyTopics(subjectId, list, existing = [], { reorder = false } = {}) {
  const byName = new Map(existing.map((t) => [topicKey(t.name), t]));
  let pos = existing.reduce((m, t) => Math.max(m, t.position || 0), -1) + 1;
  const order = [];
  for (const t of list) {
    const old = byName.get(topicKey(t.name));
    if (old) {
      await run(sb().from('topics').update({ code: t.code || old.code || null, details: t.details?.length ? t.details : old.details || [] }).eq('id', old.id));
      if (!order.includes(old.id)) order.push(old.id);
    } else {
      const row = await run(sb().from('topics').insert({ subject_id: subjectId, name: t.name.trim(), code: t.code || null, details: t.details || [], position: pos++ }).select('id').maybeSingle());
      if (row?.id) order.push(row.id);
    }
  }
  if (!reorder) return;
  const rest = [...existing].sort((a, b) => (a.position || 0) - (b.position || 0)).map((t) => t.id).filter((id) => !order.includes(id));
  const was = new Map(existing.map((t) => [t.id, t.position]));
  for (const [i, id] of [...order, ...rest].entries()) if (was.get(id) !== i) await run(sb().from('topics').update({ position: i }).eq('id', id));
}
export const profSettings = () => run(sb().from('prof_settings').select('*').eq('tutor_id', uid()).maybeSingle());
export const saveProfSettings = (patch) =>
  run(sb().from('prof_settings').upsert({ tutor_id: uid(), ...patch, updated_at: new Date().toISOString() }, { onConflict: 'tutor_id' }));
export async function profAsk(prompt, { learnerIds = [], pages = [], books = [], replyTo = null } = {}) {
  // pages: [{ blob, label }] images of book pages, kept in the tutor's own library folder until Prof has read them
  // books: [{ file_id, name, pages, outline }] whole PDFs: Prof asks for the pages it needs
  const stored = [];
  for (const p of pages) {
    const path = `${uid()}/prof/${uuid()}.jpg`;
    await run(sb().storage.from('library').upload(path, await p.blob.arrayBuffer(), { contentType: p.blob.type || 'image/jpeg' }));
    stored.push({ path, label: p.label });
  }
  const r = await run(sb().rpc('prof_ask', { p_prompt: prompt, p_context: { learner_ids: learnerIds, pages: stored, books, ...(replyTo ? { reply_to: replyTo } : {}) } }));
  callProf().catch(() => {});
  return r;
}
// Prof asked to see pages of a book: open it here, take pictures of those pages and send them
export async function profProvidePages(job) {
  const need = job.result?.need_pages;
  if (!need) return;
  const f = (await listFiles()).find((x) => x.id === need.file_id);
  const out = [];
  if (f) {
    const { renderPdfPages } = await import('../ui/PdfViewer.jsx');
    const r = await renderPdfPages(await getBlob('library', f.storage_path), need.pages);
    for (const p of r.pages) {
      const path = `${uid()}/prof/${uuid()}.jpg`;
      await run(sb().storage.from('library').upload(path, await p.blob.arrayBuffer(), { contentType: 'image/jpeg' }));
      out.push({ path, label: `${f.name}, PDF page ${p.page}` });
    }
  }
  await run(sb().rpc('prof_pages', { p_job: job.id, p_pages: out }));
  callProf().catch(() => {});
}
export async function profMark(attemptId) {
  const r = await run(sb().rpc('prof_mark', { p_attempt: attemptId }));
  callProf().catch(() => {});
  return r;
}
export const profCancel = (id) => run(sb().rpc('prof_cancel', { p_job: id }));
export async function profRetry(id) {
  await run(sb().rpc('prof_retry', { p_job: id }));
  callProf().catch(() => {});
}
