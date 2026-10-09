// Crash reports: when something breaks on someone's device, StudyBridge tells the admin.
// Only the error (message, where in the code, which screen, version, device) is sent,
// never anyone's work, files or messages.
import { sb } from './supabase.js';
import { appVersion, platformName } from './api.js';

const sent = new Set();
let installed = false;

// Things that aren't bugs: no internet, a request cancelled, the browser's resize notice, and "Script error." (all a
// browser says when a script from another site fails, e.g. the visitor counter or a WhatsApp/Instagram in-app browser:
// no file, no line, nothing to fix here)
const IGNORE = /Failed to fetch|NetworkError|Load failed|network|offline|AbortError|aborted|ResizeObserver loop|Not signed in|JWT expired|timeout|^Script error\.?$/i;

export function reportError(err, where = '') {
  try {
    const message = String(err?.message || err || 'Unknown error').slice(0, 500);
    if (IGNORE.test(message) || err?.offline) return;
    const key = message + '|' + where;
    if (sent.has(key) || sent.size > 20) return; // once per problem per session
    sent.add(key);
    const screen = (location.hash || '#/').replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id').slice(0, 200);
    sb()
      .rpc('report_error', {
        p_message: message,
        p_stack: String(err?.stack || where || '').slice(0, 4000),
        p_screen: screen,
        p_version: appVersion() || 'dev',
        p_platform: platformName(),
      })
      .then(() => {}, () => {});
  } catch {
    /* never let reporting break the app */
  }
}

export function installErrorReporting() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => reportError(e.error || e.message, `${e.filename || ''}:${e.lineno || ''}`));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'promise'));
}
