// CI: tells the desktop app where to look for updates and which version its screens are
import { writeFileSync } from 'node:fs';
const repo = process.env.RELEASES_REPO;
writeFileSync(
  new URL('../electron/build-config.json', import.meta.url),
  JSON.stringify({ updateUrl: repo ? `https://github.com/${repo}/releases/latest/download/` : null, bundleVersion: process.env.VERSION }, null, 1),
);
