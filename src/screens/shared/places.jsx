// A learner's places: their main tutor, other tutors they added, and the schools or centres whose classes they're in.
// One login for all of them; the app labels who set what (only when there's more than one) and says when a place is
// paused for now.
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';

export function usePlaces() {
  const app = useApp();
  const learner = app?.me?.role === 'learner' && !app.me.self_learner;
  const places = useQuery(learner ? 'my-places' : null, () => api.myPlaces()).data || [];
  const byTeacher = {};
  for (const p of places) for (const t of p.teachers || []) byTeacher[t.id] = p;
  return { places, many: places.length > 1, placeOf: (tutorId) => byTeacher[tutorId] };
}

// "Hill School" beside a piece of work, when the learner has more than one place
export function FromPlace({ tutorId }) {
  const { many, placeOf } = usePlaces();
  const p = many ? placeOf(tutorId) : null;
  return p ? <span className="pill from-place">{p.name}</span> : null;
}

// A place paused for now: its free week ended unpaid, or a tutor they added paused them (their main tutor pausing them
// shows in the bar at the top)
export function PausedPlaces() {
  const { places } = usePlaces();
  const off = places.filter((p) => p.unpaid || (p.paused && !p.main));
  if (!off.length) return null;
  return off.map((p) => (
    <div key={p.id} className="note warn row" style={{ gap: 10 }} role="status">
      <Icon name="pause" size={18} />
      <span className="grow">
        <b>{p.unpaid ? `${p.name}’s StudyBridge is paused for now` : `Your StudyBridge with ${p.name} is paused for now`}</b>
        <br />
        {p.unpaid ? 'You can still see your work and marks. New work will show up here once it’s back on.' : 'Your work is all kept. They can switch it back on any time.'}
      </span>
    </div>
  ));
}
