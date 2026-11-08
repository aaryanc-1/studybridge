// Links, Google Drive and OneDrive on work, lesson notes and class posts (step 6, 7 Nov 2026).
// Teachers add files from their own Drive (signing in with their own Google or Microsoft account, in this browser) or
// paste any link. On work, a Drive file can be "Learners can view" (anyone with the link) or "A copy for each learner"
// (made from the teacher's browser in the Share dialog, each shared with that learner alone).
import { useEffect, useMemo, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Empty, Field, Modal, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import * as drive from '../../lib/drive.js';
import { linkIcon, linkTitle, providerOf, safeUrl } from '../../lib/links.js';
import { LinkList } from './Kinds.jsx';

export const usePublicSettings = () => useQuery('public-settings', api.publicSettings).data || {};
const SHARE = { view: 'Learners can view', copy: 'A copy for each learner' };

// The links on something a teacher is writing. allowCopy: work (where each learner can get a copy).
export function LinksEditor({ links = [], onChange, allowCopy = false, dirty = false }) {
  const toast = useToast();
  const settings = usePublicSettings();
  const [paste, setPaste] = useState(false);
  const [ms, setMs] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => drive.preload(settings), [settings]);
  const google = drive.driveOn(settings, 'google');
  const microsoft = drive.driveOn(settings, 'microsoft');

  async function addPicked(picked) {
    if (!picked.length) return;
    const fresh = picked.filter((p) => !links.some((l) => l.provider === p.provider && l.id === p.id));
    if (links.length + fresh.length > 10) return toast({ title: 'Up to 10 links', tone: 'bad' });
    // straight away: "Learners can view" means anyone with the link can view it
    const out = [];
    for (const p of fresh) {
      try {
        const url = await drive.shareByLink(settings, p);
        out.push({ ...p, url, share: 'view' });
      } catch (e) {
        if (!allowCopy) throw e;
        toast({ title: `“${p.title}” is set to a copy for each learner`, body: e.message, ms: 9000 });
        out.push({ ...p, share: 'copy' });
      }
    }
    onChange([...links, ...out]);
  }
  async function fromGoogle() {
    if (!drive.pickHere()) return desktopNote();
    setBusy(true);
    try {
      await addPicked(await drive.pickGoogle(settings));
    } catch (e) {
      toast({ title: 'Couldn’t add from Google Drive', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  function desktopNote() {
    if (dirty) return toast({ title: 'Save first', body: 'Save your changes, then add from Google Drive or OneDrive in your browser.' });
    toast({ title: 'Opening StudyBridge in your browser', body: 'Google and Microsoft only let you sign in there. Add the file, save, and it’s here too.', ms: 8000 });
    drive.openWebApp(location.hash);
  }
  async function setShare(i, share) {
    const l = links[i];
    if (share === 'view') {
      setBusy(true);
      try {
        const url = await drive.shareByLink(settings, l);
        onChange(links.map((x, j) => (j === i ? { ...x, url, share } : x)));
      } catch (e) {
        toast({ title: 'Couldn’t share it by link', body: e.message, tone: 'bad', ms: 9000 });
      } finally {
        setBusy(false);
      }
    } else onChange(links.map((x, j) => (j === i ? { ...x, share } : x)));
  }

  return (
    <div className="stack sm">
      {links.map((l, i) => (
        <div key={l.url + i} className="link-row">
          <Icon name={linkIcon(l)} size={16} />
          <a href={l.url} target="_blank" rel="noreferrer noopener" className="grow ellipsis">
            {l.title || linkTitle(l.url)}
          </a>
          {allowCopy && l.provider && l.id ? (
            <select className="select sm" value={l.share === 'copy' ? 'copy' : 'view'} disabled={busy || !drive.pickHere()} onChange={(e) => setShare(i, e.target.value)} aria-label={`Who gets ${l.title}`}>
              {Object.entries(SHARE).map(([v, t]) => (
                <option key={v} value={v}>
                  {t}
                </option>
              ))}
            </select>
          ) : l.provider ? (
            <span className="tiny muted">{SHARE.view}</span>
          ) : null}
          <button type="button" className="btn sm ghost icon" onClick={() => onChange(links.filter((_, j) => j !== i))} aria-label={`Remove ${l.title || 'link'}`}>
            <Icon name="x" size={14} />
          </button>
        </div>
      ))}
      <div className="row wrap">
        {google && (
          <button type="button" className="btn sm" onClick={fromGoogle} disabled={busy || links.length >= 10}>
            <Icon name="file" size={16} /> Add from Google Drive
          </button>
        )}
        {microsoft && (
          <button type="button" className="btn sm" onClick={() => (drive.pickHere() ? setMs(true) : desktopNote())} disabled={busy || links.length >= 10}>
            <Icon name="file" size={16} /> Add from OneDrive
          </button>
        )}
        <button type="button" className="btn sm" onClick={() => setPaste(true)} disabled={links.length >= 10}>
          <Icon name="link" size={16} /> Add a link
        </button>
        {busy && <span className="save-state">Working…</span>}
      </div>
      {(google || microsoft) && !drive.pickHere() && <div className="tiny muted">Adding from Google Drive or OneDrive opens StudyBridge in your browser (they only let you sign in there).</div>}
      {paste && (
        <PasteLink
          onClose={() => setPaste(false)}
          onAdd={(l) => {
            onChange([...links, l]);
            setPaste(false);
          }}
        />
      )}
      {ms && (
        <MsPicker
          settings={settings}
          onClose={() => setMs(false)}
          onPick={async (picked) => {
            setMs(false);
            setBusy(true);
            try {
              await addPicked(picked);
            } catch (e) {
              toast({ title: 'Couldn’t add from OneDrive', body: e.message, tone: 'bad' });
            } finally {
              setBusy(false);
            }
          }}
        />
      )}
    </div>
  );
}

function PasteLink({ onClose, onAdd }) {
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [err, setErr] = useState('');
  function add(e) {
    e.preventDefault();
    const u = safeUrl(url);
    if (!u || !u.startsWith('https://')) return setErr('Paste a link that starts with https://');
    onAdd({ url: u, title: title.trim() || linkTitle(u) });
  }
  return (
    <Modal title="Add a link" onClose={onClose}>
      <form className="stack" onSubmit={add}>
        <Field label="Link">
          <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" autoFocus />
        </Field>
        <Field label="What to call it (optional)">
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={safeUrl(url) ? linkTitle(safeUrl(url)) : 'e.g. Reading for Monday'} />
        </Field>
        {providerOf(safeUrl(url) || '') && <div className="tiny muted">Make sure it’s shared so learners can open it (in Google Drive or OneDrive: Share → Anyone with the link).</div>}
        {err && <div className="error">{err}</div>}
        <div className="foot row end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary">Add link</button>
        </div>
      </form>
    </Modal>
  );
}

// A small OneDrive file browser (folders, search, tick files)
export function MsPicker({ settings, onClose, onPick }) {
  const [path, setPath] = useState([]); // [{ id, name }]
  const [items, setItems] = useState(null);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState([]);
  const [err, setErr] = useState('');
  const folder = path[path.length - 1];
  async function load(fn) {
    setItems(null);
    setErr('');
    try {
      setItems(await fn());
    } catch (e) {
      setErr(e.message);
      setItems([]);
    }
  }
  useEffect(() => {
    load(() => drive.msList(settings, folder?.id || null));
  }, [folder?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const on = (it) => picked.some((p) => p.id === it.id);
  return (
    <Modal
      title="Choose from OneDrive"
      wide
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={!picked.length} onClick={() => onPick(picked.map(drive.msLink))}>
            Add {picked.length || ''} file{picked.length === 1 ? '' : 's'}
          </button>
        </>
      }
    >
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim()) load(() => drive.msSearch(settings, q.trim()));
        }}
      >
        <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search your OneDrive" aria-label="Search your OneDrive" />
        <button className="btn sm">
          <Icon name="search" size={16} /> Search
        </button>
      </form>
      <div className="row wrap small">
        <button type="button" className="linkbtn" onClick={() => setPath([])}>
          My files
        </button>
        {path.map((p, i) => (
          <span key={p.id} className="row" style={{ gap: 4 }}>
            <Icon name="right" size={12} />
            <button type="button" className="linkbtn" onClick={() => setPath(path.slice(0, i + 1))}>
              {p.name}
            </button>
          </span>
        ))}
      </div>
      {err && <div className="error">{err}</div>}
      {items === null ? (
        <div className="spinner" />
      ) : items.length === 0 ? (
        <Empty>Nothing here.</Empty>
      ) : (
        <div className="list ms-list">
          {items.map((it) =>
            it.folder ? (
              <button key={it.id} type="button" className="item click" onClick={() => setPath([...path, { id: it.id, name: it.name }])}>
                <Icon name="folder" size={16} /> <span className="grow">{it.name}</span> <Icon name="right" size={14} />
              </button>
            ) : (
              <label key={it.id} className="item check">
                <input type="checkbox" checked={on(it)} onChange={() => setPicked(on(it) ? picked.filter((p) => p.id !== it.id) : [...picked, it])} />
                <Icon name="file" size={16} /> <span className="grow">{it.name}</span>
              </label>
            ),
          )}
        </div>
      )}
    </Modal>
  );
}

// Make each learner's copy (and take access away from anyone who left). Opens from the editor of posted work.
export function ShareCopies({ assignment, onClose }) {
  const toast = useToast();
  const settings = usePublicSettings();
  const people = useQuery(`drive-people:${assignment.id}`, () => api.drivePeople(assignment.id));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(0);
  const [errors, setErrors] = useState({}); // learner id -> problem
  const p = people.data;
  const copyLinks = (p?.links || assignment.links || []).filter((l) => l.share === 'copy' && l.provider && l.id);
  const todo = useMemo(
    () => (p?.learners || []).flatMap((l) => copyLinks.filter((k) => !l.copies.some((c) => c.key === k.id)).map((k) => ({ l, k }))),
    [p, copyLinks],
  );
  const noEmail = todo.filter((x) => !x.l.email);
  const ready = todo.filter((x) => x.l.email);

  async function signedIn(provider) {
    const who = await drive.signIn(settings, provider);
    const domains = p?.domains || [];
    const domain = who.split('@')[1]?.toLowerCase();
    if (domains.length && !domains.includes(domain)) {
      drive.forgetSignIn(provider); // the next try asks which account
      throw new Error(`Sign in with your school account (an email ending @${domains[0]}), so learners’ copies stay with the school. Press the button again to choose it.`);
    }
  }
  async function make() {
    setBusy(true);
    setErrors({});
    setDone(0);
    const errs = {};
    try {
      for (const prov of [...new Set(ready.map((x) => x.k.provider))]) await signedIn(prov);
      for (const { l, k } of ready) {
        try {
          const c = await drive.copyFor(settings, k, `${k.title} – ${l.name}`, l.email);
          await api.driveCopiesSave(assignment.id, [{ learner: l.id, key: k.id, provider: k.provider, ...c }]);
          setDone((n) => n + 1);
        } catch (e) {
          errs[l.id] = e.message;
        }
      }
      for (const g of p?.gone || []) {
        try {
          await drive.removeAccess(settings, g);
          await api.driveCopySet([g.id], 'gone');
        } catch (e) {
          errs[g.id] = e.message;
        }
      }
    } catch (e) {
      toast({ title: 'Couldn’t sign in', body: e.message, tone: 'bad', ms: 9000 });
    } finally {
      setErrors(errs);
      setBusy(false);
      invalidate(`drive-people:${assignment.id}`);
    }
  }
  if (!drive.pickHere())
    return (
      <Modal title="Copies for each learner" onClose={onClose}>
        <div className="small">Copies are made with your Google or Microsoft sign-in, which only works in your browser.</div>
        <div className="foot row end">
          <button className="btn primary" onClick={() => drive.openWebApp(`/assignments/${assignment.id}`)}>
            Open StudyBridge in my browser
          </button>
        </div>
      </Modal>
    );
  return (
    <Modal title="Copies for each learner" wide onClose={busy ? () => {} : onClose}>
      {!p ? (
        <div className="spinner" />
      ) : (
        <div className="stack">
          <div className="small muted">Each copy is yours (in your {copyLinks.map((k) => drive.PROVIDERS[k.provider]).filter((v, i, x) => x.indexOf(v) === i).join(' and ')}), shared with that learner alone to change. Nobody sees anyone else’s.</div>
          <div className="list small">
            {(p.learners || []).map((l) => {
              const have = l.copies.length;
              return (
                <div key={l.id} className="item">
                  <span className="grow strong">{l.name}</span>
                  {errors[l.id] ? (
                    <span className="pill bad" title={errors[l.id]}>
                      Couldn’t: {errors[l.id]}
                    </span>
                  ) : have >= copyLinks.length ? (
                    <span className="pill good">
                      <Icon name="check" size={12} /> Has {have === 1 ? 'a copy' : 'copies'}
                    </span>
                  ) : !l.email ? (
                    <span className="pill warn">No Google or Microsoft email yet: they can add one in Settings</span>
                  ) : (
                    <span className="pill">To make</span>
                  )}
                </div>
              );
            })}
            {(p.gone || []).map((g) => (
              <div key={g.id} className="item">
                <span className="grow">{g.name}</span>
                {errors[g.id] ? <span className="pill bad">{errors[g.id]}</span> : <span className="pill warn">Left: their access is taken away</span>}
              </div>
            ))}
          </div>
          {busy && (
            <div className="save-state" role="status">
              Making copies… {done} of {ready.length}
            </div>
          )}
          {noEmail.length > 0 && <div className="tiny muted">Learners who sign in without a Google or Microsoft account can add one in Settings → Your Google or Microsoft email. Then come back here.</div>}
          <div className="foot row end">
            <button className="btn" onClick={onClose} disabled={busy}>
              Close
            </button>
            <button className="btn primary" onClick={make} disabled={busy || (!ready.length && !(p.gone || []).length)}>
              <Icon name="copy" size={16} /> {ready.length ? `Make ${ready.length} cop${ready.length === 1 ? 'y' : 'ies'}` : 'Take their access away'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// The card on a piece of work's editor: how many learners have their copy
export function CopiesCard({ assignment }) {
  const [open, setOpen] = useState(false);
  const copyLinks = (assignment.links || []).filter((l) => l.share === 'copy' && l.provider);
  const posted = !assignment.draft && assignment.visibility !== 'hidden';
  const people = useQuery(posted && copyLinks.length ? `drive-people:${assignment.id}` : null, () => api.drivePeople(assignment.id));
  if (!copyLinks.length) return null;
  const p = people.data;
  const total = (p?.learners || []).length * copyLinks.length;
  const made = (p?.learners || []).reduce((s, l) => s + l.copies.length, 0);
  return (
    <div className="card">
      <h3>Copies for each learner</h3>
      {!posted ? (
        <div className="small muted">Post it, then make each learner’s copy here.</div>
      ) : (
        <>
          <div className="small">{p ? `${made} of ${total} made${(p.gone || []).length ? ` · ${p.gone.length} who left still have access` : ''}` : 'Checking…'}</div>
          <button className="btn sm primary" onClick={() => setOpen(true)}>
            <Icon name="copy" size={16} /> Share with learners
          </button>
        </>
      )}
      {open && <ShareCopies assignment={assignment} onClose={() => setOpen(false)} />}
    </div>
  );
}

// A learner's own copies on a piece of work ("Your copy"), or a note that it's on its way, with "Ask for my copy"
export function MyCopies({ assignment }) {
  const toast = useToast();
  const hasCopy = (assignment.links || []).some((l) => l.share === 'copy');
  const mine = useQuery(hasCopy ? `my-copies:${assignment.id}` : null, () => api.myDriveCopies(assignment.id)).data || [];
  if (!hasCopy) return null;
  return (
    <div className="stack sm">
      {mine.map((c) =>
        c.url ? (
          <a key={c.key} className="btn sm link-chip" href={c.url} target="_blank" rel="noreferrer noopener">
            <Icon name="file" size={15} /> Your copy: {c.title}
            {c.locked && <span className="tiny muted"> · handed in</span>}
          </a>
        ) : (
          <div key={c.key} className="row wrap small">
            <span className="muted">Your copy of “{c.title}” isn’t ready yet.</span>
            <button
              type="button"
              className="btn sm"
              onClick={async () => {
                try {
                  await api.driveCopyAsk(assignment.id);
                  toast('Your teacher has been told.');
                } catch (e) {
                  toast({ title: 'Couldn’t ask', body: e.message, tone: 'bad' });
                }
              }}
            >
              Ask for my copy
            </button>
          </div>
        ),
      )}
    </div>
  );
}

// Links learners see (never the original of a "copy for each learner" file: they get their own)
export const learnerLinks = (links) => (links || []).filter((l) => l.share !== 'copy');
export function LearnerLinks({ links }) {
  return <LinkList links={learnerLinks(links)} />;
}

// Marking: this learner's copy, with "Stop them editing" / "Let them edit again"
export function TheirCopy({ assignment, learnerId }) {
  const toast = useToast();
  const settings = usePublicSettings();
  const copyLinks = (assignment.links || []).filter((l) => l.share === 'copy');
  const people = useQuery(copyLinks.length ? `drive-people:${assignment.id}` : null, () => api.drivePeople(assignment.id));
  const [busy, setBusy] = useState(false);
  if (!copyLinks.length) return null;
  const copies = (people.data?.learners || []).find((l) => l.id === learnerId)?.copies || [];
  async function lock(c, locked) {
    if (!drive.pickHere()) return drive.openWebApp(location.hash);
    setBusy(true);
    try {
      await drive.lockCopy(settings, c, locked);
      await api.driveCopySet([c.id], locked ? 'locked' : 'unlocked');
      invalidate(`drive-people:${assignment.id}`);
      toast(locked ? 'They can comment on it now, not change it.' : 'They can change it again.');
    } catch (e) {
      toast({ title: 'Couldn’t change it', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card">
      <h3>Their copy</h3>
      {!copies.length && <div className="small muted">No copy made for them yet.</div>}
      {copies.map((c) => (
        <div key={c.id} className="stack sm">
          <a className="btn sm link-chip" href={c.url} target="_blank" rel="noreferrer noopener">
            <Icon name="file" size={15} /> {c.name || 'Open their copy'}
          </a>
          <div className="row wrap">
            <button className="btn sm" disabled={busy} onClick={() => lock(c, !c.locked)}>
              <Icon name={c.locked ? 'refresh' : 'lock'} size={14} /> {c.locked ? 'Let them edit again' : 'Stop them editing'}
            </button>
          </div>
          <div className="tiny muted">The file’s version history shows anything changed after they handed in.</div>
        </div>
      ))}
    </div>
  );
}

// Marking, for a whole piece of work: stop everyone who handed in from changing their copy
export function LockAllCopies({ assignment, handedIn }) {
  const toast = useToast();
  const settings = usePublicSettings();
  const copyLinks = (assignment?.links || []).filter((l) => l.share === 'copy');
  const people = useQuery(copyLinks.length ? `drive-people:${assignment.id}` : null, () => api.drivePeople(assignment.id));
  const [busy, setBusy] = useState(false);
  if (!copyLinks.length) return null;
  const open = (people.data?.learners || []).filter((l) => handedIn.includes(l.id)).flatMap((l) => l.copies.filter((c) => !c.locked));
  if (!open.length) return null;
  async function go() {
    if (!drive.pickHere()) return drive.openWebApp(location.hash);
    setBusy(true);
    let n = 0;
    try {
      for (const c of open) {
        await drive.lockCopy(settings, c, true);
        await api.driveCopySet([c.id], 'locked');
        n++;
      }
      toast(`Done: ${n} cop${n === 1 ? 'y' : 'ies'} can only be commented on now.`);
    } catch (e) {
      toast({ title: `Stopped after ${n}`, body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
      invalidate(`drive-people:${assignment.id}`);
    }
  }
  return (
    <button className="btn sm" onClick={go} disabled={busy}>
      <Icon name="lock" size={14} /> Stop {open.length} handed-in cop{open.length === 1 ? 'y' : 'ies'} changing
    </button>
  );
}

// Settings for a learner: the Google or Microsoft email their teachers share copies with
export function DriveEmailCard() {
  const toast = useToast();
  const cur = useQuery('drive-email', api.myDriveEmail);
  const [v, setV] = useState(null);
  const value = v ?? cur.data ?? '';
  async function save(e) {
    e.preventDefault();
    try {
      await api.setDriveEmail(value.trim());
      invalidate('drive-email');
      setV(null);
      toast(value.trim() ? 'Saved. Your teachers share your copies with it.' : 'Removed.');
    } catch (x) {
      toast({ title: 'Couldn’t save it', body: x.message, tone: 'bad' });
    }
  }
  return (
    <form className="stack sm" onSubmit={save}>
      <div className="small muted">If you use Google Drive or OneDrive with a different email from the one you sign in with, add it here. Your teachers’ files are shared with it. Nobody else sees it.</div>
      <div className="row">
        <input className="input" type="email" value={value} onChange={(e) => setV(e.target.value)} placeholder="you@gmail.com" aria-label="Your Google or Microsoft email" />
        <button className="btn sm" disabled={v === null}>
          Save
        </button>
      </div>
    </form>
  );
}
