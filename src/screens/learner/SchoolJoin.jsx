// A student who signed up with their school email, before they're in a class: confirm the email (a 6-digit code), or
// wait for a teacher to add them (or type a class code). StudyBridge opens as soon as they're in a class.
import { useEffect, useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Loading, Page, useToast } from '../../ui/kit.jsx';
import { useQuery } from '../../lib/data.js';
import * as api from '../../lib/api.js';

export function SchoolWaiting() {
  const app = useApp();
  const toast = useToast();
  const q = useQuery('my-school', api.mySchool);
  const s = q.data;
  const [code, setCode] = useState('');
  const [classCode, setClassCode] = useState('');
  const [busy, setBusy] = useState(false);
  // a teacher may add them any moment: look every 15 seconds, and open StudyBridge once they're in a class
  useEffect(() => {
    const t = setInterval(() => q.refresh(), 15000);
    return () => clearInterval(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (s?.classes > 0) app.refreshMe();
  }, [s?.classes]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!s) return <Page title="Your school">{q.error ? <div className="error">{q.error.message}</div> : <Loading />}</Page>;

  async function confirm(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.confirmSchoolEmail(code);
      if (r?.state === 'wrong') toast({ title: 'That code isn’t right', body: r.left > 0 ? `Check the email and try again (${r.left} more tries).` : 'Ask for a new code.', tone: 'bad' });
      else {
        setCode('');
        toast(`Thanks! You’re in ${s.name}.`);
      }
      q.refresh();
      app.refreshMe();
    } catch (x) {
      toast({ title: 'Couldn’t check the code', body: x.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  async function resend() {
    try {
      await api.sendSchoolCode();
      toast(`A new code is on its way to ${s.email}`);
      q.refresh();
    } catch (x) {
      toast({ title: 'Couldn’t send a code', body: x.message, tone: 'bad' });
    }
  }
  async function joinClass(e) {
    e.preventDefault();
    try {
      const r = await api.joinClass(classCode);
      toast(`You’re in ${r?.class || 'the class'}`);
      setClassCode('');
      app.refreshMe();
    } catch (x) {
      toast({ title: 'Couldn’t join the class', body: x.message, tone: 'bad' });
    }
  }
  return (
    <Page title={`You’re in ${s.name}`} subtitle="Your teachers add you to your classes. StudyBridge opens here as soon as they do.">
      {!s.ok && s.email_on && (
        <form className="card" onSubmit={confirm}>
          <h2>Check your school email</h2>
          <div className="small">
            {s.code_sent ? `We sent a 6-digit code to ${s.email}. Type it here so your school knows it’s really you.` : `We’ll send a 6-digit code to ${s.email} so your school knows it’s really you.`}
          </div>
          {s.code_sent && (
            <div className="row wrap" style={{ gap: 8 }}>
              <input className="input code-in" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" inputMode="numeric" autoComplete="one-time-code" aria-label="6-digit code" style={{ maxWidth: 180 }} />
              <button className="btn primary" disabled={busy || code.replace(/\D/g, '').length !== 6}>
                Confirm
              </button>
            </div>
          )}
          <button type="button" className={s.code_sent ? 'linkbtn small' : 'btn'} onClick={resend} style={{ alignSelf: 'flex-start' }}>
            {s.code_sent ? 'Send a new code' : 'Email me a code'}
          </button>
        </form>
      )}
      {!s.ok && !s.email_on && (
        <div className="note small" role="status">
          Your teacher lets you in when they add you to a class.
        </div>
      )}
      <div className="card">
        <div className="row" style={{ gap: 12 }}>
          <Icon name="clock" size={22} style={{ color: 'var(--accent)' }} />
          <div className="grow">
            <div className="strong">Waiting for your classes</div>
            <div className="small muted">Your teachers can see you’re here. Once they add you to a class, its work and news show up.</div>
          </div>
        </div>
        <form className="stack sm" onSubmit={joinClass}>
          <label className="label" htmlFor="class-code">
            Got a class code from your teacher?
          </label>
          <div className="row wrap" style={{ gap: 8 }}>
            <input id="class-code" className="input code-in" value={classCode} onChange={(e) => setClassCode(e.target.value)} placeholder="4829 1375" inputMode="numeric" style={{ maxWidth: 200 }} />
            <button className="btn" disabled={classCode.replace(/\D/g, '').length !== 8}>
              Join the class
            </button>
          </div>
        </form>
      </div>
    </Page>
  );
}
