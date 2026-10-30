// A class's stream: a noticeboard on the class. Its teachers (and its centre's or school's managers) post to one class or
// several at once; learners reply only when a post allows it, and see each other's replies (with names) only when it says
// so. Work, lesson notes, files and live lessons set for the class show in it by themselves. The same screen for teachers,
// managers and learners; what each can do differs (the server decides).
import { useEffect, useRef, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import MathText from '../../ui/MathText.jsx';
import { Avatar, Empty, Link, Loading, Markdown, Modal, Seg, Toggle, useConfirm, useToast } from '../../ui/kit.jsx';
import { Lightbox, StoredImage } from '../../ui/media.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, bytes, day, fromLocalInput, toLocalInput, when } from '../../lib/format.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const REPLIES = [
  { value: 'off', label: 'No replies' },
  { value: 'teachers', label: 'Learners can reply. Only teachers see the replies.' },
  { value: 'class', label: 'Learners can reply and see each other’s replies, with names.' },
];
const SET = { homework: 'set homework', quiz: 'set a quiz', test: 'set a test', exam: 'set an exam' };
const MAX_FILES = 6;
const MAX_BYTES = 20 * 1024 * 1024;
const streamChanged = () => invalidate('stream', 'my-classes', 'stream-classes');
const first = (name) => String(name || '').split(' ')[0];

export default function Stream({ classId, learner = false }) {
  const q = useQuery(`stream:${classId}`, () => api.classStream(classId));
  const [writing, setWriting] = useState(false);
  const d = q.data;
  const count = d?.posts?.length || 0;
  // a learner has looked: nothing here is new any more
  useEffect(() => {
    if (learner && d) api.streamSeen(classId).then(() => invalidate('my-classes'), () => {});
  }, [learner, classId, count]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!d) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  const pinned = d.posts.filter((p) => p.pinned);
  const timeline = [
    ...d.posts.filter((p) => !p.pinned).map((p) => ({ post: p, at: p.visible_from })),
    ...d.work.map((w) => ({ work: w, at: w.at })),
  ].sort((x, y) => new Date(y.at) - new Date(x.at));
  return (
    <div className="stream">
      {d.staff && !d.class.archived && (
        <button className="card stream-start" onClick={() => setWriting(true)}>
          <Icon name="megaphone" size={20} />
          <span className="grow">Post to {d.class.name}{d.manager ? ', or to several classes at once' : ''}…</span>
          <span className="btn sm primary" aria-hidden="true">
            <Icon name="plus" size={15} /> New post
          </span>
        </button>
      )}
      {learner && d.closed && (
        <div className="note warn small" role="status">
          This class is paused for now. You can still read it, but you can’t reply.
        </div>
      )}
      {learner && d.muted && !d.closed && (
        <div className="note small" role="status">
          Your teacher has turned off your replies in this class for now. You can still read everything.
        </div>
      )}
      {pinned.map((p) => (
        <PostCard key={p.id} p={p} d={d} learner={learner} />
      ))}
      {timeline.length === 0 && pinned.length === 0 ? (
        <Empty title="Nothing here yet">
          {d.staff
            ? 'Post news for the class here. Work, lesson notes, files and live lessons you set for the class show up here by themselves.'
            : 'Posts from your teachers, and work set for the class, show up here.'}
        </Empty>
      ) : (
        timeline.map((x) => (x.post ? <PostCard key={x.post.id} p={x.post} d={d} learner={learner} /> : <WorkCard key={x.work.kind + x.work.id} w={x.work} learner={learner} />))
      )}
      {writing && <PostEditor classId={classId} className={d.class.name} onClose={() => setWriting(false)} />}
    </div>
  );
}

// Something set for the class: a short card that opens it
function WorkCard({ w, learner }) {
  let icon = 'clipboard';
  let text = `${w.by} ${SET[w.type] || 'set some work'}`;
  let to = learner ? `/work/${w.id}` : w.mine ? `/assignments/${w.id}` : null;
  let extra = w.due_at ? `due ${day(w.due_at)}` : '';
  if (w.kind === 'lesson') [icon, text, to] = ['book', `${w.by} shared lesson notes`, learner || w.mine ? `/lesson/${w.id}` : null];
  if (w.kind === 'file') [icon, text, to] = ['file', `${w.by} shared a file`, learner ? `/file/${w.id}` : w.mine ? '/library' : null];
  // a lesson in person says where (and opens the timetable, not the video page)
  const where = w.in_person ? (w.location ? ` · ${w.location}` : '') : '';
  if (w.kind === 'session') [icon, text, to, extra] = w.in_person ? ['pin', 'Lesson in person', '/timetable', when(w.starts_at) + where] : ['video', 'Live lesson', '/live', when(w.starts_at)];
  if (w.kind === 'series') {
    const [h, m] = String(w.start_time || '').split(':');
    const every = `every ${WEEKDAYS[w.weekday] || 'week'}${h ? ` at ${h}:${m}` : ''}`;
    [icon, text, to, extra] = w.in_person ? ['pin', 'Weekly lesson in person', '/timetable', every + where] : ['video', 'Weekly live lesson', '/live', every];
  }
  return (
    <div className="card stream-work">
      <span className="stream-work-icon" aria-hidden="true">
        <Icon name={icon} size={18} />
      </span>
      <span className="grow">
        <span className="small muted">{text}</span>
        <span className="name">{to ? <Link to={to}>{w.title}</Link> : w.title}</span>
        <span className="meta">
          {extra && <span>{extra}</span>}
          <span>{ago(w.at)}</span>
        </span>
      </span>
    </div>
  );
}

// One post: who, when, what, its pictures and files, and its replies
function PostCard({ p, d, learner }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const many = (p.classes || []).length > 1;
  async function pin() {
    try {
      await api.pinClassPost(p.id, !p.pinned);
      streamChanged();
    } catch (e) {
      toast({ title: 'Couldn’t change that', body: e.message, tone: 'bad' });
    }
  }
  async function remove(everywhere) {
    try {
      const left = await api.deleteClassPost(p.id, everywhere);
      if (!left && p.mine) api.removeStreamFiles((p.files || []).map((f) => f.path));
      streamChanged();
      setDeleting(false);
      toast(everywhere ? 'Post taken down from every class' : 'Post taken down');
    } catch (e) {
      toast({ title: 'Couldn’t take it down', body: e.message, tone: 'bad' });
    }
  }
  return (
    <article className={'card stream-post' + (p.pinned ? ' pinned' : '')} aria-label={`Post from ${p.author.name}`}>
      <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
        <Avatar person={{ id: p.author.id, display_name: p.author.name }} />
        <div className="grow">
          <div className="strong">{p.author.name}</div>
          <div className="meta small muted">
            <span>{p.scheduled ? `Goes up ${when(p.visible_from)}` : ago(p.visible_from)}</span>
            {p.edited_at && <span>edited</span>}
            {many && <span>posted to {p.classes.map((c) => c.name).join(', ')}</span>}
          </div>
        </div>
        <span className="row wrap" style={{ gap: 6 }}>
          {p.pinned && (
            <span className="pill">
              <Icon name="pin" size={12} /> Pinned
            </span>
          )}
          {p.scheduled && <span className="pill warn">Scheduled</span>}
        </span>
      </div>
      {p.body_md && <Markdown src={p.body_md} className="stream-body" />}
      <StreamFiles files={p.files} />
      {d.staff && (
        <div className="row wrap stream-actions">
          <button className="btn sm ghost" onClick={pin}>
            <Icon name="pin" size={14} /> {p.pinned ? 'Unpin' : 'Pin to the top'}
          </button>
          {p.mine && (
            <button className="btn sm ghost" onClick={() => setEditing(true)}>
              <Icon name="pen" size={14} /> Edit
            </button>
          )}
          <button
            className="btn sm ghost"
            aria-label="Delete this post"
            onClick={async () => {
              if (many && (p.mine || d.manager)) return setDeleting(true);
              if (await confirm({ title: 'Delete this post?', body: 'It comes down for everyone in the class, with its replies.', ok: 'Delete', danger: true })) remove(false);
            }}
          >
            <Icon name="trash" size={14} /> Delete
          </button>
        </div>
      )}
      <Replies p={p} d={d} learner={learner} />
      {editing && <PostEditor classId={p.class_id} post={p} onClose={() => setEditing(false)} />}
      {deleting && (
        <Modal title="Delete this post?" onClose={() => setDeleting(false)}>
          <div className="small">It went to {p.classes.length} classes. Take it down from {d.class.name} only, or from all of them?</div>
          <div className="row end wrap" style={{ gap: 8 }}>
            <button className="btn" onClick={() => setDeleting(false)}>
              Keep it
            </button>
            <button className="btn danger" onClick={() => remove(false)}>
              Delete from {d.class.name} only
            </button>
            <button className="btn danger" onClick={() => remove(true)}>
              Delete from all {p.classes.length}
            </button>
          </div>
        </Modal>
      )}
    </article>
  );
}

// Pictures (shown, tap to enlarge) and files (to download) in a post
export function StreamFiles({ files }) {
  const [big, setBig] = useState(null);
  if (!files?.length) return null;
  const pics = files.filter((f) => String(f.type || '').startsWith('image/'));
  const others = files.filter((f) => !String(f.type || '').startsWith('image/'));
  return (
    <>
      {pics.length > 0 && (
        <div className="stream-pics">
          {pics.map((f) => (
            <StreamPicture key={f.path} f={f} onOpen={setBig} />
          ))}
        </div>
      )}
      {others.length > 0 && (
        <div className="row wrap" style={{ gap: 8 }}>
          {others.map((f) => (
            <StreamFile key={f.path} f={f} />
          ))}
        </div>
      )}
      {big && <Lightbox src={big} onClose={() => setBig(null)} />}
    </>
  );
}
function StreamPicture({ f, onOpen }) {
  const open = () =>
    api.getBlob('library', f.path).then(
      (b) => onOpen(URL.createObjectURL(b)),
      () => {},
    );
  return (
    <div className="stream-pic" title="Tap to see it bigger">
      <StoredImage path={f.path} alt={f.name} onClick={open} />
    </div>
  );
}
function StreamFile({ f }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function download() {
    setBusy(true);
    try {
      const blob = await api.getBlob('library', f.path);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = f.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) {
      toast({ title: 'Couldn’t open it', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <button type="button" className="btn sm stream-file" onClick={download} disabled={busy} aria-label={`Download ${f.name}`}>
      <Icon name={/pdf$/i.test(f.name) ? 'pdf' : 'file'} size={15} /> {f.name}
      {f.size ? <span className="tiny muted"> · {bytes(f.size)}</span> : null}
    </button>
  );
}

// Replies under a post, and the box to write one (when this person may)
function Replies({ p, d, learner }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [text, setText] = useState('');
  const [to, setTo] = useState(null);
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  const mode = p.replies_mode;
  const canWrite = !d.class.archived && (d.staff || (mode !== 'off' && !p.scheduled && !d.muted && !d.closed));
  const shown = p.replies || [];
  if (!shown.length && !canWrite) return null;
  if (!shown.length && d.staff && mode === 'off') return null; // a notice: teachers add to it by editing
  const nameOf = (id) => shown.find((r) => r.id === id)?.author?.name;
  const muted = (id) => (d.muted_learners || []).includes(id);
  async function send() {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api.replyToPost(p.id, text, to?.id || null);
      setText('');
      setTo(null);
      streamChanged();
    } catch (e) {
      toast({ title: 'Couldn’t send your reply', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function takeDown(r) {
    if (!(await confirm({ title: r.mine ? 'Remove your reply?' : `Remove ${first(r.author.name)}’s reply?`, body: r.mine ? 'It comes down for everyone.' : 'It comes down for the class. You and the class’s other teachers can still see it, marked removed.', ok: 'Remove', danger: true })))
      return;
    try {
      await api.removeReply(r.id);
      streamChanged();
    } catch (e) {
      toast({ title: 'Couldn’t remove it', body: e.message, tone: 'bad' });
    }
  }
  async function mute(r, on) {
    if (on && !(await confirm({ title: `Stop ${first(r.author.name)} replying in ${d.class.name}?`, body: 'They can still read everything. You can let them reply again any time.', ok: 'Stop their replies' })))
      return;
    try {
      await api.muteInClass(d.class.id, r.author.id, on);
      streamChanged();
      toast(on ? `${first(r.author.name)} can’t reply in ${d.class.name} for now` : `${first(r.author.name)} can reply again`);
    } catch (e) {
      toast({ title: 'Couldn’t change that', body: e.message, tone: 'bad' });
    }
  }
  return (
    <div className="stream-replies">
      <div className="tiny muted">
        {mode === 'off'
          ? 'Replies are closed.'
          : mode === 'teachers'
            ? learner
              ? 'Only your teachers see your reply.'
              : 'Only teachers see the replies.'
            : learner
              ? 'Everyone in the class sees replies, with names.'
              : 'The class sees each other’s replies, with names.'}
      </div>
      {shown.map((r) => (
        <div key={r.id} className={'stream-reply' + (r.removed ? ' removed' : '') + (r.teacher ? ' teacher' : '')}>
          <Avatar person={{ id: r.author.id, display_name: r.author.name }} size="sm" />
          <div className="grow">
            <div className="small">
              <b>{r.mine ? 'You' : r.author.name}</b>
              {r.teacher && <span className="pill tiny">Teacher</span>}
              {r.reply_to && nameOf(r.reply_to) && <span className="muted"> · to {nameOf(r.reply_to)}</span>}
              <span className="muted"> · {ago(r.created_at)}</span>
              {r.removed && <span className="pill tiny warn">{r.removed_by_author ? 'Removed by them' : 'Removed'}</span>}
            </div>
            {r.body != null && <Markdown src={r.body} className="stream-reply-body" />}
            {!r.removed && (
              <div className="row wrap stream-reply-acts">
                {d.staff && !r.teacher && canWrite && (
                  <button className="linkbtn tiny" onClick={() => (setTo(r), box.current?.focus())}>
                    Answer
                  </button>
                )}
                {learner && mode === 'class' && !r.mine && canWrite && (
                  <button className="linkbtn tiny" onClick={() => (setTo(r), box.current?.focus())}>
                    Reply to {first(r.author.name)}
                  </button>
                )}
                {(r.mine || d.staff) && (
                  <button className="linkbtn tiny" onClick={() => takeDown(r)}>
                    Remove
                  </button>
                )}
                {d.staff && !r.teacher && !d.class.archived && (
                  <button className="linkbtn tiny" onClick={() => mute(r, !muted(r.author.id))}>
                    {muted(r.author.id) ? `Let ${first(r.author.name)} reply again` : `Stop ${first(r.author.name)} replying`}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      ))}
      {canWrite && (
        <div className="stream-reply-box">
          {to && (
            <div className="tiny muted row" style={{ gap: 6 }}>
              Answering {to.author.name}
              <button className="linkbtn tiny" onClick={() => setTo(null)}>
                Cancel
              </button>
            </div>
          )}
          <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
            <textarea
              ref={box}
              className="textarea grow"
              rows={1}
              value={text}
              maxLength={2000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && send()}
              placeholder={d.staff ? 'Write to the class…' : 'Write a reply…'}
              aria-label={`Reply to ${p.author.name}’s post`}
            />
            <button className="btn primary" onClick={send} disabled={busy || !text.trim()}>
              <Icon name="send" size={15} /> Reply
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// Writing a post (or changing one): the words, pictures and files, which classes, who can reply, pinned, now or later
export function PostEditor({ classId, className = '', post = null, onClose }) {
  const toast = useToast();
  const confirm = useConfirm();
  const editing = !!post;
  const [group] = useState(() => post?.group_id || crypto.randomUUID());
  const [body, setBody] = useState(post?.body_md || '');
  const [files, setFiles] = useState(post?.files || []);
  const [uploading, setUploading] = useState(0);
  const [replies, setReplies] = useState(post?.replies_mode || 'off');
  const [pinned, setPinned] = useState(false);
  const [later, setLater] = useState(!!post?.scheduled);
  const [at, setAt] = useState(post?.scheduled ? toLocalInput(post.visible_from) : '');
  const [picked, setPicked] = useState([classId]);
  const [busy, setBusy] = useState(false);
  const pick = useRef(null);
  const choices = useQuery(editing ? null : 'stream-classes', api.streamClasses).data || [];
  const added = files.filter((f) => !(post?.files || []).some((g) => g.path === f.path));

  async function addFiles(list) {
    const room = MAX_FILES - files.length;
    const chosen = [...list].slice(0, Math.max(0, room));
    if (list.length > room) toast({ title: `Up to ${MAX_FILES} pictures or files a post`, tone: 'bad' });
    for (const file of chosen) {
      if (file.size > MAX_BYTES) {
        toast({ title: `${file.name} is too big`, body: 'Files can be up to 20 MB.', tone: 'bad' });
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const f = await api.uploadStreamFile(file, group);
        setFiles((xs) => [...xs, f]);
      } catch (e) {
        toast({ title: `Couldn’t add ${file.name}`, body: e.message, tone: 'bad' });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }
  function dropFile(f) {
    setFiles((xs) => xs.filter((x) => x.path !== f.path));
    if (added.some((x) => x.path === f.path)) api.removeStreamFiles([f.path]);
  }
  async function close() {
    if ((body.trim() && body !== (post?.body_md || '')) || added.length) {
      if (!(await confirm({ title: editing ? 'Leave without saving?' : 'Throw this post away?', body: 'What you wrote here won’t be kept.', ok: editing ? 'Leave' : 'Throw it away', cancel: 'Keep writing' }))) return;
    }
    api.removeStreamFiles(added.map((f) => f.path));
    onClose();
  }
  async function save() {
    if (later && !at) return toast({ title: 'Choose when it goes up', tone: 'bad' });
    setBusy(true);
    try {
      // a scheduled post changed to "Now" goes up now (no time would leave it at the old one)
      const goesUp = later ? fromLocalInput(at) : editing && post.scheduled ? new Date().toISOString() : null;
      if (editing) {
        await api.editClassPost(post.id, { body, files, replies, at: goesUp });
        const gone = (post.files || []).filter((f) => !files.some((g) => g.path === f.path));
        api.removeStreamFiles(gone.map((f) => f.path));
        toast(post.scheduled && !later ? 'Posted' : 'Post changed');
      } else {
        await api.postToClasses({ classes: picked, body, files, replies, pinned, at: goesUp, group });
        toast(later ? `Scheduled for ${when(goesUp)}` : picked.length > 1 ? `Posted to ${picked.length} classes` : `Posted to ${choices.find((c) => c.id === picked[0])?.name || className || 'the class'}`);
      }
      streamChanged();
      onClose();
    } catch (e) {
      toast({ title: editing ? 'Couldn’t save it' : 'Couldn’t post it', body: e.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  const togglePick = (id) => setPicked((xs) => (xs.includes(id) ? xs.filter((x) => x !== id) : [...xs, id]));
  return (
    <Modal title={editing ? 'Change your post' : 'New post'} onClose={close} wide>
      <div className="stack">
        <MathText value={body} onChange={setBody} placeholder="Share news, a reminder or a question with the class…" minHeight={110} label="What do you want to say?" />
        <div className="row wrap" style={{ gap: 8 }}>
          <button type="button" className="btn sm" onClick={() => pick.current?.click()} disabled={files.length >= MAX_FILES}>
            <Icon name="image" size={15} /> Add a picture or file
          </button>
          {uploading > 0 && <span className="small muted">Adding {uploading}…</span>}
          <input
            ref={pick}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFiles(e.target.files || []);
              e.target.value = '';
            }}
          />
        </div>
        {files.length > 0 && (
          <div className="chips">
            {files.map((f) => (
              <span key={f.path} className="pill">
                <Icon name={String(f.type || '').startsWith('image/') ? 'image' : 'file'} size={13} /> {f.name}
                <button type="button" className="linkbtn" onClick={() => dropFile(f)} aria-label={`Take ${f.name} off the post`}>
                  <Icon name="x" size={13} />
                </button>
              </span>
            ))}
          </div>
        )}
        {!editing && choices.length > 1 && (
          <fieldset className="stream-fieldset">
            <legend className="label">Post to</legend>
            <div className="chips">
              {choices.map((c) => (
                <label key={c.id} className={'pill pick' + (picked.includes(c.id) ? ' on' : '')}>
                  <input type="checkbox" checked={picked.includes(c.id)} onChange={() => togglePick(c.id)} /> {c.name}
                </label>
              ))}
              {picked.length < choices.length && (
                <button type="button" className="linkbtn small" onClick={() => setPicked(choices.map((c) => c.id))}>
                  All {choices.length} classes
                </button>
              )}
            </div>
          </fieldset>
        )}
        {editing && (post.classes || []).length > 1 && <div className="small muted">Changes go to every class it was posted to: {post.classes.map((c) => c.name).join(', ')}.</div>}
        <fieldset className="stream-fieldset">
          <legend className="label">Who can reply</legend>
          <div className="stack sm" role="radiogroup" aria-label="Who can reply">
            {REPLIES.map((r) => (
              <label key={r.value} className="row" style={{ gap: 8 }}>
                <input type="radio" name={`replies-${group}`} checked={replies === r.value} onChange={() => setReplies(r.value)} /> {r.label}
              </label>
            ))}
          </div>
        </fieldset>
        {!editing && <Toggle checked={pinned} onChange={setPinned} title="Pin to the top" sub="It stays first in the class until you unpin it." icon="pin" />}
        {(!editing || post.scheduled) && (
          <div className="stack sm">
            <Seg
              value={later ? 'later' : 'now'}
              onChange={(v) => setLater(v === 'later')}
              label="When it goes up"
              options={[
                { value: 'now', label: 'Now' },
                { value: 'later', label: 'Later' },
              ]}
            />
            {later && <input className="input" type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} aria-label="When it goes up" />}
          </div>
        )}
        <div className="row end wrap" style={{ gap: 8 }}>
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || uploading > 0 || (!body.trim() && !files.length) || (!editing && !picked.length)}>
            <Icon name={editing ? 'check' : 'send'} size={16} /> {busy ? 'Saving…' : editing ? 'Save changes' : later ? 'Schedule' : picked.length > 1 ? `Post to ${picked.length} classes` : 'Post'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
