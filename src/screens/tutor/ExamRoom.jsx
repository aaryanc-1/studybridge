// The exam room: one screen for a whole class doing a timed or locked-down test. A tile for each learner it's for (not
// started, doing it, handed in), their time left with any extra time, tries to leave, and whether the page is open; the
// teacher adds time for one learner or everyone, sends everyone a message (it shows on their screen, even locked down),
// and ends it for everyone.
import { useEffect, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Link, Loading, Page, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, kindLabel, time } from '../../lib/format.js';

const clockOf = (sec) => {
  const s = Math.max(0, Math.round(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

export default function ExamRoom({ id }) {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery(`exam-room:${id}`, () => api.examRoom(id), { poll: 5000 });
  const [now, setNow] = useState(Date.now());
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const d = q.data;
  if (!d) return <Page title="Exam room">{q.error ? <div className="error">{q.error.message}</div> : <Loading />}</Page>;
  const a = d.assignment;
  const doing = d.learners.filter((l) => l.attempt?.status === 'in_progress');
  const done = d.learners.filter((l) => l.attempt && l.attempt.status !== 'in_progress');
  const notYet = d.learners.filter((l) => !l.attempt);
  const refresh = () => invalidate(`exam-room:${id}`);
  async function act(what, fn, ok) {
    setBusy(what);
    try {
      const r = await fn();
      toast(typeof ok === 'function' ? ok(r) : ok);
      refresh();
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
    } finally {
      setBusy('');
    }
  }
  const addAll = (m) => act('all', () => api.examAddTime(id, m), (n) => (n ? `${m} more minutes for ${n} learner${n === 1 ? '' : 's'}` : 'Nobody is doing it right now'));
  async function endAll() {
    if (!(await confirm({ title: `End ${a.title} for everyone?`, body: `${doing.length} learner${doing.length === 1 ? ' is' : 's are'} still doing it. What they’ve answered so far is handed in.`, ok: 'End it for everyone', danger: true }))) return;
    act('end', () => api.examEnd(id), (n) => `Ended: ${n} handed in`);
  }
  async function send(e) {
    e.preventDefault();
    if (!msg.trim()) return;
    await act('msg', () => api.examMessage(id, msg.trim()), 'Sent to everyone doing it');
    setMsg('');
  }
  return (
    <Page
      eyebrow={
        <>
          <Link to="/assignments">Assignments</Link> <Icon name="right" size={14} /> {a.title}
        </>
      }
      title={`Exam room: ${a.title}`}
      subtitle={`${kindLabel[a.kind] || 'Work'}${a.time_limit_min ? ` · ${a.time_limit_min} minutes` : ''}${a.lockdown ? ' · locked down' : ''} · ${doing.length} doing it, ${done.length} handed in, ${notYet.length} not started`}
      actions={
        <>
          {a.time_limit_min && (
            <button className="btn" disabled={!!busy || !doing.length} onClick={() => addAll(5)}>
              <Icon name="plus" size={16} /> 5 minutes for everyone
            </button>
          )}
          <button className="btn danger" disabled={!!busy || !doing.length} onClick={endAll}>
            <Icon name="stop" size={16} /> End for everyone
          </button>
        </>
      }
    >
      <form className="card row wrap exam-message" onSubmit={send}>
        <input className="input grow" value={msg} onChange={(e) => setMsg(e.target.value)} maxLength={300} placeholder="For example: Ten minutes left. Check your working." aria-label="Message everyone" />
        <button className="btn primary" disabled={!!busy || !msg.trim()}>
          <Icon name="send" size={16} /> Message everyone
        </button>
        {d.messages.length > 0 && (
          <div className="exam-sent small muted">
            Sent:{' '}
            {d.messages
              .slice(-3)
              .reverse()
              .map((m) => `“${m.body}” (${time(m.at)})`)
              .join(' · ')}
          </div>
        )}
      </form>
      {d.learners.length === 0 ? (
        <Empty>Nobody has this yet. Post it to a class or to learners first.</Empty>
      ) : (
        <div className="exam-grid">
          {d.learners.map((l) => (
            <Tile key={l.id} l={l} a={a} now={now} busy={!!busy} onAdd={(m) => act(l.id, () => api.examAddTime(id, m, l.id), `${m} more minutes for ${l.name}`)} />
          ))}
        </div>
      )}
    </Page>
  );
}

function Tile({ l, a, now, busy, onAdd }) {
  const t = l.attempt;
  const doing = t?.status === 'in_progress';
  const left = doing && t.ends_at ? (new Date(t.ends_at).getTime() - now) / 1000 : null;
  const onPage = t?.seen_at && now - new Date(t.seen_at).getTime() < 75000;
  const tone = !t ? '' : doing ? (left != null && left < 300 ? 'warn' : 'good') : 'done';
  return (
    <div className={'card exam-tile ' + tone} aria-label={`${l.name}: ${!t ? 'not started' : doing ? 'doing it' : 'handed in'}`}>
      <div className="row between" style={{ gap: 8 }}>
        <span className="strong">{l.name}</span>
        <span className={'pill ' + (doing ? 'good' : t ? '' : 'warn')}>{!t ? 'Not started' : doing ? 'Doing it' : 'Handed in'}</span>
      </div>
      {doing && left != null && <div className="exam-clock">{clockOf(left)} left</div>}
      {doing && left == null && <div className="small muted">Started {ago(t.started_at)}</div>}
      {!doing && t && <div className="small muted">Handed in {ago(t.submitted_at)}</div>}
      <div className="meta small muted">
        {(l.extra_pct > 0 || t?.extra_min > 0) && <span>{t?.extra_min ? `+${t.extra_min} min` : `${l.extra_pct}% extra time`}</span>}
        {t?.strikes > 0 && (
          <span className="pill bad">
            {t.strikes} tr{t.strikes === 1 ? 'y' : 'ies'} to leave
          </span>
        )}
        {doing && a.watched && t.seen_at && <span>{onPage ? 'On the page' : `Not on the page since ${time(t.seen_at)}`}</span>}
        {t?.client && <span>{t.client}</span>}
      </div>
      <div className="row wrap" style={{ gap: 6 }}>
        {doing && a.time_limit_min && (
          <button className="btn sm" disabled={busy} onClick={() => onAdd(5)} aria-label={`Add 5 minutes for ${l.name}`}>
            +5 min
          </button>
        )}
        {doing && a.camera && (
          <Link to={`/watch/${t.id}`} className="btn sm ghost">
            <Icon name="video" size={14} /> Watch
          </Link>
        )}
        {t && !doing && (
          <Link to={`/marking/${t.id}`} className="btn sm ghost">
            Open
          </Link>
        )}
      </div>
    </div>
  );
}
