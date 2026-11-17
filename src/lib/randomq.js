// Random-number questions (Canvas gaps part 2, 17 Nov 2026): a number question whose text has letters like {a} and {b},
// each learner getting their own numbers (picked by the server when they start) and an answer worked out from a formula.
// The server works out the real answers (_formula_value in setup.sql); this is for showing a learner's numbers and for the
// editor's preview. Same rules: + - * / ^, brackets, sqrt abs round sin cos tan ln log exp, pi, and the question's letters.

const FUNCS = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  round: Math.round,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  ln: Math.log,
  log: Math.log10,
  exp: Math.exp,
};
export const RESERVED = [...Object.keys(FUNCS), 'pi'];

// The question's text with this learner's numbers in place of {a}, {b}, …
export function fillVars(text, vars) {
  if (!vars || !text) return text || '';
  return String(text).replace(/\{([a-z]{1,2})\}/g, (m, k) => (vars[k] != null ? fmt(vars[k]) : m));
}
const fmt = (n) => {
  const x = Number(n);
  return Number.isInteger(x) ? String(x) : String(+x.toFixed(4));
};
// A question with its numbers filled in (for showing to a learner, or marking their answer)
export const withVars = (q, allVars) => (allVars && allVars[q.id] ? { ...q, prompt_md: fillVars(q.prompt_md, allVars[q.id]) } : q);

// A small, safe calculator: never eval
export function evalFormula(formula, vars = {}) {
  const src = String(formula || '').toLowerCase().trim();
  if (!src || src.length > 200 || !/^[a-z0-9_+*/^(). -]+$/.test(src)) return null;
  let i = 0;
  const peek = () => src[i];
  const skip = () => {
    while (src[i] === ' ') i++;
  };
  function number() {
    skip();
    const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i));
    if (m) {
      i += m[0].length;
      return Number(m[0]);
    }
    const w = /^[a-z_]+/.exec(src.slice(i));
    if (w) {
      i += w[0].length;
      const name = w[0];
      if (name === 'pi') return Math.PI;
      if (FUNCS[name]) {
        skip();
        if (peek() !== '(') throw new Error('bracket');
        i++;
        const v = expr();
        skip();
        if (peek() !== ')') throw new Error('bracket');
        i++;
        return FUNCS[name](v);
      }
      if (vars[name] == null) throw new Error('letter');
      return Number(vars[name]);
    }
    if (peek() === '(') {
      i++;
      const v = expr();
      skip();
      if (peek() !== ')') throw new Error('bracket');
      i++;
      return v;
    }
    // (as in the database: a minus sign binds first, so -2^2 is 4, and ^ goes left to right)
    if (peek() === '-') {
      i++;
      return -number();
    }
    throw new Error('number');
  }
  function power() {
    let b = number();
    for (;;) {
      skip();
      if (peek() !== '^') return b;
      i++;
      b = Math.pow(b, number());
    }
  }
  function term() {
    let v = power();
    for (;;) {
      skip();
      const c = peek();
      if (c === '*' || c === '/') {
        i++;
        const r = power();
        if (c === '/' && r === 0) throw new Error('zero');
        v = c === '*' ? v * r : v / r;
      } else return v;
    }
  }
  function expr() {
    let v = term();
    for (;;) {
      skip();
      const c = peek();
      if (c === '+' || c === '-') {
        i++;
        const r = term();
        v = c === '+' ? v + r : v - r;
      } else return v;
    }
  }
  try {
    const v = expr();
    skip();
    if (i < src.length || !Number.isFinite(v)) return null;
    return Math.round(v * 1e6) / 1e6;
  } catch {
    return null;
  }
}

// Example numbers for the editor's preview: each letter's lowest
export const sampleVars = (spec = []) => Object.fromEntries(spec.filter((v) => v.name).map((v) => [v.name, Number(v.min) || 0]));

// What's wrong with a question's letters (or nothing)
export function varsProblem(spec = []) {
  const seen = new Set();
  for (const v of spec) {
    const n = String(v.name || '').toLowerCase();
    if (!/^[a-z]{1,2}$/.test(n) || RESERVED.includes(n)) return 'Name each random number with one or two letters, like a or b.';
    if (seen.has(n)) return `“${n}” is there twice.`;
    seen.add(n);
    if (v.min === '' || v.max === '' || isNaN(Number(v.min)) || isNaN(Number(v.max)) || Number(v.min) > Number(v.max)) return `Give “${n}” a lowest and a highest number.`;
    if (v.step !== undefined && v.step !== '' && !(Number(v.step) > 0)) return `“${n}” needs a step above 0.`;
  }
  return null;
}
