import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync } from 'node:fs';

// MathLive loads its fonts and sounds at runtime; ship them next to the app.
for (const d of ['fonts', 'sounds']) {
  if (!existsSync(`public/mathlive/${d}`)) cpSync(`node_modules/mathlive/${d}`, `public/mathlive/${d}`, { recursive: true });
}

// pdf.js needs its font, character-map and decoder files at runtime too (otherwise text in many PDFs is invisible)
for (const d of ['standard_fonts', 'cmaps', 'wasm', 'iccs']) {
  if (!existsSync(`public/pdfjs/${d}`)) cpSync(`node_modules/pdfjs-dist/${d}`, `public/pdfjs/${d}`, { recursive: true });
}

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 4000,
    target: 'es2022',
  },
  worker: { format: 'es' },
  server: { port: 5173 },
});
