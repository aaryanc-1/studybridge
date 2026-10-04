import { createContext, useContext, useMemo } from 'react';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';

// Subjects, topics, programmes and learners, shared by every screen
const Ctx = createContext(null);

export function LookupsProvider({ children, tutor }) {
  const subjects = useQuery('subjects', api.listSubjects);
  const topics = useQuery('topics', api.listTopics);
  const programmes = useQuery('programmes', api.listProgrammes);
  const learners = useQuery(tutor ? 'learners' : null, api.listLearners);
  // a tutor gets every learner's subjects; a learner only their own
  const links = useQuery('learner_subjects', api.listLearnerSubjects);

  const value = useMemo(() => {
    const s = subjects.data || [];
    const t = topics.data || [];
    const p = programmes.data || [];
    const l = learners.data || [];
    const ls = links.data || [];
    return {
      subjects: s,
      // the subjects this person works in: all of them for a tutor, the ones a learner takes
      mySubjects: tutor || !ls.length ? s : s.filter((x) => ls.some((k) => k.subject_id === x.id)),
      topics: t,
      programmes: p,
      learners: l,
      learnerSubjects: ls,
      subject: (id) => s.find((x) => x.id === id),
      topic: (id) => t.find((x) => x.id === id),
      programme: (id) => p.find((x) => x.id === id),
      learner: (id) => l.find((x) => x.id === id),
      topicsOf: (sid) => t.filter((x) => x.subject_id === sid),
      subjectsOfLearner: (lid) => ls.filter((x) => x.learner_id === lid).map((x) => x.subject_id),
      learnersOfSubject: (sid) => ls.filter((x) => x.subject_id === sid).map((x) => x.learner_id),
      // Learners an item is for (chosen, or everyone taking the subject)
      audience: (item) => {
        if (item.learner_ids && item.learner_ids.length) return l.filter((x) => item.learner_ids.includes(x.id));
        if (item.subject_id) return l.filter((x) => ls.some((k) => k.learner_id === x.id && k.subject_id === item.subject_id));
        return l;
      },
      reload: () => {
        subjects.refresh();
        topics.refresh();
        programmes.refresh();
        learners.refresh();
        links.refresh();
      },
      ready: subjects.data !== undefined,
    };
  }, [subjects.data, topics.data, programmes.data, learners.data, links.data]); // eslint-disable-line react-hooks/exhaustive-deps

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useLookups = () => useContext(Ctx);

export function SubjectTag({ id }) {
  const lk = useLookups();
  const s = lk.subject(id);
  if (!s) return null;
  return (
    <span className="row" style={{ gap: 6, display: 'inline-flex' }}>
      <span className="swatch" style={{ background: s.color || '#0E6B6B' }} />
      {s.name}
    </span>
  );
}
