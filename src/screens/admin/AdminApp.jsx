// The StudyBridge admin account: its own sign-in (same sign-in page as everyone), separate
// from any tutor account. StudyBridge opens Admin because the account is the admin.
import { useRoute } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import Shell from '../shared/Shell.jsx';
import { LookupsProvider } from '../shared/lookups.jsx';
import Settings from '../shared/Settings.jsx';
import { TutorsPage, PlatformPage, LogPage } from './Admin.jsx';
import { Overview, TutorPage, ProblemsPage, InboxPage, AnnouncementsPage, ProfPage } from './AdminPages.jsx';
import SellingPage from './Selling.jsx';
import StudentsPage from './Students.jsx';
import ContentPage from './Content.jsx';
import DemoPage from './Demo.jsx';

function notificationTarget(n) {
  const r = n.ref || {};
  if (n.kind === 'tutor_signup') return '/tutors';
  if (n.kind === 'prof_limit' && r.user_id) return `/tutors/${r.user_id}`;
  if (n.kind === 'prof_credit' || n.kind === 'prof') return '/prof';
  if (n.kind === 'problem') return '/problems';
  if (n.kind === 'feedback') return '/inbox';
  if (n.kind === 'content_report' || n.kind === 'content_check') return '/content';
  return '/';
}

export default function AdminApp() {
  const route = useRoute();
  const tutors = useQuery('admin-tutors', api.adminTutors, { poll: 60000 });
  const overview = useQuery('admin-overview', api.adminOverview, { poll: 60000 });
  // StudyBridge's own content (for students on their own and for tutors): what needs the Owner
  const content = useQuery('admin-content', api.adminContentReview, { poll: 120000 }).data;
  const contentOpen = content ? content.questions.length + content.lessons.length + content.reports.length : 0;
  const waiting = (tutors.data || []).filter((t) => t.status === 'pending').length;
  const o = overview.data || {};
  const nav = [
    { to: '/', label: 'Overview', icon: 'home' },
    { to: '/tutors', label: 'Tutors', icon: 'users', count: waiting },
    { to: '/students', label: 'Students', icon: 'book' },
    { to: '/content', label: 'Content', icon: 'layers', count: contentOpen },
    { to: '/inbox', label: 'Inbox', icon: 'message', count: o.feedback_open },
    { to: '/problems', label: 'Problems', icon: 'alert', count: o.problems_open, tone: 'claude' },
    { to: '/prof', label: 'Prof', icon: 'cap', tone: 'claude' },
    { to: '/announcements', label: 'Announcements', icon: 'send' },
    { to: '/platform', label: 'StudyBridge settings', icon: 'shield' },
    { to: '/selling', label: 'Selling', icon: 'star' },
    { to: '/log', label: 'What’s been done', icon: 'file' },
    { to: '/demo', label: 'Demo', icon: 'eye' },
  ];
  const tabs = [nav[0], nav[1], nav[2], nav[3]];
  const [a, b] = route.parts;
  let page;
  if (a === 'tutors' && b) page = <TutorPage id={b} />;
  else if (a === 'tutors') page = <TutorsPage />;
  else if (a === 'students') page = <StudentsPage />;
  else if (a === 'content') page = <ContentPage />;
  else if (a === 'inbox') page = <InboxPage />;
  else if (a === 'problems') page = <ProblemsPage />;
  else if (a === 'announcements') page = <AnnouncementsPage />;
  else if (a === 'prof') page = <ProfPage />;
  else if (a === 'platform') page = <PlatformPage />;
  else if (a === 'selling') page = <SellingPage />;
  else if (a === 'log') page = <LogPage />;
  else if (a === 'demo') page = <DemoPage />;
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
