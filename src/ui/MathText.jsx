// A text box for feedback, comments and solutions that shows maths and formatting as they'll look
// (x² − 25, bold, lists) instead of the code behind them ($x^2-25$, **bold**). Click it to edit; a small
// maths keyboard adds powers, roots and fractions without typing any code.
import { useRef, useState } from 'react';
import Icon from './Icon.jsx';
import { Markdown } from './kit.jsx';

const KEYS = [
  { label: 'x²', insert: '$x^{2}$', title: 'Power' },
  { label: '√', insert: '$\\sqrt{x}$', title: 'Square root' },
  { label: 'a⁄b', insert: '$\\frac{a}{b}$', title: 'Fraction' },
  { label: '×', insert: '×' },
  { label: '÷', insert: '÷' },
  { label: '±', insert: '±' },
  { label: '≤', insert: '≤' },
  { label: '≥', insert: '≥' },
  { label: '≠', insert: '≠' },
  { label: 'π', insert: 'π' },
  { label: '°', insert: '°' },
];

export default function MathText({ value, onChange, placeholder = '', minHeight = 64, label, disabled = false }) {
  const [editing, setEditing] = useState(false);
  const box = useRef(null);
  const area = useRef(null);
  const text = value || '';

  if ((!editing && text.trim()) || disabled)
    return (
      <div
        className={'mt-view' + (disabled ? ' disabled' : '')}
        role={disabled ? undefined : 'button'}
        tabIndex={disabled ? undefined : 0}
        aria-label={label ? `${label}: click to edit` : 'Click to edit'}
        onClick={() => !disabled && setEditing(true)}
        onKeyDown={(e) => !disabled && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), setEditing(true))}
        style={{ minHeight }}
      >
        {text.trim() ? <Markdown src={text} /> : <span className="muted">{placeholder}</span>}
        {!disabled && (
          <span className="mt-edit">
            <Icon name="pen" size={13} /> Edit
          </span>
        )}
      </div>
    );

  function insert(s) {
    const el = area.current;
    const start = el?.selectionStart ?? text.length;
    const end = el?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + s + text.slice(end);
    onChange(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + s.length, start + s.length);
    });
  }
  return (
    <div
      className="mt-edit-box"
      ref={box}
      onBlur={(e) => {
        // back to the finished look when focus leaves the box (not when using the maths keys)
        if (!box.current?.contains(e.relatedTarget)) setEditing(false);
      }}
    >
      <textarea
        ref={area}
        className="textarea"
        style={{ minHeight }}
        autoFocus={editing}
        value={text}
        aria-label={label}
        placeholder={placeholder}
        onFocus={() => setEditing(true)}
        onChange={(e) => onChange(e.target.value)}
      />
      {editing && (
        <div className="mt-keys" role="group" aria-label="Maths keys">
          {KEYS.map((k) => (
            <button key={k.label} type="button" className="mt-key" title={k.title || k.label} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(k.insert)}>
              {k.label}
            </button>
          ))}
          {/\$|\*\*/.test(text) && (
            <span className="mt-preview">
              <span className="tiny muted">Looks like: </span>
              <Markdown src={text} />
            </span>
          )}
        </div>
      )}
    </div>
  );
}
