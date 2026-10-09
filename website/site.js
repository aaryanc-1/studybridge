// The website's behaviour: theme, menu, tabs, exam countdown, pricing, the right download, early access, subject search
(function () {
  var S = window.SITE || {};
  var $ = function (s, el) { return (el || document).querySelector(s); };
  var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
  var store = {
    get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  // the old address (github.io) moved to the domain: go there, same page
  if (/\.github\.io$/.test(location.hostname) && S.siteUrl) {
    location.replace(S.siteUrl.replace(/\/$/, '') + location.pathname.replace(/^\/[^/]+/, '') + location.search + location.hash);
    return;
  }
  document.documentElement.classList.add('js');

  // Light / dark
  $$('[data-theme-toggle]').forEach(function (b) { b.addEventListener('click', function () {
    var root = document.documentElement;
    var dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store.set('site.theme', root.dataset.theme);
  }); });

  // Header border once scrolled; the phone menu
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

  // Tabs (each tablist on its own; arrow keys move between tabs)
  $$('[role=tablist]').forEach(function (list) {
    var tabs = $$('[role=tab]', list);
    function pick(tab, focus, quiet) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        var p = document.getElementById(t.getAttribute('aria-controls'));
        if (p) p.hidden = !on;
      });
      if (focus) tab.focus();
      // pricing.html#tutors and friends: the address says which tab is open, so it can be shared
      if (tab.dataset.hash && !quiet && history.replaceState) history.replaceState(null, '', '#' + tab.dataset.hash);
    }
    function fromHash() {
      var t = tabs.filter(function (x) { return x.dataset.hash && '#' + x.dataset.hash === location.hash; })[0];
      if (t) pick(t, false, true);
    }
    fromHash();
    addEventListener('hashchange', fromHash);
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { pick(t); });
      t.addEventListener('keydown', function (e) {
        var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (d) { e.preventDefault(); pick(tabs[(i + d + tabs.length) % tabs.length], true); }
      });
    });
  });

  // ---------- Exam countdown ----------
  var boards = S.boards || [];
  var cdBoard = $('#cd-board'), cdSession = $('#cd-session');
  var board = boards[0];
  var DAY = 864e5;
  function upcoming(b) {
    var now = new Date(), out = [];
    for (var y = now.getFullYear(); y <= now.getFullYear() + 2; y++) {
      (b.sessions || []).forEach(function (s) {
        var d = new Date(y, s.month - 1, s.day);
        if (d - now > DAY) out.push({ label: s.name + ' ' + y, date: d });
      });
    }
    return out.sort(function (a, b) { return a.date - b.date; }).slice(0, 4);
  }
  function fillSessions() {
    if (!cdSession || !board) return;
    var list = upcoming(board);
    cdSession.innerHTML = list.map(function (s, i) { return '<option value="' + s.date.toISOString() + '"' + (i === 0 ? ' selected' : '') + '>' + esc(s.label) + '</option>'; }).join('') +
      '<option value="custom">Another date…</option>';
    countdown();
  }
  function range(a, b) { return a === b ? 'Week ' + a : 'Weeks ' + a + '–' + b; }
  function countdown() {
    if (!cdSession) return;
    var custom = cdSession.value === 'custom';
    $('#cd-date-wrap').hidden = !custom;
    var date = custom ? ($('#cd-date').value ? new Date($('#cd-date').value + 'T09:00') : null) : new Date(cdSession.value);
    var n = $('#cd-n'), when = $('#cd-when'), bar = $('#cd-bar'), legend = $('#cd-legend'), tip = $('#cd-tip');
    if (!date || isNaN(date)) { n.textContent = '–'; when.textContent = 'Pick your exam date.'; bar.innerHTML = ''; legend.innerHTML = ''; tip.textContent = ''; return; }
    var weeks = Math.max(0, Math.ceil((date - new Date()) / (7 * DAY)));
    n.textContent = weeks;
    $('#cd-unit').textContent = weeks === 1 ? 'week to go' : 'weeks to go';
    var label = custom ? '' : ' (' + board.name + ' ' + cdSession.options[cdSession.selectedIndex].text + ')';
    when.textContent = weeks ? 'Until about ' + date.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) + label + '.' : 'Your exams are this week.';
    var learn, prac, mock;
    if (weeks >= 6) { mock = Math.max(1, Math.round(weeks * 0.15)); prac = Math.max(1, Math.round(weeks * 0.25)); learn = weeks - mock - prac; }
    else if (weeks >= 3) { mock = 1; prac = 1; learn = weeks - 2; }
    else { learn = 0; mock = weeks ? 1 : 0; prac = Math.max(0, weeks - 1); }
    var parts = [['p1', learn, 'Learn the topics', 'var(--accent)'], ['p2', prac, 'Practice papers', 'color-mix(in srgb, var(--accent) 55%, var(--gold))'], ['p3', mock, 'Mock and review', 'var(--gold)']];
    var at = 1;
    bar.innerHTML = parts.filter(function (p) { return p[1] > 0; }).map(function (p) { return '<span class="' + p[0] + '" style="flex-grow:' + p[1] + '"></span>'; }).join('');
    legend.innerHTML = parts.filter(function (p) { return p[1] > 0; }).map(function (p) {
      var li = '<li style="--c:' + p[3] + '"><b>' + range(at, at + p[1] - 1) + '</b>' + p[2] + '</li>';
      at += p[1];
      return li;
    }).join('');
    tip.textContent = weeks > 30 ? 'Plenty of time. A steady few hours a week covers everything, with room to spare.'
      : weeks >= 12 ? 'A good runway. Little and often, with a practice paper every few weeks.'
      : weeks >= 4 ? 'Tight but doable. Your plan would put your weakest topics first.'
      : 'Short on time? Focus on practice papers and your weakest topics, a little every day.';
  }
  if (cdBoard) {
    $$('button', cdBoard).forEach(function (b) {
      b.addEventListener('click', function () {
        board = boards.filter(function (x) { return x.id === b.dataset.board; })[0] || boards[0];
        $$('button', cdBoard).forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        fillSessions();
      });
    });
    cdSession.addEventListener('change', countdown);
    $('#cd-date').addEventListener('change', countdown);
    fillSessions();
    var save = $('#cd-save');
    if (save) save.addEventListener('click', function () {
      var exam = $('#ea-exam');
      if (exam && cdSession.value !== 'custom') exam.value = board.name + ' ' + cdSession.options[cdSession.selectedIndex].text;
      else if (exam && $('#cd-date').value) exam.value = $('#cd-date').value;
    });
  }

  // ---------- Prices: in the visitor's currency; tutors monthly or yearly, and what N learners cost ----------
  var levels = S.tutorLevels || [];
  var period = 'month';
  var cur = (S.currencies || [])[0] || { code: 'USD', symbol: '$', rate: 1 };
  var guess = (navigator.language || '') + ' ' + ((Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || '');
  var saved = store.get('site.currency');
  var auto = /Lusaka|-ZM/.test(guess) ? 'ZMW' : /Kolkata|Calcutta|-IN/.test(guess) ? 'INR' : 'USD';
  (S.currencies || []).forEach(function (c) { if (c.code === (saved || auto)) cur = c; });
  function money(usd) {
    var v = usd * cur.rate;
    if (cur.rate !== 1) v = v >= 1000 ? Math.round(v / 50) * 50 : Math.round(v / 5) * 5;
    var cents = cur.rate === 1 && v % 1 ? 2 : 0; // $4.40, not $4.4; whole dollars stay whole
    return cur.symbol + v.toLocaleString('en', { minimumFractionDigits: cents, maximumFractionDigits: cents });
  }
  var months = function () { return period === 'year' ? 12 - (S.yearlyMonthsFree || 0) : 1; };
  // what n learners cost a month at one level: each step's price for the learners in that step
  function total(level, n) {
    var from = 0, sum = 0;
    level.steps.forEach(function (s) {
      var top = s.upTo == null ? Infinity : s.upTo;
      sum += Math.max(0, Math.min(n, top) - from) * s.price;
      from = top;
    });
    return sum;
  }
  function renderPrices() {
    $$('[data-usd]').forEach(function (el) { el.textContent = money(+el.dataset.usd * (el.hasAttribute('data-scale') ? months() : 1)); });
    $$('[data-per]').forEach(function (el) { el.textContent = period === 'year' ? 'per learner a year' : 'per learner a month'; });
    calc();
  }
  function calc() {
    var input = $('#learners'), out = $('#calc-out');
    if (!input || !out || !levels.length) return;
    var n = +input.value;
    $('#n-out').textContent = n;
    var when = period === 'year' ? ' a year' : ' a month';
    out.innerHTML = 'With ' + n + ' learner' + (n === 1 ? '' : 's') + ': ' + levels.map(function (l) {
      var t = total(l, n) * months();
      return '<b>' + l.name + ' ' + money(t) + when + '</b>' + (n > 1 ? ' (' + money(t / n) + ' per learner)' : '');
    }).join(' or ') + '.';
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
  var rangeEl = $('#learners');
  if (rangeEl) rangeEl.addEventListener('input', calc);
  renderPrices();

  // ---------- Get the app: the right download for this device ----------
  var ua = navigator.userAgent || '';
  var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  var touchMac = /Mac/.test(platform) && navigator.maxTouchPoints > 1; // iPads say they're Macs
  var os = /iPhone|iPad|iPod/.test(ua) || touchMac ? 'ios' : /Android/.test(ua) ? 'android' : /Win/.test(platform) ? 'windows' : /Mac/.test(platform) ? 'mac' : 'other';
  var dl = $('#dl');
  var latest = 'https://github.com/' + S.releasesRepo + '/releases/latest';
  var down = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M12 4v12M7 11.5 12 16l5-4.5M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function show(rel) {
    var url = function (k) { return (rel && rel[k]) || latest; };
    $$('[data-dl]').forEach(function (a) { a.href = url(a.dataset.dl); });
    if (rel && rel.version && $('#dl-version')) $('#dl-version').textContent = 'Latest version ' + rel.version + '. Installed apps update themselves.';
    if (!dl) return;
    if (os === 'windows') {
      dl.innerHTML = '<a class="btn primary" href="' + url('windows') + '">' + down + ' Download for Windows</a><span class="alt">Windows 10 or 11. If Windows asks, choose “More info”, then “Run anyway”.</span>';
    } else if (os === 'mac') {
      dl.innerHTML = '<a class="btn primary" id="mac-main" href="' + url('mac_arm') + '">' + down + ' Download for Mac</a><span class="alt" id="mac-alt">For Apple silicon (M1 and newer). <a href="' + url('mac_x64') + '">Intel Mac? Get this one.</a></span>';
      macArch(function (arch) {
        if (arch !== 'x86') return;
        $('#mac-main').href = url('mac_x64');
        $('#mac-alt').innerHTML = 'For Intel Macs. <a href="' + url('mac_arm') + '">Apple silicon (M1 and newer)? Get this one.</a>';
      });
    } else {
      dl.innerHTML = '<span class="alt">The desktop app is for Windows and Mac computers. On this device, use ' + esc(S.brand) + ' in your browser.</span>';
      if (os === 'ios' || os === 'android') {
        document.documentElement.classList.add('on-phone');
        var d = document.getElementById(os === 'ios' ? 'a2hs-ios' : 'a2hs-android');
        if (d) d.open = true;
      }
    }
  }
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
  if (dl || $('[data-dl]')) {
    show(null);
    fetch('release.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (rel) { if (rel) show(rel); }, function () {});
  }

  // ---------- Early access (and subject requests) ----------
  function join(fields) {
    return fetch(S.sb.url + '/rest/v1/rpc/join_early_access', {
      method: 'POST',
      headers: { apikey: S.sb.key, Authorization: 'Bearer ' + S.sb.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.message || 'That didn’t go through. Please try again.');
        return j;
      });
    });
  }
  var form = $('#ea-form');
  if (form && !S.sb) { form.hidden = true; $('#ea-off').hidden = false; }
  if (form && S.sb) {
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = form.elements, msg = $('#ea-msg');
      msg.className = 'ea-msg';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(f.email.value.trim())) { msg.className = 'ea-msg bad'; msg.textContent = 'Please check your email address.'; f.email.focus(); return; }
      if (!f.age.checked) { msg.className = 'ea-msg bad'; msg.textContent = 'Please tick the box. If you’re under 13, ask a parent to sign up for you.'; return; }
      var btn = $('button[type=submit]', form);
      btn.disabled = true;
      msg.textContent = 'Saving…';
      join({ p_email: f.email.value, p_role: f.role.value, p_curriculum: f.curriculum.value, p_subjects: f.subjects.value, p_exam: f.exam.value, p_country: f.country.value, p_note: f.note.value })
        .then(function () {
          form.innerHTML = '<div class="ea-done" role="status"><b>You’re on the list.</b>We’ll email ' + esc(f.email.value.trim()) + ' when the student version opens. Thank you!</div>';
        }, function (err) { btn.disabled = false; msg.className = 'ea-msg bad'; msg.textContent = err.message; });
    });
    if (form.dataset.defaultRole) form.elements.role.value = form.dataset.defaultRole;
    // From the subjects page or a "tell us" link: fill in what we already know
    var q = new URLSearchParams(location.search);
    if (q.get('request')) {
      form.elements.note.value = 'Please add: ' + q.get('request');
      setTimeout(function () { document.getElementById('early').scrollIntoView(); }, 50);
    }
    $$('[data-role]').forEach(function (a) {
      a.addEventListener('click', function () { form.elements.role.value = a.dataset.role; });
    });
  }
  // Contact page
  var contact = $('#contact-form');
  if (contact && !S.sb) { contact.hidden = true; $('#contact-off').hidden = false; }
  if (contact && S.sb) {
    contact.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = contact.elements, msg = $('#contact-msg');
      msg.className = 'ea-msg';
      if (f.website.value) return; // a robot filled the hidden box
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(f.email.value.trim())) { msg.className = 'ea-msg bad'; msg.textContent = 'Please check your email address.'; f.email.focus(); return; }
      if (f.message.value.trim().length < 2) { msg.className = 'ea-msg bad'; msg.textContent = 'Please write a message.'; f.message.focus(); return; }
      var btn = $('button[type=submit]', contact);
      btn.disabled = true;
      msg.textContent = 'Sending…';
      fetch(S.sb.url + '/rest/v1/rpc/send_contact', {
        method: 'POST',
        headers: { apikey: S.sb.key, Authorization: 'Bearer ' + S.sb.key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ p_name: f.name.value, p_email: f.email.value, p_role: f.role.value, p_message: f.message.value }),
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.message || 'That didn’t go through. Please try again, or email us.'); });
      }).then(function () {
        contact.innerHTML = '<div class="ea-done" role="status"><b>Thank you, it’s sent.</b>We’ll reply to ' + esc(f.email.value.trim()) + ' soon.</div>';
      }, function (err) { btn.disabled = false; msg.className = 'ea-msg bad'; msg.textContent = err.message; });
    });
  }

  // Signed in to the app in this browser? The "Sign in" links become "Open my StudyBridge"
  var signedIn = false;
  try { signedIn = !!localStorage.getItem('sb.auth'); } catch (e) {}
  if (signedIn) {
    $$('a[href$="#start=signin"]').forEach(function (a) {
      a.href = S.appPath;
      a.textContent = 'Open my ' + S.brand;
    });
  }

  var req = $('#req-form');
  if (req && !S.sb) req.hidden = true;
  if (req && S.sb) {
    req.addEventListener('submit', function (e) {
      e.preventDefault();
      var f = req.elements, msg = $('#req-msg');
      msg.className = 'ea-msg';
      if (!f.subject.value.trim()) { msg.className = 'ea-msg bad'; msg.textContent = 'Which subject or exam?'; f.subject.focus(); return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(f.email.value.trim())) { msg.className = 'ea-msg bad'; msg.textContent = 'Please check your email address.'; f.email.focus(); return; }
      msg.textContent = 'Sending…';
      join({ p_email: f.email.value, p_role: 'student', p_note: 'Subject request: ' + f.subject.value.trim() })
        .then(function () { req.reset(); msg.textContent = 'Thanks! We’ve noted it, and we’ll email you when it’s ready.'; },
          function (err) { msg.className = 'ea-msg bad'; msg.textContent = err.message; });
    });
  }

  // ---------- Subjects page: search and filter ----------
  var find = $('#find');
  if (find) {
    var filter = 'all';
    function apply() {
      var t = find.value.trim().toLowerCase(), shown = 0;
      $$('.board-block').forEach(function (b) {
        var bShown = 0;
        var boardOk = filter === 'all' || b.dataset.board === filter;
        $$('.level', b).forEach(function (l) {
          var n = 0;
          $$('li', l).forEach(function (li) {
            var ok = boardOk && (!t || li.dataset.s.indexOf(t) !== -1);
            li.hidden = !ok;
            if (ok) n++;
          });
          l.hidden = !n;
          bShown += n;
        });
        b.hidden = !bShown;
        shown += bShown;
      });
      $('#none').hidden = shown > 0;
      var ask = $('#req-subject');
      if (ask && !shown && t) ask.value = find.value.trim();
    }
    find.addEventListener('input', apply);
    $$('[data-filter]').forEach(function (b) {
      b.addEventListener('click', function () {
        filter = b.dataset.filter;
        $$('[data-filter]').forEach(function (x) { x.setAttribute('aria-pressed', String(x === b)); });
        apply();
      });
    });
  }

  $$('[data-year]').forEach(function (el) { el.textContent = new Date().getFullYear(); });

  // ---------- Life: cards that arrive in turn, light up under the pointer, numbers that count, a card that tilts ----------
  var calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  $$('.pillars.reveal, .who-grid.reveal, .steps.reveal, .t-grid.reveal, .inside.reveal, .trust.reveal, .access-grid.reveal, .boards.reveal, .who-pick.reveal, .two-col.reveal, .dev-grid.reveal').forEach(function (g) {
    g.classList.add('stagger');
    Array.prototype.forEach.call(g.children, function (c, i) { c.style.setProperty('--i', i); });
  });
  if (!calm && matchMedia('(hover: hover)').matches) {
    $$('.fit-card, .plan, .t-grid article, .steps li, .board-card, .side-card, .access-grid li, .who-pick [role=tab], .dev-grid article, .split, .band, .pillars article').forEach(function (c) {
      c.classList.add('spot');
      c.addEventListener('pointermove', function (e) {
        var r = c.getBoundingClientRect();
        c.style.setProperty('--mx', (e.clientX - r.left) + 'px');
        c.style.setProperty('--my', (e.clientY - r.top) + 'px');
      });
    });
    var art = $('.hero-art'), card = $('.plan-card');
    if (art && card) {
      art.addEventListener('pointermove', function (e) {
        var r = art.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
        card.style.transform = 'perspective(900px) rotateY(' + (x * 9).toFixed(2) + 'deg) rotateX(' + (-y * 9).toFixed(2) + 'deg)';
      });
      art.addEventListener('pointerleave', function () { card.style.transform = ''; });
    }
  }
  if (!calm && 'IntersectionObserver' in window) {
    var counter = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (!e.isIntersecting) return;
        counter.unobserve(e.target);
        var el = e.target, to = +el.dataset.count, t0 = performance.now();
        (function step(t) {
          var k = Math.min(1, (t - t0) / 1300);
          el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3)));
          if (k < 1) requestAnimationFrame(step);
        })(t0);
      });
    }, { threshold: 0.6 });
    $$('[data-count]').forEach(function (el) { el.textContent = '0'; counter.observe(el); });
  }
})();
