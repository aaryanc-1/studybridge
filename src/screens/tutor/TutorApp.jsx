import { useApp } from '../../App.jsx';
import { useRoute } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import Shell from '../shared/Shell.jsx';
import { LookupsProvider } from '../shared/lookups.jsx';
import Home from './Home.jsx';
import Learners, { LearnerDetail } from './Learners.jsx';
import Structure from './Structure.jsx';
import Library, { LessonEditor } from './Library.jsx';
import Assignments from './Assignments.jsx';
import AssignmentEditor from './AssignmentEditor.jsx';
import Marking, { MarkAttempt } from './Marking.jsx';
import { useDraftCounts } from './ClaudeInbox.jsx';
import Prof, { useProfJobs } from './Prof.jsx';
import Admin from './Admin.jsx';
import Messages from '../shared/Messages.jsx';
import Live, { Watch } from '../shared/Live.jsx';
import Settings from '../shared/Settings.jsx';
import FileView from '../shared/FileView.jsx';

function notificationTarget(n) {
  const r = n.ref || {};
  if (n.kind === 'submitted' && r.attempt_id) return `/marking/${r.attempt_id}`;
  if (n.kind === 'note' && r.learner_id) return `/messages/${r.learner_id}`;
  if (n.kind === 'joined' && r.learner_id) return `/learners/${r.learner_id}`;
  if (n.kind === 'lockdown' && r.attempt_id) return `/watch/${r.attempt_id}`;
  if (n.kind === 'prof') return r.attempt_id ? `/marking/${r.attempt_id}` : r.assignment_id ? `/assignments/${r.assignment_id}` : r.lesson_id ? `/lesson/${r.lesson_id}` : '/prof';
  if (n.kind === 'tutor_signup') return '/admin';
  return '/';
}

export default function TutorApp() {
  const app = useApp();
  const route = useRoute();
  const attempts = useQuery('attempts', api.listAttempts);
  const comments = useQuery('comments', api.listComments);
  const toMark = (attempts.data || []).filter((a) => a.status === 'submitted').length;
  const unreadNotes = (comments.data || []).filter((c) => c.author_id !== app.me.id && !c.read_at).length;
  const draftCount = useDraftCounts();
  useProfJobs(); // keeps Prof's requests moving (e.g. sending book pages) on every page
  const admin = useQuery(app.me.is_admin ? 'admin-tutors' : null, api.adminTutors, { poll: 60000 });
  const waitingTutors = (admin.data || []).filter((t) => t.status === 'pending').length;

  const nav = [
    { to: '/', label: 'Home', icon: 'home' },
    { to: '/learners', label: 'Learners', icon: 'users' },
    { to: '/assignments', label: 'Assignments', icon: 'clipboard' },
    { to: '/marking', label: 'Marking', icon: 'checkCircle', count: toMark },
    { to: '/library', label: 'Library', icon: 'book', also: ['/file', '/lesson'] },
    { to: '/messages', label: 'Messages', icon: 'message', count: unreadNotes },
    { to: '/live', label: 'Live', icon: 'video', also: ['/watch'] },
    { to: '/structure', label: 'Subjects', icon: 'layers' },
    { to: '/prof', label: 'Prof', icon: 'cap', count: draftCount, tone: 'claude', also: ['/claude'] },
    ...(app.me.is_admin ? [{ to: '/admin', label: 'Admin', icon: 'shield', count: waitingTutors }] : []),
  ];
  const tabs = [nav[0], nav[2], nav[3], nav[5], nav[1]];

  const [a, b, c] = route.parts;
  let page;
  if (!a) page = <Home />;
  else if (a === 'learners' && b) page = <LearnerDetail id={b} tab={c} />;
  else if (a === 'learners') page = <Learners />;
  else if (a === 'structure') page = <Structure />;
  else if (a === 'library') page = <Library tab={b} />;
  else if (a === 'lesson') page = <LessonEditor id={b} />;
  else if (a === 'file') page = <FileView id={b} />;
  else if (a === 'assignments' && b) page = <AssignmentEditor id={b} />;
  else if (a === 'assignments') page = <Assignments />;
  else if (a === 'marking' && b) page = <MarkAttempt id={b} />;
  else if (a === 'marking') page = <Marking />;
  else if (a === 'claude' || a === 'prof') page = <Prof />;
  else if (a === 'admin') page = <Admin />;
  else if (a === 'messages') page = <Messages learnerId={b} />;
  else if (a === 'live') page = <Live sessionId={b} />;
  else if (a === 'watch' && b) page = <Watch attemptId={b} />;
  else if (a === 'settings') page = <Settings />;
  else page = <Home />;

  return (
    <LookupsProvider tutor>
      <Shell nav={nav} tabs={tabs} roleLabel="Tutor" notificationTarget={notificationTarget}>
        {page}
      </Shell>
    </LookupsProvider>
  );
}
