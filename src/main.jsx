import { restartDesktop } from './lib/autoupdate.js'; // first: after an update's restart it reopens the page you were on
import { createRoot } from 'react-dom/client';
import 'mathlive/fonts.css';
import 'mathlive/static.css';
import './styles.css';
import App from './App.jsx';
import { applyTheme } from './lib/device.js';

applyTheme();

// A screen that loads part of the app later (e.g. the exam camera's video) after StudyBridge was updated can't
// find that part any more. Instead of a confusing error, offer a restart (desktop) or a reload (web).
const chunkFailed = (m) => /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS/i.test(String(m || ''));
function updatedBar() {
  if (document.getElementById('sb-updated')) return;
  const bar = document.createElement('div');
  bar.id = 'sb-updated';
  bar.className = 'updated-bar';
  bar.setAttribute('role', 'alert');
  const text = document.createElement('span');
  text.textContent = 'StudyBridge was updated. Restart it to carry on where you were.';
  const btn = document.createElement('button');
  btn.textContent = window.studybridge ? 'Restart StudyBridge' : 'Reload';
  btn.onclick = () => (window.studybridge?.restart ? restartDesktop() : location.reload());
  bar.append(text, btn);
  document.body.appendChild(bar);
}
addEventListener('vite:preloadError', updatedBar);
addEventListener('unhandledrejection', (e) => chunkFailed(e.reason?.message || e.reason) && updatedBar());
addEventListener('error', (e) => chunkFailed(e.message) && updatedBar());

createRoot(document.getElementById('root')).render(<App />);

// Web version (phone / browser): work offline and allow "Add to Home Screen"
if (!window.studybridge && 'serviceWorker' in navigator && location.protocol.startsWith('http') && !location.hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
