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
import { confetti } from '../../ui/confetti.js';

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
  const [leaving, setLeaving] = useState(false);
  const [warning, setWarning] = useState('');
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

  // Lockdown: fill the screen until handed in; report attempts to leave
  useEffect(() => {
    if (!locked) return;
    desktop.lockdown.enter(id);
    const off = desktop.lockdown.onEvent(({ event }) => {
      api.logLockdown(id, event);
      setWarning(`${event}. Your tutor has been told. Stay in StudyBridge until you hand in.`);
    });
    return () => {
      off();
      desktop.lockdown.exit();
    };
  }, [locked, id]);

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
    [id, submitting, toast],
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
  if (done)
    return (
      <CenterMessage
        icon="trophy"
        medal
        title={done.auto ? 'Time’s up. Handed in.' : 'Handed in. Well done!'}
        body={done.queued ? 'You’re offline, so it’s saved on this laptop and will send by itself as soon as you’re connected. Don’t sign out until it has.' : 'Your tutor has been told. You’ll get a notification when it’s marked.'}
        action={
          <button className="btn primary big" onClick={() => go(done.queued ? '/work' : `/results/${id}`)}>
            {done.queued ? 'Back to my work' : 'See what I handed in'}
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
          <span className="grow">Locked until you hand in. Leaving this window is reported to your tutor.</span>
        </div>
      )}
      {!online && (
        <div className="banner off">
          <Icon name="wifiOff" size={18} />
          <span className="grow">You’re offline. Keep going: your answers are saved on this device and send when you’re back.</span>
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
        {!locked && (
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
                  <AnswerInput q={q} value={answers[q.id] || {}} onChange={(v) => change(q.id, v)} attemptId={id} disabled={!can} />
                  {a.allow_notes && (
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
            {locked && (
              <div style={{ textAlign: 'center', paddingBottom: 30 }}>
                <button className="linkbtn small danger" onClick={() => setLeaving(true)}>
                  I need to leave without handing in
                </button>
              </div>
            )}
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
      {leaving && (
        <Modal
          title="Leave without handing in?"
          onClose={() => setLeaving(false)}
          foot={
            <>
              <button className="btn primary" onClick={() => setLeaving(false)}>
                Stay
              </button>
              <button
                className="btn danger"
                onClick={async () => {
                  await api.logLockdown(id, 'Left the exam without handing in');
                  await outbox.flush();
                  if (desktop) await desktop.lockdown.exit();
                  go(`/work/${a.id}`);
                }}
              >
                Leave and tell my tutor
              </button>
            </>
          }
        >
          <div>Only do this if something has gone wrong. Your answers so far are saved, your tutor is told straight away, and the timer keeps running.</div>
        </Modal>
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
