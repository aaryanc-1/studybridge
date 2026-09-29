// Checks a learner's line-by-line working: does each line follow from the one before?
// Plain maths (no AI): lines are compared numerically at random points.
// Used on the tutor's marking screen as a hint; the tutor always decides the marks.
let cePromise = null;
async function engine() {
  if (!cePromise) cePromise = import('@cortex-js/compute-engine').then((m) => new m.ComputeEngine());
  return cePromise;
}

const SAMPLES = [-2.7, -1.3, -0.4, 0.6, 1.7, 2.9, 4.1, 7.3];

function evalAt(expr, vars, t) {
  const env = {};
  vars.forEach((v, i) => (env[v] = SAMPLES[(t + i * 3) % SAMPLES.length] + i * 0.37));
  try {
    const r = expr.subs(env).N();
    const x = typeof r.re === 'number' ? r.re : Number(r.valueOf());
    const im = typeof r.im === 'number' ? r.im : 0;
    return Number.isFinite(x) && Math.abs(im) < 1e-9 ? x : NaN;
  } catch {
    return NaN;
  }
}

function describe(ce, latex) {
  const clean = String(latex || '')
    .replace(/\\(?:quad|qquad|,|;|!)/g, ' ')
    .replace(/\\therefore|\\Rightarrow|\\implies|\\to/g, '')
    .trim();
  if (!clean) return null;
  let e;
  try {
    e = ce.parse(clean);
  } catch {
    return null;
  }
  if (!e || !e.isValid) return null;
  const op = e.operator;
  if (op === 'Equal') {
    const g = ce.box(['Subtract', e.op1, e.op2]);
    return { kind: 'eq', g, vars: e.unknowns || [] };
  }
  if (op === 'Or' || op === 'List' || op === 'Sequence' || op === 'Delimiter') {
    const items = (e.ops || []).filter((x) => x.operator === 'Equal' && x.op1.symbol && x.op2.isNumberLiteral);
    if (items.length && items.length === (e.ops || []).length) {
      return { kind: 'roots', var: items[0].op1.symbol, values: items.map((x) => Number(x.op2.N().re)) };
    }
    return null;
  }
  if (['Less', 'Greater', 'LessEqual', 'GreaterEqual', 'NotEqual'].includes(op)) return null;
  return { kind: 'expr', f: e, vars: e.unknowns || [] };
}

const close = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a), Math.abs(b));

// Roots of a one-variable equation g(x) = 0 in [-60, 60]
function roots(g, v) {
  const out = [];
  const f = (x) => {
    try {
      const r = g.subs({ [v]: x }).N();
      return typeof r.re === 'number' ? r.re : NaN;
    } catch {
      return NaN;
    }
  };
  const N = 1200;
  let px = -60;
  let py = f(px);
  for (let i = 1; i <= N; i++) {
    const x = -60 + (120 * i) / N;
    const y = f(x);
    if (Math.abs(y) < 1e-12) out.push(x);
    else if (Number.isFinite(py) && Number.isFinite(y) && py * y < 0) {
      let a = px;
      let b = x;
      for (let k = 0; k < 60; k++) {
        const m = (a + b) / 2;
        if (f(a) * f(m) <= 0) b = m;
        else a = m;
      }
      out.push((a + b) / 2);
    }
    px = x;
    py = y;
  }
  return [...new Set(out.map((r) => Math.round(r * 1e6) / 1e6))].sort((a, b) => a - b);
}

function sameSet(a, b) {
  if (a.length !== b.length) return false;
  const x = [...a].sort((p, q) => p - q);
  const y = [...b].sort((p, q) => p - q);
  return x.every((v, i) => Math.abs(v - y[i]) < 1e-4);
}

function follows(prev, cur) {
  if (!prev || !cur) return 'unknown';
  if (prev.kind === 'expr' && cur.kind === 'expr') {
    const vars = [...new Set([...prev.vars, ...cur.vars])];
    let n = 0;
    for (let t = 0; t < SAMPLES.length; t++) {
      const a = evalAt(prev.f, vars, t);
      const b = evalAt(cur.f, vars, t);
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      if (!close(a, b)) return 'check';
      n++;
    }
    return n >= 3 ? 'ok' : 'unknown';
  }
  if (prev.kind === 'eq' && cur.kind === 'eq') {
    const vars = [...new Set([...prev.vars, ...cur.vars])];
    // Same equation rearranged: (lhs - rhs) differs only by a constant factor
    let ratio = null;
    let n = 0;
    let proportional = true;
    for (let t = 0; t < SAMPLES.length; t++) {
      const a = evalAt(prev.g, vars, t);
      const b = evalAt(cur.g, vars, t);
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      if (Math.abs(a) < 1e-12 && Math.abs(b) < 1e-12) continue;
      if (Math.abs(b) < 1e-12 || Math.abs(a) < 1e-12) {
        proportional = false;
        break;
      }
      const r = a / b;
      if (ratio === null) ratio = r;
      else if (!close(ratio, r)) {
        proportional = false;
        break;
      }
      n++;
    }
    if (proportional && n >= 3) return 'ok';
    if (vars.length === 1) {
      const r1 = roots(prev.g, vars[0]);
      const r2 = roots(cur.g, vars[0]);
      if (r1.length && sameSet(r1, r2)) return 'ok';
      if (r1.length || r2.length) return 'check';
    }
    return n >= 3 || !proportional ? 'check' : 'unknown';
  }
  if (prev.kind === 'eq' && cur.kind === 'roots' && prev.vars.length === 1 && prev.vars[0] === cur.var) {
    return sameSet(roots(prev.g, cur.var), cur.values) ? 'ok' : 'check';
  }
  if (prev.kind === 'roots' && cur.kind === 'roots') {
    return prev.var === cur.var && sameSet(prev.values, cur.values) ? 'ok' : 'check';
  }
  if (prev.kind === 'roots' && cur.kind === 'eq' && cur.vars.length === 1 && cur.vars[0] === prev.var) {
    return sameSet(prev.values, roots(cur.g, prev.var)) ? 'ok' : 'check';
  }
  return 'unknown';
}

// Returns one entry per line: 'first' | 'ok' | 'check' | 'unknown', plus whether the last line matches the key
export async function checkSteps(lines, keyFinal) {
  const ce = await engine();
  const d = lines.map((l) => describe(ce, l));
  const result = d.map((cur, i) => (i === 0 ? (cur ? 'first' : 'unknown') : follows(d[i - 1], cur)));
  let final = null;
  if (keyFinal && lines.length) {
    const k = describe(ce, keyFinal);
    const last = d[d.length - 1];
    if (k && last) {
      const s = follows(k, last);
      final = s === 'ok' ? true : s === 'check' ? false : null;
    }
  }
  return { steps: result, final };
}
