// The website's small bits of behaviour: theme, menu, tabs, pricing calculator and the right download for this device
(function () {
  var S = window.SITE || {};
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  document.documentElement.classList.add('js');

  // Light / dark
  var themeBtn = $('#theme');
  if (themeBtn) themeBtn.addEventListener('click', function () {
    var root = document.documentElement;
    var dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store.set('site.theme', root.dataset.theme);
  });

  // Header border once scrolled, phone menu
  var top = $('.top');
  var onScroll = function () { if (top) top.classList.toggle('scrolled', scrollY > 8); };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  var menu = $('#menu'), nav = $('#mobile-nav');
  if (menu && nav) {
    menu.addEventListener('click', function () {
      var open = nav.hidden;
      nav.hidden = !open;
      menu.setAttribute('aria-expanded', String(open));
    });
    $$('a', nav).forEach(function (a) { a.addEventListener('click', function () { nav.hidden = true; menu.setAttribute('aria-expanded', 'false'); }); });
  }

  // Appear on scroll
  if ('IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -40px 0px' });
    $$('.reveal').forEach(function (el) { io.observe(el); });
  } else $$('.reveal').forEach(function (el) { el.classList.add('in'); });

  // Feature tabs (arrow keys move between them)
  var tabs = $$('[role=tab]');
  function pick(tab, focus) {
    tabs.forEach(function (t) {
      var on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    });
    if (focus) tab.focus();
  }
  tabs.forEach(function (t, i) {
    t.addEventListener('click', function () { pick(t); });
    t.addEventListener('keydown', function (e) {
      var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (d) { e.preventDefault(); pick(tabs[(i + d + tabs.length) % tabs.length], true); }
    });
  });

  // Pricing: monthly or yearly, currency, and which plan fits
  var plans = S.plans || [];
  var period = 'month';
  var cur = (S.currencies || [])[0] || { code: 'USD', symbol: '$', rate: 1 };
  var guess = (navigator.language || '') + ' ' + ((Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '');
  var saved = store.get('site.currency');
  var auto = /Lusaka|-ZM/.test(guess) ? 'ZMW' : /Kolkata|Calcutta|-IN/.test(guess) ? 'INR' : 'USD';
  (S.currencies || []).forEach(function (c) { if (c.code === (saved || auto)) cur = c; });
  function money(usd) {
    var v = usd * cur.rate;
    if (cur.rate !== 1) v = v >= 1000 ? Math.round(v / 50) * 50 : Math.round(v / 5) * 5;
    return cur.symbol + v.toLocaleString('en', { maximumFractionDigits: cur.rate === 1 ? 2 : 0 });
  }
  function renderPrices() {
    $$('.plan').forEach(function (el) {
      var p = plans.filter(function (x) { return x.id === el.dataset.plan; })[0];
      if (!p) return;
      var amt = $('.amount', el), per = $('.per', el), eq = $('.equiv', el);
      if (!p.month) { amt.textContent = money(0); per.textContent = 'for ever'; eq.textContent = ''; return; }
      amt.textContent = money(period === 'year' ? p.year : p.month);
      per.textContent = period === 'year' ? '/ year' : '/ month';
      eq.textContent = period === 'year' ? 'That’s ' + money(p.year / 12) + ' a month' : 'About ' + money(p.month / p.learners) + ' per learner';
    });
    calc();
  }
  function calc() {
    var input = $('#learners'), out = $('#calc-out');
    if (!input || !out) return;
    var n = +input.value;
    $('#n-out').textContent = n >= +input.max ? input.max + '+' : n;
    var fit = plans.filter(function (p) { return p.learners >= n; })[0];
    $$('.plan').forEach(function (el) { el.classList.toggle('fit', !!fit && el.dataset.plan === fit.id); });
    if (!fit) { out.innerHTML = '<b>More than ' + plans[plans.length - 1].learners + ' learners?</b> Get in touch through the app and we’ll set up a plan for your centre.'; return; }
    if (!fit.month) { out.innerHTML = '<b>' + fit.name + '</b> is enough: one learner, every feature, free.'; return; }
    var cost = period === 'year' ? fit.year / 12 : fit.month;
    out.innerHTML = '<b>' + fit.name + '</b> fits: up to ' + fit.learners + ' learners for ' + money(period === 'year' ? fit.year : fit.month) + (period === 'year' ? ' a year' : ' a month') +
      '. With ' + n + ' learner' + (n === 1 ? '' : 's') + ' that’s about <b>' + money(cost / n) + ' per learner a month</b>.' + (S.freeNow ? ' Free while paid plans are being set up.' : '');
  }
  $$('[data-period]').forEach(function (b) {
    b.addEventListener('click', function () {
      period = b.dataset.period;
      $$('[data-period]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
      renderPrices();
    });
  });
  var sel = $('#currency');
  if (sel) {
    sel.value = cur.code;
    sel.addEventListener('change', function () {
      (S.currencies || []).forEach(function (c) { if (c.code === sel.value) cur = c; });
      store.set('site.currency', cur.code);
      renderPrices();
    });
  }
  var range = $('#learners');
  if (range) range.addEventListener('input', calc);
  renderPrices();

  // Get the app: the right download for this device
  var ua = navigator.userAgent || '';
  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  var touchMac = /Mac/.test(platform) && navigator.maxTouchPoints > 1; // iPads say they're Macs
  var os = /iPhone|iPad|iPod/.test(ua) || touchMac ? 'ios' : /Android/.test(ua) ? 'android' : /Win/.test(platform) ? 'windows' : /Mac/.test(platform) ? 'mac' : 'other';
  var dl = $('#dl');
  var latest = 'https://github.com/' + S.releasesRepo + '/releases/latest';
  var icon = {
    down: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 4v12M7 11.5 12 16l5-4.5M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    phone: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><rect x="7" y="3" width="10" height="18" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M11 18h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  };
  function show(rel) {
    var url = function (k) { return (rel && rel[k]) || latest; };
    $$('[data-dl]').forEach(function (a) { a.href = url(a.dataset.dl); });
    if (rel && rel.version) $('#dl-version').textContent = 'Latest version ' + rel.version + '. Installed apps update themselves.';
    if (!dl) return;
    var app = S.appPath;
    if (os === 'windows') {
      dl.innerHTML = '<a class="btn primary big" href="' + url('windows') + '">' + icon.down + ' Download for Windows</a>' +
        '<span class="alt">Windows 10 or 11. If Windows asks, choose “More info”, then “Run anyway”.</span>';
    } else if (os === 'mac') {
      dl.innerHTML = '<a class="btn primary big" id="mac-main" href="' + url('mac_arm') + '">' + icon.down + ' Download for Mac</a>' +
        '<span class="alt" id="mac-alt">For Apple silicon (M1 and newer). <a href="' + url('mac_x64') + '">Older Intel Mac? Get this one.</a></span>';
      macArch(function (arch) {
        if (arch !== 'x86') return;
        $('#mac-main').href = url('mac_x64');
        $('#mac-alt').innerHTML = 'For Intel Macs. <a href="' + url('mac_arm') + '">Apple silicon (M1 and newer)? Get this one.</a>';
      });
    } else if (os === 'ios' || os === 'android') {
      $('#get-lead').textContent = 'On your phone, ' + S.brand + ' runs from your home screen. No app store needed.';
      dl.innerHTML = '<a class="btn primary big" href="' + app + '">' + icon.phone + ' Open ' + S.brand + '</a>' +
        '<span class="alt">Then add it to your home screen (steps below).</span>';
      document.documentElement.classList.add('on-phone');
      var d = document.getElementById(os === 'ios' ? 'a2hs-ios' : 'a2hs-android');
      $$('.a2hs details').forEach(function (x) { x.open = x === d; });
    } else {
      dl.innerHTML = '<a class="btn primary big" href="' + app + '">' + icon.phone + ' Use it in your browser</a>' +
        '<span class="alt">Apps are available for Windows and Mac.</span>';
    }
  }
  // Apple silicon or Intel: Chrome and Edge say; for Safari, the graphics chip gives it away
  function macArch(cb) {
    try {
      if (navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
        navigator.userAgentData.getHighEntropyValues(['architecture']).then(function (v) { cb(v.architecture === 'x86' ? 'x86' : 'arm'); }, function () { cb('arm'); });
        return;
      }
      var gl = document.createElement('canvas').getContext('webgl');
      var ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      var r = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      cb(/Intel|AMD|Radeon/i.test(r) ? 'x86' : 'arm');
    } catch (e) { cb('arm'); }
  }
  show(null);
  fetch('release.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (rel) { if (rel) show(rel); }, function () {});

  var y = new Date().getFullYear();
  $$('[data-year]').forEach(function (el) { el.textContent = y; });
})();
