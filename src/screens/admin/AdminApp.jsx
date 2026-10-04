// The StudyBridge admin account: its own sign-in (same sign-in page as everyone), separate
// from any tutor account. StudyBridge opens Admin because the account is the admin.
import { useRoute } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import Shell from '../shared/Shell.jsx';
import { LookupsProvider } from '../shared/lookups.jsx';
import Settings from '../shared/Settings.jsx';
import { TutorsPage, SharedBankPage, PlatformPage, LogPage } from './Admin.jsx';
import { Overview, TutorPage, ProblemsPage, InboxPage, AnnouncementsPage, ProfPage } from './AdminPages.jsx';
import PapersAdmin from './PapersAdmin.jsx';
import { useProfJobs } from '../tutor/Prof.jsx';

function notificationTarget(n) {
  const r = n.ref || {};
  if (n.kind === 'prof' && r.bank) return '/bank';
  if (n.kind === 'tutor_signup') return '/tutors';
  if (n.kind === 'prof_limit' && r.user_id) return `/tutors/${r.user_id}`;
  if (n.kind === 'prof_credit') return '/prof';
  if (n.kind === 'problem') return '/problems';
  if (n.kind === 'feedback') return '/inbox';
  if (n.kind === 'prof' && r.paper_id) return '/papers';
  return '/';
}

export default function AdminApp() {
  const route = useRoute();
  const tutors = useQuery('admin-tutors', api.adminTutors, { poll: 60000 });
  const bank = useQuery('bank', api.listBank, { poll: 120000 });
  const overview = useQuery('admin-overview', api.adminOverview, { poll: 60000 });
  useProfJobs(); // keeps Prof's shared-question jobs moving
  const waiting = (tutors.data || []).filter((t) => t.status === 'pending').length;
  const toReview = (bank.data || []).filter((b) => b.owner_id === null && b.status === 'review').length;
  const o = overview.data || {};
  const nav = [
    { to: '/', label: 'Overview', icon: 'home' },
    { to: '/tutors', label: 'Tutors', icon: 'users', count: waiting },
    { to: '/inbox', label: 'Inbox', icon: 'message', count: o.feedback_open },
    { to: '/problems', label: 'Problems', icon: 'alert', count: o.problems_open, tone: 'claude' },
    { to: '/prof', label: 'Prof', icon: 'cap', tone: 'claude' },
    { to: '/announcements', label: 'Announcements', icon: 'send' },
    { to: '/papers', label: 'StudyBridge papers', icon: 'clipboard' },
    { to: '/bank', label: 'StudyBridge questions', icon: 'cap', count: toReview, tone: 'claude' },
    { to: '/platform', label: 'StudyBridge settings', icon: 'shield' },
    { to: '/log', label: 'What’s been done', icon: 'file' },
  ];
  const tabs = [nav[0], nav[1], nav[2], nav[3]];
  const [a, b] = route.parts;
  let page;
  if (a === 'tutors' && b) page = <TutorPage id={b} />;
  else if (a === 'tutors') page = <TutorsPage />;
  else if (a === 'inbox') page = <InboxPage />;
  else if (a === 'problems') page = <ProblemsPage />;
  else if (a === 'announcements') page = <AnnouncementsPage />;
  else if (a === 'prof') page = <ProfPage />;
  else if (a === 'papers') page = <PapersAdmin />;
  else if (a === 'bank') page = <SharedBankPage />;
  else if (a === 'platform') page = <PlatformPage />;
  else if (a === 'log') page = <LogPage />;
  else if (a === 'settings') page = <Settings />;
  else page = <Overview />;
  return (
    <LookupsProvider>
      <Shell nav={nav} tabs={tabs} roleLabel="Admin" notificationTarget={notificationTarget} theme="admin">
        {page}
      </Shell>
    </LookupsProvider>
  );
}
