// Parents and children studying on their own (launch 1): the code a parent makes for their child to sign up with
// (needed below grade 8), and following a child with a parent code. Used on the parent's Home and in Settings.
import { useState } from 'react';
import { useApp } from '../../App.jsx';
import Icon from '../../ui/Icon.jsx';
import { Field, copyText, useConfirm, useToast } from '../../ui/kit.jsx';
import { useQuery, invalidate } from '../../lib/data.js';
import * as api from '../../lib/api.js';
import { GRADES } from '../../lib/students.js';

// A parent sets up a child who studies on their own: the code the child signs up with (8 digits)
export function SetUpChild() {
  const toast = useToast();
  const confirm = useConfirm();
  const codes = useQuery('child-codes', api.parentChildCodes);
  const [name, setName] = useState('');
  const [grade, setGrade] = useState('');
  const [busy, setBusy] = useState(false);
  const pretty = (c) => `${c.slice(0, 4)} ${c.slice(4)}`;
  const message = (c) =>
    `${c.name}, here’s your StudyBridge code: ${pretty(c.code)}. Open ${api.WEB_APP}#start=student, choose “I’m studying on my own”, pick your grade and type the code.`;
  return (
    <div className="card stack" id="set-child">
      <h2>Set up your child to study on their own</h2>
      <div className="muted small">
        Make a code, then your child signs up with it on their own phone or computer. Below grade 8 they need it: it shows you agreed. Their free week starts when they sign up, and you can follow their plan and progress here.
      </div>
      <div className="grid g2" style={{ gap: 12 }}>
        <Field label="Your child’s first name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Their grade">
          <select className="select" value={grade} onChange={(e) => setGrade(e.target.value)}>
            <option value="">Choose…</option>
            {[[1, 'Grade 1'], [2, 'Grade 2'], [3, 'Grade 3'], [4, 'Grade 4'], [5, 'Grade 5'], ...GRADES].map(([g, label]) => (
              <option key={g} value={g}>
                {label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div>
        <button
          className="btn primary"
          disabled={busy || !name.trim() || !grade}
          onClick={async () => {
            setBusy(true);
            try {
              await api.parentChildCode(name.trim(), Number(grade));
              invalidate('child-codes');
              setName('');
              setGrade('');
            } catch (e) {
              toast({ title: 'Couldn’t make a code', body: e.message, tone: 'bad' });
            } finally {
              setBusy(false);
            }
          }}
        >
          Make a code
        </button>
      </div>
      {(codes.data || []).length > 0 && (
        <div className="stack sm">
          {codes.data.map((c) => (
            <div key={c.id} className="code-card">
              <span className="small">
                <b>{c.name}</b>’s code
              </span>
              <b className="code-show">{pretty(c.code)}</b>
              <span className="small muted">Waiting for {c.name} to sign up with it</span>
              <span className="row wrap" style={{ gap: 8 }}>
              <button
                className="btn sm"
                onClick={async () => {
                  await copyText(message(c));
                  toast('Copied: send it to your child');
                }}
              >
                <Icon name="copy" size={14} /> Copy message
              </button>
              <button
                className="btn sm ghost"
                onClick={async () => {
                  if (!(await confirm({ title: `Cancel ${c.name}’s code?`, body: 'It stops working. You can make a new one any time.', ok: 'Cancel code', danger: true }))) return;
                  try {
                    await api.parentCancelChildCode(c.id);
                    invalidate('child-codes');
                  } catch (e) {
                    toast({ title: 'Couldn’t cancel it', body: e.message, tone: 'bad' });
                  }
                }}
              >
                Cancel
              </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Following another child with a parent code (from their tutor, or from a child studying on their own)
export function AddWithCode() {
  const app = useApp();
  const toast = useToast();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="card stack">
      <h2>Have a parent code?</h2>
      <div className="muted small">From your child’s tutor, or from your child’s own StudyBridge (Settings → Your parents). It starts with P.</div>
      <div className="row wrap">
        <input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="P3A9F04C21B" aria-label="Parent code" style={{ maxWidth: 240 }} />
        <button
          className="btn"
          disabled={busy || code.trim().length < 6}
          onClick={async () => {
            setBusy(true);
            try {
              const m = code.trim().toUpperCase().match(/P[0-9A-F]{10}/);
              await api.acceptParentInvite(m ? m[0] : code.trim(), app.me.display_name);
              invalidate('parent-children');
              setCode('');
              toast('Linked');
            } catch (e) {
              toast({ title: 'That code didn’t work', body: e.message, tone: 'bad' });
            } finally {
              setBusy(false);
            }
          }}
        >
          Link my child
        </button>
      </div>
    </div>
  );
}
