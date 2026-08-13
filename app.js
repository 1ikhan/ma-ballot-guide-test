/* =============================================================================
   app.js — MA 2026 Ballot Question Guide
   -----------------------------------------------------------------------------
   Responsibilities: fetch questions.json, hold in-memory state, route between
   the three views via the URL hash, PERSIST choices + notes to localStorage,
   render each view from data, and drive the export paths (print / copy /
   screenshot-friendly; QR is paused — see §13).

   State model (Pass 2 — ADR Part A):
     - In-memory `ballot` is always authoritative during a session.
     - localStorage is the primary recovery mechanism: an id-keyed, versioned,
       timestamped blob under ONE namespaced key (D1/D2). It survives reload,
       tab close, and browser restart, and — unlike the fragment — it survives a
       question being struck, reordered, or added.
     - The URL fragment is now a FALLBACK, not the default (D5). When storage
       works, the hash carries routing only (`q=`, `v=`) so vote choices never
       land in browser history. When storage is unavailable, the old
       choices-in-hash mirroring returns unchanged, so reload recovery still
       works in that degraded mode.
     - Incoming `s=` links are still honored exactly once at load and WIN over
       stored choices (D3), because opening a resume link is a deliberate act.
       When storage works, `s=` is then stripped from the address bar.
     - There is no `beforeunload` prompt (D6): notes are no longer
       unrecoverable, and dropping it restores bfcache eligibility.

   Design rules honored throughout:
     - Data, not structure: the count, order, and every string come from JSON.
       Nothing here assumes "nine". Palette and progress bar scale to whatever
       questions.json contains.
     - No innerHTML for content: DOM is built with createElement + textContent
       and cloned <template>s, so JSON (or a tampered storage blob) can't inject
       markup.
     - No inline styles: we toggle classes and the [hidden] attribute only, plus
       one data-* attribute (data-accent) that CSS reads — never element.style —
       so the strict `default-src 'self'` CSP stays valid. localStorage is not a
       CSP concern and adds no network request.
     - Notes never enter the URL (length + privacy).
   Loaded with `defer`, so the DOM is parsed before this runs; init() is called
   directly at the bottom.
   ========================================================================== */
(function () {
  'use strict';
  /* ===========================================================================
     0. CONSTANTS & MODULE STATE
     ======================================================================== */
  // Fragment alphabet. One char per question, canonical `questions` order.
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
  // Identity-color palette size. MUST match the count of --q-accent-* tokens in
  // styles.css (nine). Questions cycle through these by position unless a
  // question supplies its own `accent` field in questions.json.
  var ACCENT_COUNT = 9;
  // Mirrors the <textarea maxlength> in index.html. Applied again on read, since
  // a hand-edited storage blob can exceed it (B-15).
  var NOTE_MAX = 200;
  // --- Storage (D1/D2/D8) ---
  var STORAGE_KEY = 'cspa:ma-ballot-2026:v1'; // bump the suffix to migrate
  var STORAGE_SCHEMA = 1;
  var PERSIST_DEBOUNCE_MS = 400;              // note typing only
  var RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // purge 30 days after election

  // Authoritative session state.
  var meta = {};                 // questions.json → meta
  var questions = [];            // questions.json → questions (canonical order)
  var ballot = {};               // { [id]: { choice, note } }
  // View bookkeeping (mirrors the hash; used by syncHashState()).
  var currentView = 'overview';
  var currentQuestionId = null;
  var reviewMode = false;        // "Review my undecideds" nav filter (ephemeral)
  var initialized = false;       // suppress focus/scroll on the very first paint
  var dataReady = false;         // gate routing until the fetch resolves (B-1)
  // Storage bookkeeping.
  var storageOk = false;         // false → degrade to fragment mirroring
  var persistTimer = null;
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
  // Transient announcement for export/erase actions (also read by screen readers).
  function announce(msg) { setStatus(msg); }
  // Data-driven banners and the storage-mode copy swap. Handles every match, so
  // the same flag can appear in more than one place.
  function toggleFlag(name, show) {
    qsa('[data-flag="' + name + '"]').forEach(function (e) { e.hidden = !show; });
  }
  /* ===========================================================================
     3. STORAGE  (ADR D1–D4, D7, D8)
     One JSON blob, one key: atomic read/write, trivial purge, easy migration.
     Every access is wrapped: some webviews throw on merely touching
     window.localStorage, and Safari private mode throws on setItem.
     ======================================================================== */
  function detectStorage() {
    try {
      var k = STORAGE_KEY + ':test';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return true;
    } catch (e) {
      return false;
    }
  }
  function removeStored() {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* nothing to do */ }
  }
  // Political preferences have no value after the election; don't hoard them.
  // Cutoff = election date + 30 days. We purge if EITHER the clock or the blob's
  // own savedAt is past it (the latter keeps the check testable and survives a
  // wrong device clock).
  function retentionCutoff() {
    var t = Date.parse((meta.electionDate || '') + 'T00:00:00Z');
    return isNaN(t) ? null : t + RETENTION_MS;
  }
  function sanitizeChoice(c) {
    return (c === 'yes' || c === 'no' || c === 'undecided') ? c : null;
  }
  function sanitizeNote(n) {
    return (typeof n === 'string') ? n.slice(0, NOTE_MAX) : '';
  }
  // getItem → parse → shape-check. Any failure discards the blob and returns
  // null: a bad blob must never crash init or leave half-state behind.
  function readStored() {
    if (!storageOk) return null;
    var raw;
    try { raw = window.localStorage.getItem(STORAGE_KEY); } catch (e) { return null; }
    if (!raw) return null;
    var data;
    try { data = JSON.parse(raw); } catch (e) { removeStored(); return null; }
    if (!data || typeof data !== 'object' ||
        data.schema !== STORAGE_SCHEMA ||
        !data.ballot || typeof data.ballot !== 'object' || Array.isArray(data.ballot)) {
      removeStored();
      return null;
    }
    var cutoff = retentionCutoff();
    if (cutoff != null && (Date.now() > cutoff ||
        (typeof data.savedAt === 'number' && data.savedAt > cutoff))) {
      removeStored();
      return null;
    }
    return data;
  }
  // Field-level sanitization on the way in. Ids we don't recognize are ignored
  // (a struck question), and ids missing from the blob keep their seeded
  // defaults — which is why an id-keyed schema survives content edits.
  // Returns true if anything actually changed (used by the multi-tab handler).
  function mergeStored(data) {
    var changed = false;
    questions.forEach(function (q) {
      var entry = data.ballot[q.id];
      if (!entry || typeof entry !== 'object') return;
      var c = sanitizeChoice(entry.choice);
      var n = sanitizeNote(entry.note);
      if (ballot[q.id].choice !== c) { ballot[q.id].choice = c; changed = true; }
      if (ballot[q.id].note !== n) { ballot[q.id].note = n; changed = true; }
    });
    return changed;
  }
  function persistNow() {
    if (!storageOk) return;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({
        schema: STORAGE_SCHEMA,
        savedAt: Date.now(),
        ballot: ballot
      }));
    } catch (e) {
      // Quota exceeded, or private mode revoking writes mid-session. Fall back
      // to the fragment so recovery still works, and fix the UI promises.
      storageOk = false;
      applyStorageCopy();
      syncHashState();
    }
  }
  // Notes fire on every keystroke; coalesce them.
  function persistDebounced() {
    if (!storageOk) return;
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(function () {
      persistTimer = null;
      persistNow();
    }, PERSIST_DEBOUNCE_MS);
  }
  // `pagehide` and `visibilitychange → hidden` are the only reliable
  // "user is leaving" signals on mobile Safari/Chrome.
  function flushPersist() {
    if (persistTimer) persistNow();
  }
  function resetBallot() {
    questions.forEach(function (q) { ballot[q.id] = { choice: null, note: '' }; });
  }
  // One-click erasure (privacy is paramount): key gone, state reset, any `s=`
  // dropped from the address bar, UI re-rendered, outcome announced.
  function clearStored() {
    removeStored();
    resetBallot();
    reviewMode = false;
    showView(currentView, currentQuestionId, false);
    syncHashState();
    updateProgress();
    announce('Your saved answers and notes have been erased from this device.');
  }
  // Multi-tab: last write wins, plus a read-only refresh so the other tab isn't
  // showing a stale card. Never writes back — that would loop.
  function onStorageEvent(e) {
    if (!dataReady || !storageOk || !e || e.key !== STORAGE_KEY) return;
    if (e.newValue == null) {          // another tab pressed "Clear"
      resetBallot();
      refreshFromExternalChange();
      return;
    }
    var data = readStored();
    if (data && mergeStored(data)) refreshFromExternalChange();
  }
  // Targeted refresh, NOT a full re-render: rebuilding the question view would
  // collapse the reader's open <details> and stomp a note mid-typing.
  function refreshFromExternalChange() {
    updateProgress();
    refreshProgressBars();
    if (currentView === 'overview') {
      renderOverview();
    } else if (currentView === 'summary') {
      renderSummary();
    } else if (currentView === 'question' && currentQuestionId) {
      renderChoiceButtons(currentQuestionId);
      var ta = document.getElementById('note-input');
      if (ta && document.activeElement !== ta) ta.value = ballot[currentQuestionId].note || '';
    }
  }
  // Keeps every UI promise about saving true in both modes. Called at init and
  // again if writes start failing mid-session.
  function applyStorageCopy() {
    toggleFlag('storage-on', storageOk);
    toggleFlag('storage-off', !storageOk);
    var hint = document.getElementById('note-hint');
    if (hint) {
      hint.textContent = storageOk
        ? 'Saved on this device, in this browser. Print or copy your card to keep a copy.'
        : 'Notes aren’t saved on this device — print or copy your card before you leave.';
    }
    var clearBtn = document.querySelector('[data-action="clear-saved"]');
    if (clearBtn) clearBtn.hidden = !storageOk;
  }
  /* ===========================================================================
     4. FRAGMENT STATE  — encode/decode CHOICES only
     Now a fallback path (D5). buildResumeUrl() still builds an `s=` payload on
     demand for copy-as-text (and QR later): explicit sharing stays, ambient
     leaking into history stops.
     ======================================================================== */
  function schemaVersion() {
    return meta.fragmentSchemaVersion != null ? meta.fragmentSchemaVersion : 1;
  }
  // "1.YN-U--N--" → version + one char per question in canonical order.
  function buildStateString() {
    var chars = questions.map(function (q) {
      return CHOICE_TO_CHAR[ballot[q.id].choice] || '-';
    }).join('');
    return schemaVersion() + '.' + chars;
  }
  // Decode only if version AND length match. Otherwise silently start fresh.
  // Called ONCE at load; never on hashchange.
  // OPERATIONAL RULE: because this encoding is POSITIONAL, bump
  // meta.fragmentSchemaVersion whenever the question list changes in count or
  // order — that invalidates old links/QRs explicitly rather than by accident.
  // (Stored state is id-keyed and therefore immune.)
  function decodeState(s) {
    if (!s) return false;
    var dot = s.indexOf('.');
    if (dot < 0) return false;
    if (parseInt(s.slice(0, dot), 10) !== schemaVersion()) return false;
    var chars = s.slice(dot + 1);
    if (chars.length !== questions.length) return false; // stale-length guard
    questions.forEach(function (q, i) {
      var c = CHAR_TO_CHOICE[chars[i]];       // '-' → null; unknown → undefined
      if (c !== undefined) ballot[q.id].choice = c;
    });
    return true;
  }
  // Canonical resume link = same-origin URL + choices-only fragment.
  // Built on demand for copy-as-text (and the QR payload once un-paused).
  function buildResumeUrl() {
    return location.origin + location.pathname + '#s=' + buildStateString();
  }
  /* ===========================================================================
     5. HASH ROUTING
     Route shapes (storage available):
       overview → #            question → #q=<id>            summary → #v=summary
     Route shapes (storage unavailable — fragment fallback):
       overview → #s=<state>   question → #q=<id>&s=<state>  summary → #v=summary&s=<state>
     A bare "#s=…" resume link lands on the overview with choices restored in
     either mode; `q`/`v` select the view.
     ======================================================================== */
  function parseHash(hash) {
    var out = {};
    (hash || '').replace(/^#/, '').split('&').forEach(function (pair) {
      if (!pair) return;
      var i = pair.indexOf('=');
      var k = i < 0 ? pair : pair.slice(0, i);
      var v = i < 0 ? '' : pair.slice(i + 1);
      // decodeURIComponent throws URIError on malformed input (e.g. "#s=%").
      // Keep the raw value rather than taking down routing (B-2).
      try { v = decodeURIComponent(v); } catch (e) { /* keep raw */ }
      out[k] = v;
    });
    return out;
  }
  function buildHash(view, id) {
    var parts = [];
    if (view === 'question' && id) parts.push('q=' + encodeURIComponent(id));
    else if (view === 'summary') parts.push('v=summary');
    // Choices ride along ONLY when storage can't do the job (D5).
    if (!storageOk) parts.push('s=' + buildStateString());
    return '#' + parts.join('&');
  }
  // Navigation = a NEW history entry, so Back moves between views. We pushState
  // rather than assigning location.hash because the storage-mode overview route
  // is a bare "#", which assignment can't reliably re-trigger.
  function navigate(view, id) {
    var target = buildHash(view, id);
    var current = location.hash || '#';
    if (current === target) { routeAndRender(); return; } // same URL: re-render/re-focus
    try {
      history.pushState(null, '', target);
    } catch (e) {
      location.hash = target;   // fires hashchange → routeAndRender
      return;
    }
    routeAndRender();
  }
  // Choice changes = replaceState (no history spam). Does NOT fire hashchange.
  // Safari throttles replaceState (~100 calls / 30 s) and throws when exceeded,
  // so this is guarded (B-9). In storage mode it also does the D5 strip: the
  // rewritten hash simply has no `s=` in it.
  function syncHashState() {
    try {
      history.replaceState(null, '', buildHash(currentView, currentQuestionId));
    } catch (e) { /* history is a convenience here, never the source of truth */ }
  }
  function routeAndRender() {
    // Until questions.json has resolved, `questions`/`ballot` are empty and a
    // stray hashchange would let syncHashState() overwrite an incoming resume
    // link with "#s=1." — destroying the payload before we read it (B-1).
    if (!dataReady) return;
    var p = parseHash(location.hash);
    var view, qid = null;
    if (p.q && ballot[p.q]) { view = 'question'; qid = p.q; } // ignore stale ids
    else if (p.v === 'summary') { view = 'summary'; }
    else { view = 'overview'; }
    currentView = view;
    currentQuestionId = qid;
    showView(view, qid, initialized); // focus/scroll only after the first paint
    syncHashState();                  // rewrite this entry from live state:
                                      // heals a stale choice string on arrival,
                                      // and strips `s=` when storage is in use
  }
  /* ===========================================================================
     6. VIEW SWITCHING + FOCUS MANAGEMENT
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
    // Leaving the flow for Overview or Summary ends the review-undecideds filter.
    if (view === 'overview' || view === 'summary') reviewMode = false;
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
     7. RENDER — OVERVIEW
     ======================================================================== */
  function eyebrowFor(q) {
    var label = TYPE_LABELS[q.type] ||
      (q.type ? q.type.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : '');
    // Numbers appear only once the ballot order is certified. No placeholders.
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
    questions.forEach(function (q, i) {
      var node = templateRoot('tpl-overview-item').cloneNode(true);
      node.dataset.accent = String(accentFor(q, i)); // identity color hook (CSS → --q-color)
      var link = node.querySelector('.overview-item__link');
      link.dataset.nav = 'question';
      link.dataset.qid = q.id;
      link.href = '#q=' + encodeURIComponent(q.id);   // real target for middle-click
      qf(node, 'eyebrow').textContent = eyebrowFor(q);
      qf(node, 'title').textContent = q.shortTitle;
      applyChip(qf(node, 'status'), ballot[q.id].choice);
      list.appendChild(node);
    });
    updateProgress();
    renderProgressBar(qf(viewByName('overview'), 'progress-bar'), null);
  }
  /* ===========================================================================
     8. RENDER — QUESTION VIEW
     ======================================================================== */
  // Typed content blocks: h2/h3/p/ul/ol/table. Unknown types are ignored
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
    // Identity color for the eyebrow banner; CSS resolves data-accent → --q-color.
    V.dataset.accent = String(accentFor(q, questions.indexOf(q)));
    qf(V, 'eyebrow').textContent = eyebrowFor(q);
    qf(V, 'title').textContent = q.shortTitle;
    // Inversion callout — built from data, NOT special-cased to any question.
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
    qf(V, 'note').value = ballot[id].note || '';   // restores notes from storage
    renderChoiceButtons(id);
    renderQuestionNav(V, id);
    renderProgressBar(qf(V, 'progress-bar'), id);
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
    // Prev: previous question, or back to the Overview at the very start.
    if (n.prev) setNavLink(qf(V, 'prev'), n.prev, 'prev');
    else        setNavToView(qf(V, 'prev'), 'overview', '← All questions', '#');
    // Next: next question, or on to the ballot card (Summary) at the very end —
    // never a dead-ended, grayed-out button. (Which is why there is no disabled
    // state in the CSS: this nav can't produce one.)
    if (n.next) setNavLink(qf(V, 'next'), n.next, 'next');
    else        setNavToView(qf(V, 'next'), 'summary', 'Review ballot card →', '#v=summary');
  }
  function setNavLink(a, q, dir) {
    a.dataset.nav = 'question';
    a.dataset.qid = q.id;
    a.href = '#q=' + encodeURIComponent(q.id);
    a.textContent = (dir === 'prev' ? '← Previous: ' : 'Next: ') + q.shortTitle +
      (dir === 'next' ? ' →' : '');
  }
  // Route a Prev/Next slot to a VIEW (overview/summary) rather than a question,
  // so the ends of the list flow somewhere useful instead of disabling.
  function setNavToView(a, view, label, href) {
    a.dataset.nav = view;
    a.removeAttribute('data-qid');
    a.href = href;
    a.textContent = label;
  }
  /* ===========================================================================
     9. RENDER — SUMMARY / BALLOT CARD
     ======================================================================== */
  function renderSummary() {
    var V = viewByName('summary');
    qf(V, 'election-date').textContent = formatDate(meta.electionDate);
    qf(V, 'disclaimer').textContent = meta.disclaimer || '';
    var rows = qf(V, 'ballot-rows');
    rows.textContent = '';
    questions.forEach(function (q) {
      var node = templateRoot('tpl-ballot-row').cloneNode(true);
      var b = ballot[q.id];
      qf(node, 'num').textContent =
        (meta.ballotOrderCertified && q.ballotNumber != null) ? ('Q' + q.ballotNumber) : '';
      qf(node, 'title').textContent = q.shortTitle;
      var choiceEl = qf(node, 'choice');
      choiceEl.textContent = choiceWord(b.choice);
      if (b.choice === 'yes') choiceEl.classList.add('is-yes');
      else if (b.choice === 'no') choiceEl.classList.add('is-no');
      else if (b.choice === 'undecided') choiceEl.classList.add('is-undecided');
      var noteEl = qf(node, 'note');
      if (b.note && b.note.trim()) { noteEl.textContent = 'note: ' + b.note.trim(); noteEl.hidden = false; }
      // Compressed inversion reminder on the card. Prefer an explicit short
      // field if content adds one later; otherwise derive from yesMeans.
      var invEl = qf(node, 'inversion');
      if (q.inverted) {
        invEl.textContent = '⚠ ' + (q.inversionShort || ('Yes = ' + q.yesMeans));
        invEl.hidden = false;
      }
      rows.appendChild(node);
    });
    // Undecided status line + review button + completion nudge.
    var notDecided = questions.filter(function (q) { return !isDecided(ballot[q.id].choice); });
    var line = qf(V, 'undecided-line');
    var reviewBtn = V.querySelector('[data-action="review-undecided"]');
    if (notDecided.length === 0) {
      line.textContent = storageOk
        ? 'All set! Print or copy your card to take with you.'
        : 'All set! Print, copy, or screenshot your card now — your notes disappear when you close this page.';
      reviewBtn.hidden = true;
    } else {
      line.textContent = notDecided.length + (notDecided.length === 1 ? ' question' : ' questions') + ' still undecided.';
      reviewBtn.hidden = false;
    }
    renderQRBlock(V);
    // Print-only resume URL: only meaningful in fragment-fallback mode, where
    // the address bar is the sole carrier of the choices.
    var resume = qf(V, 'resume-print');
    if (resume) {
      resume.hidden = storageOk;
      resume.textContent = storageOk ? '' : 'Reopen my choices: ' + buildResumeUrl();
    }
    updateProgress();
  }
  /* ===========================================================================
     10. PROGRESS  (header counters + clickable progress bar)
     ======================================================================== */
  function updateProgress() {
    var total = questions.length;
    var decided = questions.filter(function (q) { return isDecided(ballot[q.id].choice); }).length;
    qsa('[data-field="progress-short"]').forEach(function (e) { e.textContent = '(' + decided + '/' + total + ')'; });
    qsa('[data-field="progress-long"]').forEach(function (e) {
      e.textContent = "You've decided " + decided + ' of ' + total + ' questions.';
    });
  }
  // One <a> segment per question, colored by decision status, linking straight
  // to that question. `activeId` marks the current one. Rebuilt from data, so it
  // scales to any question count automatically.
  function renderProgressBar(container, activeId) {
    if (!container) return;
    container.textContent = '';
    questions.forEach(function (q, i) {
      var choice = ballot[q.id].choice;
      var seg = el('a');
      seg.className = 'progress-seg ' + statusClass(choice);
      seg.href = '#q=' + encodeURIComponent(q.id);
      seg.dataset.nav = 'question';
      seg.dataset.qid = q.id;
      var numbered = meta.ballotOrderCertified && q.ballotNumber != null;
      seg.appendChild(el('span', String(numbered ? q.ballotNumber : (i + 1))));
      // Status conveyed in words for AT — never color alone.
      var label = (numbered ? 'Question ' + q.ballotNumber + ': ' : '') +
        q.shortTitle + ' — ' + choiceWord(choice);
      seg.setAttribute('aria-label', label);
      if (q.id === activeId) {
        seg.classList.add('is-active');
        seg.setAttribute('aria-current', 'true');
      }
      container.appendChild(seg);
    });
  }
  // Re-render every VISIBLE progress bar after a choice changes without a full
  // view switch (e.g. tapping Yes/No on the question view).
  function refreshProgressBars() {
    qsa('[data-field="progress-bar"]').forEach(function (c) {
      var view = c.closest('[data-view]');
      if (view && view.hidden) return;
      renderProgressBar(c, currentView === 'question' ? currentQuestionId : null);
    });
  }
  /* ===========================================================================
     11. NEIGHBORS / REVIEW-UNDECIDED NAV FILTER
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
     12. EXPORT — copy-as-text
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
    // Explicit sharing keeps the choices-in-link mechanism (D5): it's how a
    // voter moves their choices to another browser or device.
    lines.push('Reopen my choices: ' + buildResumeUrl());
    lines.push('(that link contains your choices — share it only with yourself)');
    return lines.join('\n');
  }
  // Clipboard fallback chain: async clipboard → execCommand → visible box.
  function doCopy() {
    var text = buildCardText();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { announce('Copied to clipboard.'); },
        function () { if (execCommandCopy(text)) announce('Copied to clipboard.'); else showCopyFallback(text); }
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
     13. EXPORT — print, and the PAUSED QR block
     ======================================================================== */
  function doPrint() {
    var printed = true;
    try { window.print(); } catch (e) { printed = false; }
    // One status region, so one message (B-12).
    if (!printed) {
      announce('Printing isn’t available here — use “Copy as text”, or take a screenshot of your card.');
    } else if (isInAppBrowser()) {
      announce('If nothing prints, open this page in your browser (Safari/Chrome), or screenshot the card.');
    }
  }
  // QR generation is PAUSED: qrcode.min.js is a stub that exports no global.
  // Rather than showing a bordered empty box, a "Scan to reopen…" label next to
  // a link, and a dead anchor on the printed card, we hide the whole block until
  // a real generator is vendored in. Hiding the container also removes the
  // focusable-link-inside-aria-hidden trap the old fallback created (B-3/B-4).
  function renderQRBlock(V) {
    var block = V.querySelector('.ballot-card__qr');
    var container = qf(V, 'qr');
    if (!block || !container) return;
    container.textContent = '';
    if (typeof window.QRCode !== 'function') {
      block.hidden = true;
      return;
    }
    // Render large (512px) so print.css can scale it down to a crisp 3cm.
    try {
      new window.QRCode(container, {
        text: buildResumeUrl(),
        width: 512,
        height: 512,
        correctLevel: (window.QRCode.CorrectLevel && window.QRCode.CorrectLevel.M) || 0
      });
      block.hidden = false;
    } catch (e) {
      block.hidden = true;   // never ship a half-drawn code
    }
  }
  /* ===========================================================================
     14. ENVIRONMENT DETECTION
     ======================================================================== */
  function isInAppBrowser() {
    var ua = navigator.userAgent || '';
    return /FBAN|FBAV|Instagram|Line\/|Twitter|TikTok|musical_ly|; wv\)/i.test(ua);
  }
  function showWebviewNudge() {
    var ov = viewByName('overview');
    var p = el('p', 'For printing and reliable copying, open this page in your browser (tap ••• → “Open in browser”).');
    p.className = 'banner banner--notice';
    var h1 = ov.querySelector('h1');
    ov.insertBefore(p, h1.nextSibling);
  }
  /* ===========================================================================
     15. EVENT WIRING (delegated)
     ======================================================================== */
  function wireEvents() {
    document.addEventListener('click', onClick);
    document.getElementById('main').addEventListener('input', onInput);
    window.addEventListener('hashchange', routeAndRender);
    // Leaving-the-page flushes for the debounced note writes (D4). These fire
    // reliably on mobile where beforeunload does not — and unlike beforeunload
    // they don't disqualify the page from bfcache.
    window.addEventListener('pagehide', flushPersist);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flushPersist();
    });
    // Multi-tab (D7): read-only refresh, last write wins.
    window.addEventListener('storage', onStorageEvent);
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
      persistDebounced();
    }
  }
  function handleNav(elm) {
    var view = elm.dataset.nav;
    if (!view) return;
    // A jump that isn't sequential Prev/Next (i.e. not inside .qnav) is a
    // deliberate move, so drop the "review undecideds" navigation filter.
    if (!elm.closest('.qnav')) reviewMode = false;
    navigate(view, elm.dataset.qid);
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
      case 'clear-saved': clearStored(); break;
    }
  }
  function doReview() {
    var first = questions.find(function (q) { return !isDecided(ballot[q.id].choice); });
    if (!first) { announce('All questions are decided.'); return; }
    reviewMode = true;
    navigate('question', first.id);
  }
  function handleChoice(btn) {
    var id = currentQuestionId;
    if (!id) return;
    var choice = btn.dataset.choice;
    // Clicking the active choice again clears it back to "no choice".
    ballot[id].choice = (ballot[id].choice === choice) ? null : choice;
    renderChoiceButtons(id);
    persistNow();           // one small synchronous write
    syncHashState();        // no-ops the `s=` part when storage is in use (D5)
    updateProgress();
    refreshProgressBars();  // keep the on-screen progress bar in sync live
  }
  /* ===========================================================================
     16. SMALL PURE HELPERS
     ======================================================================== */
  function getQuestion(id) { return questions.find(function (q) { return q.id === id; }); }
  function isDecided(c) { return c === 'yes' || c === 'no'; }
  // Identity-color slot for a question: an explicit `accent` in JSON wins,
  // otherwise cycle the palette by position. Never tied to the field size.
  function accentFor(q, i) {
    if (q && q.accent != null) return q.accent;
    var idx = (typeof i === 'number') ? i : questions.indexOf(q);
    return (idx % ACCENT_COUNT) + 1; // 1..ACCENT_COUNT
  }
  // Decision status → CSS hook for the progress bar segments.
  function statusClass(choice) {
    if (choice === 'yes' || choice === 'no') return 'is-decided';
    if (choice === 'undecided') return 'is-undecided';
    return 'is-unviewed';
  }
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
     17. CONTENT VALIDATION (draft builds only)
     A duplicate id would silently collapse two questions into one `ballot`
     entry and misalign the fragment; a missing field renders as "undefined".
     Cheap to check, and it catches content-editor mistakes before publish.
     ======================================================================== */
  function validateContent(raw) {
    var seen = {};
    var clean = [];
    raw.forEach(function (q, i) {
      if (!q || typeof q !== 'object' || !q.id) {
        console.warn('[questions.json] entry at index ' + i + ' has no id — skipped.');
        return;
      }
      if (seen[q.id]) {
        console.warn('[questions.json] duplicate id "' + q.id + '" — later copy skipped.');
        return;
      }
      seen[q.id] = true;
      clean.push(q);
      if (!meta.draft) return;   // deeper linting is a draft-time nicety
      ['shortTitle', 'yesMeans', 'noMeans'].forEach(function (f) {
        if (!q[f]) console.warn('[questions.json] "' + q.id + '" is missing ' + f + '.');
      });
      if (!Array.isArray(q.summary) || !q.summary.length) {
        console.warn('[questions.json] "' + q.id + '" has no summary paragraphs.');
      }
      if (meta.ballotOrderCertified && q.ballotNumber == null) {
        console.warn('[questions.json] "' + q.id + '" has no ballotNumber, but the order is marked certified.');
      }
    });
    return clean;
  }
  /* ===========================================================================
     18. INIT
     ======================================================================== */
  function init() {
    storageOk = detectStorage();
    wireEvents();
    setStatus('Loading questions…');
    fetch('questions.json', { cache: 'no-cache' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        meta = data.meta || {};
        questions = validateContent(Array.isArray(data.questions) ? data.questions : []);
        // Load precedence (D3): defaults → storage → fragment wins → persist.
        resetBallot();
        var stored = readStored();          // also enforces the retention purge
        if (stored) mergeStored(stored);
        var fromLink = decodeState(parseHash(location.hash).s);
        // Data-driven banners + storage-mode copy.
        toggleFlag('draft', !!meta.draft);
        toggleFlag('order-uncertified', !meta.ballotOrderCertified);
        applyStorageCopy();
        if (isInAppBrowser()) showWebviewNudge();
        clearStatus();
        updateProgress();
        dataReady = true;
        // Persist the merged result immediately, so a resume link "imports"
        // onto this device even if the voter closes the tab right away.
        if (fromLink || stored) persistNow();
        routeAndRender();     // first paint (no focus/scroll); also strips `s=`
                              // from the address bar when storage is in use
        initialized = true;   // subsequent navigations manage focus
      })
      .catch(function () {
        setStatus('Sorry — the ballot questions could not be loaded. Please refresh, or contact cSPA.');
      });
  }
  init();
})();
