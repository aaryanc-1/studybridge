// Library → Flashcards: the tutor's cards for each subject (learners review them in Study,
// with spaced repetition). Write them, or ask Prof and pick the ones to keep.
import { useEffect, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Markdown, useConfirm, useRoute, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { useLookups } from '../shared/lookups.jsx';

export default function Flashcards() {
  const lk = useLookups();
  const route = useRoute();
  const [sid, setSid] = useState(route.query.get('subject') || '');
  useEffect(() => {
    if (!sid && lk.subjects[0]) setSid(lk.subjects[0].id);
  }, [lk.subjects.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const cards = useQuery('cards', api.listCards);
  const mine = (cards.data || []).filter((c) => c.subject_id === sid && (c.source === 'tutor' || c.source === 'prof'));
  const [adding, setAdding] = useState(false);
  if (!lk.subjects.length)
    return (
      <Empty title="Add a subject first">
        Make your subjects in <a href="#/structure">Subjects</a>.
      </Empty>
    );
  const topics = lk.topicsOf(sid);
  const groups = [...topics.map((t) => ({ t, list: mine.filter((c) => c.topic_id === t.id) })), { t: null, list: mine.filter((c) => !c.topic_id || !topics.some((t) => t.id === c.topic_id)) }].filter((g) => g.list.length);
  return (
    <div className="stack">
      <div className="note small">
        Learners review these in <b>Study</b>: a card they know comes back less often, one they find hard comes back sooner. Questions they get wrong become extra cards for them automatically. Nothing from Prof reaches them until you add it.
      </div>
      <div className="row wrap between">
        <select className="select" style={{ width: 'auto' }} value={sid} onChange={(e) => setSid(e.target.value)} aria-label="Subject">
          {lk.subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="btn" onClick={() => setAdding((x) => !x)}>
          <Icon name="plus" size={16} /> Write a card
        </button>
      </div>
      {adding && <CardForm subjectId={sid} onDone={() => setAdding(false)} />}
      <ProfCards subjectId={sid} />
      {cards.data && !mine.length && <Empty title="No flashcards yet">Write some, or ask Prof for a set on a topic.</Empty>}
      {groups.map((g) => (
        <div key={g.t?.id || 'none'} className="card">
          <h3 style={{ margin: 0 }}>
            {g.t ? g.t.name : 'No topic'} <span className="small muted">({g.list.length})</span>
          </h3>
          <div className="card-grid">
            {g.list.map((c) => (
              <CardTile key={c.id} c={c} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CardTile({ c }) {
  const confirm = useConfirm();
  const lk = useLookups();
  return (
    <div className="card-tile">
      <div className="front">
        <Markdown src={c.front_md} />
      </div>
      <div className="back small">
        <Markdown src={c.back_md} />
      </div>
      <div className="row between small muted">
        <span>
          {c.source === 'prof' ? 'Prof' : 'You'}
          {c.learner_id ? ` · only ${lk.learner(c.learner_id)?.display_name?.split(' ')[0] || 'one learner'}` : ''}
        </span>
        <button
          className="btn ghost icon sm"
          aria-label="Delete card"
          onClick={async () => {
            if (!(await confirm({ title: 'Delete this card?', body: 'Learners won’t see it again.', ok: 'Delete', danger: true }))) return;
            await api.remove('cards', c.id);
            invalidate('cards');
          }}
        >
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  );
}

function CardForm({ subjectId, onDone }) {
  const lk = useLookups();
  const toast = useToast();
  const [front, setFront] = useState('');
  const [back, setBack] = useState('');
  const [topic, setTopic] = useState('');
  const [learner, setLearner] = useState('');
  const learners = lk.learnersOfSubject(subjectId).map((id) => lk.learner(id)).filter(Boolean);
  return (
    <div className="card">
      <div className="grid g2" style={{ gap: 10 }}>
        <Field label="Front">
          <textarea className="textarea" value={front} onChange={(e) => setFront(e.target.value)} placeholder="e.g. Formula for the area of a trapezium?" />
        </Field>
        <Field label="Back">
          <textarea className="textarea" value={back} onChange={(e) => setBack(e.target.value)} placeholder="e.g. $\frac{1}{2}(a+b)h$" />
        </Field>
      </div>
      <div className="row wrap">
        <select className="select" style={{ width: 'auto' }} value={topic} onChange={(e) => setTopic(e.target.value)} aria-label="Topic">
          <option value="">No topic</option>
          {lk.topicsOf(subjectId).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <select className="select" style={{ width: 'auto' }} value={learner} onChange={(e) => setLearner(e.target.value)} aria-label="For">
          <option value="">Everyone taking this subject</option>
          {learners.map((l) => (
            <option key={l.id} value={l.id}>
              Only {l.display_name}
            </option>
          ))}
        </select>
        <button
          className="btn primary"
          disabled={!front.trim() || !back.trim()}
          onClick={async () => {
            try {
              await api.addCards([{ subject_id: subjectId, topic_id: topic || null, learner_id: learner || null, front_md: front.trim(), back_md: back.trim() }]);
              invalidate('cards');
              setFront('');
              setBack('');
              toast('Card added');
            } catch (e) {
              toast({ title: 'Couldn’t add it', body: e.message, tone: 'bad' });
            }
          }}
        >
          Add card
        </button>
        <button className="btn ghost" onClick={onDone}>
          Done
        </button>
      </div>
    </div>
  );
}

function ProfCards({ subjectId }) {
  const lk = useLookups();
  const toast = useToast();
  const jobs = useQuery('prof-jobs', api.profJobs);
  const usage = useQuery('prof-usage', api.profUsage).data;
  const [topic, setTopic] = useState('');
  const [count, setCount] = useState(12);
  const [picked, setPicked] = useState({});
  const [seen, setSeen] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem('sb.cardsSeen') || '[]');
    } catch {
      return [];
    }
  });
  const mine = (jobs.data || []).filter((j) => j.kind === 'cards' && j.context?.subject_id === subjectId);
  const running = mine.find((j) => ['queued', 'running', 'waiting'].includes(j.status));
  const ready = mine.find((j) => j.status === 'done' && j.result?.cards && !seen.includes(j.id));
  const close = (id) => {
    const next = [...seen, id].slice(-100);
    setSeen(next);
    try {
      localStorage.setItem('sb.cardsSeen', JSON.stringify(next));
    } catch {
      /* fine */
    }
  };
  const topicId = (name) => lk.topicsOf(subjectId).find((t) => t.name.toLowerCase() === String(name || '').toLowerCase())?.id || null;
  return (
    <div className="card claude-card">
      <h3 className="row" style={{ margin: 0 }}>
        <Icon name="cap" style={{ color: 'var(--claude)' }} /> Ask Prof for flashcards
      </h3>
      <div className="row wrap">
        <input className="input" style={{ maxWidth: 280 }} list="card-topics" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic, e.g. Trigonometry" aria-label="Topic" />
        <datalist id="card-topics">
          {lk.topicsOf(subjectId).map((t) => (
            <option key={t.id} value={t.name} />
          ))}
        </datalist>
        <select className="select sm" value={count} onChange={(e) => setCount(Number(e.target.value))} aria-label="How many">
          {[8, 12, 20, 30].map((n) => (
            <option key={n} value={n}>
              {n} cards
            </option>
          ))}
        </select>
        <button
          className="btn claude"
          disabled={topic.trim().length < 2 || !!running || (usage && !usage.ready)}
          onClick={async () => {
            try {
              await api.profCards(subjectId, topic.trim(), count);
              invalidate('prof-jobs');
              toast({ title: 'Prof is writing them', body: 'You’ll pick which ones to keep.' });
            } catch (e) {
              toast({ title: 'Couldn’t ask Prof', body: e.message, tone: 'bad' });
            }
          }}
        >
          {running ? 'Prof is writing…' : 'Write them'}
        </button>
      </div>
      {usage && !usage.ready && <div className="tiny muted">{usage.why_not}</div>}
      {ready && (
        <div className="stack sm">
          <div className="small">
            Prof wrote {ready.result.cards.list.length} cards on <b>{ready.result.cards.topic}</b>. Untick any you don’t want.
          </div>
          <div className="card-grid">
            {ready.result.cards.list.map((c, i) => {
              const on = picked[ready.id + i] !== false;
              return (
                <label key={i} className={'card-tile pick' + (on ? '' : ' off')}>
                  <input type="checkbox" checked={on} onChange={(e) => setPicked({ ...picked, [ready.id + i]: e.target.checked })} />
                  <div className="front">
                    <Markdown src={c.front} />
                  </div>
                  <div className="back small">
                    <Markdown src={c.back} />
                  </div>
                </label>
              );
            })}
          </div>
          <div className="row">
            <button
              className="btn primary"
              onClick={async () => {
                const list = ready.result.cards.list.filter((_, i) => picked[ready.id + i] !== false);
                try {
                  await api.addCards(list.map((c) => ({ subject_id: subjectId, topic_id: topicId(ready.result.cards.topic), front_md: c.front, back_md: c.back, source: 'prof' })));
                  invalidate('cards');
                  close(ready.id);
                  toast(`${list.length} cards added. Learners see them in Study.`);
                } catch (e) {
                  toast({ title: 'Couldn’t add them', body: e.message, tone: 'bad' });
                }
              }}
            >
              Add {ready.result.cards.list.filter((_, i) => picked[ready.id + i] !== false).length} cards
            </button>
            <button className="btn" onClick={() => close(ready.id)}>
              Don’t use
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
