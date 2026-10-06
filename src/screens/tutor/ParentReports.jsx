import { useEffect, useRef, useState } from 'react';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Empty, Field, Loading, Modal, Page, copyText, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { weekRange, ago } from '../../lib/format.js';
import { reportText, waLink, mailLink } from '../../lib/reports.js';
import ReportCard, { printReport } from '../shared/ReportCard.jsx';
import { useLookups } from '../shared/lookups.jsx';

const weekLabel = (w) => {
  const d = new Date(String(w).slice(0, 10) + 'T12:00:00');
  return `Week of ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
};

// ---------------------------------------------------------------------------
// Weekly parent reports: drafted for every learner who switched them on; the
// tutor checks the words (Prof can write them) and sends them on WhatsApp or email
// ---------------------------------------------------------------------------
const thisMonday = () => {
  const { from } = weekRange(0);
  return `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}-${String(from.getDate()).padStart(2, '0')}`;
};

export default function ParentReports() {
  const lk = useLookups();
  const settings = useQuery('learner-reports', api.listLearnerReports);
  const reports = useQuery('parent-reports', api.listParentReports);
  const parents = useQuery('parent-counts', api.myParentCounts).data || {};
  const [open, setOpen] = useState(null); // { learnerId, reportId? }
  const [exam, setExam] = useState(null);
  if (!settings.data || !reports.data) return <Page title="Parent reports"><Loading /></Page>;
  const byLearner = Object.fromEntries(settings.data.map((r) => [r.learner_id, r]));
  const monday = thisMonday();
  // a finished week's report, for a learner who has reports on, waiting to be sent
  const goes = (id) => !!byLearner[id]?.enabled || parents[id] > 0;
  const ready = reports.data.filter((r) => r.status === 'draft' && String(r.week_start).slice(0, 10) < monday && goes(r.learner_id));
  const sent = reports.data.filter((r) => r.status === 'sent');

  return (
    <Page title="Parent reports" subtitle="StudyBridge fills in every learner’s report from their week: lessons, work, marks, topics, mock grade and exam countdown. Add a comment if you like, and approve it: nothing reaches a parent until you do. It goes to parent accounts, and by WhatsApp or email when the learner switched that on.">
      {ready.length > 0 && (
        <div className="card claude">
          <h2>Ready for you to check and send</h2>
          <div className="list">
            {ready.map((r) => {
              const l = lk.learner(r.learner_id);
              return (
                <button key={r.id} className="item" onClick={() => setOpen({ learnerId: r.learner_id, reportId: r.id })}>
                  <Avatar person={l || { display_name: r.data?.learner }} />
                  <span className="grow">
                    <span className="name">{r.data?.learner || l?.display_name}</span>
                    <span className="meta">
                      {weekLabel(r.week_start)} · {r.comment ? 'comment written' : 'add a comment if you like'}
                    </span>
                  </span>
                  <span className="btn sm primary">Check & approve</span>
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
                      {[
                        parents[l.id] > 0 ? `${parents[l.id]} parent account${parents[l.id] === 1 ? '' : 's'}` : null,
                        s?.enabled ? `${s.parent_name || 'a parent'} by ${[s.parent_phone && 'WhatsApp', s.parent_email && 'email'].filter(Boolean).join(' and ')}` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'no parent yet (invite one from their Parents tab)'}
                      {s?.exam_date ? ` · ${s.exam_name || 'Exam'} on ${new Date(String(s.exam_date).slice(0, 10) + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : ''}
                    </span>
                  </span>
                  <button className="btn sm ghost" onClick={() => setExam({ l, s })}>
                    <Icon name="calendar" size={16} /> Exam date
                  </button>
                  {!goes(l.id) && <AskButton learner={l} />}
                  <button className="btn sm primary" onClick={() => setOpen({ learnerId: l.id })}>
                    <Icon name="eye" size={16} /> View report
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {sent.length > 0 && (
        <div className="card">
          <h2>Approved</h2>
          <div className="list">
            {sent.slice(0, 40).map((r) => (
              <button key={r.id} className="item" onClick={() => setOpen({ learnerId: r.learner_id, reportId: r.id })}>
                <Icon name="send" style={{ color: 'var(--accent)' }} />
                <span className="grow">
                  <span className="name">
                    {r.data?.learner} · {weekLabel(r.week_start)}
                  </span>
                  <span className="meta">
                    Approved {ago(r.sent_at)} · {r.sent_via === 'whatsapp' ? 'WhatsApp' : r.sent_via === 'email' ? 'email' : r.sent_via === 'app' ? 'parent account' : 'copy and paste'}
                    {parents[r.learner_id] > 0 && r.sent_via !== 'app' ? ' and parent account' : ''}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      {open && <ReportViewer {...open} contact={byLearner[open.learnerId]} parents={parents[open.learnerId] || 0} reports={reports.data} onClose={() => setOpen(null)} />}
      {exam && <ExamModal {...exam} onClose={() => setExam(null)} />}
    </Page>
  );
}

// Asks the learner (in a message) to switch on reports for a parent: it's their choice
function AskButton({ learner }) {
  const toast = useToast();
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn sm ghost"
      disabled={done}
      onClick={async () => {
        try {
          await api.sendComment({
            tutor_id: api.getMe().id,
            learner_id: learner.id,
            body: 'Hi! Could you switch on the weekly report for your parent? Open Settings → “Weekly report for a parent”, switch it on and add their WhatsApp number. You can read every report that’s sent.',
          });
          setDone(true);
          toast({ title: `Asked ${learner.display_name}`, body: 'They got a message with how to switch it on.' });
        } catch (e) {
          toast({ title: 'Couldn’t send', body: e.message, tone: 'bad' });
        }
      }}
    >
      <Icon name="message" size={16} /> {done ? 'Asked' : `Ask ${learner.display_name.split(' ')[0]}`}
    </button>
  );
}

// One learner's reports, week by week. This week is refreshed when you open it, so it's as of now.
function ReportViewer({ learnerId, reportId, contact, parents, reports, onClose }) {
  const toast = useToast();
  const lk = useLookups();
  const l = lk.learner(learnerId);
  const mine = reports.filter((r) => r.learner_id === learnerId).sort((a, b) => String(b.week_start).localeCompare(String(a.week_start)));
  const [current, setCurrent] = useState(() => mine.find((r) => r.id === reportId) || null);
  const [loading, setLoading] = useState(!reportId);
  const monday = thisMonday();

  async function loadWeek(offset) {
    setLoading(true);
    try {
      const { from, to } = weekRange(offset);
      const r = await api.draftReport(learnerId, from, to); // fresh numbers (unless already sent)
      invalidate('parent-reports');
      setCurrent(r);
    } catch (e) {
      toast({ title: 'Couldn’t load the report', body: e.message, tone: 'bad' });
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    if (!reportId) loadWeek(0);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const weeks = [...new Set([monday, ...mine.map((r) => String(r.week_start).slice(0, 10))])].sort().reverse().slice(0, 12);
  const pick = (w) => {
    if (w === monday) return loadWeek(0);
    const r = mine.find((x) => String(x.week_start).slice(0, 10) === w);
    if (r) setCurrent(r);
  };
  const shown = current ? String(current.week_start).slice(0, 10) : monday;

  return (
    <Modal title={`${l?.display_name || current?.data?.learner || 'Report'}’s report`} wide onClose={onClose}>
      <div className="row wrap" style={{ gap: 6 }}>
        {weeks.map((w) => (
          <button key={w} className={'pill click' + (w === shown ? ' accent' : '')} onClick={() => pick(w)}>
            {w === monday ? 'This week so far' : weekLabel(w)}
            {mine.find((x) => String(x.week_start).slice(0, 10) === w)?.status === 'sent' ? ' · approved' : ''}
          </button>
        ))}
      </div>
      {loading || !current ? <Loading label="Working out the week…" /> : <ReportBody key={current.id + current.updated_at} report={current} contact={contact} parents={parents} thisWeek={shown === monday} onSent={onClose} />}
    </Modal>
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

function ReportBody({ report, contact, parents = 0, thisWeek, onSent }) {
  const onClose = onSent;
  const toast = useToast();
  const [r, setR] = useState(report);
  const [busy, setBusy] = useState(false);
  const [asked, setAsked] = useState(false);
  const usage = useQuery('prof-usage', api.profUsage).data;
  const sent = r.status === 'sent';
  const set = (p) => setR((x) => ({ ...x, ...p }));
  const d = r.data || {};
  const text = reportText({ ...r, summary: null });

  // Prof only suggests a comment; the report itself is filled in by StudyBridge
  const fresh = useQuery('parent-reports', api.listParentReports, { poll: asked ? 3000 : 0 });
  const wrote = useRef(false);
  useEffect(() => {
    const now = (fresh.data || []).find((x) => x.id === r.id);
    if (asked && now?.prof && now.comment && !wrote.current) {
      wrote.current = true;
      setAsked(false);
      set({ comment: now.comment });
      toast('Prof suggested a comment. Change anything you like.');
    }
  }, [fresh.data]); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveWords() {
    await api.saveReport(r.id, { summary: null, comment: r.comment || null, next_week: r.next_week || null });
    invalidate('parent-reports');
  }
  // Approving puts it in the parent's account (if they have one); WhatsApp, email or copy send it on as well
  async function approve(via) {
    setBusy(true);
    try {
      await saveWords();
      if (via === 'whatsapp') window.open(waLink(contact?.parent_phone, text), '_blank');
      else if (via === 'email') window.open(mailLink(contact?.parent_email, `Weekly report: ${d.learner}`, text), '_blank');
      else if (via === 'copy') await copyText(text);
      await api.markReportSent(r.id, via);
      invalidate('parent-reports');
      const inApp = parents > 0 ? `It’s in ${parents === 1 ? 'the parent’s account' : 'the parents’ accounts'}. ` : '';
      toast({
        title: 'Approved',
        body:
          inApp +
          (via === 'whatsapp' ? 'WhatsApp opened with the report written. Press send there.' : via === 'email' ? 'Your email app opened with the report written. Press send there.' : via === 'copy' ? 'Copied: paste it wherever you like.' : ''),
      });
      onClose();
    } catch (e) {
      toast({ title: 'Couldn’t approve it', body: e.message, tone: 'bad' });
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

  const byMessage = !!contact?.enabled;
  const canSend = byMessage || parents > 0;
  return (
    <div className="stack">
      {!canSend && !sent && (
        <div className="note small">
          {d.learner} has no parent linked yet, so you can read it and write your comment, but not approve it. Invite a parent from {d.learner}’s Parents tab, or {d.learner} can switch on WhatsApp or email reports in their Settings.
        </div>
      )}
      {thisWeek && !sent && <div className="tiny muted">This week so far, as of now. It fills itself in every day; the finished report is ready to approve after the week ends.</div>}
      <div className="split side-r report-review">
        <ReportCard report={r} draft={!sent} />
        <div className="stack">
          {sent ? (
            <>
              <div className="small muted">Approved {ago(r.sent_at)}.</div>
              <div>
                <button className="btn" onClick={printReport}>
                  <Icon name="download" size={16} /> Print or save as PDF
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="small muted">
                StudyBridge filled in everything from {d.learner || 'the learner'}’s week. The only words you write are your comment and, if you like, next week’s plan.
              </div>
              <Field label="Your comment to the parent (optional)">
                <textarea className="textarea" value={r.comment || ''} onChange={(e) => set({ comment: e.target.value })} placeholder="What went well, and what to work on." />
              </Field>
              {usage?.ready && (
                <div>
                  <button className="btn sm claude" disabled={asked} onClick={askProf}>
                    <Icon name="cap" size={14} /> {asked ? 'Prof is thinking…' : 'Prof, suggest a comment'}
                  </button>
                </div>
              )}
              <Field label="Next week (optional)" hint="Leave it empty and the report lists what’s due next week.">
                <textarea className="textarea" style={{ minHeight: 70 }} value={r.next_week || ''} onChange={(e) => set({ next_week: e.target.value })} placeholder="What’s coming and what to practise at home." />
              </Field>
              <div className="small muted">
                {[parents > 0 && `${parents} parent account${parents === 1 ? '' : 's'}`, byMessage && contact.parent_phone && `WhatsApp ${contact.parent_phone}`, byMessage && contact.parent_email && contact.parent_email]
                  .filter(Boolean)
                  .join(' · ') || 'No parent yet'}
              </div>
              <div className="row wrap">
                <button className="btn" onClick={async () => (await saveWords(), toast('Saved'))}>
                  Save
                </button>
                {parents > 0 && (
                  <button className="btn primary" disabled={busy} onClick={() => approve('app')}>
                    <Icon name="check" size={18} /> Approve
                  </button>
                )}
                {byMessage && contact?.parent_phone && (
                  <button className={'btn' + (parents > 0 ? '' : ' primary')} disabled={busy} onClick={() => approve('whatsapp')}>
                    <Icon name="send" size={18} /> {parents > 0 ? 'Approve + WhatsApp' : 'Approve and send on WhatsApp'}
                  </button>
                )}
                {byMessage && contact?.parent_email && (
                  <button className="btn" disabled={busy} onClick={() => approve('email')}>
                    {parents > 0 ? 'Approve + email' : 'Approve and email'}
                  </button>
                )}
                {byMessage && (
                  <button className="btn ghost" disabled={busy} onClick={() => approve('copy')}>
                    <Icon name="copy" size={16} /> Approve + copy
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// How many finished weeks' reports are waiting to be sent (the server drafts them; see _refresh_reports)
export function useWeeklyReports() {
  const settings = useQuery('learner-reports', api.listLearnerReports);
  const reports = useQuery('parent-reports', api.listParentReports, { poll: 15 * 60000 });
  const parents = useQuery('parent-counts', api.myParentCounts).data || {};
  const monday = thisMonday();
  const enabled = new Set([...(settings.data || []).filter((x) => x.enabled).map((x) => x.learner_id), ...Object.keys(parents).filter((k) => parents[k] > 0)]);
  return (reports.data || []).filter((r) => r.status === 'draft' && String(r.week_start).slice(0, 10) < monday && enabled.has(r.learner_id)).length;
}
