// Builds build/studybridge.mcpb: the one-click Claude Desktop install file for tutors.
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'connector');
const out = join(dir, 'dist', 'studybridge.mcpb');
const mcpb = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'mcpb.cmd' : 'mcpb');
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit', shell: true });

mkdirSync(dirname(out), { recursive: true });
if (existsSync(out)) unlinkSync(out);
run('npm ci --omit=dev --no-audit --no-fund', dir);
run(`"${mcpb}" validate manifest.json`, dir);
run(`"${mcpb}" pack . "${out}"`, dir);
copyFileSync(out, join(root, 'build', 'studybridge.mcpb'));
console.log('Connector packed: build/studybridge.mcpb');
