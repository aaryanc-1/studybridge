// Checks the fake Supabase server behaves like the real API for the calls the app makes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { startFakeSupabase } from './fake-supabase.mjs';

let srv;
test.before(async () => {
  srv = await startFakeSupabase();
});
test.after(async () => {
  await srv.close();
});

const client = () => createClient(srv.url, srv.anonKey, { auth: { persistSession: false, autoRefreshToken: false }, realtime: { params: {} } });

test('supabase-js works against the fake server', async () => {
  const t = client();
  const su = await t.auth.signUp({ email: 'tutor@example.com', password: 'secret123', options: { data: { name: 'Aaryan' } } });
  assert.equal(su.error, null);
  assert.ok(su.data.session);
  const prof = await t.rpc('become_tutor', { p_name: 'Aaryan', p_timezone: 'America/New_York' });
  assert.equal(prof.error, null);
  assert.equal(prof.data.role, 'tutor');

  const s = await t.from('subjects').insert({ name: 'Mathematics' }).select().single();
  assert.equal(s.error, null);
  assert.equal(s.data.name, 'Mathematics');
  await t.from('subjects').insert([{ name: 'Physics' }, { name: 'Chemistry' }]);
  const list = await t.from('subjects').select('id,name').order('name');
  assert.deepEqual(list.data.map((x) => x.name), ['Chemistry', 'Mathematics', 'Physics']);
  const inq = await t.from('subjects').select('name').in('name', ['Physics', 'Chemistry']).order('name', { ascending: false });
  assert.deepEqual(inq.data.map((x) => x.name), ['Physics', 'Chemistry']);
  const upd = await t.from('subjects').update({ color: '#ff0000' }).eq('id', s.data.id).select();
  assert.equal(upd.data[0].color, '#ff0000');
  const nul = await t.from('subjects').select('name').is('color', null);
  assert.equal(nul.data.length, 2);
  const del = await t.from('subjects').delete().eq('name', 'Chemistry');
  assert.equal(del.error, null);
  const one = await t.from('subjects').select('*').eq('name', 'Nope').maybeSingle();
  assert.equal(one.data, null);

  const inv = await t.from('invites').insert({ name: 'Sis', subject_ids: [s.data.id] }).select().single();
  const l = client();
  await l.auth.signUp({ email: 'sis@example.com', password: 'secret123' });
  const acc = await l.rpc('accept_invite', { p_code: inv.data.code, p_name: 'Sis' });
  assert.equal(acc.error, null);
  assert.equal(acc.data.role, 'learner');
  const bad = await l.rpc('accept_invite', { p_code: 'NOPE', p_name: 'x' });
  assert.equal(bad.error, null);
  assert.equal(bad.data?.id ?? null, null, 'a wrong code joins nobody (the app says so)');

  // storage
  const bytes = new TextEncoder().encode('%PDF-1.4 fake');
  const tu = await t.auth.getUser();
  const path = `${tu.data.user.id}/files/book.pdf`;
  const up = await t.storage.from('library').upload(path, bytes, { contentType: 'application/pdf' });
  assert.equal(up.error, null);
  const dl = await t.storage.from('library').download(path);
  assert.equal(await dl.data.text(), '%PDF-1.4 fake');
  const denied = await l.storage.from('library').download(path);
  assert.ok(denied.error, 'hidden until a visible files row exists');
  await t.from('files').insert({ name: 'book.pdf', storage_path: path, visibility: 'visible' });
  const ok = await l.storage.from('library').download(path);
  assert.equal(ok.error, null);
  const sg = await t.storage.from('library').createSignedUrl(path, 60);
  const via = await fetch(sg.data.signedUrl);
  assert.equal(await via.text(), '%PDF-1.4 fake');

  // void + jsonb rpcs
  const lt = await l.rpc('log_time', { p_kind: 'file', p_ref: null, p_seconds: 30 });
  assert.equal(lt.error, null);
  const pr = await t.rpc('learner_progress', { p_learner: acc.data.id });
  assert.equal(pr.data.total_seconds, 30);
  const arr = await t.rpc('set_learner', { p_learner: acc.data.id, p_name: 'Sister', p_programme: null, p_subject_ids: [s.data.id] });
  assert.equal(arr.error, null);

  // sign in again
  const si = await client().auth.signInWithPassword({ email: 'sis@example.com', password: 'secret123' });
  assert.equal(si.error, null);
  const wrong = await client().auth.signInWithPassword({ email: 'sis@example.com', password: 'nope' });
  assert.match(wrong.error.message, /Invalid login/);
});
