import { createRoot } from 'react-dom/client';
import 'mathlive/fonts.css';
import 'mathlive/static.css';
import './styles.css';
import App from './App.jsx';
import { applyTheme } from './lib/device.js';

applyTheme();

createRoot(document.getElementById('root')).render(<App />);

// Web version (phone / browser): work offline and allow "Add to Home Screen"
if (!window.studybridge && 'serviceWorker' in navigator && location.protocol.startsWith('http') && !location.hostname.match(/^(localhost|127\.0\.0\.1)$/)) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}
