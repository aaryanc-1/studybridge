import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Loading, Modal, go, useConfirm, useRoute, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as X from '../../lib/exams.js';
import { bytes, ago } from '../../lib/format.js';
import { FileSettings } from './Library.jsx';
import { useLookups } from '../shared/lookups.jsx';
import { SbPaperShelf } from '../shared/SbPapers.jsx';
import { ExamSelect } from './Structure.jsx';
import { GradeBoundaries } from './Mocks.jsx';

const THIS_YEAR = new Date().getFullYear();
const SESSION_MONTH = { m: 3, s: 5, w: 11, may: 5, nov: 11 };
// Sessions that haven't happened yet aren't listed
const happened = (y, s) => y < THIS_YEAR || (y === THIS_YEAR && new Date().getMonth() + 1 >= (SESSION_MONTH[s] || 1));
const FIRST_YEAR = 2016;

// ---------------------------------------------------------------------------
// Past papers: every IGCSE and IB paper, filed by subject, year, session and paper.
// The tutor's own copies, the tutor's own links, and the papers the exam board
// publishes itself (opened straight from the board's website).
// ---------------------------------------------------------------------------
export default function PastPapers() {
  const files = useQuery('files', api.listFiles);
  const settings = useQuery('tutor_settings', api.getSettings);
  const lk = useLookups();
  const pinned = settings.data?.exam_subjects || [];
  const route = useRoute();
  const [key, setKey] = useState(() => route.query.get('exam') || null); // 'cie:0607', 'ib:math-aa'
  const [importing, setImporting] = useState(false);
  const [panel, setPanel] = useState(null);
  const [find, setFind] = useState('');
  const toast = useToast();

  const mine = (files.data || []).filter((f) => f.exam_board);
  // Exams your learners take (from the Exam set on each subject), first
  const learnerExams = useMemo(() => {
    const m = new Map();
    for (const s of lk.subjects) {
      if (!s.exam || !X.findSyllabus(...s.exam.split(':'))) continue;
      const who = lk.learnersOfSubject(s.id).map((id) => lk.learner(id)?.display_name?.split(' ')[0]).filter(Boolean);
      if (!who.length) continue;
      const e = m.get(s.exam) || { key: s.exam, subjects: [], learners: new Set() };
      e.subjects.push(s.name);
      who.forEach((w) => e.learners.add(w));
      m.set(s.exam, e);
    }
    return [...m.values()].map((e) => ({ ...e, learners: [...e.learners] }));
  }, [lk.subjects, lk.learnerSubjects, lk.learners]); // eslint-disable-line react-hooks/exhaustive-deps
  // Others you added yourself, or have papers for
  const others = useMemo(() => {
    const s = new Set(pinned);
    for (const f of mine) s.add(`${f.exam_board}:${f.exam_code}`);
    for (const e of learnerExams) s.delete(e.key);
    return [...s].filter((k) => X.findSyllabus(...k.split(':')));
  }, [pinned, mine, learnerExams]);

  useEffect(() => {
    if (key && X.findSyllabus(...key.split(':'))) return;
    setKey(learnerExams[0]?.key || others[0] || null);
  }, [learnerExams.map((e) => e.key).join(','), others.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const [board, code] = key ? key.split(':') : [null, null];
  async function pin(on) {
    const next = on ? [...new Set([...pinned, key])] : pinned.filter((x) => x !== key);
    try {
      await api.setExamSubjects(next);
      invalidate('tutor_settings');
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    }
  }

  function search(e) {
    e.preventDefault();
    const req = X.parseRequest(find);
    if (!req) return toast({ title: 'Couldn’t tell which paper that is', body: 'Try something like “0607 June 2023 Paper 4” or “IB Physics HL Paper 2 May 2023”.', tone: 'bad' });
    setKey(`${req.exam_board}:${req.exam_code}`);
    if (req.exam_year || req.exam_session || req.exam_paper) setPanel(req);
  }

  const syl = key ? X.findSyllabus(board, code) : null;
  const forLearners = learnerExams.find((e) => e.key === key);
  const isPinned = pinned.includes(key);
  const label = (k) => X.syllabusLabel(...k.split(':'));

  return (
    <>
      <div className="row wrap between">
        <div className="row wrap" style={{ gap: 6 }}>
          {learnerExams.map((e) => (
            <button key={e.key} className={'pill click' + (e.key === key ? ' accent' : '')} onClick={() => setKey(e.key)} title={`${e.subjects.join(', ')} · ${e.learners.join(', ')}`}>
              {X.BOARDS[e.key.split(':')[0]].short} · {label(e.key)} <span className="muted">({e.learners.join(', ')})</span>
            </button>
          ))}
        </div>
        <div className="row wrap">
          <form className="row" onSubmit={search}>
            <input className="input" style={{ width: 260 }} value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a paper, e.g. 0607 June 2023 Paper 4" aria-label="Find a paper" />
            <button className="btn" type="submit">
              <Icon name="search" size={18} /> Find
            </button>
          </form>
          <button className="btn primary" onClick={() => setImporting(true)}>
            <Icon name="folder" size={18} /> Import papers
          </button>
        </div>
      </div>

      <div className="row wrap">
        <select className="select" style={{ width: 'auto', maxWidth: '100%' }} value={key || ''} onChange={(e) => setKey(e.target.value || null)} aria-label="Subject">
          <option value="">Choose a subject…</option>
          {learnerExams.length > 0 && (
            <optgroup label="Your learners’ exams">
              {learnerExams.map((e) => (
                <option key={'l' + e.key} value={e.key}>
                  {label(e.key)}
                </option>
              ))}
            </optgroup>
          )}
          {others.length > 0 && (
            <optgroup label="Also in your list">
              {others.map((k) => (
                <option key={'o' + k} value={k}>
                  {label(k)}
                </option>
              ))}
            </optgroup>
          )}
          {Object.entries(X.BOARDS).map(([b, info]) => (
            <optgroup key={b} label={`Other ${info.name} subjects`}>
              {X.syllabuses(b).map((s) => (
                <option key={b + s.code} value={`${b}:${s.code}`}>
                  {X.syllabusLabel(b, s.code)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {syl && forLearners && <span className="small muted">For {forLearners.learners.join(', ')} ({forLearners.subjects.join(', ')})</span>}
        {syl && !forLearners && (
          <button className="btn sm" onClick={() => pin(!isPinned)}>
            <Icon name="star" size={16} /> {isPinned ? 'Remove from your list' : 'Keep in your list'}
          </button>
        )}
      </div>

      <SetExams />

      {!files.data ? (
        <Loading />
      ) : !syl && !learnerExams.length && lk.subjects.some((s) => !s.exam && lk.learnersOfSubject(s.id).length) ? null : !syl ? (
        <Empty title={learnerExams.length ? 'Choose a subject' : 'Your learners’ exams show here'}>
          {learnerExams.length ? (
            'Pick one of your learners’ exams above, or any other subject from the list.'
          ) : (
            <>
              Tell StudyBridge which exam each of your subjects is for: <a href="#/structure">Subjects</a> → edit a subject → Exam. Then the papers for your learners’ exams show here first. You can still look at any subject from the list above, or import a folder of papers you have.
            </>
          )}
        </Empty>
      ) : board === 'cie' ? (
        <>
          <SbPaperShelf board="cie" code={code} />
          <CieSyllabus code={code} mine={mine.filter((f) => f.exam_board === 'cie' && f.exam_code === code)} onOpen={setPanel} />
        </>
      ) : (
        <>
          <SbPaperShelf board="ib" code={code} />
          <IbSyllabus syl={syl} mine={mine.filter((f) => f.exam_board === 'ib' && f.exam_code === code)} onOpen={setPanel} />
          <BoundariesCard exam={key} />
        </>
      )}

      {panel && <SlotPanel req={panel} files={files.data || []} onClose={() => setPanel(null)} />}
      {importing && (
        <ImportPapers
          existing={files.data || []}
          onClose={() => setImporting(false)}
          onDone={async (codes) => {
            const known = new Set(learnerExams.map((e) => e.key));
            const add = codes.filter((k) => !pinned.includes(k) && !known.has(k));
            if (add.length) await api.setExamSubjects([...pinned, ...add]).catch(() => {});
            invalidate('tutor_settings');
            invalidate('files');
            if (codes[0]) setKey(codes[0]);
          }}
        />
      )}
    </>
  );
}

// Subjects your learners take that don't say which exam they're for yet: set it right here,
// so their papers show up (instead of an empty page)
function SetExams() {
  const lk = useLookups();
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const todo = lk.subjects.filter((s) => !s.exam && lk.learnersOfSubject(s.id).length);
  if (!todo.length) return null;
  const guess = (s) => {
    const m = String(s.name).match(/\b(0\d{3})\b/);
    return m && X.findSyllabus('cie', m[1]) ? `cie:${m[1]}` : '';
  };
  async function set(s, exam) {
    if (!exam) return;
    setBusy(s.id);
    try {
      await api.save('subjects', { id: s.id, exam });
      lk.reload();
      toast(`${s.name}: ${X.syllabusLabel(...exam.split(':'))}`);
    } catch (e) {
      toast({ title: 'Couldn’t save it', body: e.message, tone: 'bad' });
    } finally {
      setBusy(null);
    }
  }
  return (
    <div className="card tint stack sm">
      <div className="strong">Which exam is each subject for?</div>
      <div className="small muted">Choose it and that exam’s past papers show here for your learners. (You can change it later in Subjects.)</div>
      {todo.map((s) => (
        <div key={s.id} className="row wrap" style={{ gap: 10 }}>
          <span className="strong small" style={{ minWidth: 140 }}>
            {s.name}{' '}
            <span className="muted">
              ({lk
                .learnersOfSubject(s.id)
                .map((id) => lk.learner(id)?.display_name?.split(' ')[0])
                .filter(Boolean)
                .join(', ')}
              )
            </span>
          </span>
          {guess(s) && (
            <button className="btn sm primary" disabled={busy === s.id} onClick={() => set(s, guess(s))}>
              {X.syllabusLabel(...guess(s).split(':'))}
            </button>
          )}
          <div style={{ minWidth: 260 }}>
            <ExamSelect value="" onChange={(v) => set(s, v)} label={`Exam for ${s.name}`} none={guess(s) ? 'Or another exam…' : 'Choose the exam…'} />
          </div>
          {busy === s.id && <div className="spinner sm" />}
        </div>
      ))}
    </div>
  );
}

// What's known for one syllabus: the tutor's files and links plus the board's own papers
function useOfficial(code) {
  const [state, setState] = useState({ loading: true, items: [], at: 0 });
  const load = (refresh = false) => {
    setState((s) => ({ ...s, loading: true, error: null }));
    api
      .officialPapers(code, { refresh })
      .then((r) => setState({ loading: false, ...r }))
      .catch((e) => setState({ loading: false, items: [], error: e.message }));
  };
  useEffect(() => {
    load(false);
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  return { ...state, refresh: () => load(true) };
}

function entryState(list) {
  const qp = list.filter((x) => x.exam_kind === 'qp');
  const any = qp.length ? qp : list;
  if (!any.length) return 'missing';
  if (any.some((x) => !x.official && !x.link_url)) return 'mine';
  if (any.some((x) => x.link_url)) return 'link';
  return 'official';
}
const CHIP_TITLE = { mine: 'In your library', link: 'Your saved link', official: 'Published by the exam board', missing: 'Not in your library yet' };

function Chip({ label, state, hasMs, onClick }) {
  return (
    <button className={'paper-chip ' + state} onClick={onClick} title={CHIP_TITLE[state] + (hasMs ? ' · mark scheme too' : '')}>
      {label}
      {hasMs && <span className="ms-dot" aria-label="with mark scheme" />}
    </button>
  );
}

function CieSyllabus({ code, mine, onOpen }) {
  const off = useOfficial(code);
  const all = [...mine, ...(off.items || [])];
  const comps = [...new Set(all.map((x) => X.component(x.exam_paper)).filter(Boolean))].sort((a, b) => (+a || 99) - (+b || 99) || a.localeCompare(b));
  const hasMarch = all.some((x) => x.exam_session === 'm');
  const years = [];
  const maxYear = Math.max(THIS_YEAR, ...all.map((x) => x.exam_year || 0));
  const minYear = Math.min(FIRST_YEAR, ...all.filter((x) => x.exam_session !== 'spec' && x.exam_year).map((x) => x.exam_year));
  for (let y = maxYear; y >= minYear; y--) years.push(y);
  const sessions = X.SESSIONS.cie.filter(([s]) => s !== 'm' || hasMarch);
  const specimens = all.filter((x) => x.exam_session === 'spec');
  const reports = (y, s) => all.filter((x) => x.exam_year === y && x.exam_session === s && (x.exam_kind === 'er' || x.exam_kind === 'gt'));
  const page = X.officialPage(code);

  return (
    <div className="stack">
      <div className="row wrap small muted">
        <span className="paper-chip mine sm">41</span> in your library
        <span className="paper-chip official sm">41</span> published by Cambridge
        <span className="paper-chip link sm">41</span> your link
        <span className="paper-chip missing sm">41</span> not yet
        <span className="grow" />
        {api.canReachBoards() ? (
          <span>
            {off.loading ? (
              'Checking Cambridge’s website…'
            ) : off.error ? (
              <>
                <span className="bad-text">{off.error}</span>{' '}
                <a href={page} target="_blank" rel="noreferrer">
                  Open Cambridge’s page
                </a>
              </>
            ) : off.at ? (
              `Cambridge’s papers checked ${ago(new Date(off.at).toISOString())}${off.stale ? ' (couldn’t check again just now)' : ''}`
            ) : (
              ''
            )}{' '}
            {!off.loading && (
              <button className="btn sm ghost" onClick={off.refresh}>
                <Icon name="refresh" size={14} /> Check again
              </button>
            )}
          </span>
        ) : (
          page && (
            <a href={page} target="_blank" rel="noreferrer">
              Cambridge’s own past papers for {code} <Icon name="globe" size={14} />
            </a>
          )
        )}
      </div>

      {comps.length === 0 ? (
        <div className="note">
          No papers for this subject yet. Import the papers you have{api.canReachBoards() ? '' : ', or open the desktop app to see the ones Cambridge publishes'}.
        </div>
      ) : (
        <div className="card pad0 papers-grid-wrap">
          <table className="table papers-grid">
            <thead>
              <tr>
                <th>Session</th>
                {comps.map((c) => (
                  <th key={c}>Paper {c}</th>
                ))}
                <th>Reports</th>
              </tr>
            </thead>
            <tbody>
              {specimens.length > 0 && (
                <tr>
                  <td className="strong">Specimen</td>
                  {comps.map((c) => {
                    const list = specimens.filter((x) => X.component(x.exam_paper) === c);
                    return (
                      <td key={c}>
                        {list.length > 0 && (
                          <Chip
                            label={`${list[0].exam_year || ''}`}
                            state={entryState(list)}
                            hasMs={list.some((x) => x.exam_kind === 'ms')}
                            onClick={() => onOpen({ exam_board: 'cie', exam_code: code, exam_session: 'spec', exam_year: list[0].exam_year, exam_paper: c })}
                          />
                        )}
                      </td>
                    );
                  })}
                  <td />
                </tr>
              )}
              {years.map((y) =>
                sessions.filter(([s]) => happened(y, s) || all.some((x) => x.exam_year === y && x.exam_session === s)).map(([s, sname]) => {
                  const row = all.filter((x) => x.exam_year === y && x.exam_session === s);
                  return (
                    <tr key={y + s} className={row.length ? '' : 'quiet'}>
                      <td className="strong nowrap">
                        {sname} {y}
                      </td>
                      {comps.map((c) => {
                        const papers = new Set(X.variantsFor(s).map((v) => (/^\d$/.test(c) ? c + v : c)));
                        for (const x of row) if (X.component(x.exam_paper) === c && x.exam_paper) papers.add(x.exam_paper);
                        return (
                          <td key={c}>
                            <div className="row" style={{ gap: 4 }}>
                              {[...papers].sort().map((p) => {
                                const list = row.filter((x) => x.exam_paper === p);
                                return (
                                  <Chip
                                    key={p}
                                    label={p}
                                    state={entryState(list)}
                                    hasMs={list.some((x) => x.exam_kind === 'ms')}
                                    onClick={() => onOpen({ exam_board: 'cie', exam_code: code, exam_year: y, exam_session: s, exam_paper: p })}
                                  />
                                );
                              })}
                            </div>
                          </td>
                        );
                      })}
                      <td>
                        {reports(y, s).length > 0 && (
                          <button className="btn sm ghost" onClick={() => onOpen({ exam_board: 'cie', exam_code: code, exam_year: y, exam_session: s, exam_kind: 'er' })}>
                            {reports(y, s).length} report{reports(y, s).length > 1 ? 's' : ''}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                }),
              )}
            </tbody>
          </table>
        </div>
      )}
      <BoundariesCard exam={`cie:${code}`} sources={(off.items || []).filter((x) => x.exam_kind === 'gt').map((x) => ({ url: x.url, name: x.name }))} />
    </div>
  );
}

// Grade boundaries for the exam, used by mock exams (private to the tutor)
function BoundariesCard({ exam, sources = [] }) {
  const [board, code] = exam.split(':');
  return (
    <div className="card" id="grade-boundaries">
      <div className="card-head">
        <h2>Grade boundaries</h2>
        <span className="small muted">Used by your mock exams to work out grades. Only you see them.</span>
      </div>
      <GradeBoundaries exam={exam} label={`${X.BOARDS[board]?.short || ''} ${X.syllabusLabel(board, code)}`.trim()} sources={sources} />
    </div>
  );
}

// IB: the IB sells its papers, so this is what you have, by level and paper, plus
// original practice papers Prof writes in each paper's style. No empty grid of years.
const SESSION_SHORT = { may: 'May', nov: 'Nov', spec: 'Specimen' };
function IbSyllabus({ syl, mine, onOpen }) {
  const assignments = useQuery('assignments', api.listAssignments);
  const papers = syl.papers.length ? syl.papers : ['1'];
  const practice = (assignments.data || []).filter((a) => /practice paper/i.test(a.title || '') && (a.title || '').toLowerCase().includes(syl.name.toLowerCase()));
  // one chip per paper sitting (question paper + mark scheme together)
  const sittings = (list) => {
    const m = new Map();
    for (const f of list) {
      const k = X.slotKey(f);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(f);
    }
    return [...m.values()].sort((x, y) => (y[0].exam_year || 0) - (x[0].exam_year || 0) || String(y[0].exam_session).localeCompare(String(x[0].exam_session)));
  };
  const levels = [...syl.levels, ...(mine.some((f) => !f.exam_level) ? [null] : [])];
  return (
    <div className="stack">
      <div className="note small">
        The IB sells its past papers through the{' '}
        <a href={X.IB_STORE} target="_blank" rel="noreferrer">
          IB store
        </a>
        . Papers you import are filed here and stay private to you. For papers you can share freely, ask Prof for an original practice paper in a paper’s style.
      </div>
      {!syl.papers.length && <div className="note small">This subject is assessed mainly through coursework, so there are few written papers.</div>}
      {levels.map((l) => (
        <div key={l || 'none'} className="card">
          <h3 style={{ margin: 0 }}>
            {syl.name} {l || '(level not set)'}
          </h3>
          <div className="list">
            {(l ? papers : ['?']).map((p) => {
              const list = mine.filter((f) => (l ? f.exam_level === l && (f.exam_paper || '1') === p : !f.exam_level));
              const sits = sittings(list);
              const req = { exam_board: 'ib', exam_code: syl.code, exam_paper: l ? p : null, exam_level: l };
              return (
                <div key={p} className="item ib-paper">
                  <span className="strong nowrap" style={{ width: 70 }}>
                    {l ? `Paper ${p}` : 'Unsorted'}
                  </span>
                  <span className="grow row wrap" style={{ gap: 4 }}>
                    {sits.map((g) => {
                      const f = g[0];
                      const lab = [SESSION_SHORT[f.exam_session] || '', f.exam_year || '', f.exam_tz || '', !l && f.exam_paper ? `P${f.exam_paper}` : ''].filter(Boolean).join(' ') || f.name;
                      return (
                        <Chip
                          key={X.slotKey(f)}
                          label={lab}
                          state={entryState(g)}
                          hasMs={g.some((x) => x.exam_kind === 'ms')}
                          onClick={() => onOpen({ exam_board: 'ib', exam_code: syl.code, exam_year: f.exam_year, exam_session: f.exam_session, exam_paper: f.exam_paper, exam_level: f.exam_level, exam_tz: f.exam_tz })}
                        />
                      );
                    })}
                    {!sits.length && <span className="small muted">None yet</span>}
                  </span>
                  {l && (
                    <button className="btn sm" onClick={() => onOpen(req)}>
                      <Icon name="plus" size={14} /> Add or practise
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <div className="card">
        <h3 style={{ margin: 0 }} className="row">
          <Icon name="cap" style={{ color: 'var(--claude)' }} /> Prof’s practice papers
        </h3>
        {practice.length ? (
          <div className="list">
            {practice.map((a) => (
              <a key={a.id} className="item" href={`#/assignments/${a.id}`}>
                <Icon name="clipboard" size={18} />
                <span className="grow">
                  <span className="name">{a.title}</span>
                  <span className="meta">{a.draft ? 'Draft: hidden until you approve' : 'Approved'}</span>
                </span>
              </a>
            ))}
          </div>
        ) : (
          <div className="small muted">None yet. Choose “Add or practise” on a paper, then “Prof: practice paper in this style”. Prof writes all-new questions with the same structure and marks, with a mark scheme, and you approve it first.</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One paper: what the tutor has, what the board publishes, and what to do next
// ---------------------------------------------------------------------------
function SlotPanel({ req, files, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const off = useOfficial(req.exam_board === 'cie' ? req.exam_code : null);
  const [busy, setBusy] = useState('');
  const [linking, setLinking] = useState(false);
  const [sharing, setSharing] = useState(null);
  const upload = useRef(null);
  const [uploadKind, setUploadKind] = useState('qp');
  const mine = files.filter((f) => f.exam_board && X.matches(req, f) && (!req.exam_kind || f.exam_kind === req.exam_kind));
  const official = req.exam_board === 'cie' ? (off.items || []).filter((x) => X.matches(req, x) && (!req.exam_kind || x.exam_kind === req.exam_kind)) : [];
  const all = [...mine, ...official];
  const kinds = Object.keys(X.KINDS).filter((k) => all.some((x) => x.exam_kind === k));
  const myQp = mine.find((f) => f.exam_kind === 'qp' && !f.link_url);
  const myMs = mine.find((f) => f.exam_kind === 'ms' && !f.link_url);
  const title = X.slotLabel({ ...req, exam_kind: req.exam_kind || 'qp' });
  const exact = req.exam_paper && (req.exam_board === 'ib' ? !!req.exam_level : /^\d\d$/.test(req.exam_paper) || req.exam_session === 'spec');

  async function saveOfficial(x) {
    setBusy(x.url);
    try {
      const blob = await api.officialBlob(x.url);
      await api.importPaper(blob, `${x.exam_code} ${x.name}.pdf`, x);
      invalidate('files');
      toast({ title: 'Saved to your library', body: 'It’s kept on this computer until you share it with learners.' });
    } catch (e) {
      toast({ title: 'Couldn’t save it', body: e.message, tone: 'bad' });
    } finally {
      setBusy('');
    }
  }

  async function uploadMine(file) {
    if (!file) return;
    setBusy('upload');
    try {
      const meta = { ...req, exam_kind: uploadKind };
      await api.importPaper(file, file.name, meta);
      invalidate('files');
      toast(`Added: ${X.slotLabel(meta)}`);
    } catch (e) {
      toast({ title: 'Couldn’t add it', body: e.message, tone: 'bad' });
    } finally {
      setBusy('');
    }
  }

  async function askProf(kind) {
    setBusy('prof');
    try {
      const { pdfBookInfo } = await import('../../ui/PdfViewer.jsx');
      const books = [];
      for (const f of kind === 'split' ? [myQp, myMs].filter(Boolean) : []) {
        const info = await pdfBookInfo(await api.getBlob('library', f.storage_path));
        books.push({ file_id: f.id, name: f.name, pages: info.pages, outline: info.outline });
      }
      const label = X.slotLabel({ ...req, exam_kind: 'qp' });
      const syl = X.syllabusLabel(req.exam_board, req.exam_code);
      const prompt =
        kind === 'split'
          ? `Turn my copy of ${label} (${syl}) into a StudyBridge test with every question, in order, with the marks shown on the paper.${myMs ? ' Use the mark scheme I attached for the answers and mark schemes.' : ' Write the answers and mark schemes yourself.'} Tag each question with its topic. Keep diagrams as images from the pages where needed.`
          : `Write an ORIGINAL practice paper in the style of ${label} (${syl}): the same structure, number of questions, topics, marks and difficulty as that paper, but entirely new questions, numbers and contexts — do not reproduce any real past-paper question. Include full answers and a mark scheme. Title it “Practice paper in the style of ${label}”.`;
      await api.profAsk(prompt, { books });
      toast({ title: 'Prof is on it', body: 'You’ll find the draft in Prof. Nothing reaches learners until you approve it.' });
      go('/prof');
    } catch (e) {
      toast({ title: 'Couldn’t ask Prof', body: e.message, tone: 'bad' });
    } finally {
      setBusy('');
    }
  }

  return (
    <Modal title={title} onClose={onClose} wide>
      <div className="small muted">{X.syllabusLabel(req.exam_board, req.exam_code)}</div>
      {off.loading && req.exam_board === 'cie' && api.canReachBoards() && (
        <div className="row small muted">
          <div className="spinner" /> Checking Cambridge’s website…
        </div>
      )}
      {all.length === 0 ? (
        <div className="note">Not in your library yet{req.exam_board === 'cie' && api.canReachBoards() && !off.loading && !off.error ? ', and Cambridge doesn’t publish this one on its website' : ''}.</div>
      ) : (
        <div className="stack">
          {kinds.map((k) => (
            <div key={k} className="stack sm">
              <div className="tiny muted strong upper">{X.kindName(k)}</div>
              {all
                .filter((x) => x.exam_kind === k)
                .map((x) => (
                  <div key={x.id || x.url} className="row paper-line">
                    <Icon name={x.link_url ? 'link' : x.official ? 'globe' : 'pdf'} style={{ color: 'var(--accent)' }} />
                    <span className="grow">
                      <span className="strong">{x.official ? x.name : X.slotLabel(x)}</span>
                      <span className="tiny muted">
                        {' '}
                        · {x.official ? 'from Cambridge’s website' : x.link_url ? 'your link' : x.cloud === false ? `on this computer · ${bytes(x.size)}` : `in your library · ${bytes(x.size)}`}
                        {x.exam_board === 'ib' && !x.official && !x.link_url ? ' · IB paper, private to you' : ''}
                      </span>
                    </span>
                    {x.official ? (
                      <>
                        {api.canReachBoards() ? (
                          <button className="btn sm" onClick={() => go('/official/' + encodeURIComponent(x.url))}>
                            Open
                          </button>
                        ) : (
                          <a className="btn sm" href={x.url} target="_blank" rel="noreferrer">
                            Open
                          </a>
                        )}
                        {api.canReachBoards() && !mine.some((f) => f.exam_kind === x.exam_kind && f.exam_paper === x.exam_paper && !f.link_url) && (
                          <button className="btn sm" disabled={busy === x.url} onClick={() => saveOfficial(x)}>
                            {busy === x.url ? 'Saving…' : 'Save to my library'}
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        {x.link_url ? (
                          <a className="btn sm" href={x.link_url} target="_blank" rel="noreferrer">
                            Open
                          </a>
                        ) : (
                          <button className="btn sm" onClick={() => go(`/file/${x.id}`)}>
                            Open
                          </button>
                        )}
                        {!x.link_url && (
                          <button className="btn sm" onClick={() => setSharing(x)}>
                            {x.visibility === 'hidden' ? 'Share' : 'Sharing'}
                          </button>
                        )}
                        <button
                          className="btn sm ghost icon"
                          aria-label="Remove"
                          title="Remove from your library"
                          onClick={async () => {
                            if (!(await confirm({ title: 'Remove this from your library?', ok: 'Remove', danger: true }))) return;
                            await api.deleteFile(x);
                            invalidate('files');
                          }}
                        >
                          <Icon name="trash" size={16} />
                        </button>
                      </>
                    )}
                  </div>
                ))}
            </div>
          ))}
        </div>
      )}

      <div className="stack sm">
        <div className="tiny muted strong upper">Do more with this paper</div>
        <div className="row wrap">
          {myQp && (
            <button className="btn claude" disabled={!!busy} onClick={() => askProf('split')}>
              <Icon name="cap" size={18} /> Turn into a test with Prof
            </button>
          )}
          {exact && (
            <button className="btn" disabled={!!busy} onClick={() => askProf('style')}>
              <Icon name="cap" size={18} /> Prof: practice paper in this style
            </button>
          )}
          {exact && (
            <>
              <select className="select" style={{ width: 'auto', minHeight: 36 }} value={uploadKind} onChange={(e) => setUploadKind(e.target.value)} aria-label="Which part">
                {['qp', 'ms', 'er', 'in'].map((k) => (
                  <option key={k} value={k}>
                    {X.kindName(k)}
                  </option>
                ))}
              </select>
              <button className="btn" disabled={busy === 'upload'} onClick={() => upload.current.click()}>
                <Icon name="upload" size={18} /> {busy === 'upload' ? 'Adding…' : 'Add my copy'}
              </button>
              <button className="btn" onClick={() => setLinking(true)}>
                <Icon name="link" size={18} /> Add my link
              </button>
              <input ref={upload} type="file" accept="application/pdf,.pdf" hidden onChange={(e) => (uploadMine(e.target.files[0]), (e.target.value = ''))} />
            </>
          )}
          {req.exam_board === 'cie' && api.canReachBoards() && (
            <button className="btn ghost" disabled={off.loading} onClick={off.refresh}>
              <Icon name="refresh" size={16} /> Check Cambridge again
            </button>
          )}
          {req.exam_board === 'ib' && (
            <a className="btn ghost" href={X.IB_STORE} target="_blank" rel="noreferrer">
              <Icon name="globe" size={16} /> IB store
            </a>
          )}
        </div>
        {!exact && <div className="tiny muted">Pick an exact paper (for example Paper 41) to add your copy or ask Prof for a practice paper.</div>}
        <div className="tiny muted">Copies you add stay private to you and are kept on this computer until you share one with learners.</div>
      </div>
      {linking && <LinkForm req={{ ...req, exam_kind: uploadKind }} onClose={() => setLinking(false)} />}
      {sharing && <FileSettings file={sharing} onClose={() => setSharing(null)} />}
    </Modal>
  );
}

function LinkForm({ req, onClose }) {
  const toast = useToast();
  const [url, setUrl] = useState('');
  const [err, setErr] = useState('');
  async function saveIt() {
    if (!/^https?:\/\/\S+\.\S+/i.test(url.trim())) return setErr('Paste a full web address starting with https://');
    try {
      await api.addPaperLink(url.trim(), X.slotLabel(req), req);
      invalidate('files');
      toast('Link saved');
      onClose();
    } catch (e) {
      setErr(e.message);
    }
  }
  return (
    <Modal
      title="Add your link"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={saveIt}>
            Save link
          </button>
        </>
      }
    >
      <div className="small">{X.slotLabel(req)}</div>
      <Field label="Web address" error={err}>
        <input className="input" autoFocus value={url} onChange={(e) => (setUrl(e.target.value), setErr(''))} placeholder="https://" />
      </Field>
      <div className="tiny muted">Only you see this link. It opens in your browser.</div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Import a whole folder: every paper is recognised from its name (or its cover
// page), paired up by slot, and duplicates are skipped.
// ---------------------------------------------------------------------------
async function filesFromDrop(dt) {
  const out = [];
  const entries = [...(dt.items || [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...(dt.files || [])].map((f) => ({ file: f, path: f.name }));
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((res, rej) => entry.file(res, rej));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, prefix + entry.name + '/');
      } while (batch.length);
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

function ImportPapers({ existing, onClose, onDone }) {
  const toast = useToast();
  const [rows, setRows] = useState([]);
  const [reading, setReading] = useState(false);
  const [doing, setDoing] = useState(null);
  const [over, setOver] = useState(false);
  const [editing, setEditing] = useState(null);
  const folder = useRef(null);
  const picker = useRef(null);
  const known = useMemo(() => new Set(existing.map((f) => f.sha256).filter(Boolean)), [existing]);

  async function read(list) {
    setReading(true);
    const { pdfFirstText } = await import('../../ui/PdfViewer.jsx');
    const seen = new Set(rows.map((r) => r.sha));
    const next = [];
    for (const { file, path } of list) {
      if (!/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') {
        if (!/^\./.test(file.name)) next.push({ name: path, size: file.size, status: 'skip', why: 'Not a PDF' });
        continue;
      }
      const sha = await api.sha256(file);
      let meta = X.parseFilename(file.name, path);
      if (!meta || !meta.exam_year) {
        const cover = X.parseCover(await pdfFirstText(file, 2));
        if (cover && (!meta || cover.exam_code === meta.exam_code)) meta = { ...meta, ...Object.fromEntries(Object.entries(cover).filter(([, v]) => v != null)) };
      }
      let status = meta ? 'new' : 'unknown';
      if (known.has(sha)) status = 'have';
      else if (seen.has(sha)) status = 'dupe';
      seen.add(sha);
      next.push({ name: path, file, size: file.size, sha, meta, status });
      if (next.length >= 10) {
        const chunk = next.splice(0);
        setRows((r) => [...r, ...chunk]);
      }
    }
    const rest = next.splice(0);
    setRows((r) => [...r, ...rest]);
    setReading(false);
  }

  const ready = rows.filter((r) => r.status === 'new');
  const total = ready.reduce((a, r) => a + r.size, 0);

  async function importAll() {
    setDoing({ done: 0, of: ready.length });
    const codes = new Set();
    let ok = 0;
    for (const r of ready) {
      try {
        await api.importPaper(r.file, r.name.split('/').pop(), r.meta, { hash: r.sha });
        codes.add(`${r.meta.exam_board}:${r.meta.exam_code}`);
        ok++;
      } catch (e) {
        r.status = 'failed';
        r.why = e.message;
      }
      setDoing((d) => ({ ...d, done: d.done + 1 }));
    }
    setDoing(null);
    toast({ title: `Imported ${ok} paper${ok === 1 ? '' : 's'}`, body: 'Filed by subject, year and session. They’re kept on this computer until you share one.' });
    await onDone([...codes]);
    onClose();
  }

  const label = { new: 'Ready', have: 'Already in your library', dupe: 'Same file twice', unknown: 'Couldn’t tell which paper', skip: 'Skipped', failed: 'Failed' };
  const tone = { new: 'good', have: '', dupe: '', unknown: 'warn', skip: '', failed: 'bad' };

  return (
    <Modal
      title="Import past papers"
      onClose={doing ? null : onClose}
      wide
      foot={
        <>
          <button className="btn" onClick={onClose} disabled={!!doing}>
            Cancel
          </button>
          <button className="btn primary" onClick={importAll} disabled={!ready.length || reading || !!doing}>
            {doing ? `Importing ${doing.done} of ${doing.of}…` : `Import ${ready.length} paper${ready.length === 1 ? '' : 's'}${ready.length ? ` (${bytes(total)})` : ''}`}
          </button>
        </>
      }
    >
      <div
        className={'dropzone' + (over ? ' over' : '')}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setOver(false);
          read(await filesFromDrop(e.dataTransfer));
        }}
      >
        <Icon name="folder" size={28} />
        <div className="strong">Drop a folder of past papers here</div>
        <div className="small muted">Cambridge files like 0607_s23_qp_41.pdf and IB papers are recognised from their names or their cover pages. Duplicates are skipped.</div>
        <div className="row">
          <button className="btn sm" onClick={() => folder.current.click()}>
            Choose a folder
          </button>
          <button className="btn sm" onClick={() => picker.current.click()}>
            Choose files
          </button>
        </div>
        <input ref={folder} type="file" hidden webkitdirectory="" directory="" multiple onChange={(e) => (read([...e.target.files].map((f) => ({ file: f, path: f.webkitRelativePath || f.name }))), (e.target.value = ''))} />
        <input ref={picker} type="file" hidden multiple accept="application/pdf,.pdf" onChange={(e) => (read([...e.target.files].map((f) => ({ file: f, path: f.name }))), (e.target.value = ''))} />
      </div>
      {reading && (
        <div className="row small">
          <div className="spinner" /> Reading {rows.length} file{rows.length === 1 ? '' : 's'}…
        </div>
      )}
      {rows.length > 0 && (
        <>
          <div className="small muted">
            {ready.length} ready · {rows.filter((r) => r.status === 'have' || r.status === 'dupe').length} duplicates skipped · {rows.filter((r) => r.status === 'unknown').length} not recognised
            {rows.some((r) => r.status === 'unknown') && ' (add those in Files instead)'}
          </div>
          <div className="card pad0" style={{ maxHeight: 340, overflowY: 'auto' }}>
            <table className="table">
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td className="small ellipsis" style={{ maxWidth: 260 }} title={r.name}>
                      {r.name}
                    </td>
                    <td className="small">{r.meta ? `${X.slotLabel(r.meta)}` : <span className="muted">{r.why || '—'}</span>}</td>
                    <td className="nowrap">
                      <span className={'pill ' + tone[r.status]}>{label[r.status]}</span>
                      {(r.status === 'new' || r.status === 'unknown') && (
                        <button className="btn sm ghost" onClick={() => setEditing(i)} aria-label={`Fix ${r.name}`}>
                          <Icon name="pen" size={14} /> Fix
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      <div className="tiny muted">Check the list: if a paper was read wrongly (or not at all), choose Fix. Imported papers stay on this computer and are private to you. A paper is uploaded only when you share it with learners.</div>
      {editing != null && rows[editing] && (
        <MetaEdit
          name={rows[editing].name}
          meta={rows[editing].meta}
          onClose={() => setEditing(null)}
          onSave={(meta) => {
            setRows((rs) => rs.map((r, i) => (i === editing ? { ...r, meta, status: 'new', why: null } : r)));
            setEditing(null);
          }}
        />
      )}
    </Modal>
  );
}

// Fix what a file was read as, before importing it
function MetaEdit({ name, meta, onClose, onSave }) {
  const [m, setM] = useState({ exam_board: 'ib', exam_kind: 'qp', ...(meta || {}) });
  const set = (k, v) => setM((x) => ({ ...x, [k]: v === '' ? null : v }));
  const syl = m.exam_code ? X.findSyllabus(m.exam_board, m.exam_code) : null;
  const ok = !!syl;
  return (
    <Modal
      title="Which paper is this?"
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!ok} onClick={() => onSave({ ...m, exam_year: m.exam_year ? Number(m.exam_year) : null })}>
            Use this
          </button>
        </>
      }
    >
      <div className="small muted ellipsis" title={name}>
        {name}
      </div>
      <div className="grid g2" style={{ gap: 12 }}>
        <Field label="Exam board">
          <select className="select" value={m.exam_board} onChange={(e) => setM((x) => ({ ...x, exam_board: e.target.value, exam_code: null, exam_session: null }))}>
            {Object.entries(X.BOARDS).map(([b, info]) => (
              <option key={b} value={b}>
                {info.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Subject">
          <select className="select" value={m.exam_code || ''} onChange={(e) => set('exam_code', e.target.value)}>
            <option value="">Choose…</option>
            {X.syllabuses(m.exam_board).map((s) => (
              <option key={s.code} value={s.code}>
                {X.syllabusLabel(m.exam_board, s.code)}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Session">
          <select className="select" value={m.exam_session || ''} onChange={(e) => set('exam_session', e.target.value)}>
            <option value="">Not known</option>
            {[...X.SESSIONS[m.exam_board], ['spec', 'Specimen']].map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Year">
          <input className="input" inputMode="numeric" value={m.exam_year || ''} onChange={(e) => set('exam_year', e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="e.g. 2025" />
        </Field>
        <Field label="Paper">
          <input className="input" value={m.exam_paper || ''} onChange={(e) => set('exam_paper', e.target.value.trim().toUpperCase().slice(0, 3))} placeholder={m.exam_board === 'ib' ? '1, 2 or 3' : 'e.g. 41'} />
        </Field>
        <Field label="What it is">
          <select className="select" value={m.exam_kind || 'qp'} onChange={(e) => set('exam_kind', e.target.value)}>
            {Object.entries(X.KINDS).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        {m.exam_board === 'ib' && (
          <>
            <Field label="Level">
              <select className="select" value={m.exam_level || ''} onChange={(e) => set('exam_level', e.target.value)}>
                <option value="">Not known</option>
                {(syl?.levels || ['SL', 'HL']).map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Time zone">
              <select className="select" value={m.exam_tz || ''} onChange={(e) => set('exam_tz', e.target.value)}>
                <option value="">None / not known</option>
                {['TZ0', 'TZ1', 'TZ2'].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </Field>
          </>
        )}
      </div>
      {ok && <div className="small">Files as: {X.slotLabel(m)}</div>}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// A paper opened straight from the exam board's website (desktop app)
// ---------------------------------------------------------------------------
export function OfficialView({ url }) {
  const [state, setState] = useState({});
  useEffect(() => {
    let alive = true;
    api
      .officialBlob(url)
      .then((blob) => alive && setState({ blob }))
      .catch((e) => alive && setState({ error: e.message }));
    return () => {
      alive = false;
    };
  }, [url]);
  const [Viewer, setViewer] = useState(null);
  useEffect(() => {
    import('../../ui/PdfViewer.jsx').then((m) => setViewer(() => m.default));
  }, []);
  const name = decodeURIComponent(url.split('/').pop() || 'Paper').replace(/^\d+-/, '').replace(/\.pdf$/i, '').replace(/-/g, ' ');
  return (
    <div className="page wide" style={{ height: 'calc(100vh - 90px)', gap: 12 }}>
      <div className="eyebrow">
        <a href="#/library/papers">Past papers</a> <Icon name="right" size={14} /> {name} <span className="pill accent">From Cambridge’s website</span>
      </div>
      {state.error ? (
        <div className="stack">
          <div className="error">{state.error}</div>
          <a className="btn" href={url} target="_blank" rel="noreferrer">
            Open in browser
          </a>
        </div>
      ) : !state.blob || !Viewer ? (
        <Loading label="Opening from Cambridge…" />
      ) : (
        <Viewer blob={state.blob} title={name} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Free textbooks with open licences
// ---------------------------------------------------------------------------
export function OpenBooks() {
  const groups = {};
  for (const b of X.OPEN_BOOKS) (groups[b.for] ||= []).push(b);
  return (
    <div className="stack">
      <div className="note small">
        Free, openly licensed textbooks you can use and share with learners. Your own textbooks go in <a href="#/library/files">Files</a>; they stay private to you and Prof can read them.
      </div>
      {Object.entries(groups).map(([g, list]) => (
        <div key={g} className="card">
          <h3>{g}</h3>
          <div className="list">
            {list.map((b) => (
              <a key={b.url} className="item" href={b.url} target="_blank" rel="noreferrer">
                <Icon name="book" style={{ color: 'var(--accent)' }} />
                <span className="grow">
                  <span className="name">{b.title}</span>
                  <span className="meta">{b.by}</span>
                </span>
                <Icon name="globe" size={16} />
              </a>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
