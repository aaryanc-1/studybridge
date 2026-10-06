import { useEffect } from 'react';
import { useApp } from '../../App.jsx';
import { desktop } from '../../lib/config.js';
import { useRoute } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import Shell from '../shared/Shell.jsx';
import { LookupsProvider } from '../shared/lookups.jsx';
import Today from './Today.jsx';
import Work, { WorkDetail } from './Work.jsx';
import Attempt from './Attempt.jsx';
import Results from './Results.jsx';
import LearnerLibrary, { LessonView } from './LearnerLibrary.jsx';
import ProgressView from '../shared/Progress.jsx';
import Messages from '../shared/Messages.jsx';
import Live from '../shared/Live.jsx';
import Settings from '../shared/Settings.jsx';
import FileView from '../shared/FileView.jsx';
import Study from './Study.jsx';
import { ErrorBoundary, Page, go } from '../../ui/kit.jsx';

function notificationTarget(n) {
  const r = n.ref || {};
  if ((n.kind === 'marked' || n.kind === 'auto_submitted') && r.attempt_id) return `/results/${r.attempt_id}`;
  if (n.kind === 'attempt_cancelled') return '/work';
  if (n.kind === 'cards') return '/study';
  if (n.kind === 'message') return '/messages';
  if (n.kind === 'session') return '/live';
  if (n.kind === 'assignment' && r.assignment_id) return `/work/${r.assignment_id}`;
  if (n.kind === 'lesson' && r.lesson_id) return `/lesson/${r.lesson_id}`;
  return '/';
}

function useBackIntoLockedExam(inside) {
  useEffect(() => {
    if (!desktop || inside) return;
    let alive = true;
    (async () => {
      try {
        const [mine, list] = await Promise.all([api.myAttempts(), api.listAssignments()]);
        const locked = (mine || []).find((t) => t.status === 'in_progress' && (list || []).find((x) => x.id === t.assignment_id)?.lockdown);
        if (!alive || !locked) return;
        const r = await api.lockdownStrike(locked.id, 'Closed StudyBridge during the exam and came back');
        go(r.handed_in ? `/results/${locked.id}` : `/attempt/${locked.id}`);
      } catch {
        /* offline: nothing to do */
      }
    })();
    return () => {
      alive = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
}

export default function LearnerApp() {
  const app = useApp();
  const route = useRoute();
  const comments = useQuery('comments', api.listComments);
  const unread = (comments.data || []).filter((c) => c.author_id !== app.me.id && !c.read_at).length;
  const [a, b] = route.parts;
  useBackIntoLockedExam(a === 'attempt');

  // Doing work takes over the whole window (and may be locked down)
  if (a === 'attempt' && b)
    return (
      <LookupsProvider>
        <div className="theme-learner" style={{ height: '100%' }}>
          <ErrorBoundary>
            <Attempt id={b} />
          </ErrorBoundary>
        </div>
      </LookupsProvider>
    );

  const nav = [
    { to: '/', label: 'Today', icon: 'home' },
    { to: '/work', label: 'My work', icon: 'clipboard', also: ['/results'] },
    { to: '/study', label: 'Study', icon: 'flame' },
    { to: '/library', label: 'Library', icon: 'book', also: ['/lesson', '/file'] },
    { to: '/progress', label: 'Progress', icon: 'chart' },
    { to: '/messages', label: 'Messages', icon: 'message', count: unread },
    { to: '/live', label: 'Live', icon: 'video' },
  ];
  const tabs = [nav[0], nav[1], nav[2], nav[5], nav[3]];

  let page;
  if (!a) page = <Today />;
  else if (a === 'work' && b) page = <WorkDetail id={b} />;
  else if (a === 'work') page = <Work />;
  else if (a === 'results' && b) page = <Results id={b} />;
  else if (a === 'study') page = <Study />;
  else if (a === 'library') page = <LearnerLibrary />;
  else if (a === 'lesson' && b) page = <LessonView id={b} />;
  else if (a === 'file' && b) page = <FileView id={b} />;
  else if (a === 'progress')
    page = (
      <Page title="My progress" subtitle="Time you’ve spent, how your work went, and which topics are strong or need more practice.">
        <ProgressView learnerId={app.me.id} name={app.me.display_name} />
      </Page>
    );
  else if (a === 'messages') page = <Messages />;
  else if (a === 'live') page = <Live sessionId={b} />;
  else if (a === 'settings') page = <Settings />;
  else page = <Today />;

  return (
    <LookupsProvider>
      <Shell nav={nav} tabs={tabs} roleLabel="Learner" notificationTarget={notificationTarget} theme="learner">
        {page}
      </Shell>
    </LookupsProvider>
  );
}
