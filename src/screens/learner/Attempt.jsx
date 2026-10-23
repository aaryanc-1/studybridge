import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon, { Logo } from '../../ui/Icon.jsx';
import { Loading, Markdown, Modal, go, useToast, useDebounced } from '../../ui/kit.jsx';
import { useQuery, useOnline, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as outbox from '../../lib/outbox.js';
import * as store from '../../lib/store.js';
import { desktop } from '../../lib/config.js';
import { clock, kindLabel, typeLabel } from '../../lib/format.js';
import { answered } from '../../lib/questions.js';
import { QuestionPrompt } from '../shared/Answer.jsx';
import { Thread } from '../shared/Messages.jsx';
import { FileBody } from '../shared/FileView.jsx';
import { joinRoom } from '../shared/Live.jsx';
import AnswerInput from './AnswerInputs.jsx';
import { Hint, ReportProblem } from './SelfStudy.jsx';
import { strokesPicture } from '../../ui/DrawingPad.jsx';
import { confetti } from '../../ui/confetti.js';

// Watched attempts this page has open right now (a reloaded page starts again with none)
const openHere = new Set();

export default function Attempt({ id }) {
  const app = useApp();
  const toast = useToast();
  const online = useOnline();
  const detail = useQuery(`attempt:${id}`, () => api.attemptDetail(id));
  const aid = detail.data?.attempt.assignment_id;
  const assignments = useQuery('assignments', api.listAssignments);
  const a = (assignments.data || []).find((x) => x.id === aid);
  const questions = useQuery(aid ? `questions:${aid}` : null, () => api.listQuestions(aid));
  const files = useQuery('files', api.listFiles).data || [];
  const comments = useQuery('comments', api.listComments).data || [];
  const [answers, setAnswers] = useState(null);
  const [saveState, setSaveState] = useState('saved');
  const [current, setCurrent] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [done, setDone] = useState(null);
  const [panel, setPanel] = useState(null); // file id
  const [noteFor, setNoteFor] = useState(null);
  const [warning, setWarning] = useState('');
  const [strike, setStrike] = useState(null); // { warningsLeft } after a try to leave a locked-down exam
  const lastStrike = useRef(0);
  const [cam, setCam] = useState({ state: 'off' });
  const camRoom = useRef(null);
  const selfVideo = useRef(null);
  const d = detail.data;
  const qs = questions.data || [];
  const t = d?.attempt;
  const redoOnly = useMemo(() => (d?.responses || []).some((r) => r.redo), [d]);
  const editable = (qid) => !redoOnly || (d?.responses || []).find((r) => r.question_id === qid)?.redo;

  // Answers: what's on the server, overlaid with anything saved on this device
  useEffect(() => {
    if (!d || answers) return;
    api.localAnswers(id).then((local) => {
      const merged = {};
      for (const r of d.responses) merged[r.question_id] = r.answer;
      Object.assign(merged, local);
      setAnswers(merged);
    });
  }, [d, id, answers]);

  // Already handed in (maybe from another device)?
  useEffect(() => {
    store.get(`submitted:${id}`).then((s) => s && setDone({ queued: s.queued }));
  }, [id]);

  const locked = !!a?.lockdown && !!desktop && t?.status === 'in_progress' && !done;
  // Watched mode: the tutor lets a locked-down (or camera) test be done in a browser too, on a Chromebook, an iPad or a
  // phone. It goes full screen where it can, and leaving the page (another tab, app or window, or out of full screen) is
  // a strike, the same as the desktop app's lockdown. With only the camera on, the tutor is told.
  const canFull = typeof document !== 'undefined' && !!document.documentElement.requestFullscreen;
  const watching = !desktop && !!a?.watched && !!(a?.lockdown || a?.camera) && t?.status === 'in_progress' && !done;
  const watchLock = watching && !!a?.lockdown;
  const [outOfFull, setOutOfFull] = useState(false);
  const doneRef = useRef(done);
  doneRef.current = done;
  const watchLockRef = useRef(null); // what it is ("test"), while it's watched and locked down
  watchLockRef.current = watchLock ? kindLabel[a.kind]?.toLowerCase() || 'exam' : null;

  // Lockdown: fill the screen until handed in. Every try to leave is a strike: the first ones bring a warning,
  // and after the tutor's number of warnings the server hands the exam in.
  const handedInFor = useCallback(
    async (why) => {
      camRoom.current?.disconnect();
      if (desktop) await desktop.lockdown.exit();
      invalidate('myattempts', 'attempt');
      setStrike(null);
      setDone({ auto: true, why });
    },
    [], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    if (!locked) return;
    desktop.lockdown.enter(id);
    const off = desktop.lockdown.onEvent(async ({ event }) => {
      // one strike per few seconds (leaving the window can fire several events at once)
      if (Date.now() - lastStrike.current < 4000) return api.logLockdown(id, event);
      lastStrike.current = Date.now();
      try {
        const r = await api.lockdownStrike(id, event);
        if (r.handed_in) return handedInFor('left');
        setStrike({ warningsLeft: r.warnings_left ?? 0, event });
      } catch {
        // offline: the tutor is told when it sends; the warning still shows
        api.logLockdown(id, event);
        setStrike({ warningsLeft: 0, event });
      }
    });
    return () => {
      off();
      desktop.lockdown.exit();
    };
  }, [locked, id, handedInFor]);

  // Watched mode in a browser: every way of leaving the page is noticed. (Before the camera starts below, so the
  // browser asking for the camera isn't taken for leaving.)
  useEffect(() => {
    if (!watching) return;
    const lock = !!a.lockdown;
    const key = `sb.watched.${id}`;
    document.body.classList.add('watching'); // no menus: there's nowhere else to go
    // choosing a photo (the device's own picker or camera app) or the browser asking to use the camera isn't leaving
    let picking = false;
    let asking = false;
    let pickEnd = null;
    let wasFull = !!document.fullscreenElement;
    const leave = async (event) => {
      if (picking || asking) return api.logLockdown(id, `${event} (choosing a photo or starting the camera)`);
      // one strike per few seconds (leaving the page can fire several events at once)
      if (Date.now() - lastStrike.current < 4000) return api.logLockdown(id, event);
      lastStrike.current = Date.now();
      if (!lock) {
        api.logLockdown(id, event);
        return setWarning('You left the page, and your tutor has been told. Stay here until you hand in.');
      }
      try {
        const r = await api.lockdownStrike(id, event);
        if (r.handed_in) return handedInFor('left');
        setStrike({ warningsLeft: r.warnings_left ?? 0, event });
      } catch {
        // offline: the tutor is told when it sends; the warning still shows
        api.logLockdown(id, event);
        setStrike({ warningsLeft: 0, event });
      }
    };
    // Open on this device before, but this page is new: it was reloaded, the tab or browser was closed, or it was left for
    // another site and opened again (kept on the device, so closing the tab counts too)
    try {
      if (lock && !openHere.has(id) && localStorage.getItem(key) === 'open') leave('Closed or reloaded the page and came back');
      localStorage.setItem(key, 'open');
    } catch {}
    openHere.add(id);
    // still on the page: the tutor sees it, and is told when the page goes quiet for 2 minutes
    const beat = () => document.visibilityState === 'visible' && navigator.onLine !== false && api.watchSeen(id).catch(() => {});
    beat();
    const beatEvery = setInterval(beat, 30 * 1000);

    // the screen stays on (a phone that locks itself while they think would look like leaving)
    let wake = null;
    let alive = true;
    const keepAwake = () =>
      navigator.wakeLock
        ?.request('screen')
        .then((w) => (alive ? (wake = w) : w.release()))
        .catch(() => {});
    keepAwake();
    const hidden = () => (document.visibilityState === 'hidden' ? leave('Left the page (another tab or app)') : keepAwake());
    const blur = () =>
      setTimeout(() => {
        // another tab or app is counted as leaving the page; a frame inside the page is still the page
        if (!alive || document.visibilityState === 'hidden' || document.hasFocus() || document.activeElement?.tagName === 'IFRAME') return;
        leave('Switched to another window');
      }, 60);
    const fullChange = () => {
      const full = !!document.fullscreenElement;
      setOutOfFull(!full);
      if (wasFull && !full) leave('Left full screen');
      wasFull = full;
    };
    const pick = (e) => {
      if (!e.target?.matches?.('input[type=file]')) return;
      picking = true;
      clearTimeout(pickEnd);
      pickEnd = setTimeout(() => (picking = false), 90 * 1000);
    };
    // back on the page (or touching it again): the picker has closed
    const back = () => setTimeout(() => (picking = false), 1000);
    const touch = () => (picking = false);
    const md = navigator.mediaDevices;
    const askCamera = md?.getUserMedia;
    if (askCamera)
      md.getUserMedia = (...x) => {
        asking = true;
        return askCamera.apply(md, x).finally(() => setTimeout(() => (asking = false), 1500));
      };
    if (canFull) setOutOfFull(!document.fullscreenElement);
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('blur', blur);
    window.addEventListener('focus', back);
    document.addEventListener('fullscreenchange', fullChange);
    document.addEventListener('click', pick, true);
    document.addEventListener('pointerdown', touch, true);
    return () => {
      clearTimeout(pickEnd);
      clearInterval(beatEvery);
      document.removeEventListener('pointerdown', touch, true);
      document.body.classList.remove('watching');
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('blur', blur);
      window.removeEventListener('focus', back);
      document.removeEventListener('fullscreenchange', fullChange);
      document.removeEventListener('click', pick, true);
      if (askCamera) md.getUserMedia = askCamera;
      alive = false;
      wake?.release().catch(() => {});
    };
  }, [watching, id, handedInFor]); // eslint-disable-line react-hooks/exhaustive-deps
  // Handed in (or stopped): nothing more to notice in this tab
  useEffect(() => {
    if (!done) return;
    openHere.delete(id);
    try {
      localStorage.removeItem(`sb.watched.${id}`);
    } catch {}
  }, [done, id]);
  // Leaving the page inside the app (the browser's back button or a back swipe) is leaving too: it's counted, and
  // they're told, as they'll be on another page by then
  useEffect(
    () => () => {
      const what = watchLockRef.current;
      if (!what || doneRef.current) return;
      openHere.delete(id);
      try {
        localStorage.setItem(`sb.watched.${id}`, 'left'); // counted now, so not again when they come back
      } catch {}
      api
        .lockdownStrike(id, 'Left the page')
        .then((r) =>
          toast({
            title: r.handed_in ? `Handed in: you left the ${what}` : `You left the ${what}`,
            body: r.handed_in
              ? 'Your tutor has been told.'
              : r.warnings_left > 0
                ? `Your tutor has been told. After ${r.warnings_left} more warning${r.warnings_left === 1 ? '' : 's'}, leaving hands your work in.`
                : 'Your tutor has been told. If you leave again, your work is handed in straight away.',
            tone: 'bad',
            ms: 9000,
          }),
        )
        .catch(() => api.logLockdown(id, 'Left the page'))
        .finally(() => invalidate('myattempts', 'attempt'));
    },
    [id], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // The tutor can end it, and the server hands it in when time runs out: notice either within seconds
  useEffect(() => {
    if (!t || t.status !== 'in_progress' || done || !aid) return;
    const iv = setInterval(async () => {
      try {
        const mine = await api.myAttempts(aid);
        const now = (mine || []).find((x) => x.id === id);
        if (!now) {
          if (desktop) await desktop.lockdown.exit();
          setDone({ cancelled: true });
        } else if (now.status !== 'in_progress') handedInFor(null);
      } catch {
        /* offline: keep going */
      }
    }, 15000);
    return () => clearInterval(iv);
  }, [t?.status, done, aid, id, handedInFor]); // eslint-disable-line react-hooks/exhaustive-deps

  // Camera (and screen) for the tutor to watch
  useEffect(() => {
    if (!a?.camera || !t || t.status !== 'in_progress' || done) return;
    let alive = true;
    setCam({ state: 'connecting' });
    joinRoom(`attempt-${id}`, { publish: true, camera: true, mic: false, screen: !!desktop })
      .then((room) => {
        if (!alive) return room.disconnect();
        camRoom.current = room;
        setCam({ state: 'on' });
        const pub = [...room.localParticipant.trackPublications.values()].find((p) => p.source === 'camera');
        if (pub?.track && selfVideo.current) pub.track.attach(selfVideo.current);
      })
      .catch((e) => {
        if (!alive) return;
        setCam({ state: 'failed', error: e.message });
        api.logLockdown(id, `Camera could not start (${(e.message || '').slice(0, 80)})`);
      });
    return () => {
      alive = false;
      camRoom.current?.disconnect();
      camRoom.current = null;
    };
  }, [a?.camera, t?.status, id, done]); // eslint-disable-line react-hooks/exhaustive-deps

  // Time on task (only while actually working)
  useEffect(() => {
    if (!t || t.status !== 'in_progress' || done) return;
    let acc = 0;
    let last = Date.now();
    let lastInput = Date.now();
    const bump = () => (lastInput = Date.now());
    ['pointerdown', 'keydown', 'pointermove'].forEach((e) => window.addEventListener(e, bump, { passive: true }));
    const iv = setInterval(() => {
      const now = Date.now();
      if (!document.hidden && now - lastInput < 3 * 60000) acc += (now - last) / 1000;
      last = now;
      if (acc >= 30) {
        api.logTime('assignment', id, acc);
        acc = 0;
      }
    }, 5000);
    return () => {
      clearInterval(iv);
      ['pointerdown', 'keydown', 'pointermove'].forEach((e) => window.removeEventListener(e, bump));
      if (acc >= 5) api.logTime('assignment', id, acc);
    };
  }, [t?.status, id, done]); // eslint-disable-line react-hooks/exhaustive-deps

  // Timer
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  const left = a?.time_limit_min && t && !redoOnly ? a.time_limit_min * 60 - (now - new Date(t.started_at).getTime()) / 1000 : null;

  // Exam conditions (students on their own, in a browser; chosen before starting): full screen until it's handed in.
  // Leaving full screen is counted on the attempt and they're asked to go back. Phones that can't go full screen
  // just keep the timer.
  const [examMode] = useState(() => {
    try {
      return !desktop && canFull && sessionStorage.getItem(`sb.exam.${id}`) === '1';
    } catch {
      return false;
    }
  });
  const [leftFull, setLeftFull] = useState(0);
  useEffect(() => {
    if (!examMode || t?.status !== 'in_progress' || done) return;
    const change = () => {
      const full = !!document.fullscreenElement;
      setOutOfFull(!full);
      if (!full) api.noteLeftFullScreen(id).then((n) => n != null && setLeftFull(n)).catch(() => {});
    };
    setOutOfFull(!document.fullscreenElement);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, [examMode, t?.status, done, id]);
  useEffect(() => {
    if (done && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  }, [done]);

  const pendingSaves = useRef({});
  const flushOne = useCallback(
    async (qid, ans) => {
      setSaveState('saving');
      try {
        const r = await api.saveAnswer(id, qid, ans);
        setSaveState(r.queued ? 'device' : 'saved');
      } catch (e) {
        setSaveState('error');
        toast({ title: 'Couldn’t save your answer', body: e.message, tone: 'bad' });
      }
    },
    [id, toast],
  );
  const debouncedSave = useDebounced(async () => {
    const all = pendingSaves.current;
    pendingSaves.current = {};
    for (const [qid, ans] of Object.entries(all)) await flushOne(qid, ans);
  }, 900);

  function change(qid, ans) {
    setAnswers((x) => ({ ...x, [qid]: ans }));
    pendingSaves.current[qid] = ans;
    setSaveState('typing');
    // Keep a copy on this device straight away
    api.localAnswers(id).then((local) => store.set(`ans:${id}`, { ...local, [qid]: ans }));
    debouncedSave();
  }

  const submit = useCallback(
    async (auto = false) => {
      if (submitting) return;
      setSubmitting(true);
      try {
        const all = pendingSaves.current;
        pendingSaves.current = {};
        for (const [qid, ans] of Object.entries(all)) await api.saveAnswer(id, qid, ans);
        // drawings: a picture of each goes with it, so Prof can read and mark it (works offline too)
        for (const q of qs.filter((x) => x.type === 'drawing')) {
          const ans = answers?.[q.id];
          if (!ans?.strokes?.length) continue;
          try {
            const pic = await strokesPicture(ans.strokes);
            if (!pic) {
              await api.saveAnswer(id, q.id, { ...ans, blank: true }); // rubbed out or empty: no answer
              continue;
            }
            const f = await api.saveWorkImage(id, q.id, pic, 'drawing.png');
            await api.saveAnswer(id, q.id, { ...ans, image: f.path });
          } catch {
            /* the tutor's app makes the picture later if this one couldn't */
          }
        }
        const r = await api.submitAttempt(id);
        camRoom.current?.disconnect();
        if (desktop) await desktop.lockdown.exit();
        invalidate('myattempts', 'attempt');
        // quizzes and practice are marked the moment they're handed in
        let marked = null;
        if (!r.queued) marked = await api.attemptDetail(id).then((x) => (x?.attempt?.status === 'marked' && x.attempt.released ? x.attempt : null)).catch(() => null);
        setDone({ queued: !!r.queued, auto, marked });
        confetti();
      } catch (e) {
        toast({ title: 'Couldn’t hand in', body: e.message, tone: 'bad' });
        setSubmitting(false);
      }
    },
    [id, submitting, toast, qs, answers],
  );

  // Hand in automatically when time runs out
  useEffect(() => {
    if (left != null && left <= 0 && t?.status === 'in_progress' && !done && !submitting) submit(true);
  }, [left, t?.status, done, submitting, submit]);

  if (detail.error && !d) return <CenterMessage title="This work couldn’t open" body={detail.error.message} />;
  if (!d || !a || !questions.data || !answers) return <Loading label="Opening your work…" />;

  if (done?.marked) {
    const m = done.marked;
    const p = m.max_score ? Math.round((Number(m.score) / Number(m.max_score)) * 100) : null;
    return (
      <CenterMessage
        icon="trophy"
        medal
        title={`${Number(m.score)} / ${Number(m.max_score)}${p != null ? ` · ${p}%` : ''}`}
        body={a?.practice ? (p === 100 ? 'All correct. Brilliant!' : 'Marked straight away. See which ones to look at again, then practise as often as you like.') : 'Marked straight away. See which ones you got right.'}
        action={
          <div className="row wrap" style={{ justifyContent: 'center' }}>
            <button className="btn primary big" onClick={() => go(`/results/${id}`)}>
              See my answers
            </button>
            {a?.practice && (
              <button className="btn big" onClick={() => go(`/work/${a.id}`)}>
                Practise again
              </button>
            )}
          </div>
        }
      />
    );
  }
  if (done?.cancelled)
    return <CenterMessage title="Your tutor stopped this" body="Nothing was handed in. You can start it again when your tutor says so." action={<button className="btn primary" onClick={() => go('/work')}>Back to my work</button>} />;
  if (done)
    return (
      <CenterMessage
        icon="trophy"
        medal={!done.why}
        title={done.why === 'left' ? `Handed in: you tried to leave the ${kindLabel[a?.kind]?.toLowerCase() || 'exam'}` : done.auto ? 'Handed in' : 'Handed in. Well done!'}
        body={
          done.queued
            ? 'You’re offline, so it’s saved on this laptop and will send by itself as soon as you’re connected. Don’t sign out until it has.'
            : app.me.self_learner
              ? (a?.self_mark
                  ? 'Now mark it yourself with the mark scheme: that’s where you learn the most.'
                  : 'See how you did, and look at the worked solutions for anything you missed.') +
                (examMode ? (leftFull ? ` You left full screen ${leftFull} time${leftFull === 1 ? '' : 's'}: in the real exam, try not to.` : ' You stayed in full screen the whole time, like the real exam.') : '')
              : 'Your tutor has been told. You’ll get a notification when it’s marked.'
        }
        action={
          <button className="btn primary big" onClick={() => go(done.queued ? '/work' : `/results/${id}`)}>
            {done.queued ? 'Back to my work' : app.me.self_learner && a?.self_mark ? 'Mark it now' : 'See what I handed in'}
          </button>
        }
      />
    );
  if (t.status !== 'in_progress')
    return <CenterMessage title="Already handed in" body="This attempt has been handed in." action={<button className="btn primary" onClick={() => go(`/results/${id}`)}>See results</button>} />;

  const attached = (a.file_refs || []).map((r) => files.find((f) => f.id === r.file_id)).filter(Boolean);
  const answeredCount = qs.filter((q) => answered(q, answers[q.id])).length;
  const unanswered = qs.length - answeredCount;
  const openFile = attached.find((f) => f.id === panel);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {locked && (
        <div className="banner lock">
          <Icon name="lock" size={18} />
          <span className="grow">Locked until you hand in. Trying to leave is reported to your tutor{a.leave_warnings > 0 ? `, and after ${a.leave_warnings} warning${a.leave_warnings === 1 ? '' : 's'} it hands your work in` : ' and hands your work in'}.</span>
        </div>
      )}
      {watching && canFull && outOfFull ? (
        <div className="banner lock" role="alert">
          <Icon name="maximize" size={18} />
          <span className="grow">Watched mode: you’re out of full screen. Go back to it and stay on this page until you hand in.</span>
          <button className="btn sm" onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}>
            Back to full screen
          </button>
        </div>
      ) : (
        watching && (
          <div className="banner lock">
            <Icon name="eye" size={18} />
            <span className="grow">
              {watchLock
                ? `Watched mode: stay on this page until you hand in. Leaving it is reported to your tutor${a.leave_warnings > 0 ? `, and after ${a.leave_warnings} warning${a.leave_warnings === 1 ? '' : 's'} it hands your work in` : ' and hands your work in'}.`
                : 'Watched mode: your tutor can see your camera, and leaving this page is reported to them.'}
            </span>
          </div>
        )
      )}
      {!online && (
        <div className="banner off">
          <Icon name="wifiOff" size={18} />
          <span className="grow">You’re offline. Keep going: your answers are saved on this device and send when you’re back.</span>
        </div>
      )}
      {examMode && outOfFull && (
        <div className="banner lock" role="alert">
          <Icon name="maximize" size={18} />
          <span className="grow">
            Exam conditions: you’re out of full screen. In the real exam you couldn’t leave.{leftFull > 0 ? ` (${leftFull} time${leftFull === 1 ? '' : 's'} so far)` : ''}
          </span>
          <button className="btn sm" onClick={() => document.documentElement.requestFullscreen?.().catch(() => {})}>
            Back to full screen
          </button>
        </div>
      )}
      <div className="attempt-bar">
        <Logo size={26} />
        <div className="grow" style={{ minWidth: 160 }}>
          <div className="strong ellipsis">{a.title}</div>
          <div className="tiny muted">
            {kindLabel[a.kind]} · {answeredCount} of {qs.length} answered
          </div>
        </div>
        <span className="save-state" aria-live="polite">
          {saveState === 'saving' || saveState === 'typing' ? 'Saving…' : saveState === 'device' ? 'Saved on this device' : saveState === 'error' ? 'Not saved' : 'All saved'}
        </span>
        {cam.state !== 'off' && (
          <span className="camchip" title={cam.error}>
            <video ref={selfVideo} autoPlay muted playsInline />
            {cam.state === 'on' ? 'Tutor can see you' : cam.state === 'connecting' ? 'Starting camera…' : 'Camera off'}
          </span>
        )}
        {left != null && <span className={'timer' + (left < 300 ? ' low' : '')} aria-label="Time left">{clock(left)}</span>}
        {attached.length > 0 && (
          <button className="btn sm" onClick={() => setPanel(panel ? null : attached[0].id)} aria-pressed={!!panel}>
            <Icon name="book" size={16} /> {panel ? 'Hide resources' : 'Resources'}
          </button>
        )}
        {!locked && !watchLock && (
          <button className="btn sm ghost" onClick={() => go(`/work/${a.id}`)}>
            Save & close
          </button>
        )}
        <button className="btn primary" onClick={() => setConfirmSubmit(true)} disabled={submitting}>
          Hand in
        </button>
      </div>
      {warning && (
        <div className="banner off" role="alert">
          <Icon name="alert" size={18} />
          <span className="grow">{warning}</span>
          <button className="btn sm ghost" onClick={() => setWarning('')}>
            OK
          </button>
        </div>
      )}
      <div className="content" style={{ paddingTop: 20 }}>
        <div className={panel ? 'split even' : ''} style={{ maxWidth: panel ? 1600 : 860, margin: '0 auto' }}>
          <div className="stack lg">
            {redoOnly && <div className="card warn small">Your tutor asked you to redo the highlighted questions. The others are already marked.</div>}
            {a.instructions_md && (
              <div className="card">
                <Markdown src={a.instructions_md} />
              </div>
            )}
            <div className="qnav" aria-label="Questions">
              {qs.map((q, i) => (
                <button
                  key={q.id}
                  className={(answered(q, answers[q.id]) ? 'done ' : '') + (redoOnly && editable(q.id) ? 'redo' : '')}
                  aria-current={current === i}
                  onClick={() => {
                    setCurrent(i);
                    document.getElementById('q-' + q.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                >
                  {i + 1}
                </button>
              ))}
            </div>
            {qs.map((q, i) => {
              const can = editable(q.id);
              const notes = comments.filter((c) => c.question_id === q.id);
              return (
                <div key={q.id} id={'q-' + q.id} className={'qcard' + (current === i ? ' active' : '')} onFocusCapture={() => setCurrent(i)} style={!can ? { opacity: 0.65 } : undefined}>
                  <div className="qhead">
                    <span className="qnum">{i + 1}</span>
                    <span className="muted small">{typeLabel[q.type]}</span>
                    <span className="grow" />
                    {redoOnly && can && <span className="pill warn">Redo</span>}
                    {!can && <span className="pill">Already marked</span>}
                    <span className="muted small">
                      {Number(q.marks)} mark{Number(q.marks) === 1 ? '' : 's'}
                    </span>
                  </div>
                  <QuestionPrompt q={q} />
                  {a.practice && <Hint md={q.hint_md} />}
                  <AnswerInput q={q} value={answers[q.id] || {}} onChange={(v) => change(q.id, v)} attemptId={id} disabled={!can} />
                  {app.me.self_learner ? (
                    <div>
                      <ReportProblem kind="question" id={q.id} />
                    </div>
                  ) : a.allow_notes && (
                    <div className="stack sm">
                      {noteFor === q.id || notes.length ? (
                        <div className="card" style={{ background: 'var(--sunk)', padding: 14 }}>
                          <div className="label">Notes with your tutor</div>
                          <Thread learnerId={app.me.id} all={comments} assignments={[a]} assignmentId={a.id} questionId={q.id} compact />
                        </div>
                      ) : (
                        <div>
                          <button className="linkbtn small" onClick={() => setNoteFor(q.id)}>
                            <Icon name="message" size={14} /> Leave a note for your tutor
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <div className="row between wrap" style={{ paddingBottom: 30 }}>
              <span className="muted small">
                {unanswered ? `${unanswered} question${unanswered > 1 ? 's' : ''} not answered yet.` : 'Everything answered.'}
              </span>
              <button className="btn primary big" onClick={() => setConfirmSubmit(true)} disabled={submitting}>
                Hand in
              </button>
            </div>
          </div>
          {panel && (
            <div className="side-doc stack sm">
              {attached.length > 1 && (
                <select className="select" value={panel} onChange={(e) => setPanel(e.target.value)} aria-label="Resource">
                  {attached.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              )}
              {openFile && <FileBody file={openFile} />}
            </div>
          )}
        </div>
      </div>
      {confirmSubmit && (
        <Modal
          title="Hand in now?"
          onClose={() => setConfirmSubmit(false)}
          foot={
            <>
              <button className="btn" onClick={() => setConfirmSubmit(false)}>
                Keep working
              </button>
              <button
                className="btn primary"
                disabled={submitting}
                onClick={() => {
                  setConfirmSubmit(false);
                  submit(false);
                }}
              >
                {submitting ? 'Handing in…' : 'Hand in'}
              </button>
            </>
          }
        >
          <div>{unanswered ? `You haven’t answered ${unanswered} question${unanswered > 1 ? 's' : ''}. ` : ''}You can’t change your answers after handing in.</div>
        </Modal>
      )}
      {strike && (
        <div className="lock-warning" role="alertdialog" aria-labelledby="strike-title">
          <div className="card" style={{ maxWidth: 520, textAlign: 'center', alignItems: 'center', padding: 32 }}>
            <Icon name="alert" size={44} style={{ color: 'var(--red)' }} />
            <h1 id="strike-title" style={{ fontFamily: 'var(--serif)', fontSize: 26 }}>
              You can’t leave this {kindLabel[a.kind]?.toLowerCase() || 'exam'}
            </h1>
            <div>
              {strike.warningsLeft > 0
                ? `Your tutor has been told. After ${strike.warningsLeft} more warning${strike.warningsLeft === 1 ? '' : 's'}, trying to leave hands your work in.`
                : 'Your tutor has been told. If you try to leave again, your work is handed in straight away.'}
            </div>
            <button
              className="btn primary big"
              onClick={() => {
                setStrike(null);
                // watched mode: back into full screen too (it needs a tap, and this is one)
                if (watching && canFull && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
              }}
            >
              Back to my work
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function CenterMessage({ icon = 'info', title, body, action, medal }) {
  return (
    <div className="lock-screen">
      <div className="card celebrate" style={{ maxWidth: 520, alignItems: 'center', textAlign: 'center', padding: 36 }}>
        {medal ? (
          <div className="medal">
            <Icon name={icon} size={46} />
          </div>
        ) : (
          <Icon name={icon} size={44} style={{ color: 'var(--accent)' }} />
        )}
        <h1 style={{ fontFamily: 'var(--serif)', fontSize: 28 }}>{title}</h1>
        {body && <div className="muted">{body}</div>}
        {action}
        {!action && (
          <button className="btn" onClick={() => go('/work')}>
            Back to my work
          </button>
        )}
      </div>
    </div>
  );
}
