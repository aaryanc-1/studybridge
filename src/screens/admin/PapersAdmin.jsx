// Admin → StudyBridge papers: Prof writes original practice papers in the exact format of each
// exam paper. 1) choose subjects, Prof works out their papers; 2) choose how many of each, see the
// cost, start; 3) review what comes back and approve it. Approved papers reach every tutor.
import { useMemo, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Page, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as X from '../../lib/exams.js';
import { money } from './Admin.jsx';
import { PaperView, paperSlot } from '../shared/SbPapers.jsx';

// Rough cost of one paper before any has been written (cents), by model
const DEFAULT_CENTS = { 'claude-opus-5-5': 70, 'claude-sonnet-5-5': 35, 'claude-haiku-4-5-20251001': 12 };
const slotKey = (board, code, level, paper) => [board, code, level || '', paper].join('|');

export default function PapersAdmin() {
  const q = useQuery('admin-papers', api.adminPapers, { poll: 20000 });
  const d = q.data;
  return (
    <Page title="StudyBridge papers" subtitle="Original practice papers in the exact format of each real paper, with mark schemes. Prof writes them in the background on your Claude key; you approve each one before tutors see it.">
      {q.error && <div className="error">{q.error.message}</div>}
      <Subjects plans={d?.plans || []} />
      {d && <Writing d={d} />}
      {d && <Review papers={d.papers} />}
    </Page>
  );
}

function Subjects({ plans }) {
  const toast = useToast();
  const [ib, setIb] = useState(() => new Set(X.ISL_IB));
  const [cie, setCie] = useState(() => new Set(X.ISL_IGCSE));
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(!plans.length);
  const planned = new Set(plans.map((p) => `${p.board}:${p.code}`));
  const toggle = (set, setter, k) => {
    const n = new Set(set);
    n.has(k) ? n.delete(k) : n.add(k);
    setter(n);
  };
  async function go() {
    setBusy(true);
    try {
      const ibList = [...ib].filter((c) => !planned.has(`ib:${c}`));
      const cieList = [...cie].filter((c) => !planned.has(`cie:${c}`));
      if (ibList.length) await api.adminPaperPlan('ib', ibList, ibList.map((c) => X.findSyllabus('ib', c)?.name || c));
      if (cieList.length) await api.adminPaperPlan('cie', cieList, cieList.map((c) => X.findSyllabus('cie', c)?.name || c));
      invalidate('admin-papers');
      toast({ title: `Prof is working out the papers for ${ibList.length + cieList.length} subjects`, body: 'A minute or two each. They appear below.' });
      setShow(false);
    } catch (e) {
      toast({ title: 'Couldn’t start', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  const pick = (board, list, set, setter) => (
    <div className="subject-picks">
      {list.map((s) => (
        <label key={s.code} className={'pick' + (set.has(s.code) ? ' on' : '')}>
          <input type="checkbox" checked={set.has(s.code)} onChange={() => toggle(set, setter, s.code)} />
          {board === 'cie' ? `${s.code} ${s.name}` : s.name}
          {planned.has(`${board}:${s.code}`) && <span className="tiny muted"> · planned</span>}
        </label>
      ))}
    </div>
  );
  return (
    <div className="card">
      <div className="row between wrap">
        <h2 style={{ margin: 0 }}>1. Subjects</h2>
        <button className="btn sm" onClick={() => setShow((x) => !x)}>
          {show ? 'Hide' : 'Choose subjects'}
        </button>
      </div>
      <div className="small muted">
        Ticked: what the International School of Lusaka teaches (its IB subjects are from the IB’s school directory; its IGCSE list is a best guess, so adjust it). Prof first works out each subject’s written papers. Listening, practical, coursework and source papers that need real documents are left out.
      </div>
      {show && (
        <>
          <div className="row wrap" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => (setIb(new Set(X.ISL_IB)), setCie(new Set(X.ISL_IGCSE)))}>
              International School of Lusaka
            </button>
            <button className="btn sm" onClick={() => (setIb(new Set()), setCie(new Set()))}>
              Clear
            </button>
          </div>
          <h3>IB Diploma</h3>
          {pick('ib', X.IB.filter((s) => s.papers.length), ib, setIb)}
          <h3>Cambridge IGCSE</h3>
          {pick('cie', X.CIE, cie, setCie)}
          <div>
            <button className="btn claude" disabled={busy || ![...ib, ...cie].some((c) => !planned.has(`ib:${c}`) && !planned.has(`cie:${c}`))} onClick={go}>
              <Icon name="cap" size={16} /> Work out their papers
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Writing({ d }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [counts, setCounts] = useState({});
  const [busy, setBusy] = useState(false);
  const have = useMemo(() => {
    const m = {};
    for (const p of d.papers) {
      const k = slotKey(p.board, p.code, p.level, p.paper);
      m[k] ||= { all: 0, approved: 0 };
      m[k].all++;
      if (p.status === 'approved') m[k].approved++;
    }
    return m;
  }, [d.papers]);
  const rows = [];
  for (const plan of [...d.plans].sort((a, b) => a.board.localeCompare(b.board) || a.code.localeCompare(b.code))) {
    for (const c of plan.components || []) rows.push({ plan, c, key: slotKey(plan.board, plan.code, c.level, c.paper) });
  }
  if (!rows.length) return null;
  const countOf = (r) => (counts[r.key] ?? (r.c.writable && !(have[r.key]?.all > 0) ? 2 : 0));
  const total = rows.reduce((n, r) => n + Number(countOf(r) || 0), 0);
  const each = Number(d.avg_cents) || DEFAULT_CENTS[d.model] || 35;
  const est = total * each;
  async function start() {
    if (!(await confirm({ title: `Write ${total} paper${total === 1 ? '' : 's'}?`, body: `About ${money(est)} on your Claude key (${money(each)} a paper${d.avg_cents ? ', from the papers so far' : ', a first estimate'}). They’re written one by one in the background; tutors’ own Prof requests always go first. You approve each before tutors see it.`, ok: 'Start writing' }))) return;
    setBusy(true);
    try {
      const slots = rows
        .filter((r) => Number(countOf(r)) > 0)
        .map((r) => ({
          board: r.plan.board, code: r.plan.code, label: X.findSyllabus(r.plan.board, r.plan.code)?.name || r.plan.code, level: r.c.level || null, paper: r.c.paper,
          name: r.c.name, count: Number(countOf(r)), duration_min: r.c.duration_min, marks: r.c.marks, structure: r.c.structure,
        }));
      const n = await api.adminWritePapers(slots);
      setCounts({});
      invalidate('admin-papers');
      toast({ title: `${n} papers queued`, body: 'Watch them come in under Review.' });
    } catch (e) {
      toast({ title: 'Couldn’t start', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  let lastPlan = null;
  return (
    <div className="card">
      <h2 style={{ margin: 0 }}>2. Papers to write</h2>
      <div className="small muted">How many new practice papers for each real paper. Each one is all-new questions in that paper’s format.</div>
      <div className="table-wrap">
        <table className="table papers-plan">
          <thead>
            <tr>
              <th>Subject</th>
              <th>Paper</th>
              <th>Format</th>
              <th>Have</th>
              <th>Write</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const first = lastPlan !== r.plan;
              lastPlan = r.plan;
              const h = have[r.key] || { all: 0, approved: 0 };
              return (
                <tr key={r.key} className={r.c.writable ? '' : 'quiet'}>
                  <td className="strong">{first ? X.syllabusLabel(r.plan.board, r.plan.code) : ''}</td>
                  <td>{r.c.name}</td>
                  <td className="small muted">
                    {r.c.writable ? [r.c.duration_min && `${r.c.duration_min} min`, r.c.marks && `${r.c.marks} marks`].filter(Boolean).join(' · ') : `Not written: ${r.c.why_not || 'not text-based'}`}
                  </td>
                  <td className="small">{h.all ? `${h.approved} approved / ${h.all}` : '—'}</td>
                  <td>
                    {r.c.writable && (
                      <select className="select sm" value={countOf(r)} onChange={(e) => setCounts({ ...counts, [r.key]: Number(e.target.value) })} aria-label={`How many for ${r.plan.code} ${r.c.name}`}>
                        {[0, 1, 2, 3, 4, 5].map((n) => (
                          <option key={n} value={n}>
                            {n}
                          </option>
                        ))}
                      </select>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row wrap between">
        <span className="strong">
          {total} paper{total === 1 ? '' : 's'} · about {money(est)}
        </span>
        <button className="btn claude" disabled={busy || !total} onClick={start}>
          <Icon name="cap" size={16} /> Write {total} paper{total === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  );
}

function Review({ papers }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState('review');
  const writing = papers.filter((p) => p.status === 'writing');
  const failed = papers.filter((p) => p.job_status === 'failed');
  const list = papers.filter((p) => (filter === 'all' ? true : p.status === filter));
  const clean = papers.filter((p) => p.status === 'review' && !p.flagged);
  async function setStatus(ids, status, msg) {
    try {
      await api.adminPaperStatus(ids, status);
      invalidate('admin-papers', 'sb-papers');
      toast(msg);
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
    }
  }
  return (
    <div className="card">
      <div className="row between wrap">
        <h2 style={{ margin: 0 }}>3. Review</h2>
        <div className="row" style={{ gap: 6 }}>
          {[
            ['review', 'To review'],
            ['approved', 'Approved'],
            ['rejected', 'Rejected'],
            ['all', 'All'],
          ].map(([k, l]) => (
            <button key={k} className={'pill click' + (filter === k ? ' accent' : '')} onClick={() => setFilter(k)}>
              {l} ({k === 'all' ? papers.length : papers.filter((p) => p.status === k).length})
            </button>
          ))}
        </div>
      </div>
      {writing.length > 0 && (
        <div className="row small">
          <div className="spinner sm" /> Writing {writing.length} paper{writing.length === 1 ? '' : 's'}… {writing.find((p) => p.job_status === 'running')?.job_progress || ''}
        </div>
      )}
      {failed.length > 0 && <div className="small bad-text">{failed.length} couldn’t be written: {failed[0].job_error}</div>}
      {filter === 'review' && clean.length > 0 && (
        <div>
          <button className="btn sm primary" onClick={() => setStatus(clean.map((p) => p.id), 'approved', `${clean.length} approved`)}>
            Approve the {clean.length} the check agreed with
          </button>
        </div>
      )}
      <div className="list">
        {list.map((p) => (
          <div key={p.id} className="item">
            <span className="grow">
              <span className="name">
                {X.syllabusLabel(p.board, p.code)} · {paperSlot(p)} · SB {p.number}
              </span>
              <span className="meta">
                {p.status === 'writing' ? p.job_progress || 'Waiting to be written' : `${p.items} parts${p.total_marks ? ` · ${Number(p.total_marks)} marks` : ''}`}
                {p.flagged ? ` · check flagged ${p.flagged}` : p.status !== 'writing' ? ' · check agreed' : ''}
                {p.uses ? ` · used ${p.uses}×` : ''}
              </span>
            </span>
            {p.status !== 'writing' && (
              <button className="btn sm" onClick={() => setOpen(p)}>
                Open
              </button>
            )}
            <button
              className="btn sm ghost icon"
              aria-label="Delete paper"
              onClick={async () => {
                if (!(await confirm({ title: 'Delete this paper?', body: 'Tutors who already copied it keep their copy.', ok: 'Delete', danger: true }))) return;
                await api.adminDeletePaper(p.id);
                invalidate('admin-papers', 'sb-papers');
              }}
            >
              <Icon name="trash" size={14} />
            </button>
          </div>
        ))}
        {!list.length && <div className="small muted">Nothing here.</div>}
      </div>
      {open && (
        <PaperView
          id={open.id}
          admin
          onClose={() => setOpen(null)}
          actions={(p) => (
            <>
              <button className="btn" onClick={() => setOpen(null)}>
                Close
              </button>
              {p.status !== 'rejected' && (
                <button className="btn danger" onClick={() => (setStatus([p.id], 'rejected', 'Rejected'), setOpen(null))}>
                  Reject
                </button>
              )}
              {p.status !== 'approved' && (
                <button className="btn primary" onClick={() => (setStatus([p.id], 'approved', 'Approved: every tutor sees it now'), setOpen(null))}>
                  Approve
                </button>
              )}
            </>
          )}
        />
      )}
    </div>
  );
}
