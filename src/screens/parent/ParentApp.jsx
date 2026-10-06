// The parent's StudyBridge (1.6): read-only. For each child: the weekly reports the tutor approved, upcoming
// lessons and due dates, marks that were given back, topic strengths, mock grades and the exam countdown.
// Never messages, working, photos, the exam camera or anything from Prof (the server only hands these out).
import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Bar, Empty, Link, Loading, Modal, Page, useRoute } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { day, kindLabel, pct, timeIn, placeOf, myTimezone, when } from '../../lib/format.js';
import Shell from '../shared/Shell.jsx';
import Settings from '../shared/Settings.jsx';
import ReportCard, { printReport } from '../shared/ReportCard.jsx';
import { gradeLine } from '../shared/MockHistory.jsx';

function notificationTarget(n) {
  const r = n.ref || {};
  if (r.learner_id) return `/child/${r.learner_id}${r.report_id ? `?report=${r.report_id}` : ''}`;
  return '/';
}

export default function ParentApp() {
  const route = useRoute();
  const kids = useQuery('parent-children', api.parentChildren);
  const [a, b] = route.parts;
  const list = kids.data || [];
  const nav = [
    { to: '/', label: list.length > 1 ? 'My children' : 'Home', icon: 'home', also: ['/child'] },
    { to: '/settings', label: 'Settings', icon: 'settings' },
  ];
  let page;
  if (a === 'settings') page = <Settings />;
  else if (a === 'child' && b) page = <Child id={b} kids={list} />;
  else if (!kids.data) page = <Loading />;
  else if (list.length === 1) page = <Child id={list[0].id} kids={list} />;
  else page = <Children list={list} />;
  return (
    <Shell nav={nav} tabs={nav} roleLabel="Parent" notificationTarget={notificationTarget}>
      {page}
    </Shell>
  );
}

function Children({ list }) {
  const app = useApp();
  if (!list.length)
    return (
      <Page title={`Hello, ${app.me.display_name.split(' ')[0]}`}>
        <Empty title="No children linked">
          Your account isn’t linked to a learner right now. Ask your child’s tutor for a parent invite, then join with it in a new account or from the sign-in page.
        </Empty>
      </Page>
    );
  return (
    <Page title={`Hello, ${app.me.display_name.split(' ')[0]}`} subtitle="Choose a child to see their reports, lessons and marks.">
      <div className="stack">
        {list.map((k) => (
          <Link key={k.id} to={`/child/${k.id}`} className="work-card">
            <span className="bar-l" style={{ background: 'var(--accent)' }} />
            <span className="grow stack sm">
              <span className="strong" style={{ fontSize: 17 }}>{k.name}</span>
              <span className="small muted row wrap" style={{ gap: 10 }}>
                <span>Tutor: {k.tutor}</span>
                <span>{k.next_lesson ? `Next lesson ${when(k.next_lesson)}` : 'No lessons booked'}</span>
                <span>
                  {k.reports} report{k.reports === 1 ? '' : 's'}
                </span>
              </span>
            </span>
            <Icon name="right" />
          </Link>
        ))}
      </div>
    </Page>
  );
}

function Child({ id, kids }) {
  const route = useRoute();
  const q = useQuery(`parent-view:${id}`, () => api.parentView(id));
  const [open, setOpen] = useState(() => route.query.get('report'));
  const v = q.data;
  if (!v) return <Page title="Progress">{q.error ? <div className="error">{q.error.message}</div> : <Loading />}</Page>;
  const myTz = myTimezone();
  const latest = v.reports[0];
  const opened = v.reports.find((r) => r.id === open);
  const topics = (v.topics || []).filter((t) => t.ratio != null).sort((x, y) => y.ratio - x.ratio);
  return (
    <Page
      eyebrow={
        kids.length > 1 ? (
          <Link to="/" className="row" style={{ gap: 4 }}>
            <Icon name="left" size={14} /> My children
          </Link>
        ) : null
      }
      title={v.learner.name}
      subtitle={`Tutor: ${v.tutor}. You see weekly reports, lessons, due dates and marks once they’re given back.`}
    >
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

      <div className="split even">
        <div className="card">
          <h2>Coming up</h2>
          {v.lessons.length === 0 && v.due.length === 0 ? (
            <div className="muted small">Nothing booked or due in the next three weeks.</div>
          ) : (
            <div className="list">
              {v.lessons.map((s, i) => (
                <div key={'l' + i} className="item">
                  <Icon name="video" style={{ color: 'var(--accent)' }} />
                  <span className="grow">
                    <span className="name">{s.title}</span>
                    <span className="meta">
                      {when(s.starts_at)} your time
                      {v.learner.timezone && v.learner.timezone !== myTz ? ` · ${timeIn(s.starts_at, v.learner.timezone)} in ${placeOf(v.learner.timezone)}` : ''} · {s.duration_min} min
                    </span>
                  </span>
                  {s.weekly && <span className="pill accent">Weekly</span>}
                </div>
              ))}
              {v.due.map((a, i) => (
                <div key={'d' + i} className="item">
                  <Icon name="clipboard" style={{ color: 'var(--muted)' }} />
                  <span className="grow">
                    <span className="name">{a.title}</span>
                    <span className="meta">
                      {kindLabel[a.kind]} · due {when(a.due_at)}
                    </span>
                  </span>
                  {a.handed_in ? <span className="pill good">Handed in</span> : new Date(a.due_at) < new Date() ? <span className="pill bad">Not handed in</span> : <span className="pill">To do</span>}
                </div>
              ))}
            </div>
          )}
        </div>

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
                    </span>
                  </span>
                  <span className="strong">{pct(m.score, m.max)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
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
