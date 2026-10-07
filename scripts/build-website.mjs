// Builds the website (website/ → an output folder) from website/site.config.json, so a rename or a price
// change is one edit. CI publishes it at the root of the releases repo's GitHub Pages, next to the phone app at app/.
//   node scripts/build-website.mjs <out dir> [version]
// With a version, release.json points the download buttons straight at that release's files.
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const siteConfig = () => JSON.parse(readFileSync(join(root, 'website/site.config.json'), 'utf8'));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function planCards(c) {
  return c.plans
    .map((p) => {
      const free = !p.month;
      const items = [
        `${p.learners === 1 ? '1 learner' : `Up to ${p.learners} learners`}`,
        'Every feature, including Prof',
        'Free parent accounts',
        free ? 'No card needed' : 'Cancel any time',
      ];
      const cta = free ? 'Start free' : c.freeNow ? 'Start free now' : `Choose ${p.name}`;
      return `<article class="plan${p.popular ? ' popular' : ''}" data-plan="${esc(p.id)}">
          ${p.popular ? '<span class="tag">Most popular</span>' : ''}
          <h3>${esc(p.name)}</h3>
          <div class="who">${esc(p.blurb)}</div>
          <div><span class="amount">$${p.month}</span><span class="per">${free ? 'for ever' : '/ month'}</span></div>
          <div class="equiv"></div>
          <ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
          <a class="btn${p.popular ? ' primary' : ''}" href="${esc(c.appPath)}#start=tutor">${cta}</a>
          ${!free && c.freeNow ? '<div class="soon">Paid plans coming soon</div>' : ''}
        </article>`;
    })
    .join('\n        ');
}

export async function buildWebsite(out, version) {
  const c = siteConfig();
  mkdirSync(out, { recursive: true });
  const today = new Date();
  const tokens = {
    brand: esc(c.brand),
    tagline: esc(c.tagline),
    siteUrl: esc(c.siteUrl),
    app: esc(c.appPath),
    repo: esc(c.releasesRepo),
    year: String(today.getFullYear()),
    updated: today.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }),
    monthsFree: String(c.yearlyMonthsFree),
    freeBadge: c.freeNow ? 'Free while we grow · paid plans coming soon' : 'Free for one learner',
    freeLine: c.freeNow ? 'Free now, paid plans coming soon.' : 'Start free with one learner.',
    plans: planCards(c),
    currencyOptions: c.currencies.map((x) => `<option value="${esc(x.code)}">${esc(x.code)} (${esc(x.symbol)})</option>`).join(''),
  };
  for (const f of readdirSync(join(root, 'website'))) {
    if (f.endsWith('.html')) {
      const html = readFileSync(join(root, 'website', f), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => {
        if (!(k in tokens)) throw new Error(`website/${f}: unknown {{${k}}}`);
        return tokens[k];
      });
      writeFileSync(join(out, f), html);
    } else if (f.endsWith('.css') || f.endsWith('.js')) copyFileSync(join(root, 'website', f), join(out, f));
  }
  const pub = { brand: c.brand, appPath: c.appPath, releasesRepo: c.releasesRepo, freeNow: c.freeNow, plans: c.plans, currencies: c.currencies };
  writeFileSync(join(out, 'config.js'), `window.SITE = ${JSON.stringify(pub)};\n`);
  copyFileSync(join(root, 'public/favicon.png'), join(out, 'favicon.png'));
  copyFileSync(join(root, 'public/icon-192.png'), join(out, 'logo-192.png'));
  copyFileSync(join(root, 'public/icon-512.png'), join(out, 'logo-512.png'));
  writeFileSync(join(out, 'app-qr.svg'), await QRCode.toString(c.siteUrl + c.appPath, { type: 'svg', margin: 1, color: { dark: '#0B3F3F', light: '#FFFFFF' } }));
  if (version) {
    const base = `https://github.com/${c.releasesRepo}/releases/download/v${version}/`;
    writeFileSync(
      join(out, 'release.json'),
      JSON.stringify({
        version,
        windows: `${base}StudyBridge-Setup-${version}.exe`,
        mac_arm: `${base}StudyBridge-${version}-arm64.dmg`,
        mac_x64: `${base}StudyBridge-${version}-x64.dmg`,
      }),
    );
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [out = 'dist-site', version] = process.argv.slice(2);
  await buildWebsite(out, version);
  console.log(`Website built in ${out}${version ? ` (downloads for ${version})` : ''}`);
}
