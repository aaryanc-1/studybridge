import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useApp } from '../../App.jsx';
import Icon, { Logo } from '../../ui/Icon.jsx';
import { Avatar, ErrorBoundary, go, hasUnsaved, Link, useConfirm, useRoute, useToast } from '../../ui/kit.jsx';
import { useOnline, useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as outbox from '../../lib/outbox.js';
import { ago } from '../../lib/format.js';
import { desktop } from '../../lib/config.js';
import { startLiveUpdates } from '../../lib/live-updates.js';
import { AWAY, CHECK_EVERY, IDLE, RECHECK_ON_RETURN, busyNow, idleFor, pageChanged, restartDesktop, webHasUpdate } from '../../lib/autoupdate.js';
import { addAccount, canSwitch, otherAccounts, switchTo } from '../../lib/accounts.js';
import { applyTextSize, dataSaver, setDataSaver, slowConnection } from '../../lib/device.js';

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
  // Ctrl+, (Cmd+, on a Mac) opens Settings from anywhere, so it can always be reached
  useEffect(() => {
    const k = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        go('/settings');
      }
    };
    addEventListener('keydown', k);
    return () => removeEventListener('keydown', k);
  }, []);
  useEffect(() => applyTextSize(app.me.role), [app.me.role]);
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
        <AccountMenu place="side" />
      </aside>
      <div className="main">
        <div className="topbar">
          <Logo size={28} />
          <span className="word">StudyBridge</span>
          <NotificationBell target={notificationTarget} />
          <AccountMenu place="top" />
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
        {app.me.role !== 'admin' && <Announcements />}
        <SlowConnectionTip />
        <UpdateBanner pending={pending} />
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


// The account button on every screen: Settings, other accounts on this device (admin's device only) and Sign out.
// In the sidebar the menu floats above the button (fixed), so the scrolling sidebar can't clip it.
function AccountMenu({ place }) {
  const app = useApp();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(null);
  const box = useRef(null);
  const toggle = (e) => {
    if (place === 'side') {
      const b = e.currentTarget.getBoundingClientRect();
      setAt({ left: b.left, width: b.width, bottom: window.innerHeight - b.top + 8 });
    }
    setOpen((x) => !x);
  };
  useEffect(() => {
    if (!open) return;
    const away = (e) => !box.current?.contains(e.target) && setOpen(false);
    const esc = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  const switching = canSwitch();
  const others = switching ? otherAccounts(app.me.id) : [];
  const pick = (f) => () => {
    setOpen(false);
    f();
  };
  return (
    <div className={'acct acct-' + place} ref={box}>
      {place === 'side' ? (
        <button className="me" onClick={toggle} aria-expanded={open} aria-haspopup="menu">
          <Avatar person={app.me} />
          <span className="grow">
            <div className="n">{app.me.display_name}</div>
            <div className="s">Settings and sign out</div>
          </span>
          <Icon name={open ? 'down' : 'up'} size={16} />
        </button>
      ) : (
        <button className="acct-btn" onClick={toggle} aria-expanded={open} aria-haspopup="menu" aria-label="Your account: settings and sign out">
          <Avatar person={app.me} size="sm" />
        </button>
      )}
      {open && (
        <div className="acct-menu" role="menu" style={place === 'side' && at ? { position: 'fixed', left: at.left, width: at.width, bottom: at.bottom } : undefined}>
          <div className="acct-who">
            <div className="strong">{app.me.display_name}</div>
            <div className="tiny muted">{ROLE_NAME[app.me.role] || app.me.role}</div>
          </div>
          <button role="menuitem" onClick={pick(() => go('/settings'))}>
            <Icon name="settings" size={18} /> Settings
          </button>
          {others.map((a) => (
            <button key={a.id} role="menuitem" onClick={pick(() => switchTo(app.me.id, a.id))}>
              <Icon name="users" size={18} /> Switch to {a.name || a.email} <span className="tiny muted">{ROLE_NAME[a.role] || a.role}</span>
            </button>
          ))}
          {switching && (
            <button role="menuitem" onClick={pick(() => addAccount(app.me.id))}>
              <Icon name="plus" size={18} /> Add another account
            </button>
          )}
          <button
            role="menuitem"
            className="danger"
            onClick={pick(async () => {
              if (await confirm({ title: 'Sign out?', body: 'Anything waiting to send is kept and sends next time you sign in here.', ok: 'Sign out' })) app.signOut();
            })}
          >
            <Icon name="logout" size={18} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

// A slow connection (or the phone's own data saver): offer StudyBridge's data saver, once
function SlowConnectionTip() {
  const [show, setShow] = useState(() => {
    try {
      return slowConnection() && !dataSaver() && localStorage.getItem('sb.datasaver.asked') !== '1';
    } catch {
      return false;
    }
  });
  if (!show) return null;
  const done = (on) => {
    if (on) setDataSaver(true);
    try {
      localStorage.setItem('sb.datasaver.asked', '1');
    } catch {}
    setShow(false);
  };
  return (
    <div className="banner" role="status">
      <Icon name="wifiOff" size={18} />
      <span className="grow">Your connection looks slow. Turn on data saver? Photos get smaller, PDFs load a page at a time and live lessons use less video.</span>
      <button className="btn sm primary" onClick={() => done(true)}>
        Turn on
      </button>
      <button className="btn sm ghost" onClick={() => done(false)}>
        No thanks
      </button>
    </div>
  );
}

// One click to another account signed in on this device (only where the admin account is one of them)
const ROLE_NAME = { admin: 'Admin', tutor: 'Tutor', learner: 'Learner', parent: 'Parent' };
export function AccountSwitcher({ full = false }) {
  const app = useApp();
  const [open, setOpen] = useState(full);
  if (!canSwitch()) return null;
  const others = otherAccounts(app.me.id);
  return (
    <div className={'switcher' + (full ? ' full' : '')}>
      {!full && (
        <button className="linkbtn small" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
          <Icon name="users" size={14} /> Switch account
        </button>
      )}
      {open && (
        <div className="stack sm">
          {others.map((a) => (
            <button key={a.id} className="switch-to" onClick={() => switchTo(app.me.id, a.id)}>
              <span className="grow">
                <span className="strong">{a.name || a.email}</span>
                <span className="tiny muted"> · {ROLE_NAME[a.role] || a.role}</span>
              </span>
              <Icon name="right" size={14} />
            </button>
          ))}
          <button className="linkbtn small" onClick={() => addAccount(app.me.id)}>
            <Icon name="plus" size={14} /> Add another account
          </button>
        </div>
      )}
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
    if (fresh.some((n) => ['submitted', 'note', 'marked', 'message', 'auto_submitted', 'attempt_cancelled'].includes(n.kind))) invalidate('attempts', 'comments', 'myattempts');
    // a parent joined or was removed; a report was approved (parent accounts)
    if (fresh.some((n) => ['parent_joined', 'parent_removed', 'report'].includes(n.kind))) invalidate('my-parents', 'parents', 'parent-counts', 'parent-children', 'parent-view');
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

// Messages from StudyBridge (the admin) at the top of the app; each can be closed
function Announcements() {
  const q = useQuery('announcements', api.listAnnouncements, { poll: 10 * 60000 });
  const [gone, setGone] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('sb.announcementsClosed') || '[]');
    } catch {
      return [];
    }
  });
  const list = (q.data || []).filter((a) => !a.ended_at && (!a.until || new Date(a.until) > new Date()) && !gone.includes(a.id)).slice(0, 2);
  if (!list.length) return null;
  return list.map((a) => (
    <div key={a.id} className="announce" role="status">
      <Icon name="send" size={18} style={{ color: 'var(--accent)', flexShrink: 0, marginTop: 2 }} />
      <span className="grow">
        <b>{a.title}</b>
        {a.body && <span className="pre-wrap"> {a.body}</span>}
      </span>
      <button
        className="btn ghost icon sm"
        aria-label="Close"
        onClick={() => {
          const next = [...gone, a.id].slice(-50);
          setGone(next);
          try {
            localStorage.setItem('sb.announcementsClosed', JSON.stringify(next));
          } catch {
            /* fine */
          }
        }}
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  ));
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

// "1.1.68" is newer than "1.1.9"
const newerVersion = (a, b) => {
  const pa = String(a || '0').split('.').map(Number);
  const pb = String(b || '0').split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
// A newer version is already downloaded and only needs a restart. The desktop shell's later checks say "up to date"
// while it waits (nothing newer to fetch), which hid the restart bar; its status still names the waiting version.
export const restartWaiting = (st) => !!st && st.kind === 'restart' && st.state !== 'ready' && st.state !== 'downloading' && newerVersion(st.version, st.current);

// The website's download page: the way to update by hand if the app can't update itself
const DOWNLOAD_PAGE = 'https://gostudybridge.com/download';

// A downloaded version that only needs a restart (most updates: new screens, not a new desktop app)
const canSwap = (st) => !!st && ((st.state === 'ready' && st.kind === 'restart') || restartWaiting(st));
// Errors from the checks the app makes by itself stay quiet (it tries again in 15 minutes); "Try again" shows them
let quietErrors = false;

// Look for a new version often and switch to it when it's safe (the rules are in lib/autoupdate.js)
function useAutoUpdate(st, pending) {
  const route = useRoute();
  const [switching, setSwitching] = useState(false);
  const [webReady, setWebReady] = useState(false);
  const now = useRef({});
  now.current = { st, busy: () => busyNow({ path: route.path, unsaved: hasUnsaved(), pending }) };
  useEffect(() => pageChanged(), [route.path]);

  // Desktop app: the shell downloads; this decides when to look and when to restart into the new version
  useEffect(() => {
    if (!desktop?.updatesOn) return;
    let awayAt = document.visibilityState === 'hidden' || !document.hasFocus() ? Date.now() : 0;
    let wasHidden = document.visibilityState === 'hidden';
    let going = false;
    const swap = async () => {
      if (going) return;
      going = true;
      setSwitching(true);
      await new Promise((r) => setTimeout(r, 700)); // let "Updating StudyBridge…" show first
      const r = await restartDesktop().catch((e) => ({ error: e.message }));
      if (r?.error) {
        going = false;
        setSwitching(false);
      }
    };
    const check = (since) => {
      const s = now.current.st;
      // a downloaded desktop installer waits as it is (checking again would download it again)
      if (navigator.onLine === false || !s || ['checking', 'downloading', 'ready'].includes(s.state)) return;
      if (s.checkedAt && Date.now() - s.checkedAt < since) return;
      quietErrors = true;
      desktop.updates.check().catch(() => {});
    };
    // back from the tray, a minimised window or another app: the moment to switch, or at least to look
    const back = () => {
      const hidden = wasHidden;
      const away = awayAt ? Date.now() - awayAt : 0;
      awayAt = 0;
      wasHidden = false;
      if (canSwap(now.current.st) && (hidden || away >= AWAY) && !now.current.busy()) return swap();
      check(RECHECK_ON_RETURN);
    };
    const leave = () => {
      if (!awayAt) awayAt = Date.now();
      if (document.visibilityState === 'hidden') wasHidden = true;
    };
    const vis = () => (document.visibilityState === 'hidden' ? leave() : document.hasFocus() && back());
    addEventListener('focus', back);
    addEventListener('blur', leave);
    document.addEventListener('visibilitychange', vis);
    const t = setInterval(() => {
      check(CHECK_EVERY);
      // left open and untouched for a while: switch now, so it's new when they come back
      if (canSwap(now.current.st) && document.visibilityState === 'visible' && document.hasFocus() && idleFor() >= IDLE && !now.current.busy()) swap();
    }, 60 * 1000);
    return () => {
      removeEventListener('focus', back);
      removeEventListener('blur', leave);
      document.removeEventListener('visibilitychange', vis);
      clearInterval(t);
    };
  }, []);

  // Phone / browser: look on the server; reload in the background, as you come back, or after a while untouched
  useEffect(() => {
    if (desktop || import.meta.env.DEV || !location.protocol.startsWith('http')) return;
    let last = Date.now();
    let backAt = 0;
    let ready = false;
    let looking = false;
    const reload = () => !now.current.busy() && location.reload();
    const look = async () => {
      if (ready || looking || navigator.onLine === false) return;
      looking = true;
      last = Date.now();
      try {
        ready = await webHasUpdate();
      } catch {
        /* offline or the server is busy: look again later */
      }
      looking = false;
      if (ready) {
        setWebReady(true);
        // in the background, or the app was only just opened again (phones mostly look then): switch now
        if (document.visibilityState === 'hidden' || Date.now() - backAt < 15 * 1000) reload();
      }
    };
    const vis = () => {
      if (ready) return reload();
      if (document.visibilityState !== 'visible') return;
      backAt = Date.now();
      if (Date.now() - last >= RECHECK_ON_RETURN) look();
    };
    document.addEventListener('visibilitychange', vis);
    const t = setInterval(() => {
      if (Date.now() - last >= CHECK_EVERY) look();
      if (ready && idleFor() >= IDLE) reload();
    }, 60 * 1000);
    return () => {
      document.removeEventListener('visibilitychange', vis);
      clearInterval(t);
    };
  }, []);
  return { switching, webReady };
}

function UpdateBanner({ pending = 0 }) {
  const st = useUpdateStatus();
  const { switching, webReady } = useAutoUpdate(st, pending);
  const toast = useToast();
  const [hidden, setHidden] = useState(false);
  const [hiddenState, setHiddenState] = useState('');
  if (switching) {
    return (
      <div className="updating-cover" role="status">
        <Logo size={44} />
        <b>Updating StudyBridge…</b>
        <span>It opens again in a moment, on this page.</span>
      </div>
    );
  }
  const hide = (
    <button className="btn ghost icon sm" style={{ background: 'transparent', color: '#fff', borderColor: 'transparent' }} onClick={() => setHidden(true)} aria-label="Later">
      <Icon name="x" size={16} />
    </button>
  );
  if (webReady && !hidden) {
    return (
      <div className="banner update-banner" role="status">
        <Icon name="download" size={18} />
        <span className="grow">A new version of StudyBridge is ready.</span>
        <button className="btn sm" onClick={() => location.reload()}>
          Reload
        </button>
        {hide}
      </div>
    );
  }
  if (!st || hidden) return null;
  // A new desktop app (not just new screens) is downloading: it's big, so say so, rather than look stuck
  if (st.state === 'downloading' && hiddenState !== 'downloading') {
    return (
      <div className="banner update-banner" role="status">
        <Icon name="download" size={18} />
        <span className="grow">Downloading a new version of StudyBridge{st.version ? ` (${st.version})` : ''}. You can keep working; we’ll tell you when it’s ready.</span>
        <button className="btn ghost icon sm" style={{ background: 'transparent', color: '#fff', borderColor: 'transparent' }} onClick={() => setHiddenState('downloading')} aria-label="Hide">
          <Icon name="x" size={16} />
        </button>
      </div>
    );
  }
  if (st.state === 'error' && !quietErrors && hiddenState !== 'error') {
    return (
      <div className="banner update-banner" role="status">
        <Icon name="alert" size={18} />
        <span className="grow">StudyBridge couldn’t update itself just now. It tries again later, or you can get the newest version from the website.</span>
        <button
          className="btn sm"
          onClick={() => {
            quietErrors = false;
            desktop?.updates.check().catch(() => {});
          }}
        >
          Try again
        </button>
        <a className="btn sm" href={DOWNLOAD_PAGE} target="_blank" rel="noreferrer">
          Download
        </a>
        <button className="btn ghost icon sm" style={{ background: 'transparent', color: '#fff', borderColor: 'transparent' }} onClick={() => setHiddenState('error')} aria-label="Hide">
          <Icon name="x" size={16} />
        </button>
      </div>
    );
  }
  const waiting = restartWaiting(st);
  if (st.state !== 'ready' && !waiting) return null;
  const mac = st.kind === 'mac-install';
  const install = st.kind === 'install';
  return (
    <div className="banner update-banner" role="status">
      <Icon name="download" size={18} />
      <span className="grow">
        {mac
          ? 'A new version of StudyBridge has downloaded. Open it and drag StudyBridge into Applications (replace the old one).'
          : install
            ? 'A new version of StudyBridge is ready. It closes, installs (about a minute) and opens again by itself.'
            : 'A new version of StudyBridge is ready. It switches by itself when you’re not in the middle of something.'}
      </span>
      <button
        className="btn sm"
        onClick={async () => {
          const r = mac || install ? await desktop.updates.apply() : await restartDesktop();
          if (r?.error) toast({ title: r.error, tone: 'bad' });
          if (mac) setHidden(true);
        }}
      >
        {mac ? 'Open it' : install ? 'Install now' : 'Restart now'}
      </button>
      {hide}
    </div>
  );
}
