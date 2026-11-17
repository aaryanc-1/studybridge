// A learner's running grade in each class whose teacher shows it (Canvas gaps part 2, 17 Nov 2026), and "what if":
// type a mark for work still to come (or try a different one) and see the overall it would make. Only marks given back
// count; the sum is the same as the gradebook's (overallOf in grading.js).
import { useState } from 'react';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { kindLabel } from '../../lib/format.js';
import { overallOf, pctText, scaleGrade } from '../../lib/grading.js';

export function MyGrades() {
  const q = useQuery('my-grades', api.myGrades);
  if (!q.data?.length) return null;
  return q.data.map((c) => <ClassGrade key={c.class_id} c={c} />);
}

function ClassGrade({ c }) {
  const [tryPct, setTryPct] = useState({}); // work id → a mark to try
  const [open, setOpen] = useState(false);
  const work = c.work.filter((w) => w.counts);
  const withTries = work.map((w) => (tryPct[w.id] !== undefined && tryPct[w.id] !== '' ? { ...w, pct: Number(tryPct[w.id]) } : w));
  const trying = Object.values(tryPct).some((v) => v !== '' && v !== undefined);
  const whatIf = trying ? overallOf(withTries, c.categories) : null;
  const catName = (id) => c.categories.find((x) => x.id === id)?.name;
  // with weights, only work in a weighted category adds up (the rest has nothing to try)
  const weighted = c.categories.some((x) => Number(x.weight) > 0);
  const inSum = (w) => !weighted || c.categories.some((x) => x.id === w.category_id && Number(x.weight) > 0);
  const how = c.categories.filter((x) => Number(x.weight) > 0).map((x) => `${x.name} ${pctText(x.weight)}${x.drop_lowest ? ` (your lowest ${x.drop_lowest} left out)` : ''}`).join(' · ');
  return (
    <div className="card">
      <div className="row between wrap">
        <h2>{c.class}: your grade so far</h2>
        <div className="row" style={{ gap: 14, alignItems: 'baseline' }}>
          <span className="score-big">{c.overall != null ? pctText(c.overall) : '—'}</span>
          {(c.final || c.suggested) && <span className="pill good">{c.final ? `Grade ${c.final}` : `About a ${c.suggested}`}</span>}
        </div>
      </div>
      <div className="small muted">
        From the marks your teacher has given back{how ? `: ${how}` : ''}.{c.final ? ' Your teacher set your grade.' : ''}
      </div>
      <button className="linkbtn small" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Hide' : 'What if…? Try a mark and see'}
      </button>
      {open && (
        <div className="stack sm">
          <table className="table small">
            <thead>
              <tr>
                <th>Work</th>
                <th>Counts in</th>
                <th>Your mark</th>
                <th>Try</th>
              </tr>
            </thead>
            <tbody>
              {work.map((w) => (
                <tr key={w.id}>
                  <td>
                    {w.title} <span className="muted">· {kindLabel[w.kind] || 'Work'}</span>
                  </td>
                  <td>{inSum(w) ? catName(w.category_id) || 'Everything' : 'Doesn’t count'}</td>
                  <td>{w.pct != null ? pctText(w.pct) : '—'}</td>
                  <td>
                    {!inSum(w) ? (
                      <span className="muted">—</span>
                    ) : (
                      <input
                        className="input sm num"
                        type="number"
                        min="0"
                        max="100"
                        value={tryPct[w.id] ?? ''}
                        placeholder={w.pct != null ? '' : '%'}
                        onChange={(e) => setTryPct({ ...tryPct, [w.id]: e.target.value === '' ? '' : Math.max(0, Math.min(100, Number(e.target.value))) })}
                        aria-label={`Try a mark for ${w.title}`}
                      />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {trying && (
            <div className="note">
              With those marks your overall would be <b>{whatIf != null ? pctText(whatIf) : '—'}</b>
              {c.scale && whatIf != null && scaleGrade(c.scale, whatIf) ? `, about a ${scaleGrade(c.scale, whatIf)}` : ''}.{' '}
              <button className="linkbtn" onClick={() => setTryPct({})}>
                Clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
