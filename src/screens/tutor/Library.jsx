import { useEffect, useRef, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { AudiencePicker, Empty, Field, Link, Markdown, Modal, Page, Seg, VisibilityPicker, VisibilityPill, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { bytes, ago } from '../../lib/format.js';
import { useLookups, SubjectTag } from '../shared/lookups.jsx';
import PastPapers, { OpenBooks } from './PastPapers.jsx';
import QuestionBank from './QuestionBank.jsx';
import Syllabus from './Syllabus.jsx';
import Flashcards from './Flashcards.jsx';

export default function Library({ tab = 'files' }) {
  return (
    <Page
      title="Library"
      subtitle="Textbooks, past papers, worksheets and lesson notes. Everything starts hidden; you choose when learners see it."
      actions={
        tab === 'lessons' ? (
          <button className="btn primary" onClick={() => go('/lesson/new')}>
            <Icon name="plus" size={18} /> New lesson notes
          </button>
        ) : null
      }
    >
      <Seg
        value={tab}
        onChange={(t) => go(`/library/${t}`, { replace: true })}
        options={[
          { value: 'files', label: 'My files', icon: 'file' },
          { value: 'syllabus', label: 'Syllabus', icon: 'target' },
          { value: 'papers', label: 'Past papers', icon: 'clipboard' },
          { value: 'bank', label: 'Question bank', icon: 'layers' },
          { value: 'cards', label: 'Flashcards', icon: 'flame' },
          { value: 'textbooks', label: 'Free textbooks', icon: 'book' },
          { value: 'lessons', label: 'Lesson notes', icon: 'pen' },
        ]}
      />
      {tab === 'lessons' ? <Lessons /> : tab === 'syllabus' ? <Syllabus /> : tab === 'cards' ? <Flashcards /> : tab === 'papers' ? <PastPapers /> : tab === 'bank' ? <QuestionBank /> : tab === 'textbooks' ? <OpenBooks /> : <Files />}
    </Page>
  );
}

function Files() {
  const lk = useLookups();
  const toast = useToast();
  const files = useQuery('files', api.listFiles);
  const [over, setOver] = useState(false);
  const [uploading, setUploading] = useState([]);
  const [edit, setEdit] = useState(null);
  const [subject, setSubject] = useState('');
  const input = useRef(null);
  const papers = (files.data || []).filter((f) => f.exam_board).length;
  const list = (files.data || []).filter((f) => !f.exam_board && (!subject || f.subject_id === subject));

  async function upload(fileList) {
    const arr = [...fileList];
    if (!arr.length) return;
    setUploading(arr.map((f) => f.name));
    let last = null;
    for (const f of arr) {
      try {
        last = await api.uploadFile(f, { subject_id: subject || null });
      } catch (e) {
        toast({ title: `Couldn’t upload ${f.name}`, body: e.message, tone: 'bad' });
      }
      setUploading((u) => u.filter((n) => n !== f.name));
    }
    invalidate('files');
    if (arr.length === 1 && last) setEdit(last);
    else toast({ title: `Uploaded ${arr.length} files`, body: 'They’re hidden until you make them visible.' });
  }

  return (
    <>
      <div className="small muted">Your own books, worksheets and handouts. Prof reads books from here when you ask it to use pages or a whole book.</div>
      <div
        className={'dropzone' + (over ? ' over' : '')}
        onClick={() => input.current.click()}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          upload(e.dataTransfer.files);
        }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && input.current.click()}
      >
        <Icon name="upload" size={28} />
        <div className="strong">Drop PDFs, images or any files here, or click to choose</div>
        <div className="small muted">Up to 200 MB each. New uploads are hidden from learners.</div>
        <input ref={input} type="file" multiple hidden onChange={(e) => (upload(e.target.files), (e.target.value = ''))} />
      </div>
      {uploading.length > 0 && (
        <div className="note row">
          <div className="spinner" /> Uploading {uploading.join(', ')}…
        </div>
      )}
      <div className="row wrap">
        <span className="small muted">Subject</span>
        <select className="select" style={{ width: 'auto', minHeight: 36 }} value={subject} onChange={(e) => setSubject(e.target.value)}>
          <option value="">All</option>
          {lk.subjects.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </div>
      {papers > 0 && (
        <div className="note small">
          {papers} past paper{papers === 1 ? ' is' : 's are'} filed under <a href="#/library/papers">Past papers</a>.
        </div>
      )}
      {list.length === 0 ? (
        files.data && <Empty>Nothing in My files yet.</Empty>
      ) : (
        <div className="card pad0">
          <table className="table responsive">
            <thead>
              <tr>
                <th>Name</th>
                <th>Subject</th>
                <th>Who sees it</th>
                <th>Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((f) => (
                <tr key={f.id} className="click" onClick={() => go(`/file/${f.id}`)}>
                  <td data-label="Name">
                    <div className="row">
                      <Icon name={/pdf/.test(f.mime || '') ? 'pdf' : /image/.test(f.mime || '') ? 'image' : 'file'} style={{ color: 'var(--accent)' }} />
                      <div className="grow">
                        <div className="strong ellipsis">{f.name}</div>
                        <div className="tiny muted">Added {ago(f.created_at)}{f.topic_id ? ` · ${lk.topic(f.topic_id)?.name}` : ''}</div>
                      </div>
                    </div>
                  </td>
                  <td data-label="Subject">{f.subject_id ? <SubjectTag id={f.subject_id} /> : <span className="muted">—</span>}</td>
                  <td data-label="Who sees it">
                    <div className="row wrap" style={{ gap: 6 }}>
                      <VisibilityPill item={f} />
                      {f.visibility !== 'hidden' && <span className="tiny muted">{f.learner_ids?.length ? lk.audience(f).map((l) => l.display_name).join(', ') : 'Everyone in the subject'}</span>}
                    </div>
                  </td>
                  <td data-label="Size" className="muted">{bytes(f.size)}</td>
                  <td>
                    <button
                      className="btn sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEdit(f);
                      }}
                    >
                      Settings
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <FileSettings file={edit} onClose={() => setEdit(null)} />}
    </>
  );
}

export function FileSettings({ file, onClose }) {
  const lk = useLookups();
  const confirm = useConfirm();
  const [f, setF] = useState(file);
  const [err, setErr] = useState('');
  const set = (patch) => setF((x) => ({ ...x, ...patch }));
  async function saveIt() {
    try {
      if (f.cloud === false && f.visibility !== 'hidden') await api.ensureCloud(file);
      await api.save('files', {
        id: f.id,
        name: f.name,
        description: f.description || null,
        subject_id: f.subject_id || null,
        topic_id: f.topic_id || null,
        visibility: f.visibility,
        visible_from: f.visibility === 'scheduled' ? f.visible_from : null,
        learner_ids: f.learner_ids?.length ? f.learner_ids : null,
      });
      invalidate('files');
      onClose();
    } catch (e) {
      setErr(e.message);
    }
  }
  return (
    <Modal
      title="File settings"
      onClose={onClose}
      foot={
        <>
          <button
            className="btn danger"
            style={{ marginRight: 'auto' }}
            onClick={async () => {
              if (!(await confirm({ title: `Delete ${f.name}?`, body: 'It’s removed for everyone.', ok: 'Delete', danger: true }))) return;
              await api.deleteFile(f);
              invalidate('files');
              onClose();
            }}
          >
            Delete
          </button>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={saveIt}>
            Save
          </button>
        </>
      }
    >
      <Field label="Name">
        <input className="input" value={f.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <div className="grid g2">
        <Field label="Subject">
          <select className="select" value={f.subject_id || ''} onChange={(e) => set({ subject_id: e.target.value || null, topic_id: null })}>
            <option value="">None</option>
            {lk.subjects.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Topic">
          <select className="select" value={f.topic_id || ''} onChange={(e) => set({ topic_id: e.target.value || null })} disabled={!f.subject_id}>
            <option value="">None</option>
            {lk.topicsOf(f.subject_id).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field label="Note for learners (optional)">
        <input className="input" value={f.description || ''} onChange={(e) => set({ description: e.target.value })} placeholder="e.g. Read chapter 3 before Thursday" />
      </Field>
      <Field label="Visibility">
        <VisibilityPicker value={f.visibility} from={f.visible_from} onChange={(v, from) => set({ visibility: v, visible_from: from })} />
      </Field>
      <Field label="Who">
        <AudiencePicker learners={f.subject_id ? lk.learners : lk.learners} value={f.learner_ids} onChange={(ids) => set({ learner_ids: ids })} />
      </Field>
      {!f.subject_id && !(f.learner_ids || []).length && f.visibility !== 'hidden' && <div className="note small">No subject chosen, so all your learners will see it.</div>}
      {err && <div className="error">{err}</div>}
    </Modal>
  );
}

function Lessons() {
  const lessons = useQuery('lessons', api.listLessons);
  const lk = useLookups();
  const list = lessons.data || [];
  if (lessons.data && list.length === 0)
    return (
      <Empty
        title="No lesson notes yet"
        action={
          <button className="btn primary" onClick={() => go('/lesson/new')}>
            <Icon name="plus" size={18} /> New lesson notes
          </button>
        }
      >
        Write notes with worked examples and maths, attach pages from your library, and release them when you’re ready.
      </Empty>
    );
  return (
    <div className="card">
      <div className="list">
        {list.map((l) => (
          <Link key={l.id} to={`/lesson/${l.id}`} className="item">
            <Icon name="book" style={{ color: 'var(--accent)' }} />
            <span className="grow">
              <span className="name">{l.title}</span>
              <span className="meta">
                {l.subject_id && <SubjectTag id={l.subject_id} />}
                {l.topic_id && <span>{lk.topic(l.topic_id)?.name}</span>}
                <span>Updated {ago(l.updated_at)}</span>
              </span>
            </span>
            <VisibilityPill item={l} />
          </Link>
        ))}
      </div>
    </div>
  );
}

export function LessonEditor({ id }) {
  const lk = useLookups();
  const toast = useToast();
  const confirm = useConfirm();
  const lessons = useQuery('lessons', api.listLessons);
  const files = useQuery('files', api.listFiles).data || [];
  const isNew = id === 'new';
  const [l, setL] = useState(isNew ? { title: '', body_md: '', visibility: 'hidden', file_ids: [], learner_ids: [] } : null);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const imgInput = useRef(null);
  const ta = useRef(null);

  useEffect(() => {
    if (!isNew && lessons.data && !l) setL(lessons.data.find((x) => x.id === id) || null);
  }, [lessons.data, id, isNew, l]);
  if (!l) return <Page title="Lesson notes">{lessons.data ? <Empty>These lesson notes no longer exist.</Empty> : null}</Page>;
  const set = (patch) => setL((x) => ({ ...x, ...patch }));

  async function saveIt({ post = false } = {}) {
    if (!l.title.trim()) return toast({ title: 'Give the lesson a title', tone: 'bad' });
    setBusy(true);
    try {
      const visibility = post && l.visibility === 'hidden' ? 'visible' : l.visibility;
      const row = {
        ...(l.id ? { id: l.id } : {}),
        title: l.title.trim(),
        body_md: l.body_md,
        subject_id: l.subject_id || null,
        topic_id: l.topic_id || null,
        file_ids: l.file_ids || [],
        visibility,
        visible_from: visibility === 'scheduled' ? l.visible_from : null,
        learner_ids: l.learner_ids?.length ? l.learner_ids : null,
        draft: post ? false : !!l.draft,
        updated_at: new Date().toISOString(),
      };
      if (visibility !== 'hidden') await api.ensureCloudIds(row.file_ids, files);
      const saved = await api.save('lessons', row);
      invalidate('lessons');
      if (post) {
        const who = lk.audience(saved).map((x) => x.display_name);
        toast({ title: saved.visibility === 'scheduled' ? `Scheduled: ${saved.title}` : `Posted: ${saved.title}`, body: who.length ? `For ${who.join(', ')}.` : 'No learners take this subject yet.' });
        go('/library/lessons');
        return;
      }
      toast('Lesson saved');
      if (isNew) go(`/lesson/${saved.id}`, { replace: true });
      setL(saved);
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  async function addImage(file) {
    try {
      const path = await api.uploadImage(file, 'lessons');
      const snippet = `\n![${file.name}](sb://library/${path})\n`;
      const el = ta.current;
      const pos = el ? el.selectionStart : l.body_md.length;
      set({ body_md: l.body_md.slice(0, pos) + snippet + l.body_md.slice(pos) });
    } catch (e) {
      toast({ title: 'Couldn’t add image', body: e.message, tone: 'bad' });
    }
  }

  return (
    <Page
      eyebrow={
        <>
          <Link to="/library/lessons">Lesson notes</Link> <Icon name="right" size={14} />
        </>
      }
      title={isNew ? 'New lesson notes' : l.title || 'Lesson notes'}
      actions={
        <>
          {!isNew && (
            <button
              className="btn danger"
              onClick={async () => {
                if (!(await confirm({ title: l.draft ? 'Discard these lesson notes?' : 'Delete these lesson notes?', body: l.draft ? 'Learners never saw them.' : undefined, ok: l.draft ? 'Discard' : 'Delete', danger: true }))) return;
                await api.remove('lessons', l.id);
                invalidate('lessons', 'drafts');
                go(l.draft ? '/prof' : '/library/lessons');
              }}
            >
              {l.draft ? 'Discard' : 'Delete'}
            </button>
          )}
          {l.visibility === 'hidden' || l.draft ? (
            <>
              <button className="btn" onClick={() => saveIt()} disabled={busy}>
                Save draft
              </button>
              <button className={'btn ' + (l.draft ? 'claude' : 'primary')} onClick={() => saveIt({ post: true })} disabled={busy}>
                <Icon name="send" size={18} /> {l.draft ? 'Approve & post' : 'Post'}
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={() => saveIt({ post: true })} disabled={busy}>
              <Icon name="check" size={18} /> {l.visibility === 'scheduled' ? 'Schedule' : 'Save changes'}
            </button>
          )}
        </>
      }
    >
      {l.draft && (
        <div className="card claude small">
          <div className="row">
            <Icon name="cap" style={{ color: 'var(--claude)' }} />
            <span>
              {l.source === 'prof' ? 'Prof' : 'Claude'} wrote these lesson notes. Learners can’t see them until you press <b>Approve & post</b>. Change anything you like first.
            </span>
          </div>
        </div>
      )}
      <div className="split side-r">
        <div className="card">
          <Field label="Title">
            <input className="input" value={l.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Solving quadratic equations" />
          </Field>
          <div className="row between">
            <Seg
              value={preview ? 'p' : 'w'}
              onChange={(v) => setPreview(v === 'p')}
              options={[
                { value: 'w', label: 'Write' },
                { value: 'p', label: 'Preview' },
              ]}
            />
            <button className="btn sm" onClick={() => imgInput.current.click()}>
              <Icon name="image" size={16} /> Add image
            </button>
            <input ref={imgInput} type="file" accept="image/*" hidden onChange={(e) => e.target.files[0] && addImage(e.target.files[0])} />
          </div>
          {preview ? (
            <LessonBody md={l.body_md} />
          ) : (
            <textarea
              ref={ta}
              className="textarea"
              style={{ minHeight: 420 }}
              value={l.body_md}
              onChange={(e) => set({ body_md: e.target.value })}
              placeholder={'Write the lesson here.\n\n## Worked example\nSolve $x^2 - 5x + 6 = 0$.\n\n$$ (x-2)(x-3) = 0 $$\n\nSo $x = 2$ or $x = 3$.'}
            />
          )}
          <div className="muted tiny">Formatting: **bold**, ## heading, - list. Maths: {'$x^2$'} in a sentence, {'$$\\frac{a}{b}$$'} on its own line.</div>
        </div>
        <div className="stack lg">
          <div className="card">
            <h3>Who sees it</h3>
            <VisibilityPicker value={l.visibility} from={l.visible_from} onChange={(v, from) => set({ visibility: v, visible_from: from })} />
            <AudiencePicker learners={lk.learners} value={l.learner_ids} onChange={(ids) => set({ learner_ids: ids })} />
          </div>
          <div className="card">
            <h3>Subject</h3>
            <select className="select" value={l.subject_id || ''} onChange={(e) => set({ subject_id: e.target.value || null, topic_id: null })}>
              <option value="">None</option>
              {lk.subjects.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select className="select" value={l.topic_id || ''} onChange={(e) => set({ topic_id: e.target.value || null })} disabled={!l.subject_id} aria-label="Topic">
              <option value="">No topic</option>
              {lk.topicsOf(l.subject_id).map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div className="card">
            <h3>Attached files</h3>
            <div className="muted tiny">Attached files are shown with the lesson. Make sure the file itself is visible too.</div>
            {files.length === 0 ? (
              <div className="muted small">Upload files in the Library first.</div>
            ) : (
              <div className="stack sm" style={{ maxHeight: 260, overflowY: 'auto' }}>
                {files.map((f) => (
                  <label key={f.id} className="check">
                    <input
                      type="checkbox"
                      checked={(l.file_ids || []).includes(f.id)}
                      onChange={(e) => set({ file_ids: e.target.checked ? [...(l.file_ids || []), f.id] : l.file_ids.filter((x) => x !== f.id) })}
                    />
                    <span className="t small">{f.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Page>
  );
}

// Lesson text, with images stored in the library shown inline
export function LessonBody({ md }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const urls = [];
    el.querySelectorAll('img[src^="sb://"]').forEach(async (img) => {
      const [, bucket, ...rest] = img.getAttribute('src').replace('sb://', '/').split('/');
      try {
        const blob = await api.getBlob(bucket, rest.join('/'));
        const u = URL.createObjectURL(blob);
        urls.push(u);
        img.src = u;
      } catch {
        img.alt = 'Image not available offline';
      }
    });
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, [md]);
  return (
    <div ref={ref}>
      <Markdown src={md || '*Nothing written yet.*'} />
    </div>
  );
}
