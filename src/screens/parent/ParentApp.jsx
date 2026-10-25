// The parent's StudyBridge (1.6): read-only. For each child: the weekly reports the tutor approved, upcoming
// lessons and due dates, marks that were given back, topic strengths, mock grades and the exam countdown.
// Never messages, working, photos, the exam camera or anything from Prof (the server only hands these out).
// Four tabs, big on phones: This week (the report), Coming up, Marks and Settings.
// A child studying on their own (launch 1): their plan, how much they study, their free week or plan and paying for
// it; the parent can set such a child up with a code (needed below grade 8).
import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Bar, Loading, Markdown, Modal, Page, go, useRoute } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { SUPPORT_EMAIL } from '../../lib/config.js';
import { studentAccess } from '../../lib/students.js';
import { SetUpChild, AddWithCode } from './ChildCodes.jsx';
import { PayOptions } from '../learner/SelfStudy.jsx';
import { ago, day, dur, kindLabel, pct, timeIn, placeOf, myTimezone, when } from '../../lib/format.js';
import Shell from '../shared/Shell.jsx';
import Settings from '../shared/Settings.jsx';
import ReportCard, { printReport } from '../shared/ReportCard.jsx';
import { gradeLine } from '../shared/MockHistory.jsx';
import { StreamFiles } from '../shared/Stream.jsx';

// "Coming up": overdue work first, then lessons and due work in date order
const overdue = (v) => v.due.filter((a) => !a.handed_in && new Date(a.due_at) < new Date());
const upcoming = (v) =>
  [...v.lessons.map((s) => ({ lesson: s, at: s.starts_at })), ...v.due.filter((a) => !overdue(v).includes(a)).map((a) => ({ due: a, at: a.due_at }))].sort(
    (x, y) => new Date(x.at) - new Date(y.at),
  );

function notificationTarget(n) {
  const r = n.ref || {};
  if (r.learner_id) return `/child/${r.learner_id}${r.report_id ? `?report=${r.report_id}` : ''}`;
  return '/';
}

// With more than one child, the one last looked at stays chosen on every tab
const savedChild = () => {
  try {
    return localStorage.getItem('sb.parent.child');
  } catch {
    return null;
  }
};
const saveChild = (id) => {
  try {
    localStorage.setItem('sb.parent.child', id);
  } catch {}
};

export default function ParentApp() {
  const route = useRoute();
  const kids = useQuery('parent-children', api.parentChildren);
  const [a, b] = route.parts;
  const list = kids.data || [];
  const picked = (a === 'child' && b) || route.query.get('child') || savedChild();
  const current = list.find((k) => k.id === picked) || list[0];
  const nav = [
    { to: '/', label: 'This week', icon: 'home', also: ['/child'] },
    { to: '/coming', label: 'Coming up', icon: 'calendar' },
    { to: '/marks', label: 'Marks', icon: 'chart' },
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ];
  let page;
  if (a === 'settings') page = <Settings />;
  else if (!kids.data) page = <Loading />;
  else if (!current) page = <NoChildren />;
  else page = <Child key={current.id} id={current.id} kids={list} section={a === 'coming' ? 'coming' : a === 'marks' ? 'marks' : 'week'} />;
  return (
    <Shell nav={nav} tabs={nav} roleLabel="Parent" notificationTarget={notificationTarget} theme="parent">
      {page}
    </Shell>
  );
}

function NoChildren() {
  const app = useApp();
  return (
    <Page title={`Hello, ${app.me.display_name.split(' ')[0]}`} subtitle="Your account isn’t linked to a child yet.">
      <SetUpChild />
      <AddWithCode />
    </Page>
  );
}

// A child studying on their own: their plan, their week, and their free week or plan (the parent can pay)
function OwnStudy({ v }) {
  const s = v.self;
  const weeks = s.exam_date ? Math.max(0, Math.ceil((new Date(s.exam_date + 'T12:00') - new Date()) / (7 * 864e5))) : null;
  const goal = (s.goal_min || 0) * 7 * 60;
  const access = studentAccess({ self_learner: true, trial_until: s.trial_until, paid_until: s.paid_until, paid_plan: s.paid_plan });
  const first = v.learner.name.split(' ')[0];
  return (
    <>
      <div className="card stack">
        <div className="card-head">
          <div>
            <h2>{first}’s plan</h2>
            <div className="small muted">{s.setup_done ? `${s.subjects.join(', ') || 'No subjects yet'}${s.exam_label ? ` · ${s.exam_label}` : ''}` : `${first} hasn’t finished setting up their plan yet.`}</div>
          </div>
          {weeks != null && (
            <div className="weeks-left">
              <b>{weeks}</b>
              <span>week{weeks === 1 ? '' : 's'} to go</span>
            </div>
          )}
        </div>
        <div className="own-stats">
          <div className="stat">
            <div className="n">{dur(s.week_seconds)}</div>
            <div className="l">Studied in the last 7 days{goal ? ` (aim: ${dur(goal)})` : ''}</div>
          </div>
          <div className="stat">
            <div className="n">{s.days_this_week}</div>
            <div className="l">Days they studied</div>
          </div>
          <div className="stat">
            <div className="n">{s.practice_this_week}</div>
            <div className="l">Practice sessions</div>
          </div>
        </div>
      </div>
      <div className="card stack">
        <h2>Their StudyBridge plan</h2>
        <div className="muted small">
          {access.paid
            ? `Paid (${access.plan === 'pass' ? 'exam pass' : 'monthly'}) until ${day(access.until + 'T12:00')}.`
            : access.trial
              ? `Free week: ${access.daysLeft} day${access.daysLeft === 1 ? '' : 's'} left.`
              : `${first}’s free week is over. Their work is all saved; pay to open it again.`}
        </div>
        {!access.paid && <PayOptions forId={v.learner.id} examDate={s.exam_date} otherWay={() => window.open(`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Paying for ' + first)}`)} />}
      </div>
    </>
  );
}

const SUBTITLE = {
  week: 'The weekly report from their tutor, and how long until their exams.',
  coming: 'Lessons and work due over the next three weeks.',
  marks: 'Marks once the tutor gives them back, mock grades and how each topic is going.',
};

function Child({ id, kids, section }) {
  const route = useRoute();
  const q = useQuery(`parent-view:${id}`, () => api.parentView(id));
  const [open, setOpen] = useState(() => route.query.get('report'));
  const v = q.data;
  if (!v) return <Page title="Progress">{q.error ? <div className="error">{q.error.message}</div> : <Loading />}</Page>;
  const myTz = myTimezone();
  const many = (v.places || []).length > 1; // a school and tutors: say who set each thing
  const latest = v.reports[0];
  const opened = v.reports.find((r) => r.id === open);
  const topics = (v.topics || []).filter((t) => t.ratio != null).sort((x, y) => y.ratio - x.ratio);
  const picker =
    kids.length > 1 ? (
      <div className="seg kid-pick" role="group" aria-label="Choose a child">
        {kids.map((k) => (
          <button
            key={k.id}
            type="button"
            aria-pressed={k.id === id}
            onClick={() => {
              saveChild(k.id);
              go(`${section === 'week' ? '/' : '/' + section}?child=${k.id}`);
            }}
          >
            {k.name.split(' ')[0]}
          </button>
        ))}
      </div>
    ) : null;
  return (
    <Page eyebrow={picker} title={v.learner.name} subtitle={v.self ? 'Studying on their own with StudyBridge.' : `${SUBTITLE[section]} Tutor: ${v.tutor}.`}>
      {section === 'week' && v.self && <OwnStudy v={v} />}
      {section === 'week' && !v.self && (
        <>
          {v.exam && (
            <div className="card row parent-exam">
              <span className="mock-grade">{v.exam.days}</span>
              <span>
                <span className="strong">days to {v.exam.name || 'the exam'}</span>
                <span className="small muted"> · {day(v.exam.date)}</span>
              </span>
            </div>
          )}
          <div className="card">
            <div className="card-head">
              <h2>Latest weekly report</h2>
              {v.reports.length > 1 && <span className="small muted">{v.reports.length} reports so far</span>}
            </div>
            {latest ? (
              <>
                <ReportCard report={latest} tutorName={v.tutor} />
                <div className="row wrap">
                  <button className="btn sm" onClick={() => setOpen(latest.id)}>
                    <Icon name="download" size={14} /> Print or save as PDF
                  </button>
                </div>
              </>
            ) : (
              <div className="muted small">The first report arrives when {v.tutor} approves it.</div>
            )}
            {v.reports.length > 1 && (
              <div className="list">
                {v.reports.slice(1).map((r) => (
                  <button key={r.id} className="item click history-row" onClick={() => setOpen(r.id)}>
                    <Icon name="send" size={16} style={{ color: 'var(--accent)' }} />
                    <span className="grow">
                      <span className="name">Week of {day(r.week_start + 'T12:00')}</span>
                      {r.comment && <span className="meta ellipsis">{r.comment}</span>}
                    </span>
                    <Icon name="right" size={16} />
                  </button>
                ))}
              </div>
            )}
          </div>
          <ClassPosts id={id} name={v.learner.name} />
        </>
      )}

      {section === 'coming' && (
        <div className="card">
          <h2>Coming up</h2>
          {v.lessons.length === 0 && v.due.length === 0 ? (
            <div className="muted small">Nothing booked or due in the next three weeks.</div>
          ) : (
            <div className="list">
              {overdue(v).length > 0 && <div className="list-head">Overdue</div>}
              {overdue(v).map((a, i) => (
                <div key={'o' + i} className="item">
                  <Icon name="clipboard" style={{ color: 'var(--red)' }} />
                  <span className="grow">
                    <span className="name">{a.title}</span>
                    <span className="meta">
                      {kindLabel[a.kind]} · was due {when(a.due_at)}
                      {many && a.from ? ` · ${a.from}` : ''}
                    </span>
                  </span>
                  <span className="pill bad">Not handed in</span>
                </div>
              ))}
              {overdue(v).length > 0 && <div className="list-head">Coming up</div>}
              {upcoming(v).map(({ lesson: s, due: a }, i) =>
                s ? (
                <div key={'l' + i} className="item">
                  <Icon name="video" style={{ color: 'var(--accent)' }} />
                  <span className="grow">
                    <span className="name">{s.title}</span>
                    <span className="meta">
                      {when(s.starts_at)} your time
                      {v.learner.timezone && v.learner.timezone !== myTz ? ` · ${timeIn(s.starts_at, v.learner.timezone)} in ${placeOf(v.learner.timezone)}` : ''} · {s.duration_min} min
                      {many && s.from ? ` · ${s.from}` : ''}
                    </span>
                  </span>
                  {s.weekly && <span className="pill accent">Weekly</span>}
                </div>
                ) : (
                <div key={'d' + i} className="item">
                  <Icon name="clipboard" style={{ color: 'var(--muted)' }} />
                  <span className="grow">
                    <span className="name">{a.title}</span>
                    <span className="meta">
                      {kindLabel[a.kind]} · due {when(a.due_at)}
                      {many && a.from ? ` · ${a.from}` : ''}
                    </span>
                  </span>
                  {a.handed_in ? <span className="pill good">Handed in</span> : <span className="pill">To do</span>}
                </div>
                ),
              )}
            </div>
          )}
        </div>
      )}

      {section === 'marks' && (
        <>
          <div className="card">
            <h2>Marks</h2>
            {v.marks.length === 0 ? (
              <div className="muted small">Marks show here once the tutor gives them back.</div>
            ) : (
              <div className="list">
                {v.marks.map((m, i) => (
                  <div key={i} className="item">
                    <span className="grow">
                      <span className="name">{m.title}</span>
                      <span className="meta">
                        {kindLabel[m.kind]} · {day(m.at)}
                        {m.late ? ' · handed in late' : ''}
                        {many && m.from ? ` · ${m.from}` : ''}
                      </span>
                    </span>
                    <span className="strong">{pct(m.score, m.max)}%</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          {v.mocks.length > 0 && (
            <div className="card">
              <h2>
                <Icon name="trophy" size={18} /> Mock exams
              </h2>
              <div className="list">
                {[...v.mocks].reverse().map((m) => (
                  <div key={m.id} className="item">
                    <span className="mock-grade sm">{m.grade || '—'}</span>
                    <span className="grow">
                      <span className="name">{m.title}</span>
                      <span className="meta">{gradeLine(m)}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {topics.length > 0 && (
            <div className="card">
              <div className="card-head">
                <h2>Topics</h2>
                <span className="muted small">From marked answers</span>
              </div>
              {topics.map((t) => (
                <div className="strength" key={t.topic_id || t.topic}>
                  <div>
                    <div className="strong">{t.topic}</div>
                    <div className="muted tiny">{t.subject}</div>
                  </div>
                  <Bar value={(t.ratio || 0) * 100} tone={t.strength === 'strong' ? 'good' : t.strength === 'weak' ? 'bad' : 'warn'} />
                  <span className="small strong" style={{ justifySelf: 'end' }}>
                    {Math.round((t.ratio || 0) * 100)}%
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {opened && (
        <Modal
          title={`Week of ${day(opened.week_start + 'T12:00')}`}
          wide
          onClose={() => setOpen(null)}
          foot={
            <button className="btn" onClick={printReport}>
              <Icon name="download" size={16} /> Print or save as PDF
            </button>
          }
        >
          <ReportCard report={opened} tutorName={v.tutor} />
        </Modal>
      )}
    </Page>
  );
}

// What teachers posted in the child's classes over the last 30 days (never anyone's replies)
function ClassPosts({ id, name }) {
  const posts = useQuery(`parent-posts:${id}`, () => api.parentClassPosts(id)).data || [];
  if (!posts.length) return null;
  return (
    <div className="card">
      <div className="card-head">
        <h2>From {name.split(' ')[0]}’s classes</h2>
      </div>
      {posts.map((p) => (
        <div key={p.id} className="stream-parent">
          <div className="small muted">
            <span className="pill">{p.class}</span> {p.author} · {ago(p.at)}
          </div>
          {p.body_md && <Markdown src={p.body_md} className="stream-body" />}
          <StreamFiles files={p.files} />
        </div>
      ))}
    </div>
  );
}
