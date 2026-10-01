// Packs the built app (dist/) into one update file for the desktop app:
//   node scripts/pack-bundle.mjs <version> [outDir]  ->  <outDir>/StudyBridge-app-<version>.sbz
// Format: gzip( 4-byte header length | JSON [{ path, size }] | file bytes … )  (read by electron/updater.cjs)
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = new URL('..', import.meta.url).pathname;
const version = process.argv[2];
const out = process.argv[3] || join(ROOT, 'release');
const dist = process.env.DIST || join(ROOT, 'dist');
if (!version) throw new Error('Usage: node scripts/pack-bundle.mjs <version> [outDir]');

const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})(dist);
const index = files.map((p) => ({ path: relative(dist, p).split('\\').join('/'), size: statSync(p).size }));
const head = Buffer.from(JSON.stringify(index));
const len = Buffer.alloc(4);
len.writeUInt32BE(head.length);
const raw = Buffer.concat([len, head, ...files.map((p) => readFileSync(p))]);
mkdirSync(out, { recursive: true });
const file = join(out, `StudyBridge-app-${version}.sbz`);
writeFileSync(file, gzipSync(raw, { level: 9 }));
console.log(`${file}: ${files.length} files, ${(statSync(file).size / 1e6).toFixed(1)} MB`);
