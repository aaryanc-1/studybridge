// Learners → New from your school (schools and centres): students who signed up with the school email and aren't in a
// class yet, by year, to tick and add to a class; and the school's class lists from a spreadsheet (email, name, year,
// classes), with accounts made in advance and starting passwords to print.
import { useMemo, useRef, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Loading, Modal, Page, copyText, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago } from '../../lib/format.js';
import { useLookups } from '../shared/lookups.jsx';
import { LearnerTabs } from './Learners.jsx';

export const gradeLabel = (g) => (g ? `Grade ${g} (Year ${g + 1})` : 'Year not given');
const changed = () => invalidate('school-waiting', 'school-roster', 'classes', 'class_members', 'class_teachers', 'class-pool', 'learners', 'learner_subjects');

export default function SchoolLearners() {
  const lk = useLookups();
  const toast = useToast();
  const confirm = useConfirm();
  const org = useQuery('org', api.myOrg).data;
  const q = useQuery('school-waiting', api.schoolWaiting);
  const [picked, setPicked] = useState([]);
  const [cls, setCls] = useState('');
  const [busy, setBusy] = useState(false);
  const manager = org?.role === 'manager';
  const classes = manager ? lk.orgClasses : lk.activeClasses;
  const list = q.data || [];
  const groups = useMemo(() => {
    const out = [];
    for (const l of list) {
      let g = out.find((x) => x.grade === (l.grade || null));
      if (!g) out.push((g = { grade: l.grade || null, people: [] }));
      g.people.push(l);
    }
    return out;
  }, [list]);
  const toggle = (id) => setPicked((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  async function add() {
    const c = classes.find((x) => x.id === cls);
    if (!c || !picked.length) return;
    setBusy(true);
    try {
      await api.schoolAddToClass(c.id, picked);
      toast(`${picked.length} added to ${c.name}`);
      setPicked([]);
      changed();
    } catch (e) {
      toast({ title: 'Couldn’t add them', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function remove(l) {
    if (!(await confirm({ title: `${l.name} isn’t in your school?`, body: 'They’re taken off your school’s list. Their account stays, but it isn’t part of your school.', ok: 'Not in our school' }))) return;
    try {
      await api.schoolRemove(l.id);
      changed();
    } catch (e) {
      toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
    }
  }
  return (
    <Page title="Learners" subtitle="Students who signed up with your school email, waiting to be put in a class.">
      <LearnerTabs tab="school" />
      {!q.data ? (
        q.error ? <div className="error">{q.error.message}</div> : <Loading />
      ) : list.length === 0 ? (
        <Empty title="Nobody waiting">
          Students who sign up with your school email show up here until they’re in a class. A class code, or your school’s class list below, puts them straight in.
        </Empty>
      ) : (
        <>
          {groups.map((g) => (
            <div key={g.grade || 'none'} className="card">
              <div className="card-head">
                <h2>{gradeLabel(g.grade)}</h2>
                <button
                  className="linkbtn small"
                  onClick={() => setPicked((xs) => (g.people.every((p) => xs.includes(p.id)) ? xs.filter((x) => !g.people.some((p) => p.id === x)) : [...new Set([...xs, ...g.people.map((p) => p.id)])]))}
                >
                  {g.people.every((p) => picked.includes(p.id)) ? 'Untick all' : `Tick all ${g.people.length}`}
                </button>
              </div>
              <div className="list">
                {g.people.map((l) => (
                  <label key={l.id} className="item school-row">
                    <input type="checkbox" checked={picked.includes(l.id)} onChange={() => toggle(l.id)} aria-label={`Choose ${l.name}`} />
                    <span className="grow">
                      <span className="name">{l.name}</span>
                      <span className="meta">
                        <span>{l.email}</span>
                        <span>joined {ago(l.joined_at)}</span>
                        {!l.ok && <span className="pill warn">Email not confirmed yet</span>}
                      </span>
                    </span>
                    {manager && (
                      <button type="button" className="btn sm ghost" onClick={(e) => (e.preventDefault(), remove(l))} aria-label={`${l.name} isn’t in our school`}>
                        Not in our school
                      </button>
                    )}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="card school-add">
            <div className="row wrap" style={{ gap: 10 }}>
              <span className="strong">{picked.length ? `${picked.length} chosen` : 'Tick the students to add'}</span>
              <select className="select" value={cls} onChange={(e) => setCls(e.target.value)} aria-label="Class to add them to" style={{ maxWidth: 260 }}>
                <option value="">Choose a class…</option>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button className="btn primary" disabled={busy || !picked.length || !cls} onClick={add}>
                <Icon name="plus" size={16} /> Add to class
              </button>
            </div>
            {!classes.length && <div className="small muted">Make a class first (Learners → Classes), then add them to it.</div>}
            {picked.some((id) => !list.find((l) => l.id === id)?.ok) && (
              <div className="small muted">Adding someone whose email isn’t confirmed yet says you know they’re in your school.</div>
            )}
          </div>
        </>
      )}
      <Roster />
    </Page>
  );
}

// The school's class lists from a spreadsheet: who's on them, and making their accounts in advance
function Roster() {
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery('school-roster', api.schoolRosterList);
  const rows = q.data || [];
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState(false);
  const [slips, setSlips] = useState(null);
  const [busy, setBusy] = useState(false);
  const notYet = rows.filter((r) => !r.joined && !r.has_account);
  const joined = rows.filter((r) => r.joined).length;
  async function make() {
    if (!(await confirm({ title: `Make accounts for ${notYet.length} learner${notYet.length === 1 ? '' : 's'}?`, body: 'Each gets a starting password to sign in with. They choose their own the first time. You see the starting passwords once, to print or copy.', ok: 'Make the accounts' }))) return;
    setBusy(true);
    try {
      const r = await api.makeSchoolAccounts(notYet.map((x) => x.id));
      setSlips(r);
      changed();
    } catch (e) {
      toast({ title: 'Couldn’t make the accounts', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <div className="card-head">
        <h2>Class lists from a spreadsheet</h2>
        <button className="btn" onClick={() => setAdding(true)}>
          <Icon name="upload" size={16} /> Add a spreadsheet
        </button>
      </div>
      <div className="small muted">
        Got a list with emails (and years and classes)? Add it here. When someone on it signs up with that email, they go straight into their classes. You can also make their accounts now, with starting passwords to hand out.
      </div>
      {rows.length > 0 && (
        <>
          <div className="row wrap" style={{ gap: 10 }}>
            <span className="small">
              {rows.length} on your lists · {joined} joined{notYet.length ? ` · ${notYet.length} without an account yet` : ''}
            </span>
            <button className="linkbtn small" onClick={() => setOpen((x) => !x)}>
              {open ? 'Hide the list' : 'Show the list'}
            </button>
            {notYet.length > 0 && (
              <button className="btn sm" disabled={busy} onClick={make}>
                <Icon name="users" size={15} /> {busy ? 'Making accounts…' : `Make accounts for ${notYet.length}`}
              </button>
            )}
          </div>
          {open && (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Email</th>
                    <th>Year</th>
                    <th>Classes</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id}>
                      <td>{r.name || '—'}</td>
                      <td className="small">{r.email}</td>
                      <td className="small">{r.grade ? gradeLabel(r.grade) : '—'}</td>
                      <td className="small">{r.classes.join(', ') || '—'}</td>
                      <td>{r.joined ? <span className="pill good">Joined</span> : r.has_account ? <span className="pill">Has an account</span> : <span className="pill warn">Not yet</span>}</td>
                      <td>
                        {!r.joined && (
                          <button
                            className="btn sm ghost icon"
                            aria-label={`Take ${r.name || r.email} off the list`}
                            onClick={async () => {
                              try {
                                await api.schoolRosterRemove(r.id);
                                changed();
                              } catch (e) {
                                toast({ title: 'Couldn’t do that', body: e.message, tone: 'bad' });
                              }
                            }}
                          >
                            <Icon name="x" size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {adding && <RosterImport onClose={() => setAdding(false)} />}
      {slips && <Slips r={slips} onClose={() => setSlips(null)} />}
    </div>
  );
}

// A spreadsheet's rows, pasted (straight from Excel or Google Sheets) or from a .csv file
function parseTable(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
  if (!lines.length) return [];
  const sep = lines.some((l) => l.includes('\t')) ? '\t' : lines[0].split(';').length > lines[0].split(',').length ? ';' : ',';
  const cells = (line) => {
    if (sep === '\t') return line.split('\t').map((x) => x.trim());
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"' && quoted && line[i + 1] === '"') (cur += '"'), i++;
      else if (ch === '"') quoted = !quoted;
      else if (ch === sep && !quoted) out.push(cur.trim()), (cur = '');
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  };
  let table = lines.map(cells);
  // a header row says which column is which; without one: email, name, year, classes
  let col = { email: 0, name: 1, year: 2, classes: 3 };
  const head = table[0].map((h) => h.toLowerCase());
  if (head.some((h) => /e-?mail/.test(h))) {
    const find = (re) => head.findIndex((h) => re.test(h));
    col = { email: find(/e-?mail/), name: find(/name/), year: find(/year|grade|form|class(?!es)\b/), classes: find(/classes|subjects?|groups?|sets?/) };
    table = table.slice(1);
  }
  const year = (v) => {
    const m = String(v || '').match(/\d{1,2}/);
    if (!m) return null;
    const n = Number(m[0]);
    return /year/i.test(v) ? n - 1 : n; // Year 10 = Grade 9
  };
  return table
    .map((r) => ({
      email: (r[col.email] || '').trim(),
      name: col.name >= 0 ? (r[col.name] || '').trim() : '',
      grade: col.year >= 0 ? year(r[col.year]) : null,
      classes: col.classes >= 0 ? String(r[col.classes] || '').split(sep === '\t' ? /[;,|]/ : /[;|]/).map((x) => x.trim()).filter(Boolean) : [],
    }))
    .filter((r) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.email));
}

function RosterImport({ onClose }) {
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const file = useRef(null);
  const rows = useMemo(() => parseTable(text), [text]);
  async function save() {
    setBusy(true);
    try {
      const r = await api.schoolRosterSave(rows);
      toast(
        r.unknown_classes?.length
          ? { title: `Saved ${r.saved} learners`, body: `These classes weren’t found (or aren’t yours to fill): ${r.unknown_classes.join(', ')}. Make them first, or check the names.`, tone: 'bad', ms: 9000 }
          : `Saved ${r.saved} learner${r.saved === 1 ? '' : 's'}`,
      );
      changed();
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save the list', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="Add a spreadsheet" onClose={onClose} wide>
      <div className="stack">
        <div className="small">
          Copy the columns from your spreadsheet and paste them here, or choose a .csv file. Columns: <b>email</b>, then name, year and classes (several classes: separate them with a semicolon). Class names must match your classes in StudyBridge.
        </div>
        <textarea
          className="textarea"
          style={{ minHeight: 160, fontFamily: 'monospace', fontSize: 13 }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Paste from your spreadsheet"
          placeholder={'Email\tName\tYear\tClasses\nchipo@school.ac.zm\tChipo Banda\tYear 10\tYear 10 maths; Year 10 science'}
        />
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn sm" onClick={() => file.current?.click()}>
            <Icon name="file" size={15} /> Choose a .csv file
          </button>
          <input ref={file} type="file" accept=".csv,.txt,text/csv,text/plain" hidden onChange={async (e) => (e.target.files?.[0] ? setText(await e.target.files[0].text()) : null, (e.target.value = ''))} />
          <span className="small muted">{rows.length ? `${rows.length} learner${rows.length === 1 ? '' : 's'} found` : 'No emails found yet'}</span>
        </div>
        {rows.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Email</th>
                  <th>Name</th>
                  <th>Year</th>
                  <th>Classes</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 8).map((r, i) => (
                  <tr key={i}>
                    <td className="small">{r.email}</td>
                    <td>{r.name || '—'}</td>
                    <td className="small">{r.grade ? gradeLabel(r.grade) : '—'}</td>
                    <td className="small">{r.classes.join(', ') || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length > 8 && <div className="small muted">…and {rows.length - 8} more</div>}
          </div>
        )}
        <div className="row end" style={{ gap: 8 }}>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !rows.length} onClick={save}>
            {busy ? 'Saving…' : `Save ${rows.length || ''} learner${rows.length === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// The slips on a page of their own (a hidden frame), so only they print
function printSlips(made) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const f = document.createElement('iframe');
  Object.assign(f.style, { position: 'fixed', right: '0', bottom: '0', width: '0', height: '0', border: '0' });
  document.body.appendChild(f);
  const d = f.contentDocument;
  d.open();
  d.write(`<!doctype html><html><head><meta charset="utf-8"><title>StudyBridge starting passwords</title><style>
body{font-family:Arial,sans-serif;margin:16px;color:#1C1F23}.slip{display:inline-block;vertical-align:top;width:45%;margin:0 2% 12px 0;padding:12px 14px;border:1px dashed #888;border-radius:8px;break-inside:avoid}
.slip div{margin:2px 0}.p{font-size:18px;letter-spacing:.06em}.m{color:#666;font-size:12px}</style></head><body>${made
    .map(
      (m) =>
        `<div class="slip"><div><b>${esc(m.name || m.email)}</b></div><div>Sign in at gostudybridge.com/app</div><div>Email: ${esc(m.email)}</div><div>Starting password: <b class="p">${esc(m.password)}</b></div><div class="m">You choose your own password the first time you sign in.</div></div>`,
    )
    .join('')}</body></html>`);
  d.close();
  f.contentWindow.focus();
  f.contentWindow.print();
  setTimeout(() => f.remove(), 60000);
}

// Starting passwords, shown once: print them as slips, or copy them
function Slips({ r, onClose }) {
  const toast = useToast();
  const text = r.made.map((m) => `${m.name || m.email}\nSign in at gostudybridge.com/app with ${m.email}\nStarting password: ${m.password}`).join('\n\n');
  return (
    <Modal title={`${r.made.length} account${r.made.length === 1 ? '' : 's'} made`} onClose={onClose} wide>
      <div className="stack">
        <div className="note small">Print or copy these now: the starting passwords aren’t shown again. Each learner chooses their own password the first time they sign in.</div>
        <div className="slips">
          {r.made.map((m) => (
            <div key={m.email} className="slip">
              <div className="strong">{m.name || m.email}</div>
              <div className="small">Sign in at gostudybridge.com/app</div>
              <div className="small">
                Email: <b>{m.email}</b>
              </div>
              <div className="small">
                Starting password: <b className="code-show">{m.password}</b>
              </div>
            </div>
          ))}
        </div>
        {r.skipped?.length > 0 && <div className="small muted">Not made: {r.skipped.map((s) => `${s.email} (${s.why})`).join(', ')}</div>}
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn primary" onClick={() => printSlips(r.made)} disabled={!r.made.length}>
            Print the slips
          </button>
          <button className="btn" onClick={() => (copyText(text), toast('Copied'))}>
            <Icon name="copy" size={15} /> Copy all
          </button>
        </div>
      </div>
    </Modal>
  );
}
