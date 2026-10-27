import { useApp } from '../../App.jsx';
import { useRoute } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import Shell from '../shared/Shell.jsx';
import { LookupsProvider } from '../shared/lookups.jsx';
import Home from './Home.jsx';
import Learners, { LearnerDetail } from './Learners.jsx';
import ClassPage from './ClassPage.jsx';
import SchoolLearners from './SchoolLearners.jsx';
import ExamRoom from './ExamRoom.jsx';
import Library, { LessonEditor } from './Library.jsx';
import Assignments from './Assignments.jsx';
import AssignmentEditor from './AssignmentEditor.jsx';
import MockPage from './Mocks.jsx';
import Marking, { MarkAttempt } from './Marking.jsx';
import { useDraftCounts } from './ClaudeInbox.jsx';
import Prof, { useProfJobs, ProfHistory } from './Prof.jsx';
import { MoveAdmin } from './MoveAdmin.jsx';
import Messages from '../shared/Messages.jsx';
import Live, { Watch } from '../shared/Live.jsx';
import Settings from '../shared/Settings.jsx';
import FileView from '../shared/FileView.jsx';
import { OfficialView } from './PastPapers.jsx';
import ParentReports, { useWeeklyReports } from './ParentReports.jsx';
import Centre from './Centre.jsx';
import SeeAs from './SeeAs.jsx';

function notificationTarget(n) {
  const r = n.ref || {};
  if ((n.kind === 'submitted' || n.kind === 'self_marked') && r.attempt_id) return `/marking/${r.attempt_id}`;
  if (n.kind === 'note' && r.learner_id) return `/messages/${r.learner_id}`;
  if (n.kind === 'joined' && r.learner_id) return `/learners/${r.learner_id}`;
  if (n.kind === 'lockdown' && r.attempt_id) return `/watch/${r.attempt_id}`;
  if (n.kind === 'prof' && r.bank) return '/library/bank';
  if (n.kind === 'prof' && r.report_id) return '/learners/reports';
  if (n.kind === 'prof' && r.boundaries) return `/library/papers?exam=${encodeURIComponent(r.exam || '')}`;
  if (n.kind === 'prof' && r.syllabus) return `/library/syllabus?subject=${r.subject_id}`;
  if (n.kind === 'prof' && r.cards) return `/library/cards?subject=${r.subject_id}`;
  if (n.kind === 'prof') return r.attempt_id ? `/marking/${r.attempt_id}` : r.assignment_id ? `/assignments/${r.assignment_id}` : r.lesson_id ? `/lesson/${r.lesson_id}` : '/prof';
  if (n.kind === 'feedback_reply') return '/settings?s=contact';
  if (n.kind === 'org') return '/settings?s=org';
  if ((n.kind === 'class_post' || n.kind === 'stream_reply') && r.class_id) return `/learners/classes/${r.class_id}/stream`;
  if (n.kind === 'class') return '/learners/classes';
  if (n.kind === 'reports_on' || n.kind === 'report_ready' || (n.kind === 'prof' && r.report_id)) return '/learners/reports';
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
  const reportsToSend = useWeeklyReports(); // drafts last week's parent reports
  // a tuition centre's managers get a Centre page: every tutor and learner in it
  const org = useQuery('org', api.myOrg).data;
  const manager = !!org && org.role === 'manager' && (org.kind === 'centre' || org.kind === 'school');

  const nav = [
    { to: '/', label: 'Home', icon: 'home' },
    { to: '/learners', label: 'Learners', icon: 'users', count: reportsToSend, also: ['/see', '/reports'] },
    { to: '/assignments', label: 'Assignments', icon: 'clipboard', also: ['/mocks'] },
    { to: '/marking', label: 'Marking', icon: 'checkCircle', count: toMark },
    { to: '/library', label: 'Library', icon: 'book', also: ['/file', '/lesson', '/structure'] },
    { to: '/messages', label: 'Messages', icon: 'message', count: unreadNotes },
    { to: '/live', label: 'Live', icon: 'video', also: ['/watch'] },
    { to: '/prof', label: 'Prof', icon: 'cap', count: draftCount, tone: 'claude', also: ['/claude'] },
    ...(manager ? [{ to: '/centre', label: 'Centre', icon: 'chart' }] : []),
    ...(app.me.admin_to_move ? [{ to: '/admin', label: 'Admin', icon: 'shield', count: 1 }] : []),
  ];
  const tabs = [nav[0], nav[2], nav[3], nav[5], nav[1]];

  const [a, b, c] = route.parts;
  let page;
  if (!a) page = <Home />;
  else if (a === 'learners' && b === 'classes' && c) page = <ClassPage id={c} tab={route.parts[3]} />;
  else if (a === 'learners' && b === 'classes') page = <Learners tab="classes" />;
  else if (a === 'learners' && b === 'school') page = <SchoolLearners />;
  else if (a === 'exam' && b) page = <ExamRoom id={b} />;
  else if ((a === 'learners' && b === 'reports') || a === 'reports') page = <ParentReports />;
  else if (a === 'see' && b) page = <SeeAs learnerId={b} tab={c} id={route.parts[3]} />;
  else if (a === 'learners' && b) page = <LearnerDetail id={b} tab={c} />;
  else if (a === 'learners') page = <Learners />;
  else if (a === 'structure') page = <Library tab="subjects" />;
  else if (a === 'library') page = <Library tab={b} />;
  else if (a === 'lesson') page = <LessonEditor id={b} />;
  else if (a === 'file') page = <FileView id={b} />;
  else if (a === 'official' && b) page = <OfficialView url={decodeURIComponent(b)} />;
  else if (a === 'assignments' && b) page = <AssignmentEditor id={b} />;
  else if (a === 'assignments') page = <Assignments />;
  else if (a === 'mocks' && b) page = <MockPage id={b} />;
  else if (a === 'marking' && b) page = <MarkAttempt id={b} />;
  else if (a === 'marking') page = <Marking />;
  else if (a === 'prof' && b === 'history') page = <ProfHistory />;
  else if (a === 'claude' || a === 'prof') page = <Prof />;
  else if (a === 'admin' && app.me.admin_to_move) page = <MoveAdmin />;
  else if (a === 'messages') page = <Messages learnerId={b} />;
  else if (a === 'live') page = <Live sessionId={b} />;
  else if (a === 'watch' && b) page = <Watch attemptId={b} />;
  else if (a === 'settings') page = <Settings />;
  else if (a === 'centre' && manager) page = <Centre />;
  else page = <Home />;

  return (
    <LookupsProvider tutor>
      <Shell nav={nav} tabs={tabs} roleLabel="Tutor" notificationTarget={notificationTarget}>
        {page}
      </Shell>
    </LookupsProvider>
  );
}
