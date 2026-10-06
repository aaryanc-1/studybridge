import { useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Link, Loading, Markdown, Modal, Page, Seg, go, useRoute, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as store from '../../lib/store.js';
import { desktop } from '../../lib/config.js';
import { ago, due, kindLabel, pct } from '../../lib/format.js';
import { useLookups, SubjectTag } from '../shared/lookups.jsx';
import { workState, needsAction } from './workState.js';
import { useMyMocks, MockPill } from '../shared/MockHistory.jsx';

export default function Work() {
  const lk = useLookups();
  const assignments = useQuery('assignments', api.listAssignments);
  const attempts = useQuery('myattempts', () => api.myAttempts()).data || [];
  const route = useRoute();
  const { paperOf } = useMyMocks();
  const [tab, setTab] = useState(route.query.get('tab') || 'todo');
  const all = (assignments.data || []).map((a) => ({ a, s: workState(a, attempts) }));
  const states = all.filter((x) => !x.a.practice);
  const practice = all.filter((x) => x.a.practice);
  const groups = {
    todo: states.filter((x) => needsAction(x.s)),
    waiting: states.filter((x) => x.s.key === 'waiting'),
    marked: states.filter((x) => x.s.key === 'marked'),
    practice,
  };
  const list = groups[tab] || [];

  return (
    <Page title="My work">
      <Seg
        value={tab}
        onChange={setTab}
        options={[
          { value: 'todo', label: `To do (${groups.todo.length})` },
          { value: 'waiting', label: `Handed in (${groups.waiting.length})` },
          { value: 'marked', label: `Marked (${groups.marked.length})` },
          ...(practice.length ? [{ value: 'practice', label: `Practice (${practice.length})` }] : []),
        ]}
      />
      {tab === 'practice' && <div className="note small">Extra practice from your tutor. Do it as often as you like: it’s marked straight away and shows you the answers.</div>}
      {!assignments.data ? (
        <Loading />
      ) : list.length === 0 ? (
        <Empty>{tab === 'todo' ? 'Nothing to do. Nice.' : 'Nothing here yet.'}</Empty>
      ) : (
        <div className="stack">
          {tab === 'practice' &&
            list.map(({ a }) => {
              const mine = attempts.filter((t) => t.assignment_id === a.id && t.score != null && t.max_score);
              const best = mine.reduce((m, t) => Math.max(m, pct(t.score, t.max_score)), -1);
              return (
                <button key={a.id} className="work-card" onClick={() => go(`/work/${a.id}`)}>
                  <span className="bar-l" style={{ background: lk.subject(a.subject_id)?.color || 'var(--accent)' }} />
                  <span className="grow stack sm">
                    <span className="row wrap" style={{ gap: 8 }}>
                      <span className="kind quiz">Practice</span>
                      <span className="pill">{mine.length ? `${mine.length} tr${mine.length === 1 ? 'y' : 'ies'}` : 'Not tried yet'}</span>
                    </span>
                    <span className="strong" style={{ fontSize: 16 }}>{a.title}</span>
                    <span className="small muted row wrap" style={{ gap: 10 }}>
                      {a.subject_id && <SubjectTag id={a.subject_id} />}
                      {best >= 0 ? `Best ${best}%` : 'Marked straight away'}
                    </span>
                  </span>
                  <span className="btn sm primary">{mine.length ? 'Practise again' : 'Start'}</span>
                </button>
              );
            })}
          {tab !== 'practice' && list.map(({ a, s }) => {
            const d = due(a.due_at);
            return (
              <button key={a.id} className="work-card" onClick={() => go(s.key === 'marked' || s.key === 'waiting' ? `/results/${s.last.id}` : `/work/${a.id}`)}>
                <span className="bar-l" style={{ background: lk.subject(a.subject_id)?.color || 'var(--accent)' }} />
                <span className="grow stack sm">
                  <span className="row wrap" style={{ gap: 8 }}>
                    <span className={'kind ' + a.kind}>{kindLabel[a.kind]}</span>
                    <span className={'pill ' + s.tone}>{s.label}</span>
                    <MockPill assignmentId={a.id} paperOf={paperOf} />
                  </span>
                  <span className="strong" style={{ fontSize: 16 }}>{a.title}</span>
                  <span className="small muted row wrap" style={{ gap: 10 }}>
                    {a.subject_id && <SubjectTag id={a.subject_id} />}
                    {tab === 'todo' ? d.text : s.last?.submitted_at ? `Handed in ${ago(s.last.submitted_at)}` : ''}
                  </span>
                </span>
                {s.key === 'marked' && s.last.score != null && <span className="strong" style={{ fontSize: 18 }}>{pct(s.last.score, s.last.max_score)}%</span>}
                <Icon name="right" />
              </button>
            );
          })}
        </div>
      )}
    </Page>
  );
}

export function WorkDetail({ id }) {
  const lk = useLookups();
  const toast = useToast();
  const assignments = useQuery('assignments', api.listAssignments);
  const attempts = useQuery(`myattempts:${id}`, () => api.myAttempts(id));
  const files = useQuery('files', api.listFiles).data || [];
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const a = (assignments.data || []).find((x) => x.id === id);
  if (!a) return <Page title="Work">{assignments.data ? <Empty>This isn’t available any more.</Empty> : <Loading />}</Page>;
  const mine = attempts.data || [];
  const s = workState(a, mine);
  const attached = (a.file_refs || []).map((r) => files.find((f) => f.id === r.file_id)).filter(Boolean);
  const special = a.lockdown || a.camera || a.time_limit_min;
  const blocked = (a.lockdown || a.camera) && !desktop;
  const canStart = s.key === 'todo' || s.key === 'doing' || s.key === 'redo' || (s.key === 'marked' && s.canRetry);
  const label = s.key === 'doing' ? 'Continue' : s.key === 'redo' ? 'Redo the questions' : s.key === 'marked' ? 'Try again' : 'Start';

  async function start() {
    setBusy(true);
    try {
      const t = await api.startAttempt(a.id);
      await store.del(`submitted:${t.id}`);
      invalidate('myattempts');
      go(`/attempt/${t.id}`);
    } catch (e) {
      toast({ title: 'Couldn’t start', body: e.message, tone: 'bad' });
      setBusy(false);
    }
  }

  return (
    <Page
      size="narrow"
      eyebrow={
        <>
          <Link to="/work">My work</Link> <Icon name="right" size={14} /> <span className={'kind ' + a.kind}>{kindLabel[a.kind]}</span>
        </>
      }
      title={a.title}
      subtitle={
        <span className="row wrap" style={{ gap: 10 }}>
          {a.subject_id && <SubjectTag id={a.subject_id} />}
          <span>{due(a.due_at).text}</span>
          <span className={'pill ' + s.tone}>{s.label}</span>
        </span>
      }
    >
      {a.instructions_md && (
        <div className="card">
          <Markdown src={a.instructions_md} />
        </div>
      )}
      {special && (
        <div className="card">
          <h3>Before you start</h3>
          <div className="stack sm">
            {a.time_limit_min && (
              <div className="row top">
                <Icon name="clock" />
                <span>You’ll have <b>{a.time_limit_min} minutes</b>. It hands in automatically when time is up.</span>
              </div>
            )}
            {a.lockdown && (
              <div className="row top">
                <Icon name="lock" />
                <span>Your screen will be <b>locked to StudyBridge</b> until you hand in. Leaving the window is reported to your tutor.</span>
              </div>
            )}
            {a.camera && (
              <div className="row top">
                <Icon name="camera" />
                <span>Your tutor will be able to <b>see your camera and screen</b> while you work.</span>
              </div>
            )}
            {a.max_attempts > 1 && (
              <div className="row top">
                <Icon name="refresh" />
                <span>You can try {a.max_attempts} times ({s.used} used).</span>
              </div>
            )}
          </div>
          {blocked && <div className="error">Open this on your laptop in the StudyBridge app. It can’t be done in a web browser.</div>}
        </div>
      )}
      {attached.length > 0 && (
        <div className="card">
          <h3>Resources</h3>
          <div className="list">
            {attached.map((f) => (
              <Link key={f.id} to={`/file/${f.id}`} className="item">
                <Icon name="pdf" style={{ color: 'var(--accent)' }} />
                <span className="grow">
                  <span className="name">{f.name}</span>
                </span>
              </Link>
            ))}
          </div>
          <div className="muted tiny">You can also open these beside the questions while you work.</div>
        </div>
      )}
      {mine.length > 0 && (
        <div className="card">
          <h3>Your attempts</h3>
          <div className="list">
            {mine.map((t) => (
              <Link key={t.id} to={t.status === 'in_progress' ? `/attempt/${t.id}` : `/results/${t.id}`} className="item">
                <span className="grow">
                  <span className="name">Attempt {t.number}</span>
                  <span className="meta">{t.submitted_at ? `Handed in ${ago(t.submitted_at)}` : `Started ${ago(t.started_at)}`}</span>
                </span>
                <span className="strong">{t.released && t.score != null ? `${Number(t.score)} / ${Number(t.max_score)}` : t.status === 'in_progress' ? 'In progress' : t.status === 'returned' ? 'Redo' : 'Being marked'}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
      {canStart && (
        <div>
          <button className="btn primary big" disabled={busy || blocked} onClick={() => (a.lockdown && s.key === 'todo' ? setConfirming(true) : start())}>
            {busy ? 'Opening…' : label}
            <Icon name="send2" size={18} />
          </button>
        </div>
      )}
      {confirming && (
        <Modal
          title="Ready?"
          onClose={() => setConfirming(false)}
          foot={
            <>
              <button className="btn" onClick={() => setConfirming(false)}>
                Not yet
              </button>
              <button className="btn primary" onClick={start} disabled={busy}>
                <Icon name="lock" size={16} /> Start {kindLabel[a.kind].toLowerCase()}
              </button>
            </>
          }
        >
          <div>StudyBridge will fill your screen and stay there until you hand in{a.time_limit_min ? ` or the ${a.time_limit_min} minutes run out` : ''}. Close other apps first.</div>
        </Modal>
      )}
    </Page>
  );
}
