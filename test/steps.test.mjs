import test from 'node:test';
import assert from 'node:assert/strict';
import { checkSteps } from '../src/lib/steps.js';

test('linear equation working', async () => {
  const r = await checkSteps(['2x+3=7', '2x=4', 'x=2']);
  assert.deepEqual(r.steps, ['first', 'ok', 'ok']);
});
test('spots the wrong line', async () => {
  const r = await checkSteps(['2x+3=7', '2x=10', 'x=5']);
  assert.deepEqual(r.steps, ['first', 'check', 'ok']);
});
test('quadratics, factorising and the two answers', async () => {
  const r = await checkSteps(['x^2-5x+6=0', '(x-2)(x-3)=0', 'x=2 \\text{ or } x=3'], 'x=2\\text{ or }x=3');
  assert.deepEqual(r.steps, ['first', 'ok', 'ok']);
  assert.equal(r.final, true);
  const w = await checkSteps(['x^2=9', 'x=3']);
  assert.equal(w.steps[1], 'check', 'lost the negative root');
});
test('simplifying expressions', async () => {
  const r = await checkSteps(['(x+1)^2', 'x^2+2x+1', 'x^2+x+1']);
  assert.deepEqual(r.steps, ['first', 'ok', 'check']);
  const f = await checkSteps(['\\frac{1}{2}+\\frac{1}{3}', '\\frac{5}{6}'], '\\frac{5}{6}');
  assert.deepEqual(f.steps, ['first', 'ok']);
  assert.equal(f.final, true);
});
test('final answer against the key', async () => {
  const r = await checkSteps(['3x-1=11', '3x=12', 'x=4'], 'x=4');
  assert.equal(r.final, true);
  const w = await checkSteps(['3x-1=11', '3x=10', 'x=10/3'], 'x=4');
  assert.equal(w.final, false);
});
test('text it cannot read is left for the tutor', async () => {
  const r = await checkSteps(['\\text{area of the shape}', '12']);
  assert.equal(r.steps[1], 'unknown');
});
