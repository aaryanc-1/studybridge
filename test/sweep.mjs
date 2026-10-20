// The button sweep: signed in as each kind of account, open every screen and press every button on it, then report
// anything that breaks (a crash screen, an error in the page) and buttons that seem to do nothing.
// Buttons that delete, send something away for good or sign out are left alone and listed instead.
// Run with the product walkthrough, which makes all the accounts first:  SWEEP=1 npm run product
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// never pressed: they delete, cancel or end things for good, sign out, or leave the app (listed as skipped)
const DANGER =
  /^(cancel( code| this| invite)?|delete.*|remove.*|discard.*|reject.*|withdraw.*|decline.*|pause.*|stop.*|end .*|hand in.*|close (their|the) account|sign out|log out|switch to.*|add another account|reset password|install.*|restart.*|download.*|print.*|join.*|start now|go live.*|leave.*|let them try again|mark as sorted|unlink.*|sign up a test student.*|make this the admin account|use this account)$/i;
const DANGER_ANY = /\b(delete|remove|discard|sign out|log out|withdraw|unlink|stop following|close (the|their) account|cancel (code|invite|this))\b/i;
const danger = (name) => DANGER.test(name) || DANGER_ANY.test(name);
// buttons that only close a pop-up window
const CLOSER = /^(cancel|close|keep it|not now|later|no|ok|done|back|×)$/i;
// screens that take over the whole window or need live video
const SKIP_ROUTE = /^\/(attempt|live|watch)\//;
const NOISE = /WebSocket|realtime|Failed to load resource|ERR_CONNECTION|net::|sb:\/\/|livekit/i;

// "/learners/0b6f…/study" → "/learners/:id/study", so each kind of screen is visited once
const pattern = (path) => path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').replace(/\?.*$/, '');

export async function signIn(page, url, email, password = 'secret123') {
  await page.goto(url);
  await page.getByText(/already have an account|Sign in/).first().click().catch(() => {});
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.locator('main#main-content').waitFor({ timeout: 30000 });
}

export async function sweep(page, who, { maxRoutes = 45, maxButtons = 60 } = {}) {
  const report = { who, routes: [], failures: [], nothing: [], skipped: new Set(), clicked: 0, inPopups: 0, badToasts: [] };
  let errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !NOISE.test(m.text()) && errors.push(m.text()));
  page.on('dialog', (d) => d.dismiss().catch(() => {})); // "Leave without saving?" and the like
  page.context().on('page', (p) => p.close().catch(() => {})); // links that open a new tab

  const go = async (hash) => {
    await page.evaluate((h) => (location.hash = h), hash);
    await page.waitForTimeout(700);
  };
  const crashed = async () => (await page.getByText('Something went wrong on this screen').count()) > 0;
  const closeDialogs = async () => {
    for (let i = 0; i < 3 && (await page.locator('[role="dialog"]').count()); i++) {
      const d = page.locator('[role="dialog"]').last();
      const shut = d.getByRole('button', { name: /^(cancel|close|keep it|not now|later|no|ok|done)$/i }).first();
      if (await shut.count()) await shut.click({ timeout: 2000 }).catch(() => {});
      else await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
    }
  };
  const state = () =>
    page.evaluate(() => ({
      hash: location.hash,
      text: (document.querySelector('main')?.innerText || '').length,
      html: (document.querySelector('main')?.innerHTML || '').length,
      dialogs: document.querySelectorAll('[role="dialog"]').length,
      toasts: [...document.querySelectorAll('.toasts > *')].map((t) => t.innerText).join(' | '),
    }));

  // Mark the nth button called `name` on the screen (not in a pop-up) and press it
  const press = async (name, nth) => {
    const found = await page.evaluate(
      ({ name, nth }) => {
        document.querySelectorAll('[data-sweep]').forEach((e) => e.removeAttribute('data-sweep'));
        const all = [...document.querySelectorAll('main button, main [role="button"], main [role="switch"], main [role="tab"], main summary')]
          .filter((b) => (b.offsetWidth || b.offsetHeight) && !b.disabled && !b.closest('[role="dialog"]'))
          .filter((b) => (b.getAttribute('aria-label') || b.innerText || b.title || '').trim().replace(/\s+/g, ' ').slice(0, 60) === name);
        if (!all[nth]) return false;
        all[nth].setAttribute('data-sweep', 'go');
        return true;
      },
      { name, nth },
    );
    return found && page.locator('[data-sweep="go"]').click({ timeout: 2500 }).then(() => true, () => false);
  };
  // Every button inside a pop-up window (except ones that delete or only close it), each from a freshly opened window
  const insidePopup = async (path, opener, nth) => {
    const inside = await page.evaluate(() => {
      const d = [...document.querySelectorAll('[role="dialog"]')].pop();
      return [...new Set([...(d?.querySelectorAll('button') || [])].filter((b) => !b.disabled && (b.offsetWidth || b.offsetHeight)).map((b) => (b.getAttribute('aria-label') || b.innerText || b.title || '').trim().replace(/\s+/g, ' ').slice(0, 60)))];
    });
    for (const n2 of inside.slice(0, 8)) {
      if (!n2 || CLOSER.test(n2) || danger(n2)) {
        if (n2 && danger(n2)) report.skipped.add(`${pattern(path)} → ${opener} → ${n2}`);
        continue;
      }
      if (!(await page.locator('[role="dialog"]').count())) {
        if ((await page.evaluate(() => location.hash)) !== '#' + path) await go('#' + path);
        if (!(await press(opener, nth))) return;
        await page.waitForTimeout(400);
        if (!(await page.locator('[role="dialog"]').count())) return;
      }
      errors = [];
      const ok = await page.locator('[role="dialog"]').last().getByRole('button', { name: n2, exact: true }).first().click({ timeout: 2500 }).then(() => true, () => false);
      if (!ok) continue;
      report.inPopups++;
      await page.waitForTimeout(450);
      if (await crashed()) report.failures.push({ where: pattern(path), what: `crash screen after “${opener}” → “${n2}”`, errors: [...errors] });
      else if (errors.length) report.failures.push({ where: pattern(path), what: `error after “${opener}” → “${n2}”`, errors: [...errors] });
      await closeDialogs();
    }
  };

  // start from the menu, then follow links inside the pages to screens not seen yet
  const queue = await page.evaluate(() => [...document.querySelectorAll('aside a[href^="#/"], nav.tabbar a[href^="#/"]')].map((a) => a.getAttribute('href').slice(1)));
  queue.push('/settings');
  const seen = new Set();
  while (queue.length && report.routes.length < maxRoutes) {
    const path = queue.shift();
    const pat = pattern(path);
    if (seen.has(pat) || SKIP_ROUTE.test(path)) continue;
    seen.add(pat);
    errors = [];
    await go('#' + path);
    report.routes.push(path);
    if (await crashed()) report.failures.push({ where: path, what: 'crash screen on opening', errors: [...errors] });
    else if (errors.length) report.failures.push({ where: path, what: 'error on opening', errors: [...errors] });
    // links to other screens, for later
    for (const h of await page.evaluate(() => [...document.querySelectorAll('main a[href^="#/"]')].map((a) => a.getAttribute('href').slice(1)))) {
      if (!seen.has(pattern(h)) && !queue.some((q) => pattern(q) === pattern(h))) queue.push(h);
    }
    // every button on this screen, one at a time (the screen is put back after each)
    const names = await page.evaluate(() =>
      [...document.querySelectorAll('main button, main [role="button"], main [role="switch"], main [role="tab"], main summary')]
        .filter((b) => (b.offsetWidth || b.offsetHeight) && !b.disabled && !b.closest('[role="dialog"]'))
        .map((b) => (b.getAttribute('aria-label') || b.innerText || b.title || '').trim().replace(/\s+/g, ' ').slice(0, 60)),
    );
    for (let i = 0; i < Math.min(names.length, maxButtons); i++) {
      const name = names[i];
      if (!name) continue;
      if (danger(name)) {
        report.skipped.add(`${pattern(path)} → ${name}`);
        continue;
      }
      // find it again (the screen may have been redrawn): the same name, the same number of times along
      const nth = names.slice(0, i).filter((x) => x === name).length;
      if (nth >= 2) continue; // a long list of the same button: the first two are enough
      const before = await state();
      errors = [];
      if (!(await press(name, nth))) continue; // gone, covered or moved: not a real button press
      report.clicked++;
      await page.waitForTimeout(450);
      const after = await state();
      if (await crashed()) report.failures.push({ where: pattern(path), what: `crash screen after “${name}”`, errors: [...errors] });
      else if (errors.length) report.failures.push({ where: pattern(path), what: `error after “${name}”`, errors: [...errors] });
      else if (after.hash === before.hash && after.dialogs === before.dialogs && after.html === before.html && after.toasts === before.toasts)
        report.nothing.push(`${pattern(path)} → ${name}`);
      // a button that opened another screen: sweep that screen too (once per kind of screen)
      const to = after.hash.replace(/^#/, '');
      if (after.hash !== before.hash && to.startsWith('/') && !seen.has(pattern(to)) && !queue.some((q) => pattern(q) === pattern(to))) queue.push(to);
      if (/couldn’t|could not|went wrong|failed/i.test(after.toasts) && after.toasts !== before.toasts) report.badToasts.push(`${pattern(path)} → ${name}: ${after.toasts}`);
      if (after.dialogs > before.dialogs && !(await crashed())) await insidePopup(path, name, nth);
      await closeDialogs();
      if ((await page.evaluate(() => location.hash)) !== '#' + path) await go('#' + path);
    }
  }
  report.skipped = [...report.skipped];
  return report;
}

export function writeReport(reports, dir) {
  const lines = ['# Button sweep', ''];
  for (const r of reports) {
    lines.push(`## ${r.who}: ${r.routes.length} screens, ${r.clicked} buttons pressed, ${r.inPopups} more inside pop-up windows`, '');
    lines.push(r.failures.length ? '**Broke:**' : 'Nothing broke.');
    for (const f of r.failures) lines.push(`- ${f.where}: ${f.what}${f.errors?.length ? ` (${f.errors.slice(0, 2).join(' / ').slice(0, 300)})` : ''}`);
    if (r.badToasts.length) lines.push('', '**Said it couldn’t (check these are fair):**', ...r.badToasts.map((x) => `- ${x}`));
    if (r.nothing.length) lines.push('', '**Seemed to do nothing (check these):**', ...r.nothing.map((x) => `- ${x}`));
    if (r.skipped.length) lines.push('', `Not pressed (they delete, send or sign out): ${r.skipped.length}`);
    lines.push('');
  }
  writeFileSync(join(dir, 'sweep.md'), lines.join('\n'));
  writeFileSync(join(dir, 'sweep.json'), JSON.stringify(reports, null, 1));
  return lines.join('\n');
}
