// "See it as …": a tutor sees one learner's own screens (Today, My work, Library, Study, Progress) exactly as that
// learner would, from what the tutor can already read. Nothing can be pressed: links move around inside the preview,
// and buttons, fields and switches do nothing. Their messages stay private.
import Icon from '../../ui/Icon.jsx';
import { AsLearnerApp } from '../../App.jsx';
import { Empty, Link, Page, Seg, go, useToast } from '../../ui/kit.jsx';
import { AsLearnerCtx, usePreviewOpen } from '../../lib/data.js';
import { LookupsProvider, useLookups } from '../shared/lookups.jsx';
import Today from '../learner/Today.jsx';
import Work, { WorkDetail } from '../learner/Work.jsx';
import LearnerLibrary, { LessonView } from '../learner/LearnerLibrary.jsx';
import { StudyForTutor } from '../learner/Study.jsx';
import ProgressView from '../shared/Progress.jsx';

const TABS = [
  { value: 'today', label: 'Today', icon: 'home' },
  { value: 'work', label: 'My work', icon: 'clipboard' },
  { value: 'library', label: 'Library', icon: 'book' },
  { value: 'study', label: 'Study', icon: 'flame' },
  { value: 'progress', label: 'Progress', icon: 'chart' },
];

export default function SeeAs({ learnerId, tab = 'today', id }) {
  const lk = useLookups();
  const toast = useToast();
  usePreviewOpen();
  const l = lk.learner(learnerId);
  if (!l) return <Page title="See it as a learner">{lk.ready ? <Empty title="That learner isn’t yours">Pick one from Learners.</Empty> : null}</Page>;
  const first = l.display_name.split(' ')[0];
  const base = `/see/${learnerId}`;
  // where a link inside their screens goes, inside the preview
  const inside = (path) => {
    const [, a, b] = path.split('?')[0].split('/');
    if (!a) return base;
    if (a === 'work' || a === 'library' || a === 'study' || a === 'progress') return `${base}/${a}${b ? '/' + b : ''}`;
    if (a === 'lesson' && b) return `${base}/lesson/${b}`;
    return null;
  };
  function onClickCapture(e) {
    const link = e.target.closest('a[href^="#/"]');
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      const to = inside(link.getAttribute('href').slice(1));
      if (to) go(to);
      else toast(`That opens something only ${first} can use.`);
      return;
    }
    // tabs inside their pages still switch; anything else (buttons, switches, fields) does nothing here
    if (e.target.closest('.seg, [role=tab]')) return;
    if (e.target.closest('button, [role=button], [role=switch], input, select, textarea, label, summary')) {
      e.preventDefault();
      e.stopPropagation();
      toast(`This is how ${first} sees it: you can’t press things here.`);
    }
  }
  const block = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  let page;
  if (tab === 'work' && id) page = <WorkDetail id={id} />;
  else if (tab === 'work') page = <Work />;
  else if (tab === 'lesson' && id) page = <LessonView id={id} />;
  else if (tab === 'library') page = <LearnerLibrary />;
  else if (tab === 'study') page = <StudyForTutor learnerId={learnerId} />;
  else if (tab === 'progress') page = <ProgressView learnerId={learnerId} name={l.display_name} />;
  else page = <Today />;

  return (
    <div className="see-as">
      <div className="banner demo see-as-bar" role="status">
        <Icon name="eye" size={18} />
        <span className="grow">
          You’re seeing StudyBridge as {l.display_name} sees it right now. Nothing here can be pressed, and their messages stay private.
        </span>
        <Link to={`/learners/${learnerId}`} className="btn sm">
          Back to {first}’s page
        </Link>
      </div>
      <div className="see-as-tabs">
        <Seg label={`${first}’s screens`} value={tab === 'lesson' ? 'library' : tab} onChange={(t) => go(t === 'today' ? base : `${base}/${t}`)} options={TABS} />
      </div>
      <AsLearnerApp learner={l}>
        <AsLearnerCtx.Provider value={learnerId}>
          <LookupsProvider>
            <div className="theme-learner see-as-page" onClickCapture={onClickCapture} onSubmitCapture={block} onBeforeInputCapture={block} onKeyDownCapture={(e) => e.key === 'Enter' && e.target.closest('input, textarea') && block(e)}>
              {page}
            </div>
          </LookupsProvider>
        </AsLearnerCtx.Provider>
      </AsLearnerApp>
    </div>
  );
}
