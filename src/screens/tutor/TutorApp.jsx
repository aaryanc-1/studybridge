import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Link, Page, useRoute } from '../../ui/kit.jsx';
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
import Live, { MeetingRoom, Watch } from '../shared/Live.jsx';
import { useFamilyUnread } from '../shared/Families.jsx';
import { MeetingPage } from '../shared/Meetings.jsx';
import Settings from '../shared/Settings.jsx';
import FileView from '../shared/FileView.jsx';
import { OfficialView } from './PastPapers.jsx';
import ParentReports, { useWeeklyReports } from './ParentReports.jsx';
import Centre from './Centre.jsx';
import SeeAs from './SeeAs.jsx';
import { RegisterPage } from '../shared/School.jsx';
import { LessonPlanPage, ProgrammeOfInquiry } from '../shared/Planner.jsx';
import { ProjectPage } from '../shared/Projects.jsx';
import TutorProjects from './ProjectsAdmin.jsx';
import TermReports from './TermReports.jsx';
import { TermReportPage, TranscriptPage } from '../shared/TermReport.jsx';
import { TimetableSetup, TutorTimetable } from './SchoolSetup.jsx';
import Office, { StudentPage, officeAccess } from './Office.jsx';
import { PeerPage } from '../shared/Peer.jsx';

function notificationTarget(n, office, officeOnly) {
  const r = n.ref || {};
  // parents, more (6 Nov 2026): messages with families, parents' meetings, and comments on a learner's portfolio
  if ((n.kind === 'family_message' || n.kind === 'family_report') && r.thread_id) return officeOnly ? `/office/messages/${r.thread_id}` : `/messages/families/${r.thread_id}`;
  if (n.kind === 'meeting' && r.event_id) return `/meetings/${r.event_id}`;
  // classroom gaps (7 Nov 2026): peer reviews to check or reported, and a learner waiting for their Drive copy
  if ((n.kind === 'peer_done' || n.kind === 'peer_report') && r.assignment_id) return `/peer/${r.assignment_id}`;
  if (n.kind === 'drive_ask' && r.assignment_id) return `/assignments/${r.assignment_id}`;
  if (n.kind === 'portfolio_comment' && r.learner_id) return `/learners/${r.learner_id}/portfolio`;
  // the school office (5 Nov 2026): absences families report, and changes to a learner's details
  if (n.kind === 'absence_report') return office ? '/office/absences' : '/timetable/attendance';
  if (n.kind === 'record' && r.learner_id) return office ? `/student/${r.learner_id}` : `/learners/${r.learner_id}/details`;
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
  if (n.kind === 'cover') return '/timetable';
  if (n.kind === 'core') return r.project_id ? `/projects/p/${r.project_id}` : '/projects';
  if (n.kind === 'term_proof' && r.round_id) return `/learners/terms/${r.round_id}/${r.class_id}`;
  if (n.kind === 'reports_on' || n.kind === 'report_ready' || (n.kind === 'prof' && r.report_id)) return '/learners/reports';
  return '/';
}

export default function TutorApp() {
  const app = useApp();
  const route = useRoute();
  const attempts = useQuery('attempts', api.listAttempts);
  const comments = useQuery('comments', api.listComments);
  const toMark = (attempts.data || []).filter((a) => a.status === 'submitted').length;
  const unreadNotes = (comments.data || []).filter((c) => c.author_id !== app.me.id && !c.read_at).length + useFamilyUnread();
  const draftCount = useDraftCounts();
  useProfJobs(); // keeps Prof's requests moving (e.g. sending book pages) on every page
  const reportsToSend = useWeeklyReports(); // drafts last week's parent reports
  // a tuition centre's managers get a Centre page: every tutor and learner in it
  const org = useQuery('org', api.myOrg).data;
  const manager = !!org && org.role === 'manager' && (org.kind === 'centre' || org.kind === 'school');
  // the school office: its office and managers (everyone), heads of year (their years); office staff teach nobody, so
  // their menu is just the office and the centre
  const office = officeAccess(org);
  const officeOnly = !!org && org.role === 'office' && (org.kind === 'centre' || org.kind === 'school');
  // IB core and the PYP: coordinators (a centre's or school's managers) and anyone supervising a project
  const coreOn = useQuery('core-on', api.coreOn).data;

  // every tutor has Timetable: their week with each lesson's register, and their learners' attendance and behaviour
  const nav = officeOnly ? [
    { to: '/', label: 'Office', icon: 'clipboard', also: ['/office', '/student', '/register', '/report', '/transcript', '/meetings', '/live'] },
    { to: '/centre', label: 'Centre', icon: 'chart' },
  ] : [
    { to: '/', label: 'Home', icon: 'home' },
    { to: '/timetable', label: 'Timetable', icon: 'calendar', also: ['/register', '/plan', '/meetings'] },
    { to: '/learners', label: 'Learners', icon: 'users', count: reportsToSend, also: ['/see', '/reports'] },
    { to: '/assignments', label: 'Assignments', icon: 'clipboard', also: ['/mocks'] },
    { to: '/marking', label: 'Marking', icon: 'checkCircle', count: toMark },
    { to: '/library', label: 'Library', icon: 'book', also: ['/file', '/lesson', '/structure'] },
    { to: '/messages', label: 'Messages', icon: 'message', count: unreadNotes },
    { to: '/live', label: 'Live', icon: 'video', also: ['/watch'] },
    ...(coreOn ? [{ to: '/projects', label: 'Projects', icon: 'flag' }] : []),
    { to: '/prof', label: 'Prof', icon: 'cap', count: draftCount, tone: 'claude', also: ['/claude'] },
    ...(office ? [{ to: '/office', label: 'Office', icon: 'clipboard', also: ['/student'] }] : []),
    ...(manager ? [{ to: '/centre', label: 'Centre', icon: 'chart' }] : []),
    ...(app.me.admin_to_move ? [{ to: '/admin', label: 'Admin', icon: 'shield', count: 1 }] : []),
  ];
  const byTo = (to) => nav.find((x) => x.to === to);
  const tabs = officeOnly ? nav : [byTo('/'), byTo('/assignments'), byTo('/marking'), byTo('/messages'), byTo('/learners')];

  const [a, b, c] = route.parts;
  let page;
  if (officeOnly && (!a || a === 'office')) page = <Office tab={b} />;
  else if (a === 'office' && office) page = <Office tab={b} />;
  else if (a === 'student' && b && office) page = <StudentPage id={b} />;
  else if (!a) page = <Home />;
  else if (a === 'learners' && b === 'classes' && c) page = <ClassPage id={c} tab={route.parts[3]} />;
  else if (a === 'learners' && b === 'classes') page = <Learners tab="classes" />;
  else if (a === 'learners' && b === 'school') page = <SchoolLearners />;
  else if (a === 'exam' && b) page = <ExamRoom id={b} />;
  else if ((a === 'learners' && b === 'reports') || a === 'reports') page = <ParentReports />;
  else if (a === 'learners' && b === 'terms') page = <TermReports round={c} part={route.parts[3]} />;
  else if (a === 'report' && b && c) page = <TermReportPage round={b} learner={c} />;
  else if (a === 'transcript' && b) page = <TranscriptPage learner={b} />;
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
  else if (a === 'peer' && b) page = <PeerPage id={b} />;
  else if (a === 'marking') page = <Marking />;
  else if (a === 'prof' && b === 'history') page = <ProfHistory />;
  else if (a === 'claude' || a === 'prof') page = <Prof />;
  else if (a === 'admin' && app.me.admin_to_move) page = <MoveAdmin />;
  else if (a === 'messages' && b === 'families') page = <Messages tab="families" threadId={c} />;
  else if (a === 'messages') page = <Messages learnerId={b} />;
  else if (a === 'meetings' && b) page = <MeetingPage id={b} />;
  else if (a === 'live' && b === 'meeting' && c) page = <MeetingRoom bookingId={c} title="Parents’ meeting" onLeave={() => window.history.back()} />;
  else if (a === 'live') page = <Live sessionId={b} />;
  else if (a === 'watch' && b) page = <Watch attemptId={b} />;
  else if (a === 'settings') page = <Settings />;
  else if (a === 'centre' && (manager || officeOnly)) page = <Centre tab={b} />;
  else if (a === 'timetable' && b === 'setup')
    page = (
      <Page title="Set out lessons" subtitle="The school day, its terms and holidays, and each class’s lessons in the week.">
        <TimetableSetup />
      </Page>
    );
  else if (a === 'timetable') page = <TutorTimetable tab={b} />;
  else if (a === 'register' && b && c) page = <RegisterPage kind={b} id={c} day={route.parts[3]} />;
  else if (a === 'projects' && b === 'p' && c) page = <ProjectPage id={c} />;
  else if (a === 'projects') page = <TutorProjects tab={b} id={c} />;
  else if (a === 'programme') page = <ProgrammeOfInquiry />;
  else if (a === 'plan' && b && c)
    page = (
      <Page
        eyebrow={
          <Link to="/timetable">
            <Icon name="left" size={14} /> Timetable
          </Link>
        }
        title="Lesson plan"
      >
        <LessonPlanPage kind={b} id={c} day={route.parts[3]} />
      </Page>
    );
  else page = officeOnly ? <Office /> : <Home />;

  return (
    <LookupsProvider tutor>
      <Shell nav={nav} tabs={tabs} roleLabel={officeOnly ? 'Office' : 'Tutor'} notificationTarget={(n) => notificationTarget(n, !!office, officeOnly)}>
        {page}
      </Shell>
    </LookupsProvider>
  );
}
