// Writes manifest.json for desktop updates from the files of one release:
//   node scripts/make-manifest.mjs <version> <dir with the release files>
// The desktop app (electron/updater.cjs) reads it from the public releases page.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const ROOT = new URL('..', import.meta.url).pathname;
const [version, dir] = process.argv.slice(2);
if (!version || !dir) throw new Error('Usage: node scripts/make-manifest.mjs <version> <dir>');

// Same fingerprint as electron/updater.cjs shellId()
export function shellId() {
  const h = createHash('sha256');
  for (const f of ['main.cjs', 'preload.cjs', 'updater.cjs']) h.update(readFileSync(join(ROOT, 'electron', f), 'utf8').replace(/\r\n/g, '\n'));
  return h.digest('hex').slice(0, 16);
}
const files = readdirSync(dir);
const entry = (name) => (name ? { file: name, sha512: createHash('sha512').update(readFileSync(join(dir, name))).digest('base64') } : undefined);
const find = (re) => files.find((f) => re.test(f));
const manifest = {
  version,
  shell: shellId(),
  date: new Date().toISOString(),
  notes: process.env.NOTES || '',
  bundle: entry(find(/^StudyBridge-app-.*\.sbz$/)),
  installers: {
    win: entry(find(/^StudyBridge-Setup-.*\.exe$/)),
    mac_arm64: entry(find(/^StudyBridge-.*-arm64\.dmg$/)),
    mac_x64: entry(find(/^StudyBridge-.*-x64\.dmg$/)),
  },
};
writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ ...manifest, bundle: manifest.bundle?.file }, null, 1));
