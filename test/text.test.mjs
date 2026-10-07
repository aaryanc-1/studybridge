// Maths written for the screen ($x^2-25$, **bold**) turned into plain text for WhatsApp, email and notifications
import test from 'node:test';
import assert from 'node:assert/strict';
import { plainMaths } from '../src/lib/plain.js';

test('plain maths: no dollar signs, stars or LaTeX left', () => {
  const fb = 'Good start: taking out the common factor 3 to get $3(x^2-25)$ is right. Factorise **fully**: $a^2-b^2=(a+b)(a-b)$ gives $3(x+5)(x-5)$.';
  const out = plainMaths(fb);
  assert.equal(out, 'Good start: taking out the common factor 3 to get 3(x² − 25) is right. Factorise fully: a² − b²=(a+b)(a − b) gives 3(x+5)(x − 5).');
  assert.doesNotMatch(out, /[$*\\]/);
  assert.equal(plainMaths('$\\frac{1}{2} \\times 6 \\le 3$'), '(1)/(2) × 6 ≤ 3');
  assert.equal(plainMaths('$\\sqrt{x}$ and $\\left(x\\right)^{3}$'), '√(x) and (x)³');
  assert.equal(plainMaths(''), '');
});
