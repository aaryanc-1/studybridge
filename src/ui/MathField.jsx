import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { MathfieldElement } from 'mathlive';
import { latexToHtml } from '../lib/markdown.js';

MathfieldElement.fontsDirectory = new URL('./mathlive/fonts/', document.baseURI).href;
MathfieldElement.soundsDirectory = new URL('./mathlive/sounds/', document.baseURI).href;
MathfieldElement.plonkSound = null;
MathfieldElement.keypressSound = null;

// Maths input box (type maths naturally: x^2, 3/4, sqrt, etc.)
const MathField = forwardRef(function MathField({ value, onChange, onEnter, onBackspaceEmpty, placeholder, label, readOnly, className = '', autoFocus }, ref) {
  const el = useRef(null);
  const cb = useRef({ onChange, onEnter, onBackspaceEmpty });
  cb.current = { onChange, onEnter, onBackspaceEmpty };
  useImperativeHandle(ref, () => ({ focus: () => el.current?.focus(), el: el.current }));

  useEffect(() => {
    const mf = el.current;
    if (!mf) return;
    mf.smartFence = true;
    mf.mathVirtualKeyboardPolicy = 'auto';
    const onInput = (e) => {
      if (e.inputType === 'insertLineBreak') return;
      cb.current.onChange?.(mf.value);
    };
    const onKey = (e) => {
      if (e.key === 'Enter' && cb.current.onEnter) {
        e.preventDefault();
        cb.current.onEnter();
      }
      if (e.key === 'Backspace' && !mf.value && cb.current.onBackspaceEmpty) {
        e.preventDefault();
        cb.current.onBackspaceEmpty();
      }
    };
    mf.addEventListener('input', onInput);
    mf.addEventListener('keydown', onKey, { capture: true });
    if (autoFocus) setTimeout(() => mf.focus(), 30);
    return () => {
      mf.removeEventListener('input', onInput);
      mf.removeEventListener('keydown', onKey, { capture: true });
    };
  }, [autoFocus]);

  useEffect(() => {
    const mf = el.current;
    if (mf && mf.value !== (value || '')) mf.setValue(value || '', { silenceNotifications: true });
  }, [value]);

  useEffect(() => {
    if (el.current) el.current.readOnly = !!readOnly;
  }, [readOnly]);

  const ph = placeholder && !placeholder.includes('\\') && !/[=^_]/.test(placeholder) ? `\\text{${placeholder}}` : placeholder;
  return <math-field ref={el} class={className} placeholder={ph} aria-label={label} />;
});

export default MathField;

export function MathStatic({ latex, className = '' }) {
  return <span className={className} dangerouslySetInnerHTML={{ __html: latexToHtml(latex || '', true) }} />;
}
