// The StudyBridge admin account: its own sign-in (same sign-in page as everyone), separate
// from any tutor account. StudyBridge opens Admin because the account is the admin.
import { useRoute } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import Shell from '../shared/Shell.jsx';
import { LookupsProvider } from '../shared/lookups.jsx';
import Settings from '../shared/Settings.jsx';
import AdminHome, { SharedBankPage, PlatformPage, LogPage } from './Admin.jsx';
import { useProfJobs } from '../tutor/Prof.jsx';

function notificationTarget(n) {
  const r = n.ref || {};
  if (n.kind === 'prof' && r.bank) return '/bank';
  if (n.kind === 'tutor_signup') return '/';
  return '/';
}

export default function AdminApp() {
  const route = useRoute();
  const tutors = useQuery('admin-tutors', api.adminTutors, { poll: 60000 });
  const bank = useQuery('bank', api.listBank, { poll: 120000 });
  useProfJobs(); // keeps Prof's shared-question jobs moving
  const waiting = (tutors.data || []).filter((t) => t.status === 'pending').length;
  const toReview = (bank.data || []).filter((b) => b.owner_id === null && b.status === 'review').length;
  const nav = [
    { to: '/', label: 'Tutors', icon: 'users', count: waiting },
    { to: '/bank', label: 'StudyBridge questions', icon: 'cap', count: toReview, tone: 'claude' },
    { to: '/platform', label: 'StudyBridge settings', icon: 'shield' },
    { to: '/log', label: 'What’s been done', icon: 'clipboard' },
  ];
  const [a] = route.parts;
  let page;
  if (a === 'bank') page = <SharedBankPage />;
  else if (a === 'platform') page = <PlatformPage />;
  else if (a === 'log') page = <LogPage />;
  else if (a === 'settings') page = <Settings />;
  else page = <AdminHome />;
  return (
    <LookupsProvider>
      <Shell nav={nav} tabs={nav} roleLabel="Admin" notificationTarget={notificationTarget} theme="admin">
        {page}
      </Shell>
    </LookupsProvider>
  );
}
