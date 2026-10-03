import { useEffect, useRef, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Field, Loading, Modal, Page, copyText, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { weekRange, ago } from '../../lib/format.js';
import { reportText, waLink, mailLink, workLine } from '../../lib/reports.js';
import { useLookups } from '../shared/lookups.jsx';

const weekLabel = (w) => {
  const d = new Date(String(w).slice(0, 10) + 'T12:00:00');
  return `Week of ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
};

// ---------------------------------------------------------------------------
// Weekly parent reports: drafted for every learner who switched them on; the
// tutor checks the words (Prof can write them) and sends them on WhatsApp or email
// ---------------------------------------------------------------------------
export default function ParentReports() {
  const lk = useLookups();
  const settings = useQuery('learner-reports', api.listLearnerReports);
  const reports = useQuery('parent-reports', api.listParentReports);
  const [open, setOpen] = useState(null);
  const [exam, setExam] = useState(null);
  const toast = useToast();
  const [busy, setBusy] = useState('');
  if (!settings.data || !reports.data) return <Page title="Parent reports"><Loading /></Page>;
  const byLearner = Object.fromEntries(settings.data.map((r) => [r.learner_id, r]));
  const drafts = reports.data.filter((r) => r.status === 'draft' && byLearner[r.learner_id]?.enabled);
  const sent = reports.data.filter((r) => r.status === 'sent');

  async function draftNow(l, offset) {
    setBusy(l.id);
    try {
      const { from, to } = weekRange(offset);
      const r = await api.draftReport(l.id, from, to);
      invalidate('parent-reports');
      setOpen(r);
    } catch (e) {
      toast({ title: 'Couldn’t draft it', body: e.message, tone: 'bad' });
    } finally {
      setBusy('');
    }
  }

  return (
    <Page title="Parent reports" subtitle="A short weekly report for each learner’s parent. Learners switch reports on themselves and give the parent’s contact. You check every report before it goes.">
      {drafts.length > 0 && (
        <div className="card claude">
          <h2>Ready for you to check and send</h2>
          <div className="list">
            {drafts.map((r) => {
              const l = lk.learner(r.learner_id);
              return (
                <button key={r.id} className="item" onClick={() => setOpen(r)}>
                  <Avatar person={l || { display_name: r.data?.learner }} />
                  <span className="grow">
                    <span className="name">{r.data?.learner || l?.display_name}</span>
                    <span className="meta">
                      {weekLabel(r.week_start)} · to {byLearner[r.learner_id]?.parent_name || 'their parent'} {r.summary ? '· words written' : '· add a comment'}
                    </span>
                  </span>
                  <span className="btn sm primary">Check & send</span>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="card">
        <h2>Learners</h2>
        {lk.learners.length === 0 ? (
          <Empty>No learners yet.</Empty>
        ) : (
          <div className="stack sm">
            {lk.learners.map((l) => {
              const s = byLearner[l.id];
              return (
                <div key={l.id} className="row wrap report-row">
                  <Avatar person={l} />
                  <span className="grow">
                    <span className="strong">{l.display_name}</span>
                    <span className="small muted">
                      {' '}
                      ·{' '}
                      {s?.enabled
                        ? `reports on, to ${s.parent_name || 'their parent'} (${[s.parent_phone && 'WhatsApp', s.parent_email && 'email'].filter(Boolean).join(' and ')})`
                        : 'reports off (they switch them on in their Settings)'}
                      {s?.exam_date ? ` · ${s.exam_name || 'Exam'} on ${new Date(String(s.exam_date).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                    </span>
                  </span>
                  <button className="btn sm ghost" onClick={() => setExam({ l, s })}>
                    <Icon name="calendar" size={16} /> Exam date
                  </button>
                  {s?.enabled && (
                    <>
                      <button className="btn sm" disabled={busy === l.id} onClick={() => draftNow(l, 0)}>
                        This week
                      </button>
                      <button className="btn sm" disabled={busy === l.id} onClick={() => draftNow(l, -1)}>
                        Last week
                      </button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {sent.length > 0 && (
        <div className="card">
          <h2>Sent</h2>
          <div className="list">
            {sent.slice(0, 40).map((r) => (
              <button key={r.id} className="item" onClick={() => setOpen(r)}>
                <Icon name="send" style={{ color: 'var(--accent)' }} />
                <span className="grow">
                  <span className="name">
                    {r.data?.learner} · {weekLabel(r.week_start)}
                  </span>
                  <span className="meta">
                    Sent {ago(r.sent_at)} by {r.sent_via === 'whatsapp' ? 'WhatsApp' : r.sent_via === 'email' ? 'email' : 'copy and paste'}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {open && <ReportEditor report={open} contact={byLearner[open.learner_id]} onClose={() => setOpen(null)} />}
      {exam && <ExamModal {...exam} onClose={() => setExam(null)} />}
    </Page>
  );
}

function ExamModal({ l, s, onClose }) {
  const toast = useToast();
  const [name, setName] = useState(s?.exam_name || '');
  const [date, setDate] = useState(s?.exam_date || '');
  async function saveIt() {
    try {
      await api.setLearnerExam(l.id, name, date || null);
      invalidate('learner-reports');
      toast('Saved');
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t save', body: e.message, tone: 'bad' });
    }
  }
  return (
    <Modal
      title={`${l.display_name}’s exam`}
      onClose={onClose}
      foot={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={saveIt}>
            Save
          </button>
        </>
      }
    >
      <div className="small muted">Shown as a countdown in their weekly reports.</div>
      <Field label="Exam">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. IGCSE International Maths (0607)" />
      </Field>
      <Field label="Date">
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Field>
    </Modal>
  );
}

function ReportEditor({ report, contact, onClose }) {
  const toast = useToast();
  const [r, setR] = useState(report);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const usage = useQuery('prof-usage', api.profUsage).data;
  const sent = r.status === 'sent';
  const set = (p) => setR((x) => ({ ...x, ...p }));
  const text = reportText(r);
  const d = r.data || {};

  // Prof writing it: pick up the words when they arrive
  const fresh = useQuery('parent-reports', api.listParentReports, { poll: asked ? 3000 : 0 });
  const wrote = useRef(false);
  useEffect(() => {
    const now = (fresh.data || []).find((x) => x.id === r.id);
    if (asked && now?.prof && now.summary && !wrote.current) {
      wrote.current = true;
      setAsked(false);
      set({ summary: now.summary, comment: now.comment, next_week: now.next_week, prof: true });
      toast('Prof wrote the report. Check it over.');
    }
  }, [fresh.data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveWords() {
    await api.saveReport(r.id, { summary: r.summary || null, comment: r.comment || null, next_week: r.next_week || null });
    invalidate('parent-reports');
  }
  async function send(via) {
    setBusy(true);
    try {
      await saveWords();
      if (via === 'whatsapp') window.open(waLink(contact?.parent_phone, text), '_blank');
      else if (via === 'email') window.open(mailLink(contact?.parent_email, `Weekly report: ${d.learner}`, text), '_blank');
      else await copyText(text);
      await api.markReportSent(r.id, via);
      invalidate('parent-reports');
      toast({ title: via === 'copy' ? 'Copied, and marked as sent' : 'Marked as sent', body: via === 'whatsapp' ? 'WhatsApp opened with the report written. Press send there.' : via === 'email' ? 'Your email app opened with the report written. Press send there.' : 'Paste it wherever you like.' });
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t send', body: e.message, tone: 'bad' });
      setBusy(false);
    }
  }
  async function askProf() {
    try {
      await saveWords();
      wrote.current = false;
      await api.profReport(r.id);
      setAsked(true);
    } catch (e) {
      toast({ title: 'Couldn’t ask Prof', body: e.message, tone: 'bad' });
    }
  }

  return (
    <Modal
      title={`${d.learner}: ${weekLabel(r.week_start)}`}
      wide
      onClose={onClose}
      foot={
        sent ? (
          <button className="btn" onClick={onClose}>
            Close
          </button>
        ) : (
          <>
            <button className="btn" onClick={async () => (await saveWords(), toast('Saved'), onClose())}>
              Save for later
            </button>
            <button className="btn" disabled={busy} onClick={() => send('copy')}>
              <Icon name="copy" size={18} /> Copy
            </button>
            {contact?.parent_email && (
              <button className="btn" disabled={busy} onClick={() => send('email')}>
                Email
              </button>
            )}
            {contact?.parent_phone && (
              <button className="btn primary" disabled={busy} onClick={() => send('whatsapp')}>
                <Icon name="send" size={18} /> Send on WhatsApp
              </button>
            )}
          </>
        )
      }
    >
      <div className="split side-r">
        <div className="stack">
          {!sent && (
            <div className="row wrap between">
              <div className="small muted">
                To {contact?.parent_name || 'their parent'}
                {contact?.parent_phone ? ` · WhatsApp ${contact.parent_phone}` : ''}
                {contact?.parent_email ? ` · ${contact.parent_email}` : ''}
              </div>
              {usage?.ready && (
                <button className="btn sm claude" disabled={asked} onClick={askProf}>
                  <Icon name="cap" size={16} /> {asked ? 'Prof is writing…' : r.summary ? 'Ask Prof to rewrite' : 'Ask Prof to write it'}
                </button>
              )}
            </div>
          )}
          <Field label="One-line summary">
            <input className="input" disabled={sent} value={r.summary || ''} onChange={(e) => set({ summary: e.target.value })} placeholder={`e.g. A strong week: all work in on time and algebra is improving.`} />
          </Field>
          <Field label="Your comment to the parent">
            <textarea className="textarea" disabled={sent} value={r.comment || ''} onChange={(e) => set({ comment: e.target.value })} placeholder="What went well, what to work on." />
          </Field>
          <Field label="Next week">
            <textarea className="textarea" style={{ minHeight: 70 }} disabled={sent} value={r.next_week || ''} onChange={(e) => set({ next_week: e.target.value })} placeholder="What’s coming and what to practise at home." />
          </Field>
          <div className="small muted">
            From the week: {d.lessons || 0} lesson{d.lessons === 1 ? '' : 's'} · work {(d.work || []).length ? workLine(d.work) : 'none due'}
            {d.avg_pct != null ? ` · ${d.avg_pct}% average` : ''}
          </div>
        </div>
        <div className="stack sm">
          <div className="tiny muted strong upper">What they’ll receive</div>
          <pre className="report-preview">{text}</pre>
        </div>
      </div>
    </Modal>
  );
}

// Drafts last week's report for every learner who has reports on (runs when the tutor's app is open),
// and asks Prof to write them if the tutor switched that on.
export function useWeeklyReports() {
  const settings = useQuery('learner-reports', api.listLearnerReports);
  const reports = useQuery('parent-reports', api.listParentReports);
  const prof = useQuery('prof-settings', api.profSettings);
  const done = useRef(false);
  useEffect(() => {
    if (done.current || !settings.data || !reports.data || prof.data === undefined) return;
    done.current = true;
    const { from, to } = weekRange(-1);
    const week = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
    (async () => {
      let made = 0;
      for (const s of settings.data.filter((x) => x.enabled)) {
        if (reports.data.some((r) => r.learner_id === s.learner_id && String(r.week_start).slice(0, 10) === week)) continue;
        try {
          const r = await api.draftReport(s.learner_id, from, to);
          made++;
          if (prof.data?.auto_reports) await api.profReport(r.id).catch(() => {});
        } catch {}
      }
      if (made) invalidate('parent-reports');
    })();
  }, [settings.data, reports.data, prof.data]);
  const enabled = new Set((settings.data || []).filter((x) => x.enabled).map((x) => x.learner_id));
  return (reports.data || []).filter((r) => r.status === 'draft' && enabled.has(r.learner_id)).length;
}
