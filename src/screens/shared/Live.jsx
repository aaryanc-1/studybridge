import { useCallback, useEffect, useRef, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Field, Link, Loading, Modal, Page, go, useConfirm, useRoute, useToast } from '../../ui/kit.jsx';
import Whiteboard from '../../ui/Whiteboard.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { desktop } from '../../lib/config.js';
import { ago, day, fromLocalInput, toLocalInput, when, time, timeIn, placeOf, myTimezone, kindLabel, clock, forKind } from '../../lib/format.js';
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
  const [starting, setStarting] = useState(false);
  const [pastOpen, setPastOpen] = useState(null);
  // lesson notes written for a past lesson (Recent → the lesson → Open lesson notes)
  const lessons = useQuery(isTutor ? 'lessons' : null, api.listLessons).data || [];
  // a new lesson: the next quarter hour, everyone
  const newLesson = () => ({ title: '', starts_at: new Date(Math.ceil(Date.now() / 900000) * 900000).toISOString(), duration_min: 60, learner_ids: lk.learners.map((l) => l.id), repeat: false });
  // /live?schedule=1 (Home's "Book a lesson") opens the form straight away; a reload doesn't open it again
  const route = useRoute();
  const wantsSchedule = isTutor && !sessionId && route.query.get('schedule') === '1';
  useEffect(() => {
    if (!wantsSchedule) return;
    setEditing(newLesson());
    go('/live', { replace: true });
  }, [wantsSchedule]); // eslint-disable-line react-hooks/exhaustive-deps

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
  // a class's name first: "Year 10 maths: Sis Tue 16:00 Lusaka, Sam" (a weekly lesson's class is on the weekly lesson)
  const forWho = (s) => {
    const c = lk.klass(s.class_id || seriesList.find((x) => x.id === s.series_id)?.class_id);
    const names = learnerTimes(s);
    return c ? `${c.name}${names ? `: ${names}` : ' (nobody yet)'}` : names;
  };
  const upcoming = list.filter((s) => new Date(s.starts_at).getTime() + s.duration_min * 60000 > now);
  const past = list.filter((s) => !s.cancelled && new Date(s.starts_at).getTime() + s.duration_min * 60000 <= now).reverse().slice(0, 10);
  const notesFor = (s) => lessons.find((l) => l.session_id === s.id);
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
            <button className="btn" onClick={() => setEditing(newLesson())}>
              <Icon name="calendar" size={18} /> Schedule
            </button>
            <button className="btn primary" disabled={!configured} onClick={() => setStarting(true)}>
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
              <div className="small">{isTutor ? 'StudyBridge is switching it on. If you need it now, tell StudyBridge.' : 'Your tutor will tell you when it’s ready.'}</div>
              {isTutor && (
                <div>
                  <button className="btn sm" onClick={() => go('/settings?s=contact')}>
                    Contact StudyBridge
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
              const skipped = !next && list.some((s) => s.series_id === x.id && s.cancelled && new Date(s.starts_at).getTime() > now);
              return (
                <div key={x.id} className="item">
                  <Icon name="calendar" style={{ color: 'var(--accent)' }} />
                  <span className="grow">
                    <span className="name">{x.title}</span>
                    <span className="meta">
                      {next ? `Every ${timeIn(next.starts_at, myTz)} your time · ${forWho(next)}` : skipped ? 'The lessons coming up are skipped' : 'No lessons coming up'}
                      {x.ends_on && ` · last one ${day(x.ends_on + 'T12:00')}`}
                    </span>
                  </span>
                  {/* always changeable, even when the next lessons are skipped */}
                  <button
                    className="btn sm ghost"
                    aria-label="Change weekly lesson"
                    onClick={() => setEditing(next ? { ...next, scope: 'all', until: x.ends_on || '' } : { ...afterLastLesson(x, list), scope: 'all', seriesOnly: true, until: x.ends_on || '' })}
                  >
                    <Icon name="pen" size={16} />
                  </button>
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
                      {isTutor && ` · ${forWho(s)}`}
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
                          try {
                            await api.remove('sessions', s.id);
                            invalidate('sessions');
                          } catch (e) {
                            toast({ title: 'Couldn’t cancel it', body: e.message, tone: 'bad' });
                          }
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
            {past.map((s) => {
              const inner = (
                <>
                  <Icon name="video" style={{ color: 'var(--muted)' }} />
                  <span className="grow">
                    <span className="name">{s.title}</span>
                    <span className="meta">
                      {when(s.starts_at)}
                      {isTutor && notesFor(s) && <span>Lesson notes written</span>}
                    </span>
                  </span>
                  {s.notes_md && <span className="small muted ellipsis" style={{ maxWidth: 300 }}>{s.notes_md}</span>}
                </>
              );
              // the tutor opens a past lesson to see who was there and write (or open) its lesson notes
              return isTutor ? (
                <button key={s.id} className="item" onClick={() => setPastOpen(s)} aria-haspopup="dialog">
                  {inner}
                  <Icon name="more" size={18} />
                </button>
              ) : (
                <div key={s.id} className="item">
                  {inner}
                </div>
              );
            })}
          </div>
        </div>
      )}
      {starting && <StartNow onClose={() => setStarting(false)} />}
      {pastOpen && <PastLesson session={pastOpen} notes={notesFor(pastOpen)} onClose={() => setPastOpen(null)} />}
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

// A weekly lesson with nothing coming up (the next ones were skipped): changing it starts the week after its
// last lesson (so skipped ones stay skipped), on my clock
function afterLastLesson(x, sessions) {
  const mine = sessions.filter((s) => s.series_id === x.id);
  const d = mine.length ? new Date(mine[mine.length - 1].starts_at) : new Date(`${x.starts_on}T${x.start_time}`);
  if (mine.length) d.setDate(d.getDate() + 7);
  while (d.getTime() <= Date.now()) d.setDate(d.getDate() + 7);
  return { title: x.title, starts_at: d.toISOString(), duration_min: x.duration_min, learner_ids: x.learner_ids || [], class_id: x.class_id || null, notes_md: x.notes_md, series_id: x.id };
}

function SessionForm({ initial, series, onClose }) {
  const lk = useLookups();
  const toast = useToast();
  // a weekly lesson's class is on the weekly lesson itself
  const [s, setS] = useState({ repeat: false, ...initial, class_id: (initial.series_id && series ? series.class_id : initial.class_id) || null, until: initial.until || series?.ends_on || '' });
  const [scope, setScope] = useState(initial.scope || 'one'); // a weekly lesson: just this one, or this and every week after
  const [err, setErr] = useState('');
  // seriesOnly: the weekly lesson itself, with no lesson of its own to change (all the coming ones were skipped)
  const isNew = !s.id && !initial.seriesOnly;
  const weekly = !!s.series_id;
  const allWeeks = (isNew && s.repeat) || (weekly && scope === 'all');
  // For a class: whoever is in it, now and later (not for one lesson of a weekly lesson)
  const canPickClass = (lk.activeClasses.length > 0 || !!s.class_id) && !(weekly && scope === 'one');
  const klass = canPickClass && s.class_id ? lk.klass(s.class_id) : null;
  const ids = klass ? lk.membersOf(klass.id).filter((id) => lk.learner(id)) : s.learner_ids;
  const myTz = myTimezone();
  const chosen = lk.learners.filter((l) => ids.includes(l.id) && l.timezone && timeIn(s.starts_at, l.timezone) !== timeIn(s.starts_at, myTz));
  const moving = allWeeks ? chosen.filter((l) => movesWithClocks(s.starts_at, l.timezone)) : [];
  async function submit(e) {
    e.preventDefault();
    if (!s.title.trim()) return setErr('Give the lesson a title.');
    if (klass && !ids.length) return setErr('Nobody is in this class yet. Add learners to it first.');
    if (!ids.length) return setErr('Choose at least one learner.');
    const row = { title: s.title.trim(), starts_at: s.starts_at, duration_min: Number(s.duration_min) || 60, learner_ids: ids, class_id: klass?.id || null, notes_md: s.notes_md || null, until: allWeeks ? s.until || null : null };
    try {
      if (isNew && s.repeat) {
        await api.createSeries(row);
        toast('Weekly lesson set. Your learners have been told.');
      } else if (weekly && scope === 'all') {
        await api.changeSeries(s.series_id, row, initial.starts_at);
        toast('Changed from this lesson on. Your learners have been told.');
      } else {
        // one lesson of a weekly lesson keeps the weekly lesson's class
        await api.save('sessions', { ...(s.id ? { id: s.id } : {}), title: row.title, starts_at: row.starts_at, duration_min: row.duration_min, learner_ids: row.learner_ids, notes_md: row.notes_md, ...(weekly ? {} : { class_id: row.class_id }) });
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
        {weekly && !initial.seriesOnly && (
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
        {canPickClass && (
          <Field label="Who">
            <select
              className="select"
              value={klass ? klass.id : ''}
              onChange={(e) => {
                const c = lk.klass(e.target.value);
                setS({ ...s, class_id: c ? c.id : null, learner_ids: c ? lk.membersOf(c.id).filter((id) => lk.learner(id)) : ids });
              }}
            >
              <option value="">Choose learners</option>
              {lk.activeClasses.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} ({c.members.length} {c.members.length === 1 ? 'learner' : 'learners'})
                </option>
              ))}
              {klass?.archived && <option value={klass.id}>{klass.name} (put away)</option>}
            </select>
          </Field>
        )}
        <Field label="Learners" hint="They get a message with the time in their own time zone, and reminders a day and 15 minutes before.">
          {klass ? (
            <>
              {ids.length ? (
                <div className="small">
                  {ids.map((id) => lk.learner(id).display_name).join(', ')}, and anyone who joins the class later.
                </div>
              ) : (
                <div className="small" style={{ color: 'var(--amber-ink)' }}>
                  Nobody is in this class yet.
                </div>
              )}
            </>
          ) : (
            <div className="stack sm">
              {lk.learners.map((l) => (
                <label key={l.id} className="check">
                  <input type="checkbox" checked={s.learner_ids.includes(l.id)} onChange={(e) => setS({ ...s, learner_ids: e.target.checked ? [...s.learner_ids, l.id] : s.learner_ids.filter((x) => x !== l.id) })} />
                  <span className="t">{l.display_name}</span>
                  <span className="s">{placeOf(l.timezone)}</span>
                </label>
              ))}
            </div>
          )}
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

// "Start now": choose who's invited (everyone to begin with), then straight into the lesson
function StartNow({ onClose }) {
  const lk = useLookups();
  const toast = useToast();
  const [title, setTitle] = useState('Live lesson');
  const [ids, setIds] = useState(() => lk.learners.map((l) => l.id));
  const [busy, setBusy] = useState(false);
  const none = lk.learners.length > 0 && ids.length === 0;
  async function start() {
    setBusy(true);
    try {
      const s = await api.save('sessions', { title: title.trim() || 'Live lesson', starts_at: new Date().toISOString(), duration_min: 60, learner_ids: ids });
      invalidate('sessions');
      onClose();
      go(`/live/${s.id}`);
    } catch (e) {
      toast({ title: 'Couldn’t start the lesson', body: e.message, tone: 'bad' });
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Start a lesson now"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || none} onClick={start}>
            <Icon name="video" size={18} /> Start
          </button>
        </>
      }
    >
      <div className="stack">
        <Field label="Title">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Simultaneous equations" />
        </Field>
        <Field label="Who to invite" hint={none ? 'Choose at least one learner.' : 'They get a message that the lesson is starting.'}>
          {lk.learners.length === 0 ? (
            <div className="small muted">You don’t have any learners yet. You can still start a lesson to try it out.</div>
          ) : (
            <div className="stack sm">
              {lk.learners.length > 1 && (
                <label className="check">
                  <input type="checkbox" checked={ids.length === lk.learners.length} onChange={(e) => setIds(e.target.checked ? lk.learners.map((l) => l.id) : [])} />
                  <span className="t">Everyone</span>
                </label>
              )}
              {lk.learners.map((l) => (
                <label key={l.id} className="check">
                  <input type="checkbox" checked={ids.includes(l.id)} onChange={(e) => setIds(e.target.checked ? [...ids, l.id] : ids.filter((x) => x !== l.id))} />
                  <span className="t">{l.display_name}</span>
                  <span className="s">{placeOf(l.timezone)}</span>
                </label>
              ))}
            </div>
          )}
        </Field>
      </div>
    </Modal>
  );
}

// A lesson that's over: when it was, who was in it, and its lesson notes (open them, or write them now)
function PastLesson({ session: s, notes, onClose }) {
  const lk = useLookups();
  const who = (s.learner_ids || []).map((id) => lk.learner(id)?.display_name).filter(Boolean);
  return (
    <Modal title={s.title} onClose={onClose}>
      <div className="stack">
        <div className="stack sm">
          <div className="row" style={{ gap: 8 }}>
            <Icon name="calendar" size={16} style={{ color: 'var(--muted)' }} />
            {day(s.starts_at)}, {time(s.starts_at)} your time
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Icon name="clock" size={16} style={{ color: 'var(--muted)' }} />
            {s.duration_min} minutes
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Icon name="users" size={16} style={{ color: 'var(--muted)' }} />
            {who.length ? who.join(', ') : 'No learners'}
          </div>
          {s.notes_md && <div className="small muted pre-wrap">{s.notes_md}</div>}
        </div>
        <div className="sheet-actions">
          {notes ? (
            <button className="btn primary" onClick={() => go(`/lesson/${notes.id}`)}>
              <Icon name="book" size={18} /> Open lesson notes
            </button>
          ) : (
            <button className="btn primary" onClick={() => go(`/lesson/new?session=${s.id}`)}>
              <Icon name="pen" size={18} /> Write lesson notes
            </button>
          )}
        </div>
      </div>
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

// Watched work done in a browser: which device, e.g. "Done on a Chromebook (watched)". The desktop app needs no note.
const DEVICES = { Chromebook: 'a Chromebook', iPad: 'an iPad', iPhone: 'an iPhone', Android: 'an Android phone or tablet', browser: 'a web browser', web: 'a web browser' };
export function doneOn(attempt, a) {
  const c = attempt?.client;
  if (!c || c === 'desktop' || !(a?.lockdown || a?.camera || a?.watched)) return '';
  return `Done on ${DEVICES[c] || c} (watched)`;
}

// Watched work still going in a browser: "On the page now", or "Not on the page since 10:42" (the page checks in
// every 30 seconds while it's open)
export function onPage(attempt, a) {
  if (!attempt || attempt.status !== 'in_progress' || !a?.watched || !attempt.client || attempt.client === 'desktop' || !attempt.seen_at) return '';
  const seen = new Date(attempt.seen_at);
  return Date.now() - seen.getTime() < 90 * 1000 ? 'On the page now' : `Not on the page since ${seen.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}

// ---------- tutor watches an exam camera ----------
export function Watch({ attemptId }) {
  const lk = useLookups();
  const confirm = useConfirm();
  const toast = useToast();
  const detail = useQuery(`attempt:${attemptId}`, () => api.attemptDetail(attemptId), { poll: 10000 });
  const aid = detail.data?.attempt.assignment_id;
  const a = useQuery(aid ? `assignment:${aid}` : null, () => api.getAssignment(aid)).data;
  const row = (useQuery('attempts', api.listAttempts).data || []).find((x) => x.id === attemptId); // which device it's on
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
  const device = doneOn({ client: t?.client ?? row?.client }, a);

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
      subtitle={t && `${kindLabel[a?.kind] || ''} · started ${ago(t.started_at)}${left != null ? ` · ${left > 0 ? clock(left) + ' left' : 'time up'}` : ''}${onPage(t, a) ? ` · ${onPage(t, a)}` : ''}`}
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
      {device && (
        <div className="small muted row" style={{ gap: 6 }}>
          <Icon name="eye" size={15} /> {device}
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
          {them?.screen ? <VideoTile track={them.screen} name="Their screen" contain /> : <div className="tile" style={{ color: '#aaa' }}>{device ? 'A browser doesn’t share the screen. You’re told each time they leave the page instead.' : room ? 'Their screen shows here when shared.' : 'Connecting…'}</div>}
        </div>
      </div>
      <div className="card">
        <h3>Lockdown alerts</h3>
        {events.length === 0 ? (
          <div className="muted small">None so far. You’ll be notified if they leave the {kindLabel[a?.kind]?.toLowerCase() || 'exam'} window.</div>
        ) : (
          <div className="list small">
            {[...events].reverse().map((e, i) => (
              <div key={i} className="item" style={{ padding: '6px 0' }}>
                <Icon name="alert" size={16} style={{ color: 'var(--amber-ink)' }} />
                <span className="muted" style={{ width: 90 }}>{new Date(e.at).toLocaleTimeString()}</span>
                {forKind(e.event, a?.kind)}
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
    return 'Live video couldn’t connect. Try again in a minute; if it keeps happening, tell StudyBridge (Settings → Contact StudyBridge).';
  return m || 'Couldn’t connect to the live session.';
}
