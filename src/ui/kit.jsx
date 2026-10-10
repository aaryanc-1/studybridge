import { Component, Children, cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import Icon from './Icon.jsx';
import { renderMarkdown } from '../lib/markdown.js';
import { initials, colorFor, toLocalInput, fromLocalInput, when } from '../lib/format.js';

// ---------------- routing (#/path) ----------------
function readHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = h.split('?');
  return { path, parts: path.split('/').filter(Boolean), query: new URLSearchParams(qs || '') };
}
let route = readHash();
let lastHash = location.hash;
const routeSubs = new Set();
// A page with unsaved changes asks before you leave it (see useLeaveGuard)
let leaveGuard = null;
const mayLeave = () => !leaveGuard || leaveGuard();
window.addEventListener('hashchange', () => {
  if (!mayLeave()) {
    history.pushState(null, '', lastHash || '#/'); // stay on the page (the back button was pressed)
    return;
  }
  lastHash = location.hash;
  route = readHash();
  routeSubs.forEach((f) => f());
});
// Editors with unsaved changes: leaving the page (a link, the menu, the back button) asks first.
// Their own "go" after saving passes { force: true }.
export function useLeaveGuard(dirty, message = 'You have unsaved changes. Leave without saving them?') {
  useEffect(() => {
    if (!dirty) return;
    const g = () => window.confirm(message);
    leaveGuard = g;
    // closing the browser tab too (not in the desktop app, where it would stop the window closing)
    const before = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    if (!window.studybridge) window.addEventListener('beforeunload', before);
    return () => {
      if (leaveGuard === g) leaveGuard = null;
      window.removeEventListener('beforeunload', before);
    };
  }, [dirty, message]);
}
export function useRoute() {
  return useSyncExternalStore(
    (f) => (routeSubs.add(f), () => routeSubs.delete(f)),
    () => route,
  );
}
export function go(path, { replace = false, force = false } = {}) {
  if (!force && !mayLeave()) return;
  if (force) leaveGuard = null;
  const h = '#' + path;
  if (replace) history.replaceState(null, '', h);
  else if (location.hash !== h) history.pushState(null, '', h);
  lastHash = location.hash;
  route = readHash();
  routeSubs.forEach((f) => f());
  document.querySelector('.content')?.scrollTo(0, 0);
}
export function Link({ to, children, className, ...rest }) {
  return (
    <a
      href={'#' + to}
      className={className}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        go(to);
      }}
      {...rest}
    >
      {children}
    </a>
  );
}

// ---------------- toasts ----------------
const ToastCtx = createContext(null);
export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((t) => {
    const id = Math.random().toString(36).slice(2);
    const item = typeof t === 'string' ? { title: t } : t;
    setItems((x) => [...x.slice(-3), { id, ...item }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), item.ms || 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div
            key={t.id}
            className={'toast ' + (t.tone || '')}
            onClick={() => {
              t.onClick?.();
              setItems((x) => x.filter((i) => i.id !== t.id));
            }}
          >
            <div>
              <div className="t">{t.title}</div>
              {t.body && <div className="b">{t.body}</div>}
            </div>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------------- modal + confirm ----------------
export function Modal({ title, children, onClose, wide, foot, label }) {
  useEffect(() => {
    const k = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true" aria-label={label || title}>
        {title && (
          <div className="row between">
            <h2>{title}</h2>
            {onClose && (
              <button className="btn ghost icon sm" onClick={onClose} aria-label="Close">
                <Icon name="x" />
              </button>
            )}
          </div>
        )}
        {children}
        {foot && <div className="foot">{foot}</div>}
      </div>
    </div>
  );
}

const ConfirmCtx = createContext(null);
export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null);
  const ask = useCallback(
    (opts) =>
      new Promise((resolve) => {
        setState({ ...opts, resolve });
      }),
    [],
  );
  const close = (v) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {state && (
        <Modal
          title={state.title}
          onClose={() => close(false)}
          foot={
            <>
              <button className="btn" onClick={() => close(false)}>
                {state.cancel || 'Cancel'}
              </button>
              <button className={'btn ' + (state.danger ? 'danger solid' : 'primary')} onClick={() => close(true)} autoFocus>
                {state.ok || 'OK'}
              </button>
            </>
          }
        >
          {state.body && <div className="muted">{state.body}</div>}
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}
export const useConfirm = () => useContext(ConfirmCtx);

// ---------------- small parts ----------------
export function Field({ label, hint, children, error }) {
  const id = useId();
  const only = Children.count(children) === 1 && isValidElement(children) && typeof children.type === 'string' ? children : null;
  const inputId = only ? only.props.id || id : null;
  return (
    <div className="field">
      {label && (inputId ? <label htmlFor={inputId}>{label}</label> : <span className="label">{label}</span>)}
      {only ? cloneElement(only, { id: inputId }) : children}
      {hint && <div className="hint">{hint}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

export function Seg({ value, onChange, options, label }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}>
          {o.icon && <Icon name={o.icon} size={16} />}
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ checked, onChange, title, sub, icon, disabled }) {
  return (
    <div
      className="toggle"
      role="switch"
      aria-checked={!!checked}
      aria-label={title}
      tabIndex={0}
      aria-disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), !disabled && onChange(!checked))}
    >
      <div className="grow">
        <div className="t">
          {icon && <Icon name={icon} size={17} />}
          {title}
        </div>
        {sub && <div className="s">{sub}</div>}
      </div>
      <span className="switch" />
    </div>
  );
}

export function Avatar({ person, size = '' }) {
  const name = person?.display_name || person?.email || '?';
  return (
    <span className={'avatar ' + size} style={{ background: person?.avatar_color || colorFor(person?.id || name) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function Markdown({ src, className = '' }) {
  const html = useMemo(() => renderMarkdown(src), [src]);
  return <div className={'md ' + className} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="loading">
      <div className="spinner" />
      {label}
    </div>
  );
}

export function Empty({ title, children, action }) {
  return (
    <div className="empty">
      {title && <div className="big">{title}</div>}
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div className="error">{error.message || String(error)}</div>;
}

export function Page({ eyebrow, title, subtitle, actions, children, size = '' }) {
  return (
    <div className={'page ' + size}>
      {(title || actions) && (
        <div className="head">
          <div>
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            {title && <h1 className="title">{title}</h1>}
            {subtitle && <div className="subtitle">{subtitle}</div>}
          </div>
          {actions && <div className="actions">{actions}</div>}
        </div>
      )}
      {children}
    </div>
  );
}

// Hidden / visible now / visible from a date
export function VisibilityPicker({ value, from, onChange }) {
  return (
    <div className="stack sm">
      <Seg
        label="Who can see this"
        value={value}
        onChange={(v) => onChange(v, v === 'scheduled' ? from || new Date(Date.now() + 86400000).toISOString() : from)}
        options={[
          { value: 'hidden', label: 'Hidden', icon: 'eyeOff' },
          { value: 'visible', label: 'Visible now', icon: 'eye' },
          { value: 'scheduled', label: 'From a date', icon: 'calendar' },
        ]}
      />
      {value === 'scheduled' && (
        <input
          className="input"
          type="datetime-local"
          aria-label="Visible from"
          value={toLocalInput(from)}
          onChange={(e) => onChange('scheduled', fromLocalInput(e.target.value))}
        />
      )}
    </div>
  );
}

export function visibilityText(item) {
  // a draft (from Prof or Claude) is hidden from learners until the tutor approves it, whatever it's set to
  if (item.draft) return { text: 'Hidden until you approve', tone: 'claude', icon: 'eyeOff' };
  if (item.visibility === 'visible') return { text: 'Visible', tone: 'good', icon: 'eye' };
  if (item.visibility === 'scheduled') {
    const live = item.visible_from && new Date(item.visible_from) <= new Date();
    return live ? { text: 'Visible', tone: 'good', icon: 'eye' } : { text: `From ${when(item.visible_from)}`, tone: 'warn', icon: 'calendar' };
  }
  return { text: 'Hidden', tone: '', icon: 'eyeOff' };
}
export function VisibilityPill({ item }) {
  const v = visibilityText(item);
  return (
    <span className={'pill ' + v.tone}>
      <Icon name={v.icon} size={13} />
      {v.text}
    </span>
  );
}

// Everyone taking the subject, or chosen learners
export function AudiencePicker({ learners, value, onChange }) {
  const chosen = value || [];
  const everyone = chosen.length === 0;
  return (
    <div className="stack sm">
      <Seg
        label="Audience"
        value={everyone ? 'all' : 'some'}
        onChange={(v) => onChange(v === 'all' ? [] : learners.slice(0, 1).map((l) => l.id))}
        options={[
          { value: 'all', label: 'Everyone in the subject' },
          { value: 'some', label: 'Chosen learners' },
        ]}
      />
      {!everyone && (
        <div className="chips">
          {learners.map((l) => {
            const on = chosen.includes(l.id);
            return (
              <button
                key={l.id}
                type="button"
                className={'pill ' + (on ? 'accent' : '')}
                style={{ cursor: 'pointer', border: 0, padding: '6px 12px' }}
                aria-pressed={on}
                onClick={() => onChange(on ? chosen.filter((x) => x !== l.id) : [...chosen, l.id])}
              >
                {on && <Icon name="check" size={13} />}
                {l.display_name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function useDebounced(fn, ms = 700) {
  const t = useRef(null);
  const f = useRef(fn);
  f.current = fn;
  useEffect(() => () => clearTimeout(t.current), []);
  return useCallback(
    (...args) => {
      clearTimeout(t.current);
      t.current = setTimeout(() => f.current(...args), ms);
    },
    [ms],
  );
}

export function Stat({ n, l }) {
  return (
    <div className="stat">
      <div className="n">{n}</div>
      <div className="l">{l}</div>
    </div>
  );
}

export function Bar({ value, tone = '' }) {
  const v = Math.max(0, Math.min(100, value || 0));
  return (
    <div className={'bar ' + tone} role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <span style={{ width: v + '%' }} />
    </div>
  );
}

export function copyText(t) {
  try {
    navigator.clipboard.writeText(t);
    return true;
  } catch {
    return false;
  }
}

// Keeps one broken screen from blanking the whole app
export class ErrorBoundary extends Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.warn('Screen error:', error);
    import('../lib/errors.js').then((m) => m.reportError(error, `${error?.stack || ''}\n${info?.componentStack || ''}`.trim())).catch(() => {});
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page narrow">
        <div className="card warn">
          <h2>Something went wrong on this screen</h2>
          <div className="small muted">{String(this.state.error?.message || this.state.error)}</div>
          <div className="row">
            <button className="btn primary" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button className="btn" onClick={() => (location.hash = '#/', location.reload())}>
              Go home
            </button>
          </div>
        </div>
      </div>
    );
  }
}
