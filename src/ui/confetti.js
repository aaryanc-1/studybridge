// A short burst of confetti (no library). Respects "reduce motion".
const COLORS = ['#0E6B6B', '#F2C66D', '#E86A5B', '#6C8CF5', '#8A4FBF', '#3FB37F'];

export function confetti({ count = 140, duration = 2600 } = {}) {
  if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const c = document.createElement('canvas');
  c.setAttribute('aria-hidden', 'true');
  Object.assign(c.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: 80 });
  document.body.appendChild(c);
  const dpr = window.devicePixelRatio || 1;
  const W = (c.width = window.innerWidth * dpr);
  const H = (c.height = window.innerHeight * dpr);
  const ctx = c.getContext('2d');
  const bits = Array.from({ length: count }, (_, i) => ({
    x: W / 2 + (Math.random() - 0.5) * W * 0.3,
    y: H * 0.35,
    vx: (Math.random() - 0.5) * 18 * dpr,
    vy: (-Math.random() * 16 - 6) * dpr,
    r: Math.random() * Math.PI,
    vr: (Math.random() - 0.5) * 0.3,
    w: (6 + Math.random() * 6) * dpr,
    h: (8 + Math.random() * 8) * dpr,
    color: COLORS[i % COLORS.length],
  }));
  const start = performance.now();
  function frame(t) {
    const k = (t - start) / duration;
    ctx.clearRect(0, 0, W, H);
    for (const b of bits) {
      b.vy += 0.45 * dpr;
      b.vx *= 0.99;
      b.x += b.vx;
      b.y += b.vy;
      b.r += b.vr;
      ctx.save();
      ctx.globalAlpha = Math.max(0, 1 - k);
      ctx.translate(b.x, b.y);
      ctx.rotate(b.r);
      ctx.fillStyle = b.color;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (k < 1) requestAnimationFrame(frame);
    else c.remove();
  }
  requestAnimationFrame(frame);
}
