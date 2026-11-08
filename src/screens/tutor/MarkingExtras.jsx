// Marking, step 6 (7 Nov 2026): recorded feedback, similar answers, and peer review at a glance.
import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Modal, go, useToast } from '../../ui/kit.jsx';
import { RecordButtons, Recordings } from '../../ui/Recorder.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { day } from '../../lib/format.js';

// Recorded feedback on one question (questionId) or the whole piece (null): voice, video or the screen, up to 3.
// Learners hear it once marks are back. "Add the words" writes out what's said, for anyone who can't listen.
export function FeedbackRecorder({ attemptId, learnerId, questionId = null, files = [], label }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function save(next) {
    await api.setFeedbackFiles(attemptId, questionId, next);
    invalidate(`attempt:${attemptId}`);
  }
  async function add(blob, info) {
    setBusy(true);
    try {
      const f = await api.uploadFeedbackRecording(learnerId, attemptId, blob, questionId ? 'Feedback' : 'Feedback on the whole piece');
      await save([...files, { ...f, sec: info.sec }]);
      toast('Recording added. They hear it when you return the marks.');
    } catch (e) {
      toast({ title: 'Couldn’t keep the recording', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="stack sm">
      <Recordings
        files={files}
        onRemove={async (f) => {
          try {
            await save(files.filter((x) => x.path !== f.path));
            api.removeWorkFiles([f.path]);
          } catch (e) {
            toast({ title: 'Couldn’t remove it', body: e.message, tone: 'bad' });
          }
        }}
        onWords={async (i, words) => {
          try {
            await save(files.map((x, j) => (j === i ? { ...x, words } : x)));
          } catch (e) {
            toast({ title: 'Couldn’t save the words', body: e.message, tone: 'bad' });
          }
        }}
      />
      {files.length < 3 && (
        <div className="row wrap" style={{ gap: 6 }}>
          <span className="tiny muted">{label || 'Or say it:'}</span>
          <RecordButtons modes={['audio', 'video', 'screen']} max={300} onDone={add} disabled={busy} />
          {busy && <span className="save-state">Keeping it…</span>}
        </div>
      )}
    </div>
  );
}

// ---------------- similar answers ----------------
const SIM_WORD = /[A-Za-z0-9]+/g;
// The text with the words at these positions (1, 2, 3… as the server counts them) highlighted
export function Highlighted({ text, words }) {
  const on = new Set(words || []);
  const t = String(text || '');
  const segs = []; // [start, end, highlighted]
  let pos = 0;
  [...t.matchAll(SIM_WORD)].forEach((m, i) => {
    const n = i + 1;
    if (m.index > pos) segs.push([pos, m.index, on.has(n) && on.has(n - 1)]); // the space between two highlighted words too
    segs.push([m.index, m.index + m[0].length, on.has(n)]);
    pos = m.index + m[0].length;
  });
  if (pos < t.length) segs.push([pos, t.length, false]);
  const merged = [];
  for (const sg of segs) {
    const l = merged[merged.length - 1];
    if (l && l[2] === sg[2]) l[1] = sg[1];
    else merged.push([...sg]);
  }
  return <div className="sim-text">{merged.map(([x, y, m], i) => (m ? <mark key={i}>{t.slice(x, y)}</mark> : <span key={i}>{t.slice(x, y)}</span>))}</div>;
}

const level = (p) => (p >= 50 ? 'bad' : p >= 25 ? 'warn' : '');
export function useSimilarity(attemptId, enabled = true) {
  return useQuery(enabled ? `similarity:${attemptId}` : null, () => api.similarity(attemptId));
}

// Under a written answer in marking: how much of it is also in other answers at this school, centre or tutor
export function SimilarLine({ attemptId, questionId, text }) {
  const sim = useSimilarity(attemptId).data;
  const [open, setOpen] = useState(null); // a match, or 'model'
  const e = (sim || []).find((x) => x.question_id === questionId);
  if (!sim) return null;
  if (!e) return <div className="tiny muted sim-line">Similar answers: checked from 30 words.</div>;
  const top = e.matches[0];
  return (
    <div className="sim-line small">
      <Icon name="layers" size={14} />
      {top ? (
        <span>
          <span className={'pill ' + level(top.pct)}>{top.pct}%</span> also in {top.can_see ? `${top.name}’s answer` : 'another learner’s answer here'}
          {top.same_work ? ' to this' : top.can_see && top.title ? ` (“${top.title}”)` : ''}
          {e.matches.length > 1 ? ` · ${e.matches.length - 1} more` : ''}{' '}
          <button type="button" className="linkbtn" onClick={() => setOpen(top)}>
            Compare
          </button>
        </span>
      ) : (
        <span>Similar answers: nothing close among other answers here.</span>
      )}
      {e.model > 0 && (
        <span className="muted">
          {' '}
          · {e.model}% is the model answer’s wording{' '}
          <button type="button" className="linkbtn" onClick={() => setOpen('model')}>
            Show
          </button>
        </span>
      )}
      {open && <CompareModal entry={e} match={open === 'model' ? null : open} text={text} onClose={() => setOpen(null)} onPick={setOpen} />}
    </div>
  );
}

function CompareModal({ entry, match, text, onClose, onPick }) {
  const pair = useQuery(`sim-pair:${entry.response_id}:${match?.response_id || 'model'}`, () => api.similarityPair(entry.response_id, match?.response_id || null)).data;
  return (
    <Modal title={match ? 'Similar answers' : 'The model answer’s wording'} wide onClose={onClose}>
      <div className="small muted">
        Highlighted: runs of five or more words that are in both{match ? '' : ' (this answer and your model answer or mark scheme)'}. Words from the question itself don’t count. It’s a guide for you to look at, not a verdict, and it doesn’t search the internet.
      </div>
      {match && entry.matches.length > 1 && (
        <div className="row wrap">
          {entry.matches.map((m) => (
            <button key={m.response_id} className={'btn sm' + (m.response_id === match.response_id ? ' primary' : '')} onClick={() => onPick(m)}>
              {m.can_see ? m.name : 'Another learner'} · {m.pct}%
            </button>
          ))}
        </div>
      )}
      {!pair ? (
        <div className="spinner" />
      ) : (
        <div className={match && pair.other_text != null ? 'grid g2' : 'stack'} style={{ gap: 14 }}>
          <div className="stack sm">
            <div className="label">This answer</div>
            <Highlighted text={text} words={pair.mine} />
          </div>
          {match && pair.other_text != null && (
            <div className="stack sm">
              <div className="label">
                {pair.other_name}’s{match.at ? `, handed in ${day(match.at)}` : ''}
              </div>
              <Highlighted text={pair.other_text} words={pair.theirs} />
            </div>
          )}
          {match && pair.other_text == null && (
            <div className="note small">The other answer was handed in{match.at ? ` on ${day(match.at)}` : ''} to another teacher here, so only their teachers can open it. Ask them if you need to.</div>
          )}
        </div>
      )}
    </Modal>
  );
}

// For a whole piece of work (Marking, one assignment): pairs of answers that share a lot
export function SimilarOverview({ assignmentId }) {
  const rows = useQuery(`similar-overview:${assignmentId}`, () => api.similarityOverview(assignmentId)).data;
  if (!rows?.length) return null;
  return (
    <div className="card">
      <h3 className="row">
        <Icon name="layers" /> Similar answers
      </h3>
      <div className="small muted">Pairs of written answers to this work that share a quarter or more of their wording. Open one to compare them.</div>
      <div className="list small">
        {rows.map((r, i) => (
          <button key={i} type="button" className="item click" onClick={() => go(`/marking/${r.a.attempt_id}`)}>
            <span className={'pill ' + level(r.pct)}>{r.pct}%</span>
            <span className="grow">
              Question {r.n}: {r.a.name} and {r.b.name}
            </span>
            <Icon name="right" size={14} />
          </button>
        ))}
      </div>
    </div>
  );
}

// Marking, for work with peer review: a way to the peer review page
export function PeerCard({ assignment }) {
  if (!assignment?.peer) return null;
  return (
    <div className="card">
      <h3 className="row">
        <Icon name="users" /> Peer review
      </h3>
      <div className="small muted">Classmates review each other’s answers. You read every review before its author sees it.</div>
      <button className="btn sm" onClick={() => go(`/peer/${assignment.id}`)}>
        Open peer review
      </button>
    </div>
  );
}
