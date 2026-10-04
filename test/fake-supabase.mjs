// A small stand-in for a Supabase project, used by the app tests.
// It runs the real supabase/setup.sql inside PGlite (Postgres in WASM) and
// answers the subset of the Auth / REST / Storage HTTP API the app uses, with
// every request executed under the caller's role so the real security rules apply.
import http from 'node:http';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';

const SETUP = readFileSync(new URL('../supabase/setup.sql', import.meta.url), 'utf8');

export const STUBS = `
create role authenticated nologin; create role anon nologin; create role service_role nologin bypassrls;
create schema auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text, raw_user_meta_data jsonb default '{}',
  encrypted_password text, email_confirmed_at timestamptz default now(), last_sign_in_at timestamptz, created_at timestamptz default now(),
  banned_until timestamptz);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb,
                  jsonb_build_object('sub', nullif(current_setting('request.jwt.claim.sub', true), ''))) $$;
grant usage on schema auth to authenticated, anon;
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid,
  metadata jsonb default '{}', created_at timestamptz default now(), unique (bucket_id, name));
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
grant usage on schema storage to authenticated, anon, service_role;
grant all on storage.objects to authenticated, service_role;
grant usage on schema auth to service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
grant usage on schema public to service_role;
`;

const IDENT = /^[a-z_][a-z0-9_]*$/;

// Authenticator-app codes (RFC 6238: SHA-1, 6 digits, 30 seconds), so tests can do two-step sign-in
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}
export function totp(secret, at = Date.now(), step = 0) {
  let bits = '';
  for (const c of secret.replace(/=+$/, '').toUpperCase()) bits += B32.indexOf(c).toString(2).padStart(5, '0');
  const key = Buffer.from((bits.match(/.{8}/g) || []).map((x) => parseInt(x, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30000) + step));
  const h = crypto.createHmac('sha1', key).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1000000).padStart(6, '0');
}
const reqCtx = new AsyncLocalStorage();
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

export async function startFakeSupabase({ port = 0, log = false, anthropicUrl = null } = {}) {
  const db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(STUBS);
  await db.exec(SETUP);
  const anonKey = 'fake-anon-key-for-local-testing-only';
  const serviceKey = 'fake-service-role-key-for-local-testing-only';
  const SERVICE = 'service';
  let prof = null; // the Prof edge function, loaded on first use
  const users = new Map(); // email -> { id, password, meta }
  const refresh = new Map(); // refresh token -> user id
  const files = new Map(); // bucket/path -> { bytes, type }
  const signed = new Map(); // token -> bucket/path
  let offline = false;
  let base = '';

  const colTypes = new Map();
  async function columns(table) {
    if (!colTypes.has(table)) {
      const r = await db.query(
        `select a.attname, format_type(a.atttypid, a.atttypmod) t from pg_attribute a
          where a.attrelid = ('public.' || $1)::regclass and a.attnum > 0 and not a.attisdropped`, [table]);
      colTypes.set(table, Object.fromEntries(r.rows.map((x) => [x.attname, x.t])));
    }
    return colTypes.get(table);
  }
  const fnInfo = new Map();
  async function fn(name) {
    if (!fnInfo.has(name)) {
      const r = await db.query(
        `select p.proretset, t.typtype, t.typname, p.proargnames,
                array(select format_type(x, null) from unnest(p.proargtypes) x) argtypes
           from pg_proc p join pg_type t on t.oid = p.prorettype join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = $1`, [name]);
      fnInfo.set(name, r.rows[0] || null);
    }
    return fnInfo.get(name);
  }

  function token(user, aal = 'aal1') {
    const now = Math.floor(Date.now() / 1000);
    const amr = [{ method: 'password', timestamp: now }, ...(aal === 'aal2' ? [{ method: 'totp', timestamp: now }] : [])];
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', aal, amr, iat: now, exp: now + 3600 })}.fakesig`;
  }
  function session(user, aal = 'aal1') {
    const rt = crypto.randomBytes(12).toString('hex');
    refresh.set(rt, { email: user.email, aal });
    return {
      access_token: token(user, aal), token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
      refresh_token: rt, user: userJson(user),
    };
  }
  function userJson(u) {
    const factors = (u.factors || []).map(({ secret, ...f }) => f);
    return { id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, user_metadata: u.meta || {}, app_metadata: { provider: 'email' },
      created_at: new Date().toISOString(), email_confirmed_at: new Date().toISOString(), ...(factors.length ? { factors } : {}) };
  }
  function claimsOf(req) {
    const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    try {
      return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
    } catch {
      return {};
    }
  }
  function caller(req) {
    const h = req.headers.authorization || '';
    const t = h.replace(/^Bearer\s+/i, '');
    if (!t || t === anonKey) return req.headers.apikey === serviceKey ? SERVICE : null;
    if (t === serviceKey) return SERVICE;
    try {
      const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
      if (p.exp < Date.now() / 1000) return null;
      return p.sub;
    } catch {
      return null;
    }
  }
  async function as(uid, fnc) {
    return db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid && uid !== SERVICE ? uid : '']);
      const aal = reqCtx.getStore()?.aal || 'aal1';
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [uid && uid !== SERVICE ? JSON.stringify({ sub: uid, role: 'authenticated', aal }) : '']);
      await tx.exec(`set local role ${uid === SERVICE ? 'service_role' : uid ? 'authenticated' : 'anon'}`);
      return fnc(tx);
    });
  }

  function pgLiteral(v, type) {
    if (v === null || v === undefined) return null;
    if (type.endsWith('[]')) {
      const arr = Array.isArray(v) ? v : [v];
      return '{' + arr.map((x) => (x === null ? 'NULL' : '"' + String(x).replace(/["\\]/g, '\\$&') + '"')).join(',') + '}';
    }
    if (type === 'jsonb' || type === 'json') return JSON.stringify(v);
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  function parseFilters(params, types, startIdx) {
    const where = [];
    const vals = [];
    for (const [k, raw] of params) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict', 'columns'].includes(k)) continue;
      if (!IDENT.test(k) || !(k in types)) throw Object.assign(new Error(`Unknown column ${k}`), { status: 400 });
      let v = raw;
      let neg = false;
      if (v.startsWith('not.')) { neg = true; v = v.slice(4); }
      const dot = v.indexOf('.');
      const op = v.slice(0, dot);
      const arg = v.slice(dot + 1);
      let cond;
      if (op === 'is') cond = `"${k}" is ${arg === 'null' ? 'null' : arg === 'true' ? 'true' : 'false'}`;
      else if (op === 'in') {
        const items = arg.replace(/^\(|\)$/g, '').split(',').filter(Boolean).map((s) => s.replace(/^"|"$/g, ''));
        vals.push(pgLiteral(items, types[k] + '[]'));
        cond = `"${k}" = any($${startIdx + vals.length - 1}::text::${types[k]}[])`;
      } else if (op === 'cs' || op === 'cd' || op === 'ov') {
        const items = arg.replace(/^\{|\}$/g, '').split(',').filter(Boolean);
        vals.push(pgLiteral(items, types[k]));
        cond = `"${k}" ${op === 'cs' ? '@>' : op === 'cd' ? '<@' : '&&'} $${startIdx + vals.length - 1}::text::${types[k]}`;
      } else {
        const sql = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'like', ilike: 'ilike' }[op];
        if (!sql) throw Object.assign(new Error(`Unsupported filter ${op}`), { status: 400 });
        vals.push(op === 'like' || op === 'ilike' ? arg.replace(/\*/g, '%') : arg);
        cond = op === 'like' || op === 'ilike' ? `"${k}"::text ${sql} $${startIdx + vals.length - 1}` : `"${k}" ${sql} $${startIdx + vals.length - 1}::text::${types[k]}`;
      }
      where.push(neg ? `not (${cond})` : cond);
    }
    return { where: where.length ? 'where ' + where.join(' and ') : '', vals };
  }
  function selectList(sel, types) {
    if (!sel || sel === '*') return '*';
    return sel.split(',').map((c) => {
      c = c.trim();
      if (!IDENT.test(c) || !(c in types)) throw Object.assign(new Error(`Unknown column ${c}`), { status: 400 });
      return `"${c}"`;
    }).join(', ');
  }
  function orderBy(o, types) {
    if (!o) return '';
    return 'order by ' + o.split(',').map((part) => {
      const [c, ...mods] = part.split('.');
      if (!(c in types)) throw Object.assign(new Error(`Unknown column ${c}`), { status: 400 });
      return `"${c}" ${mods.includes('desc') ? 'desc' : 'asc'}${mods.includes('nullsfirst') ? ' nulls first' : mods.includes('nullslast') ? ' nulls last' : ''}`;
    }).join(', ');
  }

  async function rest(req, url, body, uid) {
    const parts = url.pathname.split('/').filter(Boolean); // rest v1 table
    const params = [...url.searchParams.entries()];
    const prefer = req.headers.prefer || '';
    const wantObject = (req.headers.accept || '').includes('vnd.pgrst.object');
    if (parts[2] === 'rpc') {
      const info = await fn(parts[3]);
      if (!info) return [404, { message: `Function ${parts[3]} not found`, code: 'PGRST202' }];
      const args = body ? JSON.parse(body) : {};
      const names = info.proargnames || [];
      const vals = [];
      const list = [];
      for (const [k, v] of Object.entries(args)) {
        const i = names.indexOf(k);
        if (i < 0) return [404, { message: `Function ${parts[3]} has no argument ${k}`, code: 'PGRST202' }];
        vals.push(pgLiteral(v, info.argtypes[i]));
        list.push(`"${k}" := $${vals.length}::text::${info.argtypes[i]}`);
      }
      const call = `public."${parts[3]}"(${list.join(', ')})`;
      const rows = await as(uid, async (tx) => {
        if (info.typtype === 'c' || info.typname === 'record') return (await tx.query(`select * from ${call}`, vals)).rows;
        return (await tx.query(`select ${call} as v`, vals)).rows.map((r) => r.v);
      });
      if (info.proretset) return [200, rows];
      const one = rows[0] ?? null;
      if (info.typtype === 'c' && one && Object.values(one).every((x) => x === null)) return [200, null];
      return [200, one];
    }
    const table = parts[2];
    if (!IDENT.test(table)) return [404, { message: 'Not found' }];
    let types;
    try {
      types = await columns(table);
    } catch {
      return [404, { message: `Table ${table} not found`, code: '42P01' }];
    }
    const ret = prefer.includes('return=representation');
    const sel = selectList(url.searchParams.get('select'), types);
    let sql;
    let vals = [];
    if (req.method === 'GET' || req.method === 'HEAD') {
      const f = parseFilters(params, types, 1);
      vals = f.vals;
      const lim = url.searchParams.get('limit');
      const off = url.searchParams.get('offset');
      sql = `select ${sel} from public."${table}" ${f.where} ${orderBy(url.searchParams.get('order'), types)} ${lim ? 'limit ' + Number(lim) : ''} ${off ? 'offset ' + Number(off) : ''}`;
    } else if (req.method === 'POST') {
      const rowsIn = JSON.parse(body || '[]');
      const arr = Array.isArray(rowsIn) ? rowsIn : [rowsIn];
      const cols = [...new Set(arr.flatMap((r) => Object.keys(r)))];
      for (const c of cols) if (!(c in types)) return [400, { message: `Unknown column ${c}`, code: 'PGRST204' }];
      vals = [JSON.stringify(arr)];
      const collist = cols.map((c) => `"${c}"`).join(', ');
      let conflict = '';
      const oc = url.searchParams.get('on_conflict');
      if (prefer.includes('resolution=merge-duplicates')) {
        const target = oc ? oc.split(',').map((c) => `"${c}"`).join(', ') : '"id"';
        const upd = cols.filter((c) => !(oc || 'id').split(',').includes(c)).map((c) => `"${c}" = excluded."${c}"`);
        conflict = `on conflict (${target}) do ${upd.length ? 'update set ' + upd.join(', ') : 'nothing'}`;
      } else if (prefer.includes('resolution=ignore-duplicates')) {
        conflict = 'on conflict do nothing';
      }
      sql = `insert into public."${table}" (${collist}) select ${collist} from jsonb_populate_recordset(null::public."${table}", $1::jsonb) ${conflict} ${ret ? 'returning ' + sel : ''}`;
    } else if (req.method === 'PATCH') {
      const obj = JSON.parse(body || '{}');
      const cols = Object.keys(obj);
      for (const c of cols) if (!(c in types)) return [400, { message: `Unknown column ${c}`, code: 'PGRST204' }];
      const f = parseFilters(params, types, 2);
      vals = [JSON.stringify(obj), ...f.vals];
      const set = cols.map((c) => `"${c}" = r."${c}"`).join(', ');
      sql = `update public."${table}" t set ${set} from jsonb_populate_record(null::public."${table}", $1::jsonb) r ${f.where.replace(/"(\w+)"/g, 't."$1"')} ${ret ? 'returning ' + sel.split(', ').map((c) => (c === '*' ? 't.*' : 't.' + c)).join(', ') : ''}`;
    } else if (req.method === 'DELETE') {
      const f = parseFilters(params, types, 1);
      vals = f.vals;
      sql = `delete from public."${table}" ${f.where} ${ret ? 'returning ' + sel : ''}`;
    } else {
      return [405, { message: 'Method not allowed' }];
    }
    const rows = await as(uid, async (tx) => (await tx.query(sql, vals)).rows);
    if (req.method === 'POST' && !ret) return [201, null];
    if ((req.method === 'PATCH' || req.method === 'DELETE') && !ret) return [204, null];
    if (wantObject) {
      if (rows.length !== 1) return [406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `${rows.length} rows` }];
      return [200, rows[0]];
    }
    return [req.method === 'POST' ? 201 : 200, rows];
  }

  async function storage(req, url, raw, uid) {
    const p = decodeURIComponent(url.pathname).replace(/^\/storage\/v1\/object\//, '');
    const readable = async (bucket, name) =>
      (await as(uid, async (tx) => (await tx.query(`select 1 from storage.objects where bucket_id = $1 and name = $2`, [bucket, name])).rows)).length > 0;
    if (p.startsWith('sign/')) {
      const rest = p.slice(5);
      const bucket = rest.split('/')[0];
      const name = rest.slice(bucket.length + 1);
      if (req.method === 'GET') {
        const key = signed.get(url.searchParams.get('token'));
        const f = key && files.get(key);
        if (!f) return [400, { message: 'Invalid signature' }];
        return [200, f.bytes, f.type];
      }
      if (!(await readable(bucket, name))) return [400, { statusCode: '404', error: 'not_found', message: 'Object not found' }];
      const t = crypto.randomBytes(10).toString('hex');
      signed.set(t, `${bucket}/${name}`);
      return [200, { signedURL: `/object/sign/${bucket}/${name}?token=${t}` }];
    }
    const bucket = p.split('/')[0];
    const name = p.slice(bucket.length + 1);
    if (req.method === 'DELETE' && !name) {
      const { prefixes } = JSON.parse(raw.toString() || '{}');
      const rows = await as(uid, async (tx) => (await tx.query(`delete from storage.objects where bucket_id = $1 and name = any($2::text[]) returning name`, [bucket, prefixes])).rows);
      for (const r of rows) files.delete(`${bucket}/${r.name}`);
      return [200, rows.map((r) => ({ name: r.name, bucket_id: bucket }))];
    }
    if (req.method === 'POST' || req.method === 'PUT') {
      const upsert = req.headers['x-upsert'] === 'true' || req.method === 'PUT';
      try {
        await as(uid, async (tx) => {
          if (upsert) await tx.query(`delete from storage.objects where bucket_id = $1 and name = $2`, [bucket, name]);
          await tx.query(`insert into storage.objects (bucket_id, name, owner, metadata) values ($1, $2, $3, $4)`,
            [bucket, name, uid === SERVICE ? null : uid, { size: raw.length, mimetype: req.headers['content-type'] || null }]);
        });
      } catch (e) {
        if (/duplicate/.test(e.message)) return [400, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' }];
        return [400, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' }];
      }
      files.set(`${bucket}/${name}`, { bytes: raw, type: req.headers['content-type'] || 'application/octet-stream' });
      return [200, { Key: `${bucket}/${name}`, Id: crypto.randomUUID() }];
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const n = name.replace(/^authenticated\//, '');
      if (!(await readable(bucket, n))) return [400, { statusCode: '404', error: 'not_found', message: 'Object not found' }];
      const f = files.get(`${bucket}/${n}`);
      if (!f) return [400, { statusCode: '404', error: 'not_found', message: 'Object not found' }];
      return [200, f.bytes, f.type];
    }
    return [405, { message: 'Method not allowed' }];
  }

  async function banned(id) {
    if (!id) return false;
    const r = await db.query(`select banned_until > now() as b from auth.users where id = $1`, [id]);
    return !!r.rows[0]?.b;
  }

  // Supabase Edge Function "prof", run in-process (Claude is the stand-in at anthropicUrl)
  async function functions(req, url, raw) {
    if (url.pathname !== '/functions/v1/prof') return [404, { message: 'Function not found' }];
    if (!prof) {
      const mod = await import('../supabase/functions/prof/index.ts');
      const env = { SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: serviceKey, SUPABASE_ANON_KEY: anonKey, ANTHROPIC_BASE_URL: anthropicUrl || 'http://127.0.0.1:9' };
      prof = mod.createHandler((k) => env[k]);
    }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const r = await prof(new Request(base + url.pathname + url.search, { method: req.method, headers, body: req.method === 'GET' || req.method === 'HEAD' ? undefined : raw }));
    const text = await r.text();
    if (!(r.headers.get('content-type') || '').includes('json')) return [r.status, Buffer.from(text), r.headers.get('content-type') || 'text/plain'];
    return [r.status, text ? JSON.parse(text) : null];
  }

  async function auth(req, url, body) {
    const route = url.pathname.replace('/auth/v1/', '');
    const b = body ? JSON.parse(body) : {};
    if (route === 'signup') {
      if (!b.email || !b.password || b.password.length < 6) return [422, { code: 422, error_code: 'weak_password', msg: 'Password should be at least 6 characters.' }];
      if (users.has(b.email.toLowerCase())) return [422, { code: 422, error_code: 'user_already_exists', msg: 'User already registered' }];
      const r = await db.query(`insert into auth.users (email, raw_user_meta_data, encrypted_password) values ($1, $2, extensions.crypt($3, extensions.gen_salt('bf'))) returning id`, [b.email.toLowerCase(), b.data || {}, b.password]);
      const u = { id: r.rows[0].id, email: b.email.toLowerCase(), password: b.password, meta: b.data || {} };
      users.set(u.email, u);
      return [200, session(u)];
    }
    if (route === 'token') {
      const gt = url.searchParams.get('grant_type');
      if (gt === 'password') {
        // Checked against the database, like the real thing (so password resets done in SQL count)
        const r = await db.query(
          `update auth.users set last_sign_in_at = now() where lower(email) = lower($1) and encrypted_password = extensions.crypt($2, encrypted_password) returning id, email, raw_user_meta_data`,
          [b.email || '', b.password || ''],
        );
        const row = r.rows[0];
        if (!row) return [400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' }];
        if (await banned(row.id)) return [400, { code: 400, error_code: 'user_banned', msg: 'User is banned' }];
        const u = users.get(row.email) || { id: row.id, email: row.email, meta: row.raw_user_meta_data };
        users.set(row.email, u);
        return [200, session(u)];
      }
      if (gt === 'refresh_token') {
        const rt = refresh.get(b.refresh_token);
        if (!rt) return [400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' }];
        if (await banned(users.get(rt.email)?.id)) return [400, { code: 400, error_code: 'user_banned', msg: 'User is banned' }];
        return [200, session(users.get(rt.email), rt.aal)];
      }
    }
    if (route === 'user') {
      const uid = caller(req);
      const u = [...users.values()].find((x) => x.id === uid);
      if (!u) return [401, { code: 401, msg: 'Not signed in' }];
      if (req.method === 'PUT') {
        if (b.password) await db.query(`update auth.users set encrypted_password = extensions.crypt($2, extensions.gen_salt('bf')) where id = $1`, [u.id, b.password]);
        if (b.data) u.meta = { ...u.meta, ...b.data };
      }
      return [200, userJson(u)];
    }
    // Two-step sign-in (authenticator app)
    if (route === 'factors' || route.startsWith('factors/')) {
      const uid = caller(req);
      const u = [...users.values()].find((x) => x.id === uid);
      if (!u) return [401, { code: 401, msg: 'Not signed in' }];
      u.factors ||= [];
      const [, id, act] = route.split('/');
      const f = id && u.factors.find((x) => x.id === id);
      if (route === 'factors' && req.method === 'POST') {
        const secret = base32(crypto.randomBytes(20));
        const nf = { id: crypto.randomUUID(), factor_type: 'totp', friendly_name: b.friendly_name || '', status: 'unverified', secret,
          created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        u.factors.push(nf);
        const uri = `otpauth://totp/${encodeURIComponent(b.issuer || 'StudyBridge')}:${encodeURIComponent(u.email)}?secret=${secret}&issuer=${encodeURIComponent(b.issuer || 'StudyBridge')}`;
        return [200, { id: nf.id, type: 'totp', friendly_name: nf.friendly_name, totp: { qr_code: '<svg xmlns="http://www.w3.org/2000/svg"/>', secret, uri } }];
      }
      if (!f) return [404, { code: 404, error_code: 'mfa_factor_not_found', msg: 'Factor not found' }];
      if (!act && req.method === 'DELETE') {
        u.factors = u.factors.filter((x) => x.id !== id);
        return [200, { id }];
      }
      if (act === 'challenge') return [200, { id: crypto.randomUUID(), type: 'totp', expires_at: Math.floor(Date.now() / 1000) + 300 }];
      if (act === 'verify') {
        const ok = [-1, 0, 1].some((st) => totp(f.secret, Date.now(), st) === String(b.code || '').trim());
        if (!ok) return [422, { code: 422, error_code: 'mfa_verification_failed', msg: 'Invalid TOTP code entered' }];
        f.status = 'verified';
        return [200, session(u, 'aal2')];
      }
      return [404, { msg: 'Not found' }];
    }
    if (route === 'logout') return [204, null];
    if (route === 'settings') return [200, { external: { email: true }, disable_signup: false, mailer_autoconfirm: true }];
    return [404, { msg: 'Not found' }];
  }

  const server = http.createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS,HEAD',
      'access-control-expose-headers': 'content-range, x-supabase-api-version',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    if (offline) {
      req.socket.destroy();
      return;
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    let out;
    try {
      const store = { aal: claimsOf(req).aal || 'aal1' };
      out = await reqCtx.run(store, () => handle(req, url, raw));
    } catch (e) {
      out = [e.status || 400, { message: e.message, code: e.code || 'P0001', details: e.detail || null, hint: e.hint || null }];
    }
    async function handle(req, url, raw) {
      if (url.pathname.startsWith('/auth/v1/')) return auth(req, url, raw.toString());
      if (url.pathname.startsWith('/rest/v1/')) return rest(req, url, raw.toString(), caller(req));
      if (url.pathname.startsWith('/storage/v1/object/')) return storage(req, url, raw, caller(req));
      if (url.pathname.startsWith('/functions/v1/')) return functions(req, url, raw);
      return [404, { message: 'Not found' }];
    }
    const [status, payload, type] = out;
    if (log) console.log(req.method, url.pathname + url.search, status, status >= 400 ? JSON.stringify(payload) : '');
    if (Buffer.isBuffer(payload)) {
      res.writeHead(status, { ...cors, 'content-type': type });
      return res.end(payload);
    }
    if (payload === null && (status === 204 || status === 201)) {
      res.writeHead(status, cors);
      return res.end();
    }
    res.writeHead(status, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  server.on('upgrade', (req, socket) => socket.destroy()); // no realtime: the app falls back to polling
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  base = url;
  return {
    url,
    anonKey,
    serviceKey,
    db,
    files,
    setOffline(v) {
      offline = v;
    },
    async close() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await db.close();
    },
  };
}

// Run standalone: node test/fake-supabase.mjs  (prints the URL + key for manual testing)
if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startFakeSupabase({ port: Number(process.env.PORT || 54321), log: true });
  console.log(`Fake Supabase at ${s.url}  anon key: ${s.anonKey}`);
}
