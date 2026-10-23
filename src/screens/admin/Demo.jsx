// Admin → Demo: a pretend tuition centre made of fake accounts with sample work, so the Owner can see what every kind
// of user sees. "Open as" switches straight into any of them (only ever a demo account); the bar at the top of a demo
// account switches back. Demo accounts never show in Admin's numbers or lists and are never emailed.
import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Avatar, Page, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { forgetAccount } from '../../lib/accounts.js';
import { ago } from '../../lib/format.js';

// who each demo account is, and what they have to show
const WHO = {
  manager: ['Centre manager', 'Runs Riverside Tuition and doesn’t teach: the Centre page with every tutor and learner'],
  tutor1: ['Tutor', 'Year 10 maths: homework marked, a mock, a teaching plan, messages, a weekly lesson'],
  tutor2: ['Tutor', 'Year 11 physics, with a quiz waiting to be marked'],
  tutor3: ['Tutor', 'Year 9 biology: homework nobody has started yet (try Nudge on Home)'],
  learner1: ['Learner', 'Mercy’s class: homework marked and back, a mock grade, messages'],
  learner2: ['Learner', 'Mercy’s class: homework still to do'],
  learner3: ['Learner', 'Daniel’s class: a quiz handed in, waiting for marks'],
  learner4: ['Learner', 'Daniel’s class: physics'],
  learner5: ['Learner', 'Joseph’s class: biology homework to start'],
  learner6: ['Learner', 'Joseph’s class: biology'],
  parent: ['Parent', 'Chipo’s mum: last week’s report, and she follows Lina too'],
  student: ['Student on their own', 'A plan to the exams (a test student: never pays)'],
};

export default function DemoPage() {
  const app = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery('admin-demo', api.adminDemo);
  const d = q.data;
  const [busy, setBusy] = useState('');
  const [student, setStudent] = useState(true);
  const accounts = d?.accounts || [];

  async function act(what, fn) {
    setBusy(what);
    try {
      await fn();
    } catch (e) {
      toast({ title: 'That didn’t work', body: e.message, tone: 'bad' });
    } finally {
      setBusy('');
      invalidate('admin-demo');
    }
  }
  const make = () =>
    act('make', async () => {
      await api.makeDemo({ student: student && d?.content });
      toast('The demo is ready');
    });
  const remove = async (again) => {
    const ok = await confirm(
      again
        ? { title: 'Start the demo again?', body: 'Everything done in it so far goes, and it’s filled in fresh.', ok: 'Reset the demo' }
        : { title: 'Remove the demo?', body: 'Its accounts and everything in them are deleted. You can make it again any time.', ok: 'Remove the demo', danger: true },
    );
    if (!ok) return;
    act(again ? 'reset' : 'remove', async () => {
      await api.removeDemo();
      accounts.forEach((a) => forgetAccount(a.id)); // and off this device's account list
      if (again) await api.makeDemo({ student: accounts.some((a) => a.label === 'student') && d?.content });
      toast(again ? 'The demo is fresh again' : 'The demo is removed');
    });
  };

  return (
    <Page title="Demo" subtitle="A pretend tuition centre with fake accounts and sample work, to see what everyone sees. It never shows in Admin’s numbers and never sends emails.">
      {!d ? null : accounts.length === 0 ? (
        <div className="card stack">
          <h2>Make the demo</h2>
          <div className="small muted">It makes Riverside Tuition (demo), with:</div>
          <ul className="small" style={{ margin: 0, paddingLeft: 20 }}>
            <li>Grace Mwansa, the centre manager, and three tutors: Mercy Tembo (maths), Daniel Okafor (physics) and Joseph Lungu (biology)</li>
            <li>Six learners in three classes, with homework, a quiz, lesson notes, a weekly lesson, a teaching plan, a mock grade and messages</li>
            <li>Ruth Banda, a parent, with last week’s report</li>
            <li>Lina Haddad, a student on their own</li>
          </ul>
          <label className="check">
            <input type="checkbox" checked={student && !!d.content} disabled={!d.content} onChange={(e) => setStudent(e.target.checked)} />
            <span className="t">Include a student on their own</span>
            <span className="s">{d.content ? 'She studies the first subject that’s open (0607 if it is).' : 'Pick the content account first (Admin → Students).'}</span>
          </label>
          <div>
            <button className="btn primary" disabled={!!busy} onClick={make}>
              <Icon name="plus" size={18} /> {busy === 'make' ? 'Making the demo…' : 'Make the demo'}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="card stack">
            <div className="row between wrap">
              <h2>Open as…</h2>
              <span className="small muted">Made {ago(d.made_at)}</span>
            </div>
            <div className="small muted">Opening one switches this device to that account. The bar at the top of every demo screen brings you back here.</div>
            <div className="list">
              {accounts.map((a) => (
                <div key={a.id} className="item">
                  <Avatar person={{ id: a.id, display_name: a.name }} />
                  <span className="grow">
                    <span className="name">
                      {a.name} <span className="pill">{WHO[a.label]?.[0] || a.role}</span>
                    </span>
                    <span className="meta">{WHO[a.label]?.[1]}</span>
                  </span>
                  <button className="btn sm" disabled={!!busy} onClick={() => act('open', () => api.openDemo(app.me.id, a.id))}>
                    Open as {a.name.split(' ')[0]}
                  </button>
                </div>
              ))}
            </div>
          </div>
          <div className="card row wrap">
            <span className="grow small muted">Start again from the beginning, or take the demo away.</span>
            <button className="btn" disabled={!!busy} onClick={() => remove(true)}>
              {busy === 'reset' ? 'Starting again…' : 'Reset the demo'}
            </button>
            <button className="btn danger ghost" disabled={!!busy} onClick={() => remove(false)}>
              {busy === 'remove' ? 'Removing…' : 'Remove the demo'}
            </button>
          </div>
        </>
      )}
    </Page>
  );
}
