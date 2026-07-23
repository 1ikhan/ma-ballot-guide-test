/* =============================================================================
   app.js — MA 2026 Ballot Question Guide
   -----------------------------------------------------------------------------
   Responsibilities (per PRD): fetch questions.json, hold in-memory state, route
   between the three views via the URL hash, mirror CHOICES ONLY into the hash
   for lossless reload/back-swipe recovery (§6), render each view from data, and
   drive the four export paths (print / copy / screenshot-friendly / QR, §9).

   Design rules honored throughout:
     - Data, not structure: the count, order, and every string come from JSON.
       Nothing here assumes "nine" (§3).
     - No innerHTML for content: DOM is built with createElement + textContent
       and cloned <template>s, so JSON content can't inject markup (§4).
     - No inline styles: we toggle classes and the [hidden] attribute only, so
       the strict `default-src 'self'` CSP stays valid (constraint #3, §13).
     - Choices live in the hash; notes never do (length + privacy, §6).
     - The hash is a MIRROR, not the source of truth during a session: we decode
       it once at load, then keep in-memory `ballot` authoritative. This is what
       makes back/forward across view history safe (an older history entry can
       carry a stale choice string; we never let it clobber live state).

   Loaded with `defer`, so the DOM is parsed before this runs; init() is called
   directly at the bottom.
   ========================================================================== */
(function () {
  'use strict';

  /* ===========================================================================
     0. CONSTANTS & MODULE STATE
     ======================================================================== */

  // Fragment alphabet (§6). One char per question, canonical `questions` order.
  var CHOICE_TO_CHAR = { yes: 'Y', no: 'N', undecided: 'U' }; // null → '-'
  var CHAR_TO_CHOICE = { Y: 'yes', N: 'no', U: 'undecided', '-': null };

  // Human labels for question `type`. Unknown types are prettified from the id.
  var TYPE_LABELS = {
    'initiative-petition': 'Initiative petition',
    'veto-referendum': 'Veto referendum'
  };

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];

  var APP_TITLE = 'MA 2026 Ballot Guide';

  // Authoritative session state.
  var meta = {};                 // questions.json → meta
  var questions = [];            // questions.json → questions (canonical order)
  var ballot = {};               // { [id]: { choice, note } }

  // View bookkeeping (mirrors the hash; used by syncHashState()).
  var currentView = 'overview';
  var currentQuestionId = null;
  var reviewMode = false;        // "Review my undecideds" nav filter (ephemeral)
  var initialized = false;       // suppress focus/scroll on the very first paint
  var beforeUnloadArmed = false; // desktop-only, armed after first note keystroke

  /* ===========================================================================
     1. TINY DOM HELPERS
     ======================================================================== */

  function qsa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function qf(root, name) { return root.querySelector('[data-field="' + name + '"]'); }
  function viewByName(name) { return document.querySelector('[data-view="' + name + '"]'); }
  function templateRoot(id) { return document.getElementById(id).content.firstElementChild; }

  // el('p', 'text') → <p>text</p>. text is set via textContent (never parsed).
  function el(tag, text) {
    var n = document.createElement(tag);
    if (text != null) n.textContent = text;
    return n;
  }

  // A <strong>label</strong> + plain text line, built without innerHTML.
  function labeledLine(tag, label, text) {
    var n = el(tag);
    n.appendChild(el('strong', label));
    n.appendChild(document.createTextNode(text));
    return n;
  }

  /* ===========================================================================
     2. STATUS / ANNOUNCEMENTS  (role="status" region, top of page)
     ======================================================================== */

  function setStatus(msg) {
    var s = document.getElementById('app-status');
    s.textContent = msg;
    s.hidden = false;
  }
  function clearStatus() {
    var s = document.getElementById('app-status');
    s.textContent = '';
    s.hidden = true;
  }
  // Transient announcement for export actions (also read by screen readers).
  function announce(msg) { setStatus(msg); }

  function toggleFlag(name, show) {
    var e = document.querySelector('[data-flag="' + name + '"]');
    if (e) e.hidden = !show;
  }

  /* ===========================================================================
     3. FRAGMENT STATE  (§6)  — encode/decode choices only
     ======================================================================== */

  function schemaVersion() {
    return meta.fragmentSchemaVersion != null ? meta.fragmentSchemaVersion : 1;
  }

  // "1.YN-U--N--"  → version + one char per question in canonical id order.
  function buildStateString() {
    var chars = questions.map(function (q) {
      return CHOICE_TO_CHAR[ballot[q.id].choice] || '-';
    }).join('');
    return schemaVersion() + '.' + chars;
  }

  // Decode only if version AND length match (§6). Otherwise silently start fresh.
  // Called ONCE at load; never on hashchange (see routing note above).
  function decodeState(s) {
    if (!s) return;
    var dot = s.indexOf('.');
    if (dot < 0) return;
    if (parseInt(s.slice(0, dot), 10) !== schemaVersion()) return;

    var chars = s.slice(dot + 1);
    if (chars.length !== questions.length) return; // stale-length guard

    questions.forEach(function (q, i) {
      var c = CHAR_TO_CHOICE[chars[i]];       // '-' → null; unknown → undefined
      if (c !== undefined) ballot[q.id].choice = c;
    });
  }

  // Canonical resume link = same-origin URL + choices-only fragment.
  // Doubles as the QR payload (§9.4) and the copy-as-text "reopen" link (§9.2).
  function buildResumeUrl() {
    return location.origin + location.pathname + '#s=' + buildStateString();
  }

  /* ===========================================================================
     4. HASH ROUTING
     Route shapes:
       overview  →  #s=<state>
       question  →  #q=<id>&s=<state>
       summary   →  #v=summary&s=<state>
     A bare "#s=…" resume link therefore lands on the overview with choices
     restored. `q`/`v` select the view; `s` only ever carries choices.
     ======================================================================== */

  function parseHash(hash) {
    var out = {};
    (hash || '').replace(/^#/, '').split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      var k = i < 0 ? pair : pair.slice(0, i);
      out[k] = i < 0 ? '' : decodeURIComponent(pair.slice(i + 1));
    });
    return out;
  }

  function buildHash(view, id) {
    var parts = [];
    if (view === 'question' && id) parts.push('q=' + id);
    else if (view === 'summary') parts.push('v=summary');
    parts.push('s=' + buildStateString());
    return '#' + parts.join('&');
  }

  // Navigation = a NEW history entry (so Back moves between views, §6).
  function navigate(view, id) {
    var target = buildHash(view, id);
    if (location.hash === target) routeAndRender(); // same URL: re-render/re-focus
    else location.hash = target;                    // fires hashchange → route
  }

  // Choice changes = replaceState (no history spam, §6). Does NOT fire hashchange.
  function syncHashState() {
    history.replaceState(null, '', buildHash(currentView, currentQuestionId));
  }

  function routeAndRender() {
    var p = parseHash(location.hash);
    var view, qid = null;

    if (p.q && ballot[p.q]) { view = 'question'; qid = p.q; } // ignore stale ids
    else if (p.v === 'summary') { view = 'summary'; }
    else { view = 'overview'; }

    currentView = view;
    currentQuestionId = qid;

    showView(view, qid, initialized); // focus/scroll only after the first paint
    syncHashState();                  // rewrite this entry's `s` from live state,
                                      // healing any stale choice string on arrival
  }

  /* ===========================================================================
     5. VIEW SWITCHING + FOCUS MANAGEMENT (§12)
     ======================================================================== */

  function titleFor(view, qid) {
    if (view === 'question' && qid) {
      var q = getQuestion(qid);
      return (q ? q.shortTitle + ' — ' : '') + APP_TITLE;
    }
    if (view === 'summary') return 'My ballot card — ' + APP_TITLE;
    return 'Massachusetts 2026 Ballot Questions — ' + APP_TITLE;
  }

  function showView(view, qid, focus) {
    if (view === 'overview') reviewMode = false; // leaving the review flow

    qsa('[data-view]').forEach(function (v) {
      v.hidden = (v.dataset.view !== view);
    });

    if (view === 'overview') renderOverview();
    else if (view === 'question') renderQuestion(qid);
    else if (view === 'summary') renderSummary();

    document.title = titleFor(view, qid);

    var active = viewByName(view);
    var h1 = active && active.querySelector('h1');
    if (focus && h1) { h1.focus(); window.scrollTo(0, 0); }
  }

  /* ===========================================================================
     6. RENDER — OVERVIEW
     ======================================================================== */

  function eyebrowFor(q) {
    var label = TYPE_LABELS[q.type] ||
      (q.type ? q.type.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : '');
    // Numbers appear only once the ballot order is certified (§4). No placeholders.
    if (meta.ballotOrderCertified && q.ballotNumber != null) {
      return 'Question ' + q.ballotNumber + ' · ' + label;
    }
    return label;
  }

  function applyChip(chip, choice) {
    chip.className = 'chip';
    if (choice === 'yes' || choice === 'no') { chip.textContent = 'Decided ✓'; chip.classList.add('chip--decided'); }
    else if (choice === 'undecided') { chip.textContent = 'Undecided ?'; chip.classList.add('chip--undecided'); }
    else { chip.textContent = 'Not viewed'; chip.classList.add('chip--unviewed'); }
  }

  function renderOverview() {
    var list = qf(document, 'overview-list');
    list.textContent = '';

    questions.forEach(function (q) {
      var node = templateRoot('tpl-overview-item').cloneNode(true);
      var link = node.querySelector('.overview-item__link');
      link.dataset.nav = 'question';
      link.dataset.qid = q.id;
      qf(node, 'eyebrow').textContent = eyebrowFor(q);
      qf(node, 'title').textContent = q.shortTitle;
      applyChip(qf(node, 'status'), ballot[q.id].choice);
      list.appendChild(node);
    });

    updateProgress();
  }

  /* ===========================================================================
     7. RENDER — QUESTION VIEW  (§8)
     ======================================================================== */

  // Typed content blocks (§4/§8): h2/h3/p/ul/ol/table. Unknown types are ignored
  // (forward-compatible). Everything set via textContent — no HTML-in-JSON.
  function renderBlocks(container, blocks) {
    container.textContent = '';
    (blocks || []).forEach(function (b) {
      var node;
      switch (b.type) {
        case 'h2': node = el('h2', b.text); break;
        case 'h3': node = el('h3', b.text); break;
        case 'p':  node = el('p', b.text); break;
        case 'ul':
        case 'ol':
          node = el(b.type);
          (b.items || []).forEach(function (it) { node.appendChild(el('li', it)); });
          break;
        case 'table': node = renderTable(b); break;
        default: return; // ignore unknown block types
      }
      container.appendChild(node);
    });
  }

  function renderTable(b) {
    var table = el('table');
    if (b.headers && b.headers.length) {
      var thead = el('thead'), htr = el('tr');
      b.headers.forEach(function (h) { htr.appendChild(el('th', h)); });
      thead.appendChild(htr);
      table.appendChild(thead);
    }
    var tbody = el('tbody');
    (b.rows || []).forEach(function (row) {
      var tr = el('tr');
      row.forEach(function (cell) { tr.appendChild(el('td', cell)); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function renderParagraphs(container, arr) {
    container.textContent = '';
    (arr || []).forEach(function (t) { container.appendChild(el('p', t)); });
  }

  function renderNamedList(ul, arr, emptyMsg) {
    ul.textContent = '';
    if (arr && arr.length) {
      arr.forEach(function (x) { ul.appendChild(el('li', x)); });
    } else {
      var li = el('li', emptyMsg);
      li.className = 'is-muted';
      ul.appendChild(li);
    }
  }

  function renderDeeper(container, arr) {
    container.textContent = '';
    (arr || []).forEach(function (item) {
      var node = templateRoot('tpl-deeper-item').cloneNode(true);
      qf(node, 'heading').textContent = item.heading;
      renderParagraphs(qf(node, 'body'), item.body);
      container.appendChild(node);
    });
  }

  function renderQuestion(id) {
    var q = getQuestion(id);
    if (!q) { navigate('overview'); return; }
    var V = viewByName('question');

    qf(V, 'eyebrow').textContent = eyebrowFor(q);
    qf(V, 'title').textContent = q.shortTitle;

    // Inversion callout (§8.3) — built from data, NOT special-cased to firearms.
    var callout = qf(V, 'inversion');
    callout.textContent = '';
    if (q.inverted) {
      callout.appendChild(el('h2', 'Read this one carefully'));
      callout.appendChild(el('p', 'This question works differently than you might expect.'));
      callout.appendChild(labeledLine('p', 'A YES vote: ', q.yesMeans));
      callout.appendChild(labeledLine('p', 'A NO vote: ', q.noMeans));
      callout.hidden = false;
    } else {
      callout.hidden = true;
    }

    qf(V, 'yesMeans').textContent = q.yesMeans;
    qf(V, 'noMeans').textContent = q.noMeans;

    renderParagraphs(qf(V, 'summary'), q.summary);

    var fiscal = qf(V, 'fiscal');
    if (q.fiscal) { fiscal.textContent = q.fiscal; fiscal.hidden = false; }
    else { fiscal.textContent = ''; fiscal.hidden = true; }

    renderBlocks(qf(V, 'guide'), q.fullGuide);
    renderNamedList(qf(V, 'support'), q.support, 'None listed.');
    renderNamedList(qf(V, 'oppose'), q.oppose, 'No organized opposition.');
    renderDeeper(qf(V, 'deeper'), q.deeper);

    qf(V, 'note').value = ballot[id].note || '';
    renderChoiceButtons(id);
    renderQuestionNav(V, id);
  }

  function renderChoiceButtons(id) {
    var V = viewByName('question');
    var c = ballot[id].choice;
    qsa('.choice-btn', V).forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.choice === c));
    });
  }

  function renderQuestionNav(V, id) {
    var n = neighbors(id);
    setNavLink(qf(V, 'prev'), n.prev, 'prev');
    setNavLink(qf(V, 'next'), n.next, 'next');
  }

  function setNavLink(a, q, dir) {
    if (q) {
      a.dataset.nav = 'question';
      a.dataset.qid = q.id;
      a.setAttribute('aria-disabled', 'false');
      a.textContent = (dir === 'prev' ? '← Previous: ' : 'Next: ') + q.shortTitle +
        (dir === 'next' ? ' →' : '');
    } else {
      // No target: strip data-nav so clicks don't route; CSS pointer-events:none
      // (via aria-disabled) also blocks activation.
      a.removeAttribute('data-nav');
      a.removeAttribute('data-qid');
      a.setAttribute('aria-disabled', 'true');
      a.textContent = dir === 'prev' ? '← Previous' : 'Next →';
    }
  }

  /* ===========================================================================
     8. RENDER — SUMMARY / BALLOT CARD  (§9)
     ======================================================================== */

  function renderSummary() {
    var V = viewByName('summary');
    qf(V, 'election-date').textContent = formatDate(meta.electionDate);
    qf(V, 'disclaimer').textContent = meta.disclaimer || '';

    var rows = qf(V, 'ballot-rows');
    rows.textContent = '';

    questions.forEach(function (q) {
      var node = templateRoot('tpl-ballot-row').cloneNode(true);
      var c = ballot[q.id].choice;
      var b = ballot[q.id];

      qf(node, 'num').textContent =
        (meta.ballotOrderCertified && q.ballotNumber != null) ? ('Q' + q.ballotNumber) : '';
      qf(node, 'title').textContent = q.shortTitle;

      var choiceEl = qf(node, 'choice');
      choiceEl.textContent = choiceWord(c);
      if (c === 'yes') choiceEl.classList.add('is-yes');
      else if (c === 'no') choiceEl.classList.add('is-no');
      else if (c === 'undecided') choiceEl.classList.add('is-undecided');

      var noteEl = qf(node, 'note');
      if (b.note && b.note.trim()) { noteEl.textContent = 'note: ' + b.note.trim(); noteEl.hidden = false; }

      // Compressed inversion reminder on the card (§8.3). Prefer an explicit
      // short field if content adds one later; otherwise derive from yesMeans.
      var invEl = qf(node, 'inversion');
      if (q.inverted) {
        invEl.textContent = '⚠ ' + (q.inversionShort || ('Yes = ' + q.yesMeans));
        invEl.hidden = false;
      }

      rows.appendChild(node);
    });

    // Undecided status line + review button + completion nudge (§9.3, §10).
    var notDecided = questions.filter(function (q) { return !isDecided(ballot[q.id].choice); });
    var line = qf(V, 'undecided-line');
    var reviewBtn = V.querySelector('[data-action="review-undecided"]');

    if (notDecided.length === 0) {
      line.textContent = 'All set! Print, copy, or screenshot your card now — your notes disappear when you close this page.';
      reviewBtn.hidden = true;
    } else {
      line.textContent = notDecided.length + (notDecided.length === 1 ? ' question' : ' questions') + ' still undecided.';
      reviewBtn.hidden = false;
    }

    renderQR(qf(V, 'qr'), buildResumeUrl());
    updateProgress();
  }

  /* ===========================================================================
     9. PROGRESS  (header + overview, §12)
     ======================================================================== */

  function updateProgress() {
    var total = questions.length;
    var decided = questions.filter(function (q) { return isDecided(ballot[q.id].choice); }).length;
    qsa('[data-field="progress-short"]').forEach(function (e) { e.textContent = '(' + decided + '/' + total + ')'; });
    qsa('[data-field="progress-long"]').forEach(function (e) {
      e.textContent = "You've decided " + decided + ' of ' + total + ' questions.';
    });
  }

  /* ===========================================================================
     10. NEIGHBORS / REVIEW-UNDECIDED NAV FILTER (§9.3)
     ======================================================================== */

  function neighbors(id) {
    var idx = questions.findIndex(function (q) { return q.id === id; });
    if (reviewMode) {
      return { prev: scanUndecided(idx, -1), next: scanUndecided(idx, +1) };
    }
    return { prev: questions[idx - 1] || null, next: questions[idx + 1] || null };
  }

  // Dynamically finds the nearest not-yet-decided question in a direction, so it
  // self-updates as the voter decides questions during the review pass.
  function scanUndecided(from, step) {
    for (var i = from + step; i >= 0 && i < questions.length; i += step) {
      if (!isDecided(ballot[questions[i].id].choice)) return questions[i];
    }
    return null;
  }

  /* ===========================================================================
     11. EXPORT — copy-as-text (§9.2)
     ======================================================================== */

  function buildCardText() {
    var lines = [];
    lines.push('MY BALLOT CARD — Massachusetts, ' + formatDate(meta.electionDate));
    lines.push('(cSPA voter guide · not an official ballot)');

    questions.forEach(function (q) {
      var b = ballot[q.id];
      var num = (meta.ballotOrderCertified && q.ballotNumber != null) ? ('Q' + q.ballotNumber + ' ') : '';
      var line = num + q.shortTitle + ' — ' + choiceWord(b.choice);
      if (q.inverted) line += ' (' + (q.inversionShort || ('yes = ' + q.yesMeans)) + ')';
      lines.push(line);
      if (b.note && b.note.trim()) lines.push('   note: ' + b.note.trim());
    });

    var undec = questions
      .filter(function (q) { return !isDecided(ballot[q.id].choice); })
      .map(function (q) {
        return (meta.ballotOrderCertified && q.ballotNumber != null) ? ('Q' + q.ballotNumber) : q.shortTitle;
      });
    if (undec.length) lines.push('Still undecided: ' + undec.join(', '));

    lines.push('Reopen my choices: ' + buildResumeUrl());
    lines.push('(that link contains your choices — share it only with yourself)');
    return lines.join('\n');
  }

  // Clipboard fallback chain (§11): async clipboard → execCommand → visible box.
  function doCopy() {
    var text = buildCardText();

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { announce('Copied to clipboard.'); },
        function () { if (!execCommandCopy(text)) showCopyFallback(text); else announce('Copied to clipboard.'); }
      );
      return;
    }
    if (execCommandCopy(text)) { announce('Copied to clipboard.'); return; }
    showCopyFallback(text);
  }

  // Tier 2: hidden textarea + execCommand. Uses the .visually-hidden utility so
  // no inline styles are needed (keeps the strict CSP intact).
  function execCommandCopy(text) {
    var ta = el('textarea');
    ta.className = 'visually-hidden';
    ta.value = text;
    ta.setAttribute('readonly', '');
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  // Tier 3: a visible, pre-selected textarea the voter copies manually.
  function showCopyFallback(text) {
    var V = viewByName('summary');
    var box = V.querySelector('.copy-fallback');
    if (!box) {
      box = el('div');
      box.className = 'copy-fallback';
      box.appendChild(el('p',
        'Copy didn’t work automatically. Select the text below and copy it ' +
        '(on mobile: tap and hold → Select All → Copy):'));
      var ta = el('textarea');
      ta.className = 'copy-fallback__text';
      ta.setAttribute('readonly', '');
      ta.rows = 12;
      box.appendChild(ta);
      var actions = V.querySelector('.ballot-card__actions');
      actions.parentNode.insertBefore(box, actions.nextSibling);
    }
    var area = box.querySelector('textarea');
    area.value = text;
    box.hidden = false;
    area.focus();
    area.select();
    announce('Automatic copy is unavailable — the text is selected below for you to copy.');
  }

  /* ===========================================================================
     12. EXPORT — print (§9.1) and QR (§9.4)
     ======================================================================== */

  function doPrint() {
    try { window.print(); }
    catch (e) { announce('Printing isn’t available here — try “Copy as text”, or take a screenshot of your card.'); }
    if (isInAppBrowser()) {
      announce('If nothing prints, open this page in your browser (Safari/Chrome), or screenshot the card.');
    }
  }

  // QR is generated ENTIRELY client-side from the vendored library (§9.4) — never
  // an external image API. We render large (512px) so the print stylesheet can
  // scale it down to a crisp 3cm; CSS keeps it inside its box on screen.
  // Adapter targets the common davidshimjs `QRCode` global; degrades to a link.
  function renderQR(container, text) {
    container.textContent = '';
    if (typeof window.QRCode === 'function') {
      try {
        new window.QRCode(container, {
          text: text,
          width: 512,
          height: 512,
          correctLevel: (window.QRCode.CorrectLevel && window.QRCode.CorrectLevel.M) || 0
        });
        return;
      } catch (e) { /* fall through to link */ }
    }
    var a = el('a', 'Open your resume link');
    a.href = text;
    a.className = 'qr__fallback-link';
    container.appendChild(a);
  }

  /* ===========================================================================
     13. ENVIRONMENT DETECTION (§11)
     ======================================================================== */

  function isInAppBrowser() {
    var ua = navigator.userAgent || '';
    return /FBAN|FBAV|Instagram|Line\/|Twitter|TikTok|musical_ly|; wv\)/i.test(ua);
  }

  function isLikelyDesktop() {
    return !('ontouchstart' in window) &&
      !/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent || '');
  }

  function showWebviewNudge() {
    var ov = viewByName('overview');
    var p = el('p', 'For printing and reliable copying, open this page in your browser (tap ••• → “Open in browser”).');
    p.className = 'banner banner--notice';
    var h1 = ov.querySelector('h1');
    ov.insertBefore(p, h1.nextSibling);
  }

  /* ===========================================================================
     14. beforeunload — DESKTOP ONLY, notes-only (§10)
     Notes are the only unrecoverable state (choices survive via the fragment).
     We don't register on mobile: it doesn't fire on iOS Safari and can disable
     bfcache, perversely increasing loss risk.
     ======================================================================== */

  function armBeforeUnload() {
    if (beforeUnloadArmed || !isLikelyDesktop()) return;
    beforeUnloadArmed = true;
    window.addEventListener('beforeunload', function (e) {
      var hasNote = questions.some(function (q) {
        var n = ballot[q.id].note;
        return n && n.trim();
      });
      if (!hasNote) return;
      e.preventDefault();
      e.returnValue = ''; // required by some browsers to trigger the prompt
    });
  }

  /* ===========================================================================
     15. EVENT WIRING (delegated)
     ======================================================================== */

  function wireEvents() {
    document.addEventListener('click', onClick);
    document.getElementById('main').addEventListener('input', onInput);
    window.addEventListener('hashchange', routeAndRender);
  }

  function onClick(e) {
    var navEl = e.target.closest('[data-nav]');
    if (navEl) { e.preventDefault(); handleNav(navEl); return; }

    var actEl = e.target.closest('[data-action]');
    if (actEl) { handleAction(actEl.dataset.action); return; }

    var chEl = e.target.closest('[data-choice]');
    if (chEl) { handleChoice(chEl); return; }
  }

  function onInput(e) {
    if (e.target && e.target.id === 'note-input' && currentQuestionId) {
      ballot[currentQuestionId].note = e.target.value; // notes never touch the hash
      armBeforeUnload();
    }
  }

  function handleNav(el) {
    var view = el.dataset.nav;
    if (!view) return;
    if (view === 'overview' || view === 'summary') reviewMode = false;
    navigate(view, el.dataset.qid);
  }

  function handleAction(action) {
    switch (action) {
      case 'start':
        reviewMode = false;
        if (questions[0]) navigate('question', questions[0].id);
        break;
      case 'print': doPrint(); break;
      case 'copy': doCopy(); break;
      case 'review-undecided': doReview(); break;
    }
  }

  function doReview() {
    var first = questions.find(function (q) { return !isDecided(ballot[q.id].choice); });
    if (!first) { announce('All questions are decided.'); return; }
    reviewMode = true;
    navigate('question', first.id);
  }

  function handleChoice(el) {
    var id = currentQuestionId;
    if (!id) return;
    var choice = el.dataset.choice;
    // Clicking the active choice again clears it back to "no choice".
    ballot[id].choice = (ballot[id].choice === choice) ? null : choice;
    renderChoiceButtons(id);
    syncHashState();   // mirror choices into the URL immediately (§6)
    updateProgress();
  }

  /* ===========================================================================
     16. SMALL PURE HELPERS
     ======================================================================== */

  function getQuestion(id) { return questions.find(function (q) { return q.id === id; }); }
  function isDecided(c) { return c === 'yes' || c === 'no'; }

  function choiceWord(c) {
    if (c === 'yes') return 'YES';
    if (c === 'no') return 'NO';
    if (c === 'undecided') return 'UNDECIDED';
    return 'NOT ANSWERED';
  }

  function formatDate(iso) {
    if (!iso) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!m) return iso;
    return MONTHS[(+m[2]) - 1] + ' ' + (+m[3]) + ', ' + m[1]; // parsed by hand to avoid TZ shift
  }

  /* ===========================================================================
     17. INIT
     ======================================================================== */

  function init() {
    wireEvents();
    setStatus('Loading questions…');

    fetch('questions.json', { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        meta = data.meta || {};
        questions = Array.isArray(data.questions) ? data.questions : [];

        // Seed authoritative state, then restore choices from the fragment (once).
        questions.forEach(function (q) { ballot[q.id] = { choice: null, note: '' }; });
        decodeState(parseHash(location.hash).s);

        // Data-driven banners (§4).
        toggleFlag('draft', !!meta.draft);
        toggleFlag('order-uncertified', !meta.ballotOrderCertified);

        if (isInAppBrowser()) showWebviewNudge();

        clearStatus();
        updateProgress();
        routeAndRender();     // first paint (no focus/scroll)
        initialized = true;   // subsequent navigations manage focus (§12)
      })
      .catch(function () {
        setStatus('Sorry — the ballot questions could not be loaded. Please refresh, or contact cSPA.');
      });
  }

  init();
})();