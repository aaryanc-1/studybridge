// Mock exam grades for a learner (1.6). The grade comes from the server, worked out from the tutor's
// own boundaries; learners never see the boundaries, only their grade and how close the next one was.
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Bar } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { day } from '../../lib/format.js';
import { SubjectTag } from './lookups.jsx';

const n = (x) => (x == null ? '' : String(Math.round(Number(x) * 10) / 10));

// "Grade B · 60% · 5 marks short of an A"
export function gradeLine(r) {
  if (!r || r.pct == null) return '';
  const parts = [];
  if (r.grade) parts.push(`Grade ${r.grade}`);
  parts.push(`${r.pct}%`);
  if (r.next && r.short_by != null) parts.push(`${n(r.short_by)} mark${Number(r.short_by) === 1 ? '' : 's'} short of ${/^[AEIOU8]/i.test(r.next) ? 'an' : 'a'} ${r.next}`);
  return parts.join(' · ');
}

// A learner's own mocks, and which paper of which mock each piece of work is
export function useMyMocks() {
  const app = useApp();
  const q = useQuery(app.me.role === 'learner' ? 'mymocks' : null, api.myMocks);
  const mocks = q.data || [];
  const paperOf = {};
  for (const m of mocks) (m.papers || []).forEach((p, i) => (paperOf[p.id] = { mock: m, index: i + 1, count: m.count }));
  return { mocks, paperOf };
}

export function MockPill({ assignmentId, paperOf }) {
  const x = paperOf[assignmentId];
  if (!x) return null;
  return (
    <span className="pill accent">
      Mock: {x.mock.title} · paper {x.index} of {x.count}
    </span>
  );
}

// On a mock paper's results: the mock's grade once every paper has been given back
export function MockResultCard({ assignmentId }) {
  const { paperOf } = useMyMocks();
  const x = paperOf[assignmentId];
  if (!x) return null;
  const m = x.mock;
  return (
    <div className="card mock-result">
      <div className="row between wrap">
        <div>
          <div className="kind exam">Mock exam</div>
          <div className="strong" style={{ fontSize: 17 }}>{m.title}</div>
        </div>
        {m.released && m.grade && <div className="mock-grade">{m.grade}</div>}
      </div>
      {m.released ? (
        <>
          <div>{gradeLine(m)}</div>
          <div className="small muted">
            {n(m.total)} out of {n(m.max)} marks across {m.count} paper{m.count === 1 ? '' : 's'}.
          </div>
        </>
      ) : (
        <div className="small muted">
          This is paper {x.index} of {m.count}. Your mock grade shows here once your tutor has given back the marks for every paper.
        </div>
      )}
    </div>
  );
}

// Mock grades over time (Progress)
export default function MockHistory({ learnerId }) {
  const q = useQuery(`mockhist:${learnerId}`, () => api.mockHistory(learnerId));
  const list = q.data || [];
  if (!list.length) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h2>
          <Icon name="trophy" size={18} /> Mock exams
        </h2>
        <span className="muted small">Each grade comes from the grade boundaries for its exam</span>
      </div>
      <div className="list">
        {[...list].reverse().map((m) => (
          <div key={m.id} className="item">
            <span className="mock-grade sm">{m.grade || '—'}</span>
            <span className="grow stack sm">
              <span className="name">{m.title}</span>
              <span className="meta row wrap" style={{ gap: 8 }}>
                {m.subject_id && <SubjectTag id={m.subject_id} />}
                {m.last_at && <span>{day(m.last_at)}</span>}
                {m.next && m.short_by != null && (
                  <span>
                    {n(m.short_by)} short of {m.next}
                  </span>
                )}
              </span>
              <Bar value={m.pct || 0} tone={m.pct >= 70 ? 'good' : m.pct >= 50 ? 'warn' : 'bad'} />
            </span>
            <span className="strong">{m.pct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
