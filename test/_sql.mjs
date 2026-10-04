import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import { STUBS } from './fake-supabase.mjs';
const db = new PGlite({ extensions: { pgcrypto } });
await db.exec(STUBS);
const S = readFileSync(new URL('../supabase/setup.sql', import.meta.url), 'utf8');
try { await db.exec(S); await db.exec(S); console.log('ok'); } catch (e) { console.log('ERR', e.message, e.position, S.slice(Math.max(0, e.position - 300), Number(e.position) + 100)); }
