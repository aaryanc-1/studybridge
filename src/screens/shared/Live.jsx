import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Field, Link, Loading, Modal, Page, go, useConfirm, useToast } from '../../ui/kit.jsx';
import Whiteboard from '../../ui/Whiteboard.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { desktop } from '../../lib/config.js';
import { ago, fromLocalInput, toLocalInput, when, kindLabel, clock } from '../../lib/format.js';
import { useLookups } from './lookups.jsx';

// ---------- LiveKit connection ----------
export async function joinRoom(roomName, { publish = true, camera = true, mic = true, screen = false } = {}) {
  const { Room, RoomEvent } = await import('livekit-client');
  const pass = await api.livePass(roomName);
  if (publish && desktop) await desktop.askMedia();
  const room = new Room({ adaptiveStream: true, dynacast: true });
  await room.connect(pass.url, pass.token);
  if (publish) {
    try {
      if (camera) await room.localParticipant.setCameraEnabled(true);
    } catch {}
    try {
      if (mic) await room.localParticipant.setMicrophoneEnabled(true);
    } catch {}
    try {
      if (screen) await room.localParticipant.setScreenShareEnabled(true);
    } catch {}
  }
  room.RoomEvent = RoomEvent;
  return room;
}

// Everyone in the room and their video/audio
export function useParticipants(room) {
  const [list, setList] = useState([]);
  useEffect(() => {
    if (!room) return;
    const upd = () => {
      const all = [room.localParticipant, ...room.remoteParticipants.values()];
      setList(
        all.map((p) => {
          const pubs = [...p.trackPublications.values()];
          const cam = pubs.find((x) => x.source === 'camera' && x.track);
          const scr = pubs.find((x) => x.source === 'screen_share' && x.track);
          const aud = pubs.find((x) => x.source === 'microphone' && x.track);
          return { id: p.identity, name: p.name || 'Someone', local: p === room.localParticipant, cam: cam?.isMuted ? null : cam?.track, screen: scr?.track, audio: aud?.track, micOn: !!aud && !aud.isMuted };
        }),
      );
    };
    upd();
    const evs = ['participantConnected', 'participantDisconnected', 'trackSubscribed', 'trackUnsubscribed', 'localTrackPublished', 'localTrackUnpublished', 'trackMuted', 'trackUnmuted'];
    evs.forEach((e) => room.on(e, upd));
    return () => evs.forEach((e) => room.off(e, upd));
  }, [room]);
  return list;
}

export function VideoTile({ track, name, mirror, contain, audio, local }) {
  const v = useRef(null);
  const a = useRef(null);
  useEffect(() => {
    if (!track || !v.current) return;
    track.attach(v.current);
    return () => track.detach(v.current);
  }, [track]);
  useEffect(() => {
    if (!audio || local || !a.current) return;
    audio.attach(a.current);
    return () => audio.detach(a.current);
  }, [audio, local]);
  return (
    <div className="tile">
      {track ? <video ref={v} autoPlay playsInline muted className={contain ? 'contain' : ''} style={mirror ? { transform: 'scaleX(-1)' } : undefined} /> : <Avatar person={{ display_name: name }} size="lg" />}
      {audio && !local && <audio ref={a} autoPlay />}
      <span className="who">{name}</span>
    </div>
  );
}

// ---------- sessions list ----------
export default function Live({ sessionId }) {
  const app = useApp();
  const isTutor = app.me.role === 'tutor';
  const lk = useLookups();
  const confirm = useConfirm();
  const sessions = useQuery('sessions', api.listSessions);
  const status = useQuery('live-status', api.liveStatus);
  const attempts = useQuery(isTutor ? 'attempts' : null, api.listAttempts).data || [];
  const assignments = useQuery('assignments', api.listAssignments).data || [];
  const [editing, setEditing] = useState(null);

  if (sessionId) {
    const s = (sessions.data || []).find((x) => x.id === sessionId);
    if (!sessions.data) return <Loading />;
    if (!s) return <Page title="Live session"><Empty>This session isn’t available.</Empty></Page>;
    return <LiveRoom session={s} onLeave={() => go('/live')} />;
  }

  const now = Date.now();
  const list = sessions.data || [];
  const upcoming = list.filter((s) => new Date(s.starts_at).getTime() + s.duration_min * 60000 > now);
  const past = list.filter((s) => new Date(s.starts_at).getTime() + s.duration_min * 60000 <= now).reverse().slice(0, 10);
  const aById = Object.fromEntries(assignments.map((a) => [a.id, a]));
  const watching = attempts.filter((t) => t.status === 'in_progress' && aById[t.assignment_id]?.camera);
  const configured = status.data?.configured;

  return (
    <Page
      title="Live"
      subtitle={isTutor ? 'Video lessons with a shared whiteboard, and live exam cameras.' : 'Your live lessons with a shared whiteboard.'}
      actions={
        isTutor && (
          <>
            <button className="btn" onClick={() => setEditing({ title: '', starts_at: new Date(Math.ceil(now / 900000) * 900000).toISOString(), duration_min: 60, learner_ids: lk.learners.map((l) => l.id) })}>
              <Icon name="calendar" size={18} /> Schedule
            </button>
            <button
              className="btn primary"
              disabled={!configured}
              onClick={async () => {
                const s = await api.save('sessions', { title: 'Live lesson', starts_at: new Date().toISOString(), duration_min: 60, learner_ids: lk.learners.map((l) => l.id) });
                invalidate('sessions');
                go(`/live/${s.id}`);
              }}
            >
              <Icon name="video" size={18} /> Start now
            </button>
          </>
        )
      }
    >
      {status.data && !configured && (
        <div className="card warn">
          <div className="row top">
            <Icon name="info" />
            <div className="stack sm">
              <div className="strong">Live video isn’t switched on yet</div>
              <div className="small">{isTutor ? 'Add your free LiveKit keys in Settings → Live video. It takes two minutes.' : 'Your tutor needs to switch it on first.'}</div>
              {isTutor && (
                <div>
                  <button className="btn sm" onClick={() => go('/settings?s=live')}>
                    Open settings
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      {isTutor && watching.length > 0 && (
        <div className="card">
          <h2 className="row">
            <span className="dot live" /> Exam cameras
          </h2>
          <div className="list">
            {watching.map((t) => (
              <Link key={t.id} to={`/watch/${t.id}`} className="item">
                <Avatar person={lk.learner(t.learner_id)} size="sm" />
                <span className="grow">
                  <span className="name">{lk.learner(t.learner_id)?.display_name} · {aById[t.assignment_id]?.title}</span>
                  <span className="meta">Started {ago(t.started_at)}</span>
                </span>
                <span className="btn sm primary">Watch</span>
              </Link>
            ))}
          </div>
        </div>
      )}
      <div className="card">
        <h2>Upcoming</h2>
        {upcoming.length === 0 ? (
          <div className="muted small">No sessions scheduled.</div>
        ) : (
          <div className="list">
            {upcoming.map((s) => {
              const live = new Date(s.starts_at).getTime() - 15 * 60000 < now;
              return (
                <div key={s.id} className="item">
                  <Icon name="video" style={{ color: 'var(--accent)' }} />
                  <span className="grow">
                    <span className="name">{s.title}</span>
                    <span className="meta">
                      {when(s.starts_at)} · {s.duration_min} min
                      {isTutor && ` · ${s.learner_ids.map((id) => lk.learner(id)?.display_name).filter(Boolean).join(', ')}`}
                    </span>
                  </span>
                  {isTutor && (
                    <>
                      <button className="btn sm ghost" onClick={() => setEditing(s)} aria-label="Edit session">
                        <Icon name="pen" size={16} />
                      </button>
                      <button
                        className="btn sm ghost"
                        aria-label="Cancel session"
                        onClick={async () => {
                          if (!(await confirm({ title: 'Cancel this session?', ok: 'Cancel session', cancel: 'Keep', danger: true }))) return;
                          await api.remove('sessions', s.id);
                          invalidate('sessions');
                        }}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </>
                  )}
                  <button className={'btn sm ' + (live ? 'primary' : '')} disabled={!configured} onClick={() => go(`/live/${s.id}`)}>
                    {live ? 'Join now' : 'Open'}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      {past.length > 0 && (
        <div className="card">
          <h2>Recent</h2>
          <div className="list">
            {past.map((s) => (
              <div key={s.id} className="item">
                <Icon name="video" style={{ color: 'var(--muted)' }} />
                <span className="grow">
                  <span className="name">{s.title}</span>
                  <span className="meta">{when(s.starts_at)}</span>
                </span>
                {s.notes_md && <span className="small muted ellipsis" style={{ maxWidth: 300 }}>{s.notes_md}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
      {editing && <SessionForm initial={editing} onClose={() => setEditing(null)} />}
    </Page>
  );
}

function SessionForm({ initial, onClose }) {
  const lk = useLookups();
  const [s, setS] = useState(initial);
  const [err, setErr] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (!s.title.trim()) return setErr('Give the session a title.');
    if (!s.learner_ids.length) return setErr('Choose at least one learner.');
    try {
      await api.save('sessions', { ...(s.id ? { id: s.id } : {}), title: s.title.trim(), starts_at: s.starts_at, duration_min: Number(s.duration_min) || 60, learner_ids: s.learner_ids, notes_md: s.notes_md || null });
      invalidate('sessions');
      onClose();
    } catch (x) {
      setErr(x.message);
    }
  }
  return (
    <Modal title={s.id ? 'Edit session' : 'Schedule a live session'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <Field label="Title">
          <input className="input" autoFocus value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} placeholder="e.g. Simultaneous equations" />
        </Field>
        <div className="grid g2" style={{ gap: 10 }}>
          <Field label="Starts (your time)">
            <input className="input" type="datetime-local" value={toLocalInput(s.starts_at)} onChange={(e) => setS({ ...s, starts_at: fromLocalInput(e.target.value) })} />
          </Field>
          <Field label="Length (minutes)">
            <input className="input" type="number" min="10" step="5" value={s.duration_min} onChange={(e) => setS({ ...s, duration_min: e.target.value })} />
          </Field>
        </div>
        <Field label="Learners" hint="They get a notification with the time in their own time zone.">
          <div className="stack sm">
            {lk.learners.map((l) => (
              <label key={l.id} className="check">
                <input type="checkbox" checked={s.learner_ids.includes(l.id)} onChange={(e) => setS({ ...s, learner_ids: e.target.checked ? [...s.learner_ids, l.id] : s.learner_ids.filter((x) => x !== l.id) })} />
                <span className="t">{l.display_name}</span>
                <span className="s">{l.timezone}</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label="Notes (optional)">
          <textarea className="textarea" style={{ minHeight: 60 }} value={s.notes_md || ''} onChange={(e) => setS({ ...s, notes_md: e.target.value })} placeholder="What to bring or revise" />
        </Field>
        {err && <div className="error">{err}</div>}
        <div className="foot row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

// ---------- in a live session ----------
function LiveRoom({ session, onLeave }) {
  const app = useApp();
  const [room, setRoom] = useState(null);
  const [err, setErr] = useState('');
  const [board, setBoard] = useState(true);
  const [state, setState] = useState({ cam: true, mic: true, screen: false });
  const people = useParticipants(room);
  const started = useRef(Date.now());
  const [, tick] = useState(0);

  useEffect(() => {
    let r = null;
    let alive = true;
    joinRoom(`session-${session.id}`)
      .then((x) => {
        r = x;
        if (alive) setRoom(x);
        else x.disconnect();
      })
      .catch((e) => alive && setErr(liveError(e)));
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => {
      alive = false;
      clearInterval(t);
      r?.disconnect();
    };
  }, [session.id]);

  // Count live-session time for learners
  useEffect(() => {
    if (app.me.role !== 'learner' || !room) return;
    const t = setInterval(() => api.logTime('session', session.id, 60), 60000);
    return () => clearInterval(t);
  }, [room, app.me.role, session.id]);

  const toggle = useCallback(
    async (what) => {
      if (!room) return;
      const lp = room.localParticipant;
      try {
        if (what === 'cam') await lp.setCameraEnabled(!state.cam);
        if (what === 'mic') await lp.setMicrophoneEnabled(!state.mic);
        if (what === 'screen') await lp.setScreenShareEnabled(!state.screen);
        setState((s) => ({ ...s, [what]: !s[what] }));
      } catch {}
    },
    [room, state],
  );

  const screens = people.filter((p) => p.screen);

  return (
    <div className="live" role="dialog" aria-label={`Live session: ${session.title}`}>
      <div className="lbar">
        <span className="dot live" />
        <span className="strong">{session.title}</span>
        <span className="small" style={{ opacity: 0.7 }}>{clock((Date.now() - started.current) / 1000)}</span>
        <span className="grow" />
        <button className={'btn sm ' + (state.mic ? 'on' : '')} onClick={() => toggle('mic')} aria-label={state.mic ? 'Mute' : 'Unmute'} aria-pressed={state.mic}>
          <Icon name={state.mic ? 'mic' : 'micOff'} size={18} />
        </button>
        <button className={'btn sm ' + (state.cam ? 'on' : '')} onClick={() => toggle('cam')} aria-label={state.cam ? 'Turn camera off' : 'Turn camera on'} aria-pressed={state.cam}>
          <Icon name={state.cam ? 'video' : 'videoOff'} size={18} />
        </button>
        <button className={'btn sm ' + (state.screen ? 'on' : '')} onClick={() => toggle('screen')} aria-pressed={state.screen}>
          <Icon name="screen" size={18} /> {state.screen ? 'Stop sharing' : 'Share screen'}
        </button>
        <button className={'btn sm ' + (board ? 'on' : '')} onClick={() => setBoard((b) => !b)} aria-pressed={board}>
          <Icon name="pen" size={18} /> Whiteboard
        </button>
        <button className="btn sm danger solid" onClick={onLeave}>
          Leave
        </button>
      </div>
      {err ? (
        <div style={{ padding: 30 }}>
          <div className="error" style={{ maxWidth: 520 }}>{err}</div>
          <button className="btn" style={{ marginTop: 14 }} onClick={onLeave}>
            Back
          </button>
        </div>
      ) : !room ? (
        <div className="loading" style={{ color: '#ccc' }}>
          <div className="spinner" /> Connecting…
        </div>
      ) : (
        <div className={'lbody' + (board || screens.length ? '' : ' board-off')}>
          <div className="stage">
            {board ? (
              <Whiteboard room={room} me={app.me.id} />
            ) : screens.length ? (
              <div style={{ flex: 1, padding: 10 }}>
                <VideoTile track={screens[0].screen} name={`${screens[0].name}’s screen`} contain />
              </div>
            ) : null}
          </div>
          <div className="tiles">
            {people.map((p) => (
              <VideoTile key={p.id} track={p.cam} audio={p.audio} local={p.local} name={p.local ? 'You' : p.name} mirror={p.local} />
            ))}
            {board && screens.map((p) => <VideoTile key={p.id + 's'} track={p.screen} name={`${p.local ? 'Your' : p.name + '’s'} screen`} contain />)}
            {people.length === 1 && <div className="small" style={{ opacity: 0.7, padding: 8 }}>Waiting for others to join…</div>}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- tutor watches an exam camera ----------
export function Watch({ attemptId }) {
  const lk = useLookups();
  const detail = useQuery(`attempt:${attemptId}`, () => api.attemptDetail(attemptId), { poll: 10000 });
  const aid = detail.data?.attempt.assignment_id;
  const a = useQuery(aid ? `assignment:${aid}` : null, () => api.getAssignment(aid)).data;
  const [room, setRoom] = useState(null);
  const [err, setErr] = useState('');
  const people = useParticipants(room);

  useEffect(() => {
    let r = null;
    let alive = true;
    joinRoom(`attempt-${attemptId}`, { publish: false })
      .then((x) => {
        r = x;
        if (alive) setRoom(x);
        else x.disconnect();
      })
      .catch((e) => alive && setErr(liveError(e)));
    return () => {
      alive = false;
      r?.disconnect();
    };
  }, [attemptId]);

  const t = detail.data?.attempt;
  const learner = t ? lk.learner(t.learner_id) : null;
  const them = people.find((p) => !p.local);
  const events = t?.lockdown_events || [];
  const left = a?.time_limit_min && t ? a.time_limit_min * 60 - (Date.now() - new Date(t.started_at).getTime()) / 1000 : null;

  return (
    <Page
      size="wide"
      eyebrow={
        <>
          <Link to="/live">Live</Link> <Icon name="right" size={14} /> Exam camera
        </>
      }
      title={
        <span className="row" style={{ gap: 12 }}>
          {t?.status === 'in_progress' && <span className="dot live" />}
          {learner?.display_name || 'Learner'} · {a?.title || ''}
        </span>
      }
      subtitle={t && `${kindLabel[a?.kind] || ''} · started ${ago(t.started_at)}${left != null ? ` · ${left > 0 ? clock(left) + ' left' : 'time up'}` : ''}`}
      actions={
        t && t.status !== 'in_progress' ? (
          <button className="btn primary" onClick={() => go(`/marking/${attemptId}`)}>
            Mark it
          </button>
        ) : null
      }
    >
      {t && t.status !== 'in_progress' && <div className="okmsg">Submitted {ago(t.submitted_at)}. The camera has stopped.</div>}
      {err && <div className="error">{err}</div>}
      <div className="watch-grid">
        <div className="stack sm">
          <div className="label">Camera</div>
          {them?.cam ? <VideoTile track={them.cam} audio={them.audio} name={learner?.display_name} /> : <div className="tile" style={{ color: '#aaa' }}>{room ? 'Waiting for their camera…' : 'Connecting…'}</div>}
        </div>
        <div className="stack sm">
          <div className="label">Screen</div>
          {them?.screen ? <VideoTile track={them.screen} name="Their screen" contain /> : <div className="tile" style={{ color: '#aaa' }}>{room ? 'Their screen shows here when shared.' : 'Connecting…'}</div>}
        </div>
      </div>
      <div className="card">
        <h3>Lockdown alerts</h3>
        {events.length === 0 ? (
          <div className="muted small">None so far. You’ll be notified if they leave the exam window.</div>
        ) : (
          <div className="list small">
            {[...events].reverse().map((e, i) => (
              <div key={i} className="item" style={{ padding: '6px 0' }}>
                <Icon name="alert" size={16} style={{ color: 'var(--amber-ink)' }} />
                <span className="muted" style={{ width: 90 }}>{new Date(e.at).toLocaleTimeString()}</span>
                {e.event}
              </div>
            ))}
          </div>
        )}
      </div>
    </Page>
  );
}

// LiveKit's messages, in words people can act on
function liveError(e) {
  const m = String(e?.message || e || '');
  if (/invalid API key|invalid token|signature|unauthorized|401/i.test(m))
    return 'Live video couldn’t sign in: the LiveKit keys don’t match. Tutor: check Settings → Live video (or, for the shared setup, Admin → Live video for every tutor) and paste the current key, secret and URL from cloud.livekit.io.';
  return m || 'Couldn’t connect to the live session.';
}
