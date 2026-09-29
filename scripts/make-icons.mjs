// Renders the StudyBridge logo to PNG icons (app, web, tray)
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
const svg = (bg = true) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
${bg ? '<rect width="64" height="64" rx="15" fill="#0E6B6B"/>' : ''}
<path d="M12 42c6-10 14-15 20-15s14 5 20 15" fill="none" stroke="${bg ? '#fff' : '#000'}" stroke-width="5" stroke-linecap="round"/>
<path d="M17 42V33M32 42V27M47 42V33" stroke="${bg ? '#fff' : '#000'}" stroke-width="4" stroke-linecap="round"/>
<path d="M9 42h46" stroke="${bg ? '#F2C66D' : '#000'}" stroke-width="5" stroke-linecap="round"/>
<circle cx="32" cy="17" r="4.5" fill="${bg ? '#F2C66D' : '#000'}"/></svg>`;
const b = await chromium.launch({ executablePath: process.env.CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined) });
const p = await b.newPage();
async function render(size, file, bg = true, pad = 0) {
  await p.setViewportSize({ width: size, height: size });
  await p.setContent(`<html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px;padding:${pad}px;box-sizing:border-box">${svg(bg).replace('<svg ', `<svg width="${size - 2 * pad}" height="${size - 2 * pad}" `)}</div></body></html>`);
  writeFileSync(file, await p.screenshot({ omitBackground: true }));
}
mkdirSync('build', { recursive: true });
await render(1024, 'build/icon.png', true, 64);
await render(512, 'public/icon-512.png');
await render(192, 'public/icon-192.png');
await render(32, 'build/tray.png');
await render(16, 'build/trayTemplate.png', false);
await render(32, 'build/trayTemplate@2x.png', false);
await b.close();
console.log('icons written');
