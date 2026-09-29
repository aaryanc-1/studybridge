// Instant updates: when something changes on the server, refresh what's on screen.
import { sb } from './supabase.js';
import { invalidate } from './data.js';

const MAP = {
  notifications: ['notifications'],
  comments: ['comments'],
  attempts: ['attempts', 'attempt', 'myattempts'],
  responses: ['attempt'],
  assignments: ['assignments', 'assignment'],
  sessions: ['sessions'],
  claude_drafts: ['drafts', 'assignments'],
};

export function startLiveUpdates(uid) {
  let connected = false;
  let channel = null;
  try {
    channel = sb().channel('sb-live-' + uid);
    for (const table of Object.keys(MAP)) {
      const opts = { event: '*', schema: 'public', table };
      if (table === 'notifications') opts.filter = `user_id=eq.${uid}`;
      channel.on('postgres_changes', opts, () => invalidate(...MAP[table]));
    }
    channel.subscribe((status) => {
      connected = status === 'SUBSCRIBED';
    });
  } catch {
    connected = false;
  }
  // Fallbacks: notifications every 30 s; everything every 60 s if live updates aren't connected
  let n = 0;
  const t = setInterval(() => {
    if (document.hidden) return;
    n++;
    if (!connected && n % 2 === 0) invalidate();
    else invalidate('notifications');
  }, 30000);
  const onFocus = () => invalidate();
  window.addEventListener('focus', onFocus);
  return () => {
    clearInterval(t);
    window.removeEventListener('focus', onFocus);
    try {
      if (channel) sb().removeChannel(channel);
    } catch {}
  };
}
