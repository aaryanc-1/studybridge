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

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

function storedUser() {
  try {
    return JSON.parse(localStorage.getItem('sb.auth') || 'null')?.user || null;
  } catch {
    return null;
  }
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

  const loadProfile = useCallback(async (u) => {
    setScope(u.id);
    const cached = await store.get(`profile:${u.id}`);
    try {
      let p = await api.getProfile(u.id);
      // A pending invite from before sign-in
      const pending = sessionStorage.getItem('sb.pendingInvite');
      if (p && !p.role && pending) {
        const inv = decodeInvite(pending);
        p = await api.acceptInvite(inv.code, sessionStorage.getItem('sb.pendingName') || p.display_name);
      }
      sessionStorage.removeItem('sb.pendingInvite');
      sessionStorage.removeItem('sb.pendingName');
      // A tutor account that still holds admin the old way is offered the move to its own admin account
      if (p?.role === 'tutor') p = { ...p, admin_to_move: !!(await api.adminToMove().catch(() => cached?.admin_to_move)) };
      if (p?.role === 'admin') p = { ...p, is_admin: true };
      if (p) await store.set(`profile:${u.id}`, p);
      api.setMe(p);
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

  let body;
  if (user === undefined || (user && profile === undefined)) body = <Loading label="Opening StudyBridge…" />;
  else if (!server || !user) body = <Welcome />;
  else if (!profile || !profile.role) body = <FinishSetup />;
  else if (profile.role === 'admin') body = <AdminApp />;
  else if (profile.role === 'tutor' && profile.status !== 'active') body = <WaitingForApproval />;
  else if (profile.role === 'tutor') body = <TutorApp />;
  else body = <LearnerApp />;

  return (
    <AppCtx.Provider value={ctx}>
      <ToastProvider>
        <ConfirmProvider>{body}</ConfirmProvider>
      </ToastProvider>
    </AppCtx.Provider>
  );
}
