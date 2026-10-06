import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Field, Link, Loading, Modal, Page, go, useConfirm, useToast } from '../../ui/kit.jsx';
import Whiteboard from '../../ui/Whiteboard.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { desktop } from '../../lib/config.js';
import { ago, day, fromLocalInput, toLocalInput, when, time, timeIn, placeOf, myTimezone, kindLabel, clock } from '../../lib/format.js';
import { useLookups } from './lookups.jsx';
import { dataSaver, liveMode } from '../../lib/device.js';

// ---------- LiveKit connection ----------
export async function joinRoom(roomName, { publish = true, camera = true, mic = true, screen = false } = {}) {
  const { Room, RoomEvent, VideoPresets, VideoQuality, Track } = await import('livekit-client');
  const pass = await api.livePass(roomName);
  if (publish && desktop) await desktop.askMedia();
  // Data saver (live lessons only; exam cameras stay as they are): small video, or no cameras at all
  const saver = dataSaver() && !roomName.startsWith('attempt-') ? liveMode() : null;
  if (saver === 'audio') camera = false;
  const room = new Room({
    adaptiveStream: true,
    dynacast: true,
    ...(saver
      ? {
          videoCaptureDefaults: { resolution: VideoPresets.h180.resolution },
          publishDefaults: { simulcast: false, videoEncoding: { maxBitrate: 120_000, maxFramerate: 12 }, screenShareEncoding: { maxBitrate: 350_000, maxFramerate: 5 } },
        }
      : {}),
  });
  if (saver)
    room.on(RoomEvent.TrackSubscribed, (_track, pub) => {
      if (pub.kind !== 'video') return;
      if (saver === 'audio' && pub.source === Track.Source.Camera) pub.setSubscribed(false);
      else pub.setVideoQuality?.(VideoQuality.LOW);
    });
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
  const toast = useToast();
  // the tutor also sees skipped weekly lessons (to put them back); learners never do
  const sessions = useQuery(isTutor ? 'sessions:all' : 'sessions', isTutor ? api.listAllSessions : api.listSessions);
  const seriesList = useQuery('sessions:series', api.listSeries).data || [];
  const [stopping, setStopping] = useState(null);
  const [showAll, setShowAll] = useState(false);
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
  const myTz = myTimezone();
  const todayStr = toLocalInput(new Date().toISOString()).slice(0, 10);
  const activeSeries = seriesList.filter((x) => !x.ends_on || x.ends_on >= todayStr);
  // "Sis Tue 16:00 Lusaka" for learners whose clock differs from mine
  const learnerTimes = (s) =>
    s.learner_ids
      .map((id) => {
        const l = lk.learner(id);
        if (!l) return null;
        const theirs = timeIn(s.starts_at, l.timezone);
        return l.timezone && theirs && theirs !== timeIn(s.starts_at, myTz) ? `${l.display_name} ${theirs} ${placeOf(l.timezone)}` : l.display_name;
      })
      .filter(Boolean)
      .join(', ');
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
            <button className="btn" onClick={() => setEditing({ title: '', starts_at: new Date(Math.ceil(now / 900000) * 900000).toISOString(), duration_min: 60, learner_ids: lk.learners.map((l) => l.id), repeat: false })}>
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
      {isTutor && activeSeries.length > 0 && (
        <div className="card">
          <h2>Weekly lessons</h2>
          <div className="list">
            {activeSeries.map((x) => {
              const next = list.find((s) => s.series_id === x.id && !s.cancelled && new Date(s.starts_at).getTime() > now);
              return (
                <div key={x.id} className="item">
                  <Icon name="calendar" style={{ color: 'var(--accent)' }} />
                  <span className="grow">
                    <span className="name">{x.title}</span>
                    <span className="meta">
                      {next ? `Every ${timeIn(next.starts_at, myTz)} your time · ${learnerTimes(next)}` : 'No lessons coming up'}
                      {x.ends_on && ` · last one ${day(x.ends_on + 'T12:00')}`}
                    </span>
                  </span>
                  {next && (
                    <button className="btn sm ghost" aria-label="Change weekly lesson" onClick={() => setEditing({ ...next, scope: 'all', until: x.ends_on || '' })}>
                      <Icon name="pen" size={16} />
                    </button>
                  )}
                  <button className="btn sm ghost" aria-label="Stop weekly lesson" onClick={() => setStopping({ ...(next || {}), series_id: x.id, whole: true })}>
                    <Icon name="trash" size={16} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="card">
        <h2>Upcoming</h2>
        {upcoming.length === 0 ? (
          <div className="muted small">No lessons scheduled.</div>
        ) : (
          <div className="list">
            {(showAll ? upcoming : upcoming.slice(0, 8)).map((s) => {
              const live = new Date(s.starts_at).getTime() - 15 * 60000 < now;
              return (
                <div key={s.id} className="item" style={s.cancelled ? { opacity: 0.6 } : undefined}>
                  <Icon name="video" style={{ color: s.cancelled ? 'var(--muted)' : 'var(--accent)' }} />
                  <span className="grow">
                    <span className="name row" style={{ gap: 6 }}>
                      {s.title}
                      {s.series_id && <span className="pill accent">Weekly</span>}
                      {s.cancelled && <span className="pill">Skipped</span>}
                    </span>
                    <span className="meta">
                      {when(s.starts_at)}
                      {isTutor && ' your time'} · {s.duration_min} min
                      {isTutor && ` · ${learnerTimes(s)}`}
                    </span>
                  </span>
                  {isTutor && s.cancelled && (
                    <button
                      className="btn sm"
                      onClick={async () => {
                        try {
                          await api.skipLesson(s.id, false);
                          toast('Back on. Your learners have been told.');
                        } catch (x) {
                          toast({ title: 'Couldn’t put it back', body: x.message, tone: 'bad' });
                        }
                        invalidate('sessions');
                      }}
                    >
                      Put back
                    </button>
                  )}
                  {isTutor && !s.cancelled && (
                    <>
                      <button className="btn sm ghost" onClick={() => setEditing(s)} aria-label="Edit session">
                        <Icon name="pen" size={16} />
                      </button>
                      <button
                        className="btn sm ghost"
                        aria-label="Cancel session"
                        onClick={async () => {
                          if (s.series_id) return setStopping(s);
                          if (!(await confirm({ title: 'Cancel this lesson?', body: 'Your learners get a message saying it’s cancelled.', ok: 'Cancel lesson', cancel: 'Keep', danger: true }))) return;
                          await api.remove('sessions', s.id);
                          invalidate('sessions');
                        }}
                      >
                        <Icon name="trash" size={16} />
                      </button>
                    </>
                  )}
                  {!s.cancelled && (
                    <button className={'btn sm ' + (live ? 'primary' : '')} disabled={!configured} onClick={() => go(`/live/${s.id}`)}>
                      {live ? 'Join now' : 'Open'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!showAll && upcoming.length > 8 && (
          <div>
            <button className="btn sm ghost" onClick={() => setShowAll(true)}>
              Show all {upcoming.length}
            </button>
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
      {editing && <SessionForm initial={editing} series={seriesList.find((x) => x.id === editing.series_id)} onClose={() => setEditing(null)} />}
      {stopping && (
        <Modal
          title="This is a weekly lesson"
          onClose={() => setStopping(null)}
          foot={
            <button className="btn" onClick={() => setStopping(null)}>
              Keep it
            </button>
          }
        >
          <div className="stack">
            {stopping.starts_at && <div className="small muted">Next: {when(stopping.starts_at)} your time</div>}
            {stopping.id && !stopping.whole && (
              <button
                className="btn"
                onClick={async () => {
                  try {
                    await api.skipLesson(stopping.id);
                    toast('Skipped. Your learners have been told.');
                  } catch (x) {
                    toast({ title: 'Couldn’t skip it', body: x.message, tone: 'bad' });
                  }
                  invalidate('sessions');
                  setStopping(null);
                }}
              >
                Skip just this one
              </button>
            )}
            <button
              className="btn danger"
              onClick={async () => {
                try {
                  await api.endSeries(stopping.series_id);
                  toast('Weekly lesson stopped. Your learners have been told.');
                } catch (x) {
                  toast({ title: 'Couldn’t stop it', body: x.message, tone: 'bad' });
                }
                invalidate('sessions');
                setStopping(null);
              }}
            >
              Stop the weekly lesson
            </button>
            <div className="small muted">Past lessons stay in reports either way.</div>
          </div>
        </Modal>
      )}
    </Page>
  );
}

// Does a learner's clock time for this lesson move over the next half year (one country changes its clocks, the other doesn't)?
function movesWithClocks(startIso, tz) {
  const base = new Date(startIso);
  const t0 = timeIn(base, tz, { weekday: false });
  for (let w = 4; w <= 26; w += 2) {
    const d = new Date(base);
    d.setDate(d.getDate() + 7 * w); // same clock time for me, w weeks later
    if (timeIn(d, tz, { weekday: false }) !== t0) return true;
  }
  return false;
}

function SessionForm({ initial, series, onClose }) {
  const lk = useLookups();
  const toast = useToast();
  const [s, setS] = useState({ repeat: false, ...initial, until: initial.until || series?.ends_on || '' });
  const [scope, setScope] = useState(initial.scope || 'one'); // a weekly lesson: just this one, or this and every week after
  const [err, setErr] = useState('');
  const isNew = !s.id;
  const weekly = !!s.series_id;
  const allWeeks = (isNew && s.repeat) || (weekly && scope === 'all');
  const myTz = myTimezone();
  const chosen = lk.learners.filter((l) => s.learner_ids.includes(l.id) && l.timezone && timeIn(s.starts_at, l.timezone) !== timeIn(s.starts_at, myTz));
  const moving = allWeeks ? chosen.filter((l) => movesWithClocks(s.starts_at, l.timezone)) : [];
  async function submit(e) {
    e.preventDefault();
    if (!s.title.trim()) return setErr('Give the lesson a title.');
    if (!s.learner_ids.length) return setErr('Choose at least one learner.');
    const row = { title: s.title.trim(), starts_at: s.starts_at, duration_min: Number(s.duration_min) || 60, learner_ids: s.learner_ids, notes_md: s.notes_md || null, until: allWeeks ? s.until || null : null };
    try {
      if (isNew && s.repeat) {
        await api.createSeries(row);
        toast('Weekly lesson set. Your learners have been told.');
      } else if (weekly && scope === 'all') {
        await api.changeSeries(s.series_id, row, initial.starts_at);
        toast('Changed from this lesson on. Your learners have been told.');
      } else {
        await api.save('sessions', { ...(s.id ? { id: s.id } : {}), title: row.title, starts_at: row.starts_at, duration_min: row.duration_min, learner_ids: row.learner_ids, notes_md: row.notes_md });
      }
      invalidate('sessions');
      onClose();
    } catch (x) {
      setErr(x.message);
    }
  }
  return (
    <Modal title={isNew ? 'Schedule a lesson' : weekly ? 'Change a weekly lesson' : 'Edit lesson'} onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        {weekly && (
          <div className="row wrap" role="radiogroup" aria-label="Which lessons">
            <label className="check">
              <input type="radio" name="scope" checked={scope === 'one'} onChange={() => setScope('one')} />
              <span className="t">Just this lesson</span>
            </label>
            <label className="check">
              <input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} />
              <span className="t">This and every week after</span>
            </label>
          </div>
        )}
        <Field label="Title">
          <input className="input" autoFocus value={s.title} onChange={(e) => setS({ ...s, title: e.target.value })} placeholder="e.g. Simultaneous equations" />
        </Field>
        <div className="grid g2" style={{ gap: 10 }}>
          <Field label={allWeeks ? 'First lesson (your time)' : 'Starts (your time)'} hint={chosen.length ? chosen.map((l) => `${l.display_name}: ${timeIn(s.starts_at, l.timezone)} in ${placeOf(l.timezone)}`).join(' · ') : undefined}>
            <input className="input" type="datetime-local" value={toLocalInput(s.starts_at)} onChange={(e) => setS({ ...s, starts_at: fromLocalInput(e.target.value) })} />
          </Field>
          <Field label="Length (minutes)">
            <input className="input" type="number" min="10" step="5" value={s.duration_min} onChange={(e) => setS({ ...s, duration_min: e.target.value })} />
          </Field>
        </div>
        {isNew && (
          <Field label="Repeat">
            <select className="select" value={s.repeat ? 'week' : 'once'} onChange={(e) => setS({ ...s, repeat: e.target.value === 'week' })}>
              <option value="once">Just this once</option>
              <option value="week">Every week</option>
            </select>
          </Field>
        )}
        {allWeeks && (
          <Field label="Last lesson (optional)" hint="Leave empty to keep it going. Lessons are planned 8 weeks ahead and keep coming.">
            <input className="input" type="date" value={s.until || ''} onChange={(e) => setS({ ...s, until: e.target.value })} />
          </Field>
        )}
        {moving.length > 0 && (
          <div className="small muted">
            It stays at {time(s.starts_at)} your time every week. {moving.map((l) => l.display_name).join(' and ')}’s time moves by an hour when the clocks change.
          </div>
        )}
        <Field label="Learners" hint="They get a message with the time in their own time zone, and reminders a day and 15 minutes before.">
          <div className="stack sm">
            {lk.learners.map((l) => (
              <label key={l.id} className="check">
                <input type="checkbox" checked={s.learner_ids.includes(l.id)} onChange={(e) => setS({ ...s, learner_ids: e.target.checked ? [...s.learner_ids, l.id] : s.learner_ids.filter((x) => x !== l.id) })} />
                <span className="t">{l.display_name}</span>
                <span className="s">{placeOf(l.timezone)}</span>
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
  const confirm = useConfirm();
  const toast = useToast();
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
        ) : t ? (
          // Only the tutor can let a learner out of a locked-down exam early
          <>
            <button
              className="btn"
              onClick={async () => {
                if (!(await confirm({ title: 'Hand it in now?', body: `${learner?.display_name || 'They'} stop${learner ? 's' : ''} straight away and what they’ve answered is handed in for marking.`, ok: 'Hand in now' }))) return;
                try {
                  await api.endAttempt(attemptId, 'hand_in');
                  invalidate(`attempt:${attemptId}`, 'attempts');
                  toast('Handed in');
                } catch (e) {
                  toast({ title: 'Couldn’t hand it in', body: e.message, tone: 'bad' });
                }
              }}
            >
              Hand in now
            </button>
            <button
              className="btn danger"
              onClick={async () => {
                if (!(await confirm({ title: 'Let them leave?', body: 'Nothing is handed in and this attempt is removed, so they can start the exam again later. Use this for an emergency or if something went wrong.', ok: 'Let them leave', danger: true }))) return;
                try {
                  await api.endAttempt(attemptId, 'cancel');
                  invalidate('attempts');
                  toast('They can leave now');
                  go('/live');
                } catch (e) {
                  toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
                }
              }}
            >
              Let them leave
            </button>
          </>
        ) : null
      }
    >
      {t && t.status !== 'in_progress' && (
        <div className="okmsg">
          Submitted {ago(t.submitted_at)}
          {t.auto_reason ? ` (handed in automatically: ${t.auto_reason})` : ''}. The camera has stopped.
        </div>
      )}
      {t && t.status === 'in_progress' && a?.lockdown && (
        <div className="small muted">
          Tries to leave so far: {t.strikes || 0}. {a.leave_warnings > 0 ? `After ${a.leave_warnings} warning${a.leave_warnings === 1 ? '' : 's'}, the next try hands it in.` : 'The first try hands it in.'}
        </div>
      )}
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
