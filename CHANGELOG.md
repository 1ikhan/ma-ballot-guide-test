# Changelog — MA 2026 Ballot Question Guide

All notable changes to this project. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); this project is not versioned
for public consumption, so "versions" here mean development passes.

---

## [2.0.0] — 2026-08-13 · Pass 2: local persistence + code audit

**Headline:** a voter's choices *and notes* now survive reload, tab close, and
browser restart, saved locally on their own device. As a direct consequence, vote
choices no longer sit in the URL — and therefore no longer accumulate in browser
history — during normal use.

This pass also fixed five bugs (one of which could ship an unstyled site, one of
which could silently destroy an incoming resume link), removed the broken
paused-QR UI, and deleted three pieces of dead code.

**Breaking / behavioral changes for voters:** none that lose data. Anyone
arriving with a V1 resume link (`#s=…`) is restored exactly as before, and their
state is then written to local storage. There is no V1 stored state to migrate,
because V1 stored nothing.

---

### Added

#### Local persistence (`app.js` §3)
- **`localStorage`-backed save** of choices and notes under a single namespaced
  key, `cspa:ma-ballot-2026:v1`. One JSON blob per browser profile per device:
  atomic read/write, trivial to purge, and migratable by bumping the key suffix.
- **Id-keyed schema**, deliberately unlike the URL fragment's positional
  encoding:
  ```json
  { "schema": 1, "savedAt": 1760000000000,
    "ballot": { "tax-cap-62f": { "choice": "yes", "note": "check §2 table" } } }
  ```
  A question being struck, added, or reordered therefore does **not** invalidate
  a voter's saved state. Unknown ids are ignored; absent ids keep their defaults.
- **Defensive read.** `schema` must match; `ballot` must be a plain object; every
  `choice` is coerced to `yes`/`no`/`undecided`/`null`; every `note` is coerced to
  a string and truncated to 200 chars (mirroring the textarea `maxlength`, which a
  hand-edited blob can otherwise bypass). Any parse or shape failure discards the
  blob and starts fresh. A corrupt blob can never crash init or leave half-state.
- **Write policy.** Choice changes persist immediately; note typing is debounced
  400 ms, with a flush on `pagehide` and on `visibilitychange → hidden` — the only
  reliable "user is leaving" signals on mobile Safari and Chrome.
- **Feature detection inside `try/catch`.** Some webviews throw `SecurityError` on
  merely *accessing* `window.localStorage`, and Safari private mode throws on
  `setItem`, so the detection is a real test write, wrapped.
- **Mid-session degradation.** If a write later fails (quota, private mode
  revoking access), `storageOk` flips to false, the UI copy is re-swapped, and
  fragment mirroring re-arms — so the interface's promise about saving is never
  false, even after a partial failure.

#### Retention and erasure
- **Automatic expiry.** At load, state is purged if the clock *or* the blob's own
  `savedAt` is past `meta.electionDate` + 30 days. Political preferences have no
  value after the election and are not kept around.
- **"Clear my saved answers and notes"** button below the ballot card. Wipes the
  key, resets in-memory state, drops any `s=` from the address bar, re-renders,
  and announces the outcome through the existing `role="status"` region. Shown
  only when there is actually something saved to erase.

#### Multi-tab awareness
- A `storage` event listener, filtered to our key, re-reads and merges when
  another tab saves, and resets state when another tab clears. Read-only — it
  never writes back, so no loops. Last write wins.
- The refresh is **targeted rather than a re-render**: rebuilding the question
  view would collapse the reader's open `<details>` sections and overwrite a note
  mid-typing. It updates the choice buttons, progress, and the note textarea only
  when that textarea isn't focused.

#### Content validation (`app.js` §17)
- Init-time check that warns to the console on duplicate or missing question ids
  (which would silently collapse two questions into one state entry and misalign
  the fragment) and drops the unusable entry rather than corrupting the map.
- When `meta.draft` is true, additionally warns on missing `shortTitle`,
  `yesMeans`, `noMeans`, or `summary`, and on a missing `ballotNumber` while the
  ballot order is marked certified. Catches content-editor mistakes before
  publish, at zero cost in production.

#### Documentation
- `questions.json` gained an inert `_docs` block: what each `meta` flag does, the
  block types the renderer accepts, and — most importantly — the operational rule
  that `fragmentSchemaVersion` must be bumped whenever the question list changes
  in count or order.
- `qrcode.min.js` placeholder now documents the paused-state behavior and the CSP
  hazard in library selection (see *Deferred*, below).

---

### Changed

#### The URL fragment is now a fallback, not the default
- **When storage works, the hash carries routing only** (`q=`, `v=`). Choices are
  no longer mirrored into the address bar on every tap, so they no longer land in
  browser history — which, on many setups, means a cloud-synced history.
- **When storage is unavailable, V1 behavior returns unchanged**: full
  choices-in-hash mirroring, so reload recovery still works in that degraded mode.
- **Incoming `s=` links still win.** Opening a resume link is a deliberate act, so
  its choices override stored choices (notes are never touched by the fragment).
  When storage is in use, `s=` is then stripped from the address bar on arrival —
  handled for free by the existing `replaceState`-on-route behavior.
- **`buildResumeUrl()` is unchanged** and still builds an `s=` payload on demand
  for "Copy as text" (and for the QR payload once un-paused). Explicit sharing
  stays; ambient leaking stops.

#### Navigation now uses `pushState`
`navigate()` pushes a history entry and calls `routeAndRender()` directly instead
of assigning `location.hash`. **Reason:** the storage-mode overview route is a
bare `#`, and assigning `location.hash = '#'` when the hash is already empty fires
no event — "All questions" would have silently no-opped. `location.hash` remains
the catch-path fallback if `pushState` throws, and `hashchange` still handles
user-driven back/forward.

#### Copy, so every promise matches reality
`applyStorageCopy()` swaps these based on whether the browser actually allows
local storage:

| Location | V1 | V2 (storage available) | V2 (storage blocked) |
|---|---|---|---|
| Privacy aside | "Nothing you enter here is collected, stored, or sent anywhere" / "Your notes live only on this screen" | Never sent anywhere; saved only on this device, in this browser; erasable anytime; auto-erased a month after the election | Explains that this browser blocks saving, that choices ride in the page address, and that notes are screen-only |
| `#note-hint` | "Notes aren't saved if the page reloads…" | "Saved on this device, in this browser. Print or copy your card to keep a copy." | "Notes aren't saved on this device — print or copy your card before you leave." |
| Ballot card, all decided | "…your notes disappear when you close this page." | "All set! Print or copy your card to take with you." | unchanged from V1 |

#### Other changes
- Print message consolidation: `doPrint()` wrote two `announce()` calls into a
  single status region, so the second clobbered the first. Now one message.
- Overview items, progress-bar segments, and Prev/Next links carry real hash
  targets, so middle-click and open-in-new-tab land on the right view rather than
  a bare page top.
- `styles.css` header comment now states that the filename must match what
  `index.html` links, because GitHub Pages serves name-exact.

---

### Fixed

| ID | Severity | Issue |
|---|---|---|
| B-1 | 🔴 | **`hashchange` race could destroy an incoming resume link.** The listener was registered before `questions.json` resolved; a hashchange in that window ran routing against empty state, and its trailing `syncHashState()` rewrote the hash to `#s=1.` — wiping the payload before `decodeState()` read it. Fixed with a `dataReady` gate that early-returns from `routeAndRender()`. |
| B-2 | 🔴 | **`parseHash()` could throw.** `decodeURIComponent` raises `URIError` on malformed input (e.g. `#s=%`); during init that surfaced as the misleading "questions could not be loaded" error, and on a later hashchange it was an uncaught exception that killed routing. Now wrapped, falling back to the raw value. |
| B-3 | 🔴 | **Focusable link inside `aria-hidden="true"`.** The QR fallback anchor rendered inside the `aria-hidden` QR container — a keyboard stop that announces nothing. Resolved by B-4's fix. |
| B-4 | 🔴 | **Paused-QR state leaked broken UI to screen and paper.** The card showed an empty bordered box, a "Scan to reopen your choices" label with nothing to scan, and printed a dead "Open your resume link" anchor inside an empty 3 cm frame. `renderQR()` became `renderQRBlock()`, which hides the entire `.ballot-card__qr` region when no generator is present; the container also ships `hidden` so it never flashes during load. |
| B-5 | 🔴 | **`style.css` / `styles.css` filename mismatch** — would ship a completely unstyled site. Standardized on `styles.css`, with a note in the file header. *(Verify the repo filename; this is the one fix that can't be confirmed from the source alone.)* |
| B-9 | 🟠 | Safari throttles `history.replaceState` (~100 calls / 30 s) and throws when exceeded; rapid choice toggling could hit it. `syncHashState()` is now guarded, and the D5 change removes most of that call path anyway. |
| B-10 | 🟠 | Question ids were interpolated into the hash unencoded. Current ids are safe slugs, but one containing `&`, `=`, or `#` would corrupt routing. Now `encodeURIComponent`'d on build. |
| B-12 | 🟡 | Two sequential `announce()` calls in `doPrint()` — see *Changed*. |
| B-13 | 🟡 | Missing favicon caused a guaranteed 404 on every load. Added an inline `data:` icon (already permitted by the `img-src` policy), so no extra file to ship. |
| B-14 | 🟡 | `renderSummary()` held a redundant `c` alongside `b.choice`. Collapsed. |
| B-15 | 🟡 | Notes restored from a hand-edited blob could exceed the textarea's `maxlength`. Truncated on read. |
| B-17 | 🟡 | Header and back links used `href="#"`, so middle-click yielded a bare page-top link. Real hash targets now. |

---

### Removed

- **The `beforeunload` handler (all of V1 §14).** Its justification — "notes are
  the only unrecoverable state" — is now false. Removing it also restores bfcache
  eligibility on desktop. In the degraded no-storage mode, the hint copy carries
  the warning instead of a browser prompt.
- **`isLikelyDesktop()`**, whose only caller was that handler.
- **The disabled-button state** (`.btn[aria-disabled="true"]`, `.is-disabled`, and
  the two `setAttribute('aria-disabled', 'false')` calls). Prev/Next always route
  somewhere — the ends go to Overview and Summary — so no nav control can ever be
  inert. This was both halves of a feature that could not trigger; the CSS comment
  claiming the state was "rarely hit" understated it.
- **`.qr__fallback-link`** styling, orphaned by the B-4 fix.

---

### Unchanged (verified, not overlooked)

- **The Content-Security-Policy.** `localStorage` is not governed by CSP and
  issues no network request, so the strict `default-src 'self'` posture, the
  zero-external-requests guarantee, and the no-inline-styles rule all stand
  exactly as they were. The `index.html` CSP comment gained one clarifying line.
- **The no-`innerHTML` rule.** All content still goes in through `textContent`,
  `.value`, and cloned `<template>`s — which is also why a tampered storage blob
  can't inject markup, independent of the validation.
- **System-font-only typography**, the token layer, the identity-color palette,
  and the print token-override strategy.
- **`questions.json` content.** Four questions, unedited. Only the `_docs` block
  was added.

---

### Known limitations

- **Shared `*.github.io` origin (organizational decision, open).** Project pages
  under `<org>.github.io/<repo>` share one origin with every other repo's Pages
  site on that subdomain, and `localStorage` is origin-scoped — so any other
  project's JavaScript on that origin can read a voter's ballot data. The
  namespaced key prevents *collisions*, not *reads*. Options: serve from a custom
  domain for true origin isolation, or accept and document the risk on the grounds
  that all repos are org-controlled. No code depends on the answer; a later switch
  to a custom domain requires no changes.
- **Safari ITP may evict script-writable storage** after roughly seven days of
  Safari use without a return visit. The "print or copy your card" guidance stays
  in the UI for this reason, softened from "will be lost" to "saved on this
  device, but don't rely on it forever."
- **Multi-tab is last-write-wins.** Both tabs converge on the most recent write;
  a simultaneous edit in two tabs can drop one of them. Small surface — it's the
  same person on the same device.
- **The URL fragment encoding remains positional.** Any change to question count
  or order invalidates every previously shared resume link and printed QR. This is
  by design, but it depends on remembering to bump `meta.fragmentSchemaVersion` —
  now documented in `questions.json`. Stored state is immune.
- **`ACCENT_COUNT` in `app.js` and the `--q-accent-*` token count in
  `styles.css` are a manual coupling.** Both sides are now commented; adding a
  tenth hue to one file without the other makes colors repeat silently or leaves
  `[data-accent="10"]` matching nothing.

---

### Deferred

- **QR generation.** Still pinned; `qrcode.min.js` is an intentional stub that
  exports no global, and the whole QR block is hidden as a result. When
  un-pinning, note the CSP hazard: with `default-src 'self'` and no
  `style-src`/`unsafe-inline`, any library path that writes inline `style=""`
  attributes is blocked by the browser. `kazuhikoarase/qrcode-generator` is
  preferred (crisp SVG or a `data:` URI `<img>`, both already permitted, no style
  attributes) over `davidshimjs/qrcodejs`, whose `<table>` fallback path sets
  inline styles. `renderQRBlock()` is the only function that needs changing.
- **Custom-domain decision** — see *Known limitations*.

---

### Verification performed

Files pass syntax and parse checks (`node --check`, JSON parse), and the removed
identifiers (`armBeforeUnload`, `isLikelyDesktop`, `renderQR`, `beforeUnloadArmed`,
`aria-disabled`, `qr__fallback-link`) have zero remaining references across all
four source files.

Suggested manual acceptance run before publish:

1. Set choices and notes → hard reload → all restored, and no `s=` in the URL.
2. Same, then quit and reopen the browser → still restored.
3. Open a resume link whose choices differ from stored state → the link wins,
   notes survive, `s=` disappears from the address bar, storage updates.
4. Override `setItem` to throw in DevTools → behaves like V1 (mirroring on,
   degraded hint copy, erase button hidden, no console errors).
5. "Clear my saved answers and notes" → key gone, UI reset, status announced.
6. Hand-edit `savedAt` past election + 30 days → purged on load.
7. Feed a corrupt blob (`{"schema":1,"ballot":"lol"}`, truncated JSON,
   `choice:"maybe"`, a 10 KB note) → silent fresh start or field-level
   sanitization; never a crash.
8. Two tabs open → decide in one, confirm the other reflects it without
   collapsing an open guide section or clobbering a note being typed.
9. Delete a question from `questions.json` → remaining ids still load their saved
   choices and notes.
10. Print preview → QR block absent, card still fits one page.

---

## [1.0.0] — Pass 1

Initial build: data-driven three-view flow (overview / question / summary) with
every string, the question count, and the ordering sourced from
`questions.json`; hash routing with choices-only fragment mirroring for reload
recovery; clickable progress bar; per-question identity colors; inversion
callout; export paths for print, clipboard (three-tier fallback), and
screenshot; strict CSP with zero external requests and system fonts only;
`beforeunload` guard for unsaved notes on desktop; QR generation stubbed.
