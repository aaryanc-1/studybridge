import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getServer, readConnectFromHash, setServer, decodeInvite, desktop } from './lib/config.js';
import { sb, resetClient, isOffline } from './lib/supabase.js';
import * as api from './lib/api.js';
import * as store from './lib/store.js';
import { setScope } from './lib/data.js';
import { ToastProvider, ConfirmProvider, Loading } from './ui/kit.jsx';
import Welcome from './screens/Welcome.jsx';
import FinishSetup, { WaitingForApproval } from './screens/FinishSetup.jsx';
import TutorApp from './screens/tutor/TutorApp.jsx';
import LearnerApp from './screens/learner/LearnerApp.jsx';
import AdminApp from './screens/admin/AdminApp.jsx';
import ParentApp from './screens/parent/ParentApp.jsx';
import { rememberAccount, forgetAccount } from './lib/accounts.js';
import { installErrorReporting } from './lib/errors.js';

installErrorReporting();

// "1.1.25" → comparable number
const vnum = (v) => (String(v || '').match(/^(\d+)\.(\d+)\.(\d+)/) || []).slice(1).reduce((a, x) => a * 10000 + Number(x), 0);

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

function storedUser() {
  try {
    return JSON.parse(localStorage.getItem('sb.auth') || 'null')?.user || null;
  } catch {
    return null;
  }
}

// Opened from the "set a new password" email: choose one, then carry on
function NewPassword({ onDone }) {
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="welcome">
      <div className="box">
        <form
          className="card"
          onSubmit={async (e) => {
            e.preventDefault();
            if (pw.length < 6) return setErr('Use a password of at least 6 characters.');
            setBusy(true);
            try {
              await api.changePassword(pw);
              onDone();
            } catch (x) {
              setErr(x.message);
              setBusy(false);
            }
          }}
        >
          <h2 style={{ fontFamily: 'var(--serif)', fontSize: 24 }}>Set a new password</h2>
          <input className="input" type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password" aria-label="New password" autoComplete="new-password" />
          {err && <div className="error">{err}</div>}
          <button className="btn primary" disabled={busy}>
            Save and continue
          </button>
        </form>
      </div>
    </div>
  );
}

export default function App() {
  const [server, setServerState] = useState(() => {
    const fromQr = readConnectFromHash();
    if (fromQr) {
      setServer(fromQr);
      localStorage.setItem('sb.seen', '1');
    }
    return getServer();
  });
  const [user, setUser] = useState(undefined); // undefined = checking
  const [profile, setProfile] = useState(undefined);
  const [offlineBoot, setOfflineBoot] = useState(false);
  const [bootError, setBootError] = useState(null);
  const [recovery, setRecovery] = useState(false); // opened from a "set a new password" email

  const loadProfile = useCallback(async (u) => {
    setScope(u.id);
    const cached = await store.get(`profile:${u.id}`);
    try {
      let p = await api.getProfile(u.id);
      // A pending invite from before sign-in
      const pending = sessionStorage.getItem('sb.pendingInvite');
      if (p && !p.role && pending) {
        const inv = decodeInvite(pending);
        p = await api.joinWithCode(inv.code, sessionStorage.getItem('sb.pendingName') || p.display_name);
      }
      sessionStorage.removeItem('sb.pendingInvite');
      sessionStorage.removeItem('sb.pendingName');
      // A tutor account that still holds admin the old way is offered the move to its own admin account
      if (p?.role === 'tutor') p = { ...p, admin_to_move: !!(await api.adminToMove().catch(() => cached?.admin_to_move)) };
      if (p?.role === 'admin') p = { ...p, is_admin: true };
      if (p) await store.set(`profile:${u.id}`, p);
      rememberAccount(p);
      api.setMe(p);
      if (p?.role) api.markSeen().catch(() => {});
      setBootError(null);
      setProfile(p || null);
    } catch (e) {
      if (e.offline && cached) {
        api.setMe(cached);
        setProfile(cached);
        setOfflineBoot(true);
      } else {
        setBootError(e.message);
        setProfile(null);
      }
    }
  }, []);

  useEffect(() => {
    if (!server) {
      setUser(null);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const link = await api.sessionFromLink();
        if (link?.recovery) setRecovery(true);
      } catch {
        /* an old or used link: carry on to sign in */
      }
      const { data, error } = await sb().auth.getSession();
      if (!alive) return;
      let u = data.session?.user || null;
      if (!u && error && isOffline(error)) u = storedUser();
      if (!u && !navigator.onLine) u = storedUser();
      setUser(u);
      if (u) loadProfile(u);
    })();
    const { data: sub } = sb().auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') {
        setUser(null);
        setProfile(undefined);
        api.setMe(null);
      }
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, [server, loadProfile]);

  const ctx = useMemo(
    () => ({
      server,
      user,
      me: profile,
      offlineBoot,
      bootError,
      setServer: (s) => {
        if (s) setServer(s);
        resetClient();
        setServerState(s ? getServer() : null);
      },
      async signedIn(u) {
        setUser(u);
        await loadProfile(u);
      },
      async refreshMe() {
        if (user) await loadProfile(user);
      },
      async signOut() {
        if (user) forgetAccount(user.id);
        await api.signOut();
        setScope(null);
        setUser(null);
        setProfile(undefined);
        api.setMe(null);
      },
    }),
    [server, user, profile, offlineBoot, bootError, loadProfile],
  );

  // Tell the desktop app this version started properly (so it keeps it after an update)
  useEffect(() => {
    if (user !== undefined) desktop?.updates?.ok?.().catch?.(() => {});
  }, [user]);

  // The admin can require a minimum version (e.g. after a database change old apps can't handle)
  const [tooOld, setTooOld] = useState(null);
  useEffect(() => {
    if (!profile?.role) return;
    const mine = api.appVersion();
    if (!mine) return;
    api
      .appConfig()
      .then((c) => setTooOld(c?.min_version && vnum(mine) < vnum(c.min_version) ? c.min_version : null))
      .catch(() => {});
  }, [profile?.role]);

  let body;
  if (tooOld) body = <UpdateRequired need={tooOld} />;
  else if (recovery && user) body = <NewPassword onDone={() => setRecovery(false)} />;
  else if (user === undefined || (user && profile === undefined)) body = <Loading label="Opening StudyBridge…" />;
  else if (!server || !user) body = <Welcome />;
  else if (!profile || !profile.role) body = <FinishSetup />;
  else if (profile.role === 'admin') body = <AdminApp />;
  else if (profile.role === 'tutor' && profile.status !== 'active') body = <WaitingForApproval />;
  else if (profile.role === 'tutor') body = <TutorApp />;
  else if (profile.role === 'parent') body = <ParentApp />;
  else body = <LearnerApp />;

  return (
    <AppCtx.Provider value={ctx}>
      <ToastProvider>
        <ConfirmProvider>{body}</ConfirmProvider>
      </ToastProvider>
    </AppCtx.Provider>
  );
}

function UpdateRequired({ need }) {
  const [msg, setMsg] = useState('');
  return (
    <div className="welcome">
      <div className="box">
        <div className="hero">
          <h1>Please update StudyBridge</h1>
          <p className="lead">This version is too old to keep working with StudyBridge. Version {need} or newer is needed.</p>
        </div>
        <div className="card">
          {desktop ? (
            <>
              <div className="small">Updating takes a minute and keeps all your work.</div>
              <button
                className="btn primary"
                onClick={async () => {
                  setMsg('Getting the update…');
                  try {
                    await desktop.updates.check();
                    const r = await desktop.updates.apply();
                    if (r?.error) setMsg(r.error);
                  } catch (e) {
                    setMsg(e.message);
                  }
                }}
              >
                Update now
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={() => location.reload()}>
              Reload
            </button>
          )}
          {msg && <div className="small muted">{msg}</div>}
        </div>
      </div>
    </div>
  );
}
