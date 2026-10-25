// One class's page, for its teachers: its stream (posts to the class, and what's been set for it), its classwork by topic
// (from every teacher of the class), a gradebook (each learner × each piece of work, with averages and a spreadsheet to
// download), and its people, where a teacher adds a whole class list at once (an invite with its own code for each
// learner). A centre's manager who doesn't teach the class sees its stream only (never marks).
import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Empty, Link, Loading, Modal, Page, Seg, copyText, go, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { day, kindLabel, pct } from '../../lib/format.js';
import { useLookups, SubjectTag } from '../shared/lookups.jsx';
import Stream from '../shared/Stream.jsx';

const prettyCode = (c) => (/^\d{8}$/.test(String(c)) ? `${String(c).slice(0, 4)} ${String(c).slice(4)}` : c);
const STATE = { draft: 'Draft', hidden: 'Hidden', scheduled: 'Scheduled', posted: 'Posted' };

export default function ClassPage({ id, tab = 'stream' }) {
  const lk = useLookups();
  const app = useApp();
  const c = lk.klass(id);
  if (!c) return <Page title="Class">{lk.ready ? <Empty>This class isn’t in your list.</Empty> : <Loading />}</Page>;
  const members = lk.membersOf(id);
  const teaches = lk.teachersOf(id).includes(app.me.id);
  const tabs = teaches
    ? [
        { value: 'stream', label: 'Stream' },
        { value: 'classwork', label: 'Classwork' },
        { value: 'gradebook', label: 'Gradebook' },
        { value: 'people', label: 'People' },
      ]
    : [{ value: 'stream', label: 'Stream' }];
  const shown = tabs.some((t) => t.value === tab) ? tab : 'stream';
  return (
    <Page
      eyebrow={
        <>
          <Link to="/learners/classes">Classes</Link> <Icon name="right" size={14} /> {c.name}
        </>
      }
      title={c.name}
      subtitle={
        <span className="row wrap" style={{ gap: 8 }}>
          {c.subject_id && <SubjectTag id={c.subject_id} />}
          <span>{members.length ? `${members.length} learner${members.length === 1 ? '' : 's'}` : 'Nobody in it yet'}</span>
        </span>
      }
      actions={
        teaches && (
          <button className="btn primary" onClick={() => go(`/assignments?new=1&class=${id}${c.subject_id ? `&subject=${c.subject_id}` : ''}`)}>
            <Icon name="plus" size={18} /> Set work for {c.name}
          </button>
        )
      }
    >
      {tabs.length > 1 && <Seg value={shown} onChange={(t) => go(`/learners/classes/${id}/${t}`, { replace: true })} options={tabs} />}
      {shown === 'gradebook' ? (
        <Gradebook id={id} name={c.name} />
      ) : shown === 'people' ? (
        <People c={c} />
      ) : shown === 'classwork' ? (
        <Classwork id={id} />
      ) : (
        <Stream classId={id} />
      )}
    </Page>
  );
}

// Everything set for the class, grouped by topic
function Classwork({ id }) {
  const q = useQuery(`class-work:${id}`, () => api.classWork(id));
  if (!q.data) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  const items = q.data;
  if (!items.length) return <Empty>Nothing set for this class yet. Work, lesson notes and files you set for it show here, by topic.</Empty>;
  const groups = [];
  for (const x of items) {
    const key = x.topic || 'No topic';
    let g = groups.find((y) => y.key === key);
    if (!g) groups.push((g = { key, items: [] }));
    g.items.push(x);
  }
  const open = (x) => (x.kind === 'assignment' ? `/assignments/${x.id}` : x.kind === 'lesson' ? `/lesson/${x.id}` : '/library');
  return groups.map((g) => (
    <div key={g.key} className="card">
      <h2>{g.key}</h2>
      <div className="list">
        {g.items.map((x) => (
          <div key={x.kind + x.id} className="item">
            <Icon name={x.kind === 'assignment' ? 'clipboard' : x.kind === 'lesson' ? 'book' : 'file'} style={{ color: 'var(--muted)' }} />
            <span className="grow">
              {x.mine ? (
                <Link to={open(x)} className="name">
                  {x.title}
                </Link>
              ) : (
                <span className="name">{x.title}</span>
              )}
              <span className="meta">
                <span>{x.kind === 'assignment' ? kindLabel[x.type] : x.kind === 'lesson' ? 'Lesson notes' : 'File'}</span>
                {x.due_at && <span>due {day(x.due_at)}</span>}
                {!x.mine && <span>set by {x.by}</span>}
                {x.kind === 'assignment' && x.state === 'posted' && <span>{x.handed_in} handed in</span>}
              </span>
            </span>
            <span className={'pill' + (x.state === 'posted' ? ' good' : '')}>{STATE[x.state]}</span>
          </div>
        ))}
      </div>
    </div>
  ));
}

// Each learner × each piece of work: their latest try (marks they've been given back, or what's waiting)
function Gradebook({ id, name }) {
  const q = useQuery(`gradebook:${id}`, () => api.classGradebook(id));
  const g = q.data;
  if (!g) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  if (!g.learners.length) return <Empty>Nobody is in this class yet.</Empty>;
  if (!g.work.length) return <Empty>No work posted for this class yet. Marks show here as you give them back.</Empty>;
  const cell = (l, w) => g.cells.find((x) => x.learner_id === l && x.assignment_id === w);
  const percent = (x) => (x && x.score != null && x.max ? pct(x.score, x.max) : null);
  const avg = (xs) => {
    const v = xs.filter((x) => x != null);
    return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null;
  };
  const byLearner = (l) => avg(g.work.map((w) => percent(cell(l, w.id))));
  const byWork = (w) => avg(g.learners.map((l) => percent(cell(l.id, w))));
  const show = (x) => {
    if (!x) return { text: '—', tone: 'muted' };
    if (x.status === 'in_progress' || x.status === 'returned') return { text: 'Working', tone: 'muted' };
    const p = percent(x);
    if (p == null) return { text: 'To mark', tone: 'warn' };
    return { text: `${p}%`, tone: p >= 70 ? 'good' : p >= 50 ? '' : 'bad' };
  };
  function download() {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const rows = [['Learner', ...g.work.map((w) => w.title), 'Average'].map(esc).join(',')];
    for (const l of g.learners) {
      rows.push([l.name, ...g.work.map((w) => {
        const x = cell(l.id, w.id);
        return percent(x) != null ? `${percent(x)}%` : x ? (x.status === 'in_progress' || x.status === 'returned' ? 'Working' : 'To mark') : '';
      }), byLearner(l.id) != null ? `${byLearner(l.id)}%` : ''].map(esc).join(','));
    }
    rows.push(['Class average', ...g.work.map((w) => (byWork(w.id) != null ? `${byWork(w.id)}%` : '')), ''].map(esc).join(','));
    const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w -]+/g, '').trim() || 'class'} gradebook.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  return (
    <div className="card pad0">
      <div className="row between wrap" style={{ padding: '12px 16px', gap: 8 }}>
        <span className="small muted">Each learner’s latest try. Marks count once they’re given back to the learner or marked.</span>
        <button className="btn sm" onClick={download}>
          <Icon name="download" size={15} /> Download (spreadsheet)
        </button>
      </div>
      <div className="gradebook-wrap">
        <table className="table gradebook">
          <thead>
            <tr>
              <th>Learner</th>
              {g.work.map((w) => (
                <th key={w.id} title={w.title}>
                  <span className="gb-title">{w.title}</span>
                  <span className="tiny muted">{kindLabel[w.kind]}{w.due_at ? ` · ${day(w.due_at)}` : ''}</span>
                </th>
              ))}
              <th>Average</th>
            </tr>
          </thead>
          <tbody>
            {g.learners.map((l) => (
              <tr key={l.id}>
                <th scope="row">{l.name}</th>
                {g.work.map((w) => {
                  const x = cell(l.id, w.id);
                  const s = show(x);
                  return (
                    <td key={w.id}>
                      {x ? (
                        <Link to={`/marking/${x.attempt_id}`} className={'pill ' + s.tone} style={{ textDecoration: 'none' }}>
                          {s.text}
                          {x.late ? ' · late' : ''}
                        </Link>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  );
                })}
                <td className="strong">{byLearner(l.id) != null ? `${byLearner(l.id)}%` : '—'}</td>
              </tr>
            ))}
            <tr className="gb-avg">
              <th scope="row">Class average</th>
              {g.work.map((w) => (
                <td key={w.id} className="strong">
                  {byWork(w.id) != null ? `${byWork(w.id)}%` : '—'}
                </td>
              ))}
              <td className="strong">{avg(g.work.map((w) => byWork(w.id))) != null ? `${avg(g.work.map((w) => byWork(w.id)))}%` : '—'}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// The class's learners, and adding a whole class list at once
function People({ c }) {
  const lk = useLookups();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [names, setNames] = useState('');
  const [made, setMade] = useState(null);
  const [busy, setBusy] = useState(false);
  const members = lk.membersOf(c.id);
  const list = names
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  async function make() {
    setBusy(true);
    try {
      const r = await api.classInvites(c.id, list);
      setMade(r);
      setNames('');
      invalidate('invites');
    } catch (e) {
      toast({ title: 'Couldn’t make the codes', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  const message = (x) => `${x.name}: join ${c.name} on StudyBridge with the code ${prettyCode(x.code)}`;
  return (
    <>
      <div className="card">
        <div className="row between wrap" style={{ gap: 8 }}>
          <h2>Learners</h2>
          <button className="btn" onClick={() => (setOpen(true), setMade(null))}>
            <Icon name="users" size={16} /> Add a class list
          </button>
        </div>
        {members.length === 0 ? (
          <div className="small muted">Nobody yet. Add a class list, give out the class code, or put your learners in from Edit.</div>
        ) : (
          <div className="chips">
            {members
              .map((mid) => lk.learner(mid))
              .filter(Boolean)
              .sort((x, y) => x.display_name.localeCompare(y.display_name))
              .map((l) => (
                <Link key={l.id} to={`/learners/${l.id}`} className="pill" style={{ textDecoration: 'none' }}>
                  {l.display_name}
                </Link>
              ))}
          </div>
        )}
      </div>
      {open && (
        <Modal title={`Add a class list to ${c.name}`} onClose={() => setOpen(false)}>
          {made ? (
            <div className="stack sm">
              <div className="small">Here’s a code for each learner. They type it when they sign up (or in Settings → Your schools and tutors), and they’re in {c.name}.</div>
              <div className="list">
                {made.map((x) => (
                  <div key={x.id} className="item">
                    <span className="grow name">{x.name}</span>
                    <b className="code-show" style={{ fontSize: 18 }}>{prettyCode(x.code)}</b>
                  </div>
                ))}
              </div>
              <div className="row wrap" style={{ gap: 8 }}>
                <button className="btn primary" onClick={() => (copyText(made.map(message).join('\n')), toast('All codes copied'))}>
                  <Icon name="copy" size={15} /> Copy all
                </button>
                <button className="btn" onClick={() => window.print()}>
                  Print
                </button>
              </div>
            </div>
          ) : (
            <div className="stack sm">
              <label className="label" htmlFor="class-list">
                One name per line
              </label>
              <textarea id="class-list" className="textarea" style={{ minHeight: 180 }} value={names} onChange={(e) => setNames(e.target.value)} placeholder={'Chipo Banda\nTendai Moyo\nAmara Okafor'} />
              <div className="small muted">Each learner gets their own code (it works once). Up to 200 at a time.</div>
              <div className="row end" style={{ gap: 8 }}>
                <button className="btn" onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button className="btn primary" disabled={busy || !list.length} onClick={make}>
                  {busy ? 'Making codes…' : `Make ${list.length || ''} code${list.length === 1 ? '' : 's'}`}
                </button>
              </div>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}
