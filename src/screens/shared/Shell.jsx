import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useApp } from '../../App.jsx';
import Icon, { Logo } from '../../ui/Icon.jsx';
import { Avatar, ErrorBoundary, go, Link, useRoute, useToast } from '../../ui/kit.jsx';
import { useOnline, useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as outbox from '../../lib/outbox.js';
import { ago } from '../../lib/format.js';
import { desktop } from '../../lib/config.js';
import { startLiveUpdates } from '../../lib/live-updates.js';

export function isActive(route, item) {
  if (item.to === '/') return route.path === '/' || route.path === '';
  return route.path === item.to || route.path.startsWith(item.to + '/') || (item.also || []).some((a) => route.path.startsWith(a));
}

export default function Shell({ nav, tabs, roleLabel, banner, children, notificationTarget, theme = '' }) {
  const app = useApp();
  const route = useRoute();
  const online = useOnline();
  const pending = usePending();
  useAnnouncer(notificationTarget);

  useEffect(() => startLiveUpdates(app.me.id), [app.me.id]);
  useEffect(() => {
    if (desktop && app.me.role === 'tutor' && localStorage.getItem('sb.background') === '1') desktop.keepInBackground(true);
    outbox.flush();
  }, [app.me.role]);

  return (
    <div className={'shell ' + (theme ? 'theme-' + theme : '')}>
      <aside className="side" aria-label="Main">
        <div className="brand">
          <Logo />
          <div>
            <div className="word">StudyBridge</div>
            <div className="role">{roleLabel}</div>
          </div>
        </div>
        {nav.map((n) => (
          <Link key={n.to} to={n.to} className="nav" aria-current={isActive(route, n) ? 'page' : undefined}>
            <Icon name={n.icon} />
            {n.label}
            {n.count > 0 && <span className={'count ' + (n.tone || '')}>{n.count}</span>}
          </Link>
        ))}
        <div className="spacer" />
        <NotificationBell target={notificationTarget} inline />
        <button className="me" onClick={() => go('/settings')}>
          <Avatar person={app.me} />
          <span className="grow">
            <div className="n">{app.me.display_name}</div>
            <div className="s">Settings</div>
          </span>
          <Icon name="settings" size={18} />
        </button>
      </aside>
      <div className="main">
        <div className="topbar">
          <Logo size={28} />
          <span className="word">StudyBridge</span>
          <NotificationBell target={notificationTarget} />
          <button className="btn ghost icon sm" onClick={() => go('/settings')} aria-label="Settings">
            <Icon name="settings" />
          </button>
        </div>
        {!online && (
          <div className="banner off" role="status">
            <Icon name="wifiOff" size={18} />
            <span className="grow">You’re offline. You can keep working; changes are saved on this device{pending ? ` (${pending} waiting to send)` : ''}.</span>
          </div>
        )}
        {online && pending > 0 && (
          <div className="banner off" role="status">
            <Icon name="refresh" size={18} />
            <span className="grow">Sending {pending} saved change{pending === 1 ? '' : 's'}…</span>
          </div>
        )}
        {banner}
        <UpdateBanner />
        <div className="content">
          <ErrorBoundary key={route.path}>{children}</ErrorBoundary>
        </div>
        <nav className="tabbar" aria-label="Main">
          {tabs.map((n) => (
            <Link key={n.to} to={n.to} aria-current={isActive(route, n) ? 'page' : undefined}>
              <Icon name={n.icon} size={22} />
              {n.label}
              {n.count > 0 && <span className="count">{n.count}</span>}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  );
}


// Pops up new notifications (in-app toast, plus a system notification when the app isn't in front)
function useAnnouncer(target) {
  const toast = useToast();
  const q = useQuery('notifications', api.listNotifications);
  const seen = useRef(null);
  useEffect(() => {
    if (!q.data) return;
    if (seen.current === null) {
      seen.current = new Set(q.data.map((n) => n.id));
      return;
    }
    const fresh = q.data.filter((n) => !seen.current.has(n.id) && !n.read_at);
    fresh.forEach((n) => seen.current.add(n.id));
    for (const n of fresh.slice(0, 3)) {
      const open = () => {
        desktop?.focus();
        go(target(n));
      };
      if (document.hasFocus()) toast({ title: n.title, body: n.body, onClick: open, ms: 7000 });
      showSystemNotification(n, open);
    }
    if (fresh.some((n) => ['submitted', 'note', 'marked', 'message'].includes(n.kind))) invalidate('attempts', 'comments', 'myattempts');
  }, [q.data]); // eslint-disable-line react-hooks/exhaustive-deps

}

function usePending() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const upd = () => outbox.pending().then(setN);
    upd();
    const off = outbox.subscribe(upd);
    const t = setInterval(upd, 5000);
    return () => {
      off();
      clearInterval(t);
    };
  }, []);
  return n;
}

// Bell with the latest notifications; also shows desktop / phone notifications for new ones
function NotificationBell({ target, inline }) {
  const q = useQuery('notifications', api.listNotifications);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(null); // where the sidebar's list opens (fixed, so the sidebar doesn't clip it or scroll sideways)
  const ref = useRef(null);
  const list = q.data || [];
  const unread = list.filter((n) => !n.read_at);

  useEffect(() => {
    desktop?.setBadge(unread.length);
  }, [unread.length]);

  useEffect(() => {
    if (!open) return;
    const h = (e) => ref.current && !ref.current.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [open]);

  async function markAll() {
    const ids = unread.map((n) => n.id);
    q.mutate((d) => (d || []).map((n) => (ids.includes(n.id) ? { ...n, read_at: new Date().toISOString() } : n)));
    await api.markNotificationsRead(ids).catch(() => {});
  }

  return (
    <div ref={ref} style={{ position: 'relative', width: inline ? '100%' : 'auto', marginBottom: inline ? 8 : 0 }}>
      <button
        className={inline ? 'nav' : 'btn ghost icon sm'}
        onClick={(e) => {
          if (inline) {
            const b = e.currentTarget.getBoundingClientRect();
            setAt({ left: b.left, bottom: window.innerHeight - b.top + 6 });
          }
          setOpen((o) => !o);
          if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
        }}
        aria-label={`Notifications${unread.length ? `, ${unread.length} new` : ''}`}
        aria-expanded={open}
      >
        <Icon name="bell" />
        {inline && 'Notifications'}
        {unread.length > 0 && (inline ? <span className="count">{unread.length}</span> : <span className="pill accent" style={{ padding: '0 6px', marginLeft: -6 }}>{unread.length}</span>)}
      </button>
      {open && (
        <div className="pop" style={inline ? { position: 'fixed', left: at?.left ?? 12, right: 'auto', top: 'auto', bottom: at?.bottom ?? 80, zIndex: 60, maxHeight: `min(480px, calc(100vh - ${(at?.bottom ?? 80) + 16}px))` } : undefined}>
          <div className="row between" style={{ padding: '4px 8px 8px' }}>
            <span className="strong">Notifications</span>
            {unread.length > 0 && (
              <button className="linkbtn small" onClick={markAll}>
                Mark all read
              </button>
            )}
          </div>
          {list.length === 0 && <div className="muted small" style={{ padding: 10 }}>Nothing yet.</div>}
          {list.slice(0, 30).map((n) => (
            <div
              key={n.id}
              className={'notif' + (n.read_at ? '' : ' unread')}
              role="button"
              tabIndex={0}
              onClick={() => {
                setOpen(false);
                if (!n.read_at) {
                  q.mutate((d) => d.map((x) => (x.id === n.id ? { ...x, read_at: new Date().toISOString() } : x)));
                  api.markNotificationsRead([n.id]).catch(() => {});
                }
                go(target(n));
              }}
            >
              <Icon name={iconFor(n.kind)} size={18} style={{ marginTop: 2, color: 'var(--accent)', flexShrink: 0 }} />
              <div className="grow">
                <div className="t">{n.title}</div>
                {n.body && <div className="b">{n.body}</div>}
                <div className="w">{ago(n.created_at)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function iconFor(kind) {
  return (
    { submitted: 'clipboard', note: 'message', message: 'message', marked: 'checkCircle', joined: 'user', lockdown: 'alert', session: 'video', assignment: 'clipboard', lesson: 'book' }[kind] || 'bell'
  );
}

function showSystemNotification(n, onClick) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.hasFocus()) return;
    const x = new Notification(n.title, { body: n.body || '', tag: n.id, silent: false });
    x.onclick = () => {
      window.focus();
      onClick();
      x.close();
    };
  } catch {}
}

export function useIsNarrow() {
  return useSyncExternalStore(
    (f) => {
      window.addEventListener('resize', f);
      return () => window.removeEventListener('resize', f);
    },
    () => window.innerWidth <= 900,
  );
}

// "A new version is ready" (desktop app). Restarting never happens during a locked exam.
export function useUpdateStatus() {
  const [st, setSt] = useState(null);
  useEffect(() => {
    const u = desktop?.updates;
    if (!u) return;
    u.get().then(setSt).catch(() => {});
    return u.onStatus(setSt);
  }, []);
  return st;
}

function UpdateBanner() {
  const st = useUpdateStatus();
  const toast = useToast();
  const [hidden, setHidden] = useState(false);
  if (!st || st.state !== 'ready' || hidden) return null;
  const mac = st.kind === 'mac-install';
  return (
    <div className="banner update-banner" role="status">
      <Icon name="download" size={18} />
      <span className="grow">
        {mac ? 'A new version of StudyBridge has downloaded. Open it and drag StudyBridge into Applications (replace the old one).' : 'A new version of StudyBridge is ready.'}
      </span>
      <button
        className="btn sm"
        onClick={async () => {
          const r = await desktop.updates.apply();
          if (r?.error) toast({ title: r.error, tone: 'bad' });
          if (mac) setHidden(true);
        }}
      >
        {mac ? 'Open it' : 'Restart now'}
      </button>
      <button className="btn ghost icon sm" style={{ background: 'transparent', color: '#fff', borderColor: 'transparent' }} onClick={() => setHidden(true)} aria-label="Later">
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}
