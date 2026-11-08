// Writing the new question types (step 6): fill in the blanks, matching, put in order, label a picture,
// record an answer, hand in a file, and a word guide for written answers.
import Icon from '../../ui/Icon.jsx';
import { Field } from '../../ui/kit.jsx';
import { StoredImage } from '../../ui/media.jsx';
import { ClozeInput, MatchInput, OrderInput, LabelInput } from '../shared/Kinds.jsx';
import { buildQuestion, MEDIA, recordMax } from '../../lib/qkinds.js';

const MAX_ITEMS = 12;

export function KindEditor({ q, onChange }) {
  // the public options follow the edit straight away, so the preview shows the order that's saved
  const setEdit = (patch) => {
    const edit = { ...(q.edit || {}), ...patch };
    onChange({ edit, options: buildQuestion({ ...q, edit }).options });
  };
  if (q.type === 'cloze') return <ClozeEditor q={q} setEdit={setEdit} />;
  if (q.type === 'match') return <MatchEditor q={q} setEdit={setEdit} />;
  if (q.type === 'order') return <OrderEditor q={q} setEdit={setEdit} />;
  if (q.type === 'label') return <LabelEditor q={q} setEdit={setEdit} />;
  if (q.type === 'record') return <RecordEditor q={q} onChange={onChange} />;
  if (q.type === 'short') return <WordsEditor q={q} onChange={onChange} />;
  return null;
}

// How it will look to a learner (with nothing filled in)
function Preview({ q }) {
  const b = buildQuestion(q);
  const shown = { ...q, prompt_md: b.prompt_md, options: b.options };
  const props = { q: shown, value: {}, onChange: () => {}, disabled: true };
  return (
    <details className="small">
      <summary>How learners see it</summary>
      <div className="note" style={{ marginTop: 8 }}>
        {q.type === 'cloze' && <ClozeInput {...props} />}
        {q.type === 'match' && <MatchInput {...props} />}
        {q.type === 'order' && <OrderInput {...props} />}
        {q.type === 'label' && <LabelInput {...props} />}
      </div>
    </details>
  );
}

function ClozeEditor({ q, setEdit }) {
  return (
    <div className="stack sm">
      <textarea
        className="textarea"
        style={{ minHeight: 110 }}
        value={q.edit?.src || ''}
        onChange={(e) => setEdit({ src: e.target.value })}
        placeholder="The capital of France is [[Paris]]. Water boils at [[100]] °C. A [[noun|verb|adjective]] names a thing."
        aria-label="Text with blanks"
      />
      <div className="tiny muted">
        Put each answer in double square brackets: <code>[[Paris]]</code>. Other answers that count go after a semicolon: <code>[[colour; color]]</code>. For a list to choose from, put the right answer first and the others after a bar: <code>[[Paris|Lyon|Nice]]</code>. Capitals and spaces don’t matter, and numbers can be written either way (0.5 or .50).
      </div>
      {(q.edit?.src || '').includes('[[') && <Preview q={q} />}
    </div>
  );
}

function MatchEditor({ q, setEdit }) {
  const rows = q.edit?.rows || [];
  const extras = q.edit?.extras || [];
  const setRows = (next) => setEdit({ rows: next });
  return (
    <div className="stack sm">
      <div className="label">Each item and its match</div>
      <div className="tiny muted">To sort things into groups, give several items the same match (e.g. Lion → Mammal, Shark → Fish, Whale → Mammal).</div>
      {rows.map((r, i) => (
        <div key={i} className="row">
          <input className="input" value={r.item} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, item: e.target.value } : x)))} placeholder={`Item ${i + 1}`} aria-label={`Item ${i + 1}`} />
          <Icon name="right" size={16} className="muted" />
          <input className="input" value={r.match} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, match: e.target.value } : x)))} placeholder="Its match" aria-label={`Match for item ${i + 1}`} />
          <button className="btn sm ghost icon" disabled={rows.length <= 2} aria-label={`Remove item ${i + 1}`} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
      {rows.length < MAX_ITEMS && (
        <button className="linkbtn small" onClick={() => setRows([...rows, { item: '', match: '' }])}>
          + Add an item
        </button>
      )}
      <Field label="Extra wrong matches (optional)" hint="One per line. They’re mixed in with the right ones.">
        <textarea className="textarea" style={{ minHeight: 50 }} value={extras.join('\n')} onChange={(e) => setEdit({ extras: e.target.value.split('\n').slice(0, MAX_ITEMS) })} aria-label="Extra wrong matches" />
      </Field>
      <Preview q={q} />
    </div>
  );
}

function OrderEditor({ q, setEdit }) {
  const list = q.edit?.items || [];
  const set = (next) => setEdit({ items: next });
  const move = (i, d) => {
    const next = [...list];
    const [x] = next.splice(i, 1);
    next.splice(i + d, 0, x);
    set(next);
  };
  return (
    <div className="stack sm">
      <div className="label">In the right order (learners get them mixed up)</div>
      {list.map((x, i) => (
        <div key={i} className="row">
          <span className="order-n">{i + 1}</span>
          <input className="input" value={x} onChange={(e) => set(list.map((y, j) => (j === i ? e.target.value : y)))} placeholder={i === 0 ? 'First' : `Then (${i + 1})`} aria-label={`Line ${i + 1}`} />
          <button className="btn sm ghost icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move line ${i + 1} up`}>
            <Icon name="up" size={16} />
          </button>
          <button className="btn sm ghost icon" disabled={i === list.length - 1} onClick={() => move(i, 1)} aria-label={`Move line ${i + 1} down`}>
            <Icon name="down" size={16} />
          </button>
          <button className="btn sm ghost icon" disabled={list.length <= 2} onClick={() => set(list.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
      {list.length < MAX_ITEMS && (
        <button className="linkbtn small" onClick={() => set([...list, ''])}>
          + Add a line
        </button>
      )}
      <div className="tiny muted">Each one in the right place earns its share of the marks.</div>
    </div>
  );
}

function LabelEditor({ q, setEdit }) {
  const spots = q.edit?.spots || [];
  const extras = q.edit?.extras || [];
  const setSpots = (next) => setEdit({ spots: next });
  function add(e) {
    const img = e.currentTarget.querySelector('img');
    if (!img || spots.length >= MAX_ITEMS) return;
    const r = img.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    setSpots([...spots, { x, y, label: '' }]);
  }
  if (!q.image_path) return <div className="note small">Add the picture first (Add image or diagram, above). Then click on it to mark each place to label.</div>;
  return (
    <div className="stack sm">
      <div className="label">Click the picture to add each place to label</div>
      <div className="label-pic editing" onClick={add} role="presentation">
        <StoredImage path={q.image_path} className="label-img" alt="The picture to label" />
        {spots.map((s, i) => (
          <span key={i} className="label-spot" style={{ left: `${s.x * 100}%`, top: `${s.y * 100}%` }}>
            {i + 1}
          </span>
        ))}
      </div>
      {spots.map((s, i) => (
        <div key={i} className="row">
          <span className="label-spot inline">{i + 1}</span>
          <input className="input" value={s.label} onChange={(e) => setSpots(spots.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} placeholder="Its label" aria-label={`Label for place ${i + 1}`} />
          <button className="btn sm ghost icon" onClick={() => setSpots(spots.filter((_, j) => j !== i))} aria-label={`Remove place ${i + 1}`}>
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
      <Field label="Extra wrong labels (optional)" hint="One per line. They’re mixed in with the right ones.">
        <textarea className="textarea" style={{ minHeight: 50 }} value={extras.join('\n')} onChange={(e) => setEdit({ extras: e.target.value.split('\n').slice(0, MAX_ITEMS) })} aria-label="Extra wrong labels" />
      </Field>
      {spots.length > 0 && <Preview q={q} />}
    </div>
  );
}

function RecordEditor({ q, onChange }) {
  const o = q.options && !Array.isArray(q.options) ? q.options : {};
  const set = (patch) => onChange({ options: { media: o.media || 'audio', max: recordMax(o), ...patch } });
  return (
    <div className="grid g2" style={{ gap: 10 }}>
      <Field label="They record">
        <select className="select" value={o.media || 'audio'} onChange={(e) => set({ media: e.target.value })}>
          {MEDIA.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Up to">
        <select className="select" value={recordMax(o)} onChange={(e) => set({ max: Number(e.target.value) })}>
          {[30, 60, 120, 180, 300, 600].map((s) => (
            <option key={s} value={s} disabled={s > 300 && (o.media || 'audio') !== 'audio'}>
              {s < 60 ? `${s} seconds` : `${s / 60} minute${s === 60 ? '' : 's'}`}
            </option>
          ))}
        </select>
      </Field>
    </div>
  );
}

function WordsEditor({ q, onChange }) {
  const w = (q.options && !Array.isArray(q.options) && q.options.words) || [null, null];
  const set = (i, v) => {
    const next = [...w];
    next[i] = v === '' ? null : Math.max(0, Math.min(5000, Math.round(Number(v)) || 0));
    onChange({ options: next[0] || next[1] ? { words: next } : [] });
  };
  return (
    <div className="row wrap small" style={{ gap: 8 }}>
      <span className="muted">Word guide (optional):</span>
      <input className="input sm num" type="number" min="0" value={w[0] ?? ''} onChange={(e) => set(0, e.target.value)} aria-label="Fewest words" placeholder="from" />
      <span className="muted">to</span>
      <input className="input sm num" type="number" min="0" value={w[1] ?? ''} onChange={(e) => set(1, e.target.value)} aria-label="Most words" placeholder="to" />
      <span className="muted">words. They see a count as they write.</span>
    </div>
  );
}
