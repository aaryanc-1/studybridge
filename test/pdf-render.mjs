// Opens several kinds of PDF in the library viewer and checks each page actually draws ink:
// plain text with standard fonts, and scanned-text PDFs (JBIG2, common in textbooks).
//   npm run build && node test/pdf-render.mjs
import http from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import assert from 'node:assert/strict';
import { chromium, _electron as electron } from 'playwright';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { startFakeSupabase } from './fake-supabase.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const PDFS = ['algebra-chapter-3.pdf', 'jbig2_symbol_offset.pdf', 'bitmap-composite-and-xnor-text.pdf'];

const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.png': 'image/png', '.wasm': 'application/wasm' };
const web = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const f = join(ROOT, 'dist', p);
  if (!existsSync(f) || statSync(f).isDirectory()) return res.writeHead(404), res.end();
  res.writeHead(200, { 'content-type': types[extname(f)] || 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));

const srv = await startFakeSupabase();
const t = createClient(srv.url, srv.anonKey, { auth: { persistSession: false } });
await t.auth.signUp({ email: 'tutor@example.com', password: 'secret123' });
await t.rpc('become_tutor', { p_name: 'Aaryan' });
const uid = (await t.auth.getUser()).data.user.id;
const ids = {};
for (const name of PDFS) {
  const path = `${uid}/files/${name}`;
  await t.storage.from('library').upload(path, readFileSync(join(ROOT, 'test', 'fixtures', name)), { contentType: 'application/pdf' });
  ids[name] = (await t.from('files').insert({ name, storage_path: path, mime: 'application/pdf' }).select().single()).data.id;
}

// ELECTRON=1 checks the desktop app itself (files load from disk there, not from a web server)
const inApp = !!process.env.ELECTRON;
const browser = inApp
  ? await electron.launch({ executablePath: join(ROOT, 'node_modules', 'electron', 'dist', 'electron'), args: ['--no-sandbox', ROOT], env: { ...process.env, SB_USER_DATA: mkdtempSync(join(tmpdir(), 'sb-')), SB_TEST: '1' } })
  : await chromium.launch({ executablePath: process.env.CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
const page = inApp ? await browser.firstWindow() : await browser.newPage({ viewport: { width: 1200, height: 900 } });
const warnings = [];
page.on('console', (m) => /warn|error/.test(m.type()) && warnings.push(m.text()));
let failed = false;
try {
  if (!inApp) await page.goto(`http://127.0.0.1:${web.address().port}/`);
  await page.evaluate(([u, k]) => localStorage.setItem('sb.server', JSON.stringify({ url: u, key: k })), [srv.url, srv.anonKey]);
  await page.reload();
  await page.getByLabel('Email').fill('tutor@example.com');
  await page.getByLabel('Password').fill('secret123');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('.content').waitFor();
  for (const name of PDFS) {
    await page.evaluate((id) => (location.hash = `#/file/${id}`), ids[name]);
    await page.locator('canvas[aria-label="Page 1"]').waitFor();
    await page.waitForTimeout(1500);
    const ink = await page.evaluate(() => {
      const c = document.querySelector('canvas[aria-label="Page 1"]');
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 120 && d[i + 1] < 120 && d[i + 2] < 120 && d[i + 3] > 0) n++;
      return n;
    });
    const ok = ink > 300;
    console.log(`${ok ? '•' : '✗'} ${name}: ${ink} dark pixels`);
    if (!ok) failed = true;
  }
  const relevant = warnings.filter((w) => /font|wasm|jbig|cmap|Warning/i.test(w));
  if (relevant.length) console.log('pdf.js warnings:\n  ' + [...new Set(relevant)].slice(0, 8).join('\n  '));
  assert.ok(!failed, 'every PDF drew its text');
  console.log('\nPDF rendering check passed.');
} catch (e) {
  console.error('FAILED:', e.message);
  process.exitCode = 1;
} finally {
  if (inApp) await browser.evaluate(({ app }) => app.exit(0)).catch(() => {});
  else await browser.close();
  web.close();
  await srv.close();
}
