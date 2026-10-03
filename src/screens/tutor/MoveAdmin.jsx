// Admin used to live inside the first tutor's account. Now it's its own account, so a tutor account that still holds admin sees this page once to move it.
import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Field, Page, useToast } from '../../ui/kit.jsx';
import * as api from '../../lib/api.js';

export function MoveAdmin() {
  const app = useApp();
  const toast = useToast();
  const suggestion = app.me.email?.includes('@') ? app.me.email.replace('@', '+admin@') : '';
  const [email, setEmail] = useState(suggestion);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(null);
  async function move(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.adminMoveTo(email.trim());
      if (r.moved) {
        toast({ title: 'Admin moved', body: `Sign in as ${r.email} to open Admin.` });
        await app.refreshMe();
      } else setWaiting(r.email);
    } catch (x) {
      toast({ title: 'Couldn’t move admin', body: x.message, tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }
  return (
    <Page title="Admin has its own account now" size="narrow" subtitle="Your tutor account is for teaching. Approving tutors, StudyBridge’s keys and the shared questions now live in a separate admin account. You sign in to it on the same sign-in page, with its own email and password.">
      <div className="card">
        {waiting ? (
          <>
            <div className="okmsg">Saved. {waiting} will be the admin account.</div>
            <ol className="small steps">
              <li>Sign out of this tutor account (Settings → Sign out).</li>
              <li>
                On the sign-in screen choose <b>Create a tutor account</b> and use <b>{waiting}</b> with a new password. StudyBridge recognises it and won’t make it a tutor.
              </li>
              <li>
                Choose <b>Set up admin account</b>.
              </li>
              <li>Admin opens. From then on, sign in with that email to open Admin, and with your usual email to teach.</li>
            </ol>
            <div className="small muted">Until then, this tutor account keeps the admin role. Afterwards it’s only a tutor.</div>
            <div>
              <button className="btn" onClick={() => setWaiting(null)}>
                Use a different email
              </button>
            </div>
          </>
        ) : (
          <form className="stack" onSubmit={move}>
            <Field label="Email for the admin account" hint="A different email from your tutor one. A Gmail “+admin” address works and arrives in the same inbox." >
              <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you+admin@gmail.com" autoComplete="off" />
            </Field>
            <div>
              <button className="btn primary" disabled={busy || !email.includes('@')}>
                <Icon name="shield" size={16} /> Make this the admin account
              </button>
            </div>
            <div className="small muted">If that account already exists (and isn’t a tutor or learner), admin moves straight away. Otherwise you’ll create it next.</div>
          </form>
        )}
      </div>
    </Page>
  );
}
