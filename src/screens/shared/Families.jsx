// Messages between families and teachers (6 Nov 2026). One conversation is one parent and one teacher (or a centre's or
// school's office) about one child. Parents see their own conversations, never another parent's; a teacher sees theirs;
// the office sees the office's; a manager reads one only once someone reports it. Learners never see these, and the
// message itself never goes into an email or a phone alert ("Open Messages to read it").
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Field, Loading, Modal, go, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { ago, when } from '../../lib/format.js';
import { useLookups } from './lookups.jsx';

const first = (name) => String(name || '').split(' ')[0];
const refresh = () => invalidate('family-list', 'family-thread', 'notifications');

// How a conversation is named in the list: by the other side
export function threadName(t, parent) {
  if (parent) return t.to_office ? `The office, ${t.place}` : t.staff?.name || 'A teacher';
  return t.parent?.name || 'A parent';
}
function threadSub(t, parent) {
  if (parent) return `About ${first(t.learner.name)}${t.to_office ? '' : ` · ${t.place}`}`;
  return `${t.learner.name}’s parent${t.to_office ? ' · to the office' : ''}${t.side === 'review' ? ' · reported' : ''}`;
}

// Unread family messages, for a menu badge (one notification a conversation until it's read)
export function useFamilyUnread() {
  const n = useQuery('notifications', api.listNotifications).data || [];
  return n.filter((x) => x.kind === 'family_message' && !x.read_at).length;
}

// The list of conversations beside the open one. base: the page's path ('/messages' for parents, '/messages/families'
// for teachers, '/office/messages' for the office); officeOnly shows only the office's conversations.
export function FamilyInbox({ threadId, base, officeOnly = false, learnerId = null }) {
  const app = useApp();
  const parent = app.me.role === 'parent';
  const q = useQuery(`family-list:${learnerId || 'all'}`, () => api.familyList(learnerId), { poll: 30000 });
  const [composing, setComposing] = useState(false);
  const all = (q.data || []).filter((t) => !officeOnly || t.to_office || t.side === 'review');
  if (!q.data) return q.error ? <div className="error">{q.error.message}</div> : <Loading />;
  return (
    <>
      <div className="row between wrap" style={{ gap: 8 }}>
        <span className="small muted">
          {parent
            ? 'Write to your child’s teachers, or their school’s office. Only you and they see what you write.'
            : officeOnly
              ? 'Messages families send to the office. The office, the managers and each child’s head of year read them.'
              : 'Messages with your learners’ parents. Only you and that parent see them (and the managers, if one is reported).'}
        </span>
        <button className="btn primary" onClick={() => setComposing(true)}>
          <Icon name="plus" size={16} /> New message
        </button>
      </div>
      {all.length === 0 && !threadId ? (
        <Empty title="No messages yet">
          {parent ? 'Start one with “New message”. Teachers usually answer on school days.' : 'When a parent writes, or you write to one, it shows here.'}
        </Empty>
      ) : (
        <div className={'card pad0 chat' + (threadId ? ' open' : '')}>
          <div className="people" aria-label="Conversations">
            {all.map((t) => (
              <button key={t.id} aria-current={t.id === threadId} onClick={() => go(`${base}/${t.id}`, { replace: !!threadId })}>
                <Avatar person={{ display_name: threadName(t, parent), id: t.id }} />
                <span className="grow" style={{ minWidth: 0 }}>
                  <div className="strong ellipsis">{threadName(t, parent)}</div>
                  <div className="tiny muted ellipsis">{threadSub(t, parent)}</div>
                  <div className="small muted ellipsis">{t.last ? (t.last.body ?? 'Message deleted') : ''}</div>
                </span>
                {t.unread > 0 && <span className="pill accent">{t.unread}</span>}
              </button>
            ))}
          </div>
          <div className="pane">
            {threadId ? (
              <FamilyThread key={threadId} id={threadId} back={() => go(base, { replace: true })} />
            ) : (
              <div className="muted" style={{ padding: 30 }}>
                Choose a conversation.
              </div>
            )}
          </div>
        </div>
      )}
      {composing && <NewFamilyMessage base={base} office={officeOnly} learnerId={learnerId} onClose={() => setComposing(false)} />}
    </>
  );
}

// One conversation: what's been said, the box to write in, and reporting, closing and stopping a parent
export function FamilyThread({ id, back }) {
  const app = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const parent = app.me.role === 'parent';
  const q = useQuery(`family-thread:${id}`, () => api.familyThread(id), { poll: 15000 });
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState(false);
  const t = q.data;
  const count = t?.messages?.length || 0;
  // opening it marks it read: the list's counts and the bell catch up
  useEffect(() => {
    if (t) invalidate('family-list', 'notifications');
  }, [t?.id, count]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    document.getElementById('family-end')?.scrollIntoView({ block: 'end' });
  }, [count]);
  if (!t) return <div style={{ padding: 20 }}>{q.error ? <div className="error">{q.error.message}</div> : <Loading />}</div>;
  const staff = t.side === 'staff' || t.side === 'office';
  async function send(e) {
    e?.preventDefault();
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      await api.familySend(t.id, body);
      setText('');
      refresh();
    } catch (x) {
      toast({ title: 'Couldn’t send', body: x.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function act(fn, done) {
    try {
      await fn();
      refresh();
      if (done) toast(done);
    } catch (x) {
      toast({ title: 'Couldn’t do that', body: x.message, tone: 'bad' });
    }
  }
  const other = threadName(t, parent);
  return (
    <>
      <div className="family-head">
        <button className="btn sm ghost family-back" onClick={back} aria-label="Back to the list">
          <Icon name="left" size={16} />
        </button>
        <span className="grow" style={{ minWidth: 0 }}>
          <span className="strong">{other}</span>
          <span className="tiny muted">
            {' '}
            · {parent ? `about ${t.learner.name}` : `${t.learner.name}’s parent`}
            {!parent && t.to_office ? ' · to the office' : ''}
          </span>
          {t.office_text && <div className="tiny muted">{t.office_text}</div>}
        </span>
        <span className="row wrap" style={{ gap: 6, justifyContent: 'flex-end' }}>
          {!t.reported && t.side !== 'review' && (
            <button className="btn sm ghost" onClick={() => setReporting(true)}>
              <Icon name="flag" size={14} /> Report
            </button>
          )}
          {(staff || t.side === 'review') && (
            <button
              className="btn sm ghost"
              onClick={() => act(() => api.familyClose(t.id, !t.closed_by_staff), t.closed_by_staff ? 'Open again' : 'Conversation closed')}
            >
              {t.closed_by_staff ? 'Open it again' : 'Close conversation'}
            </button>
          )}
          {t.can_block && t.parent?.id && (
            <button
              className="btn sm ghost"
              onClick={async () => {
                if (
                  !t.blocked &&
                  !(await confirm({
                    title: `Stop ${t.parent.name} contacting ${t.place}?`,
                    body: 'They can’t send messages to anyone here or book meetings, and their meetings still to come are cancelled. You can let them again any time.',
                    ok: 'Stop them',
                    danger: true,
                  }))
                )
                  return;
                act(() => api.familyBlock(t.parent.id, !t.blocked), t.blocked ? 'They can write again' : 'Stopped');
              }}
            >
              {t.blocked ? 'Let them write again' : 'Stop this parent'}
            </button>
          )}
        </span>
      </div>
      {t.reported && (
        <div className="note small family-note">
          <Icon name="flag" size={14} /> This conversation was reported{t.report_reason ? `: “${t.report_reason}”` : ''}. {t.views?.length ? `Read by ${t.views.join(', ')} since.` : 'The managers can read it.'}
        </div>
      )}
      <div className="msgs">
        <div className="thread">
          {t.messages.map((m) => (
            <div key={m.id} className={'bubble' + (m.mine ? ' mine' : '') + (m.deleted ? ' deleted' : '')}>
              {!m.mine && <div className="ctx">{m.author}</div>}
              {m.deleted && m.body == null ? <em>Message deleted</em> : <div className="family-body">{m.body}</div>}
              {m.deleted && m.body != null && <div className="tiny">(deleted by the writer)</div>}
              <div className="w">
                {ago(m.at)}
                {m.seen && ' · Seen'}
                {m.can_delete && (
                  <>
                    {' · '}
                    <button
                      type="button"
                      className="linkbtn tiny"
                      onClick={async () => {
                        if (!(await confirm({ title: 'Delete this message?', body: 'It’s hidden for both of you.', ok: 'Delete', danger: true }))) return;
                        act(() => api.familyDelete(m.id));
                      }}
                    >
                      Delete
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
          <div id="family-end" />
        </div>
      </div>
      {t.side === 'review' ? (
        <div className="note small" style={{ margin: 12 }}>
          You can read this because it was reported. Only {parent ? 'you' : 'the parent'} and {t.to_office ? 'the office' : t.staff?.name || 'the teacher'} write in it.
        </div>
      ) : t.closed ? (
        <div className="note small" style={{ margin: 12 }}>
          {t.closed}
        </div>
      ) : (
        <form className="composer" onSubmit={send}>
          <textarea
            className="textarea"
            value={text}
            rows={2}
            maxLength={4000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={`Message ${other}…`}
            aria-label="Message"
          />
          <button className="btn primary icon" disabled={busy || !text.trim()} aria-label="Send">
            <Icon name="send" size={18} />
          </button>
        </form>
      )}
      {reporting && <ReportThread t={t} onClose={() => setReporting(false)} onDone={refresh} />}
    </>
  );
}

function ReportThread({ t, onClose, onDone }) {
  const toast = useToast();
  const [why, setWhy] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Modal
      title="Report this conversation"
      onClose={onClose}
      foot={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn primary"
            disabled={busy || why.trim().length < 3}
            onClick={async () => {
              setBusy(true);
              try {
                await api.familyReport(t.id, why.trim());
                onDone();
                toast('Reported. Thank you for telling us.');
                onClose();
              } catch (x) {
                toast({ title: 'Couldn’t report it', body: x.message, tone: 'bad' });
              } finally {
                setBusy(false);
              }
            }}
          >
            Report
          </button>
        </>
      }
    >
      <div className="small muted">
        The managers at {t.place} (or StudyBridge, for a tutor on their own) are told and can read this conversation; their names show on it.
        Nothing in it can be deleted after this.
      </div>
      <Field label="What’s wrong">
        <textarea className="textarea" rows={3} maxLength={500} value={why} onChange={(e) => setWhy(e.target.value)} />
      </Field>
    </Modal>
  );
}

// Start a conversation. A parent picks a child (if they have more than one), then a teacher or an office; a teacher picks
// a learner (or comes with one), then one of their parents; the office can write as the office.
export function NewFamilyMessage({ base, learnerId = null, office = false, onClose }) {
  const app = useApp();
  const parent = app.me.role === 'parent';
  const toast = useToast();
  const lk = useLookups();
  const kids = useQuery(parent ? 'parent-children' : null, api.parentChildren).data || [];
  const [child, setChild] = useState(learnerId);
  const shownChild = child || (parent && kids.length === 1 ? kids[0].id : null);
  const contacts = useQuery(parent && shownChild ? `family-contacts:${shownChild}` : null, () => api.familyContacts(shownChild));
  const parents = useQuery(!parent && shownChild ? `family-parents:${shownChild}` : null, () => api.familyParents(shownChild));
  const [to, setTo] = useState(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  // (parents have no learner lists: the app gives them none; the office picks from the school's learners)
  const school = useQuery(!parent && office && !learnerId ? 'student-records' : null, api.studentRecords).data;
  const learners = useMemo(
    () => (parent ? [] : office ? (school?.learners || []).map((l) => ({ id: l.id, display_name: l.name })) : lk?.learners || []),
    [parent, office, school, lk?.learners],
  );
  const options = useMemo(() => {
    if (parent) {
      const out = [];
      for (const pl of contacts.data || []) {
        const off = pl.paused || pl.blocked;
        for (const t of pl.teachers)
          out.push({ key: t.id, label: t.name, sub: `${t.classes.length ? t.classes.join(', ') : t.main ? 'Their tutor' : 'Their teacher'} · ${pl.name}`, to: { learner: shownChild, staff: t.id }, disabled: off || !t.can_start, why: off ? (pl.blocked ? 'Not taking messages from you' : 'Paused for now') : !t.can_start ? (pl.mode === 'homeroom' ? 'Write to their form tutor or the office first' : 'Write to the office first') : '' });
        if (pl.office) out.push({ key: 'office:' + pl.place_id, label: `The office, ${pl.name}`, sub: pl.office_text, to: { learner: shownChild, office: true, place: pl.place_id }, disabled: off, why: off ? (pl.blocked ? 'Not taking messages from you' : 'Paused for now') : '' });
      }
      return out;
    }
    const d = parents.data;
    if (!d) return [];
    const out = [];
    for (const p of d.parents) {
      if (d.teach && !office) out.push({ key: p.id, label: p.name, sub: 'From you', to: { learner: shownChild, parent: p.id }, thread: p.thread });
      if (d.office) out.push({ key: 'office:' + p.id, label: p.name, sub: 'From the office', to: { learner: shownChild, parent: p.id, office: true }, thread: p.office_thread });
    }
    return out;
  }, [parent, contacts.data, parents.data, shownChild, office]);
  const picked = options.find((o) => o.key === to);
  async function send() {
    setBusy(true);
    try {
      const r = picked.thread ? await api.familySend(picked.thread, text.trim()) : await api.familySend(null, text.trim(), picked.to);
      refresh();
      onClose();
      if (base) go(`${base}/${r.thread_id}`);
      else toast('Sent');
    } catch (x) {
      toast({ title: 'Couldn’t send', body: x.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  const loading = shownChild && (parent ? !contacts.data && !contacts.error : !parents.data && !parents.error);
  const err = parent ? contacts.error : parents.error;
  return (
    <Modal
      title="New message"
      onClose={onClose}
      foot={
        <>
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !picked || picked.disabled || !text.trim()} onClick={send}>
            <Icon name="send" size={16} /> Send
          </button>
        </>
      }
    >
      {parent && kids.length > 1 && !learnerId && (
        <Field label="About">
          <select className="input" value={child || ''} onChange={(e) => (setChild(e.target.value || null), setTo(null))}>
            <option value="">Choose a child</option>
            {kids.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {!parent && !learnerId && (
        <Field label="About">
          <select className="input" value={child || ''} onChange={(e) => (setChild(e.target.value || null), setTo(null))}>
            <option value="">Choose a learner</option>
            {learners.map((l) => (
              <option key={l.id} value={l.id}>
                {l.display_name}
              </option>
            ))}
          </select>
        </Field>
      )}
      {err && <div className="error">{err.message}</div>}
      {loading && <Loading />}
      {shownChild && !loading && !err && options.length === 0 && (
        <div className="note small">{parent ? 'There’s nobody to write to about them yet.' : 'No parent follows them on StudyBridge yet. Give their family a parent code from their page.'}</div>
      )}
      {options.length > 0 && (
        <div className="stack xs" role="radiogroup" aria-label="Who to write to">
          {options.map((o) => (
            <label key={o.key} className={'family-pick' + (o.disabled ? ' off' : '')}>
              <input type="radio" name="family-to" checked={to === o.key} disabled={o.disabled} onChange={() => setTo(o.key)} />
              <span className="grow">
                <span className="strong">{o.label}</span>
                <span className="tiny muted"> · {o.sub}</span>
                {o.why && <div className="tiny muted">{o.why}</div>}
              </span>
            </label>
          ))}
        </div>
      )}
      {picked && !picked.disabled && (
        <Field label="Message" hint="Only you and they see it. They’re told there’s a message; what you write stays in StudyBridge.">
          <textarea className="textarea" rows={4} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
        </Field>
      )}
    </Modal>
  );
}

// "Message their family", on a learner's page (teachers) or a student's page (the office)
export function MessageFamily({ learnerId, office = false, label = 'Message their family' }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="btn" onClick={() => setOpen(true)}>
        <Icon name="message" size={16} /> {label}
      </button>
      {open && <NewFamilyMessage learnerId={learnerId} office={office} base={office ? '/office/messages' : '/messages/families'} onClose={() => setOpen(false)} />}
    </>
  );
}

// A learner's family conversations, shown on their page (only the ones this teacher or the office is part of)
export function FamilyThreadsFor({ learnerId, base }) {
  const q = useQuery(`family-list:${learnerId}`, () => api.familyList(learnerId));
  const list = q.data || [];
  if (!list.length) return null;
  return (
    <div className="list">
      {list.map((t) => (
        <button key={t.id} className="item click" onClick={() => go(`${base}/${t.id}`)}>
          <Icon name="message" style={{ color: 'var(--accent)' }} />
          <span className="grow">
            <span className="name">
              {t.parent.name}
              {t.to_office ? ' · to the office' : ''}
            </span>
            <span className="meta">
              {t.last?.body ?? 'Message deleted'} · {when(t.last_at)}
            </span>
          </span>
          {t.unread > 0 && <span className="pill accent">{t.unread}</span>}
        </button>
      ))}
    </div>
  );
}
