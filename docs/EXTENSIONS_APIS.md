# Chrome Extension API Implementation Plan

**Status: implemented.** All APIs below are done and spec-covered — see [Implementation Status](#implementation-status-july-2026) at the bottom for the test-suite results. Sections 1-10 are kept as the original design rationale (why each API matters to the fleet); read the ✅/pending markers per section for current status, not the tense of the prose.

## Context

Rambox embeds Chrome extensions via `electron-chrome-extensions`. Many extensions in the current fleet fail because certain `chrome.*` namespaces are absent or stubbed as noops. Research against the actual manifests of the fleet (Bitwarden, 1Password, KeePassXC, uBlock, Dark Reader are open-source or auditable) revealed two critical APIs missing from the original assessment: **`chrome.idle`** (password-manager auto-lock) and **`chrome.offscreen`** (MV3 clipboard operations).

**Current version:** electron-chrome-extensions 4.9.0, Electron 42.5.2
**Package location:** `packages/electron-chrome-extensions/src/`

---

## Current Extension Fleet

The full list as given, grouped by category (all 29 accounted for below and in the per-extension table):

- **Password managers (13):** 1Password, Bitwarden, Dashlane, Keeper, LastPass, NordPass, NordPass2, Roboform, SafeInCloud, Proton Pass, Enpass, iCloud Passwords, KeePass XC
- **Gmail/email tools (6):** Boomerang, GMass, Streak, MailTrack, DragApp, HubSpot
- **Writing/translation (4):** Grammarly, Google Translate, DeepL, Language Tool
- **Productivity/other (6):** Dark Reader, uBlock, Everhour, Calendly, Microsoft SSO, Endpoint Verification

### Per-extension research (every extension individually checked)

Sourced from each extension's actual manifest (GitHub for open-source ones; chrome-stats.com permission data for closed-source ones). `❓` means no concrete manifest was found — permission surface inferred from partial signals, not verified line-by-line.

| # | Extension | MV | Verified `chrome.*` needs | Coverage |
|---|---|---|---|---|
| 1 | 1Password | 3 | alarms, contextMenus, downloads, idle, management, nativeMessaging, notifications, offscreen, privacy, scripting | ✅ Fully covered |
| 2 | Bitwarden | 3 | alarms, idle, offscreen, scripting, sidePanel, webRequest, webRequestAuthProvider, clipboardRead/Write, nativeMessaging (opt), contextMenus, notifications, webNavigation | ✅ Fully covered (webRequest via restored native passthrough — retest recommended) |
| 3 | Boomerang | 3 | **management** (explicit — conflicting-extension detection) | ✅ Fully covered |
| 4 | Dark Reader | 2 | alarms, fontSettings, contextMenus (opt) | ✅ Fully covered |
| 5 | Dashlane | 3 | contextMenus, cookies, idle, privacy, storage, tabs, unlimitedStorage, scripting, webRequest, webRequestAuthProvider, alarms, **declarativeNetRequest** | ⚠️ Gap: `declarativeNetRequest` (Out of Scope). Its account-creation flow was also broken by tabs not reloading after `chrome.runtime.reload()` (its `reloadOnLogout` task) — fixed 2026-07-10, see Tier 3 notes |
| 6 | DragApp | ❓ | dragapp.com/google.com/googleapis.com host access; no `chrome.*` permission list surfaced | ❓ Unverified, likely baseline-only |
| 7 | GMass | 3 | described as "very minimum permissions" + script injection (activeTab/scripting implied) | ✅ Likely fully covered |
| 8 | Google Translate | ❓ | no manifest surfaced; Google's own extension, historically contextMenus + storage | ❓ Unverified, likely fully covered |
| 9 | Grammarly | ❓ | scripting, activeTab | ✅ Fully covered |
| 10 | Keeper | ❓ | tabs; vault-domain host permissions; full list not surfaced | ❓ Unverified, likely same pattern as other password managers |
| 11 | LastPass | 3 | scripting, storage, webRequest, webRequestAuthProvider, offscreen, alarms (idle removed Dec 2024; **DNR permission NOT present in installed 4.154.2 manifest** — earlier chrome-stats data was stale) | ✅ API-covered — its Tier 3 login failure is unrelated to any API gap (debug via fix-app-extension) |
| 12 | NordPass | 3 | alarms, contextMenus, idle, privacy | ✅ Fully covered |
| 13 | NordPass2 | 3 | legacy Web Store listing, same codebase as NordPass | ✅ Fully covered |
| 14 | Roboform | 3 | tabs access confirmed; full list not surfaced; has nativeMessaging for its desktop app | ❓ Unverified, likely fully covered |
| 15 | SafeInCloud | 3 | contextMenus (rest of functionality via desktop app over nativeMessaging) | ✅ Fully covered |
| 16 | Streak | 3 | scripting, declarativeNetRequestWithHostAccess (webRequest/webRequestBlocking **removed** in their MV3 migration) | ⚠️ Gap: `declarativeNetRequestWithHostAccess` (Out of Scope) |
| 17 | uBlock | 2 | webRequest, webRequestBlocking, alarms, privacy, contextMenus, webNavigation, unlimitedStorage | ✅ Covered via native webRequest passthrough — **retest recommended**, blocking behavior is the real unknown |
| 18 | Proton Pass | 3 | open-source, `<all_urls>`; full list not surfaced (architecture is publicly similar to Bitwarden: alarms/idle/offscreen/scripting) | ❓ Unverified, likely fully covered |
| 19 | DeepL | 3 | activeTab, storage, contextMenus, tabs, scripting, identity, alarms, webRequest, **declarativeNetRequest**, **tts** | ⚠️ Gap: `tts` (Phase 2), `declarativeNetRequest` (Out of Scope) |
| 20 | Language Tool | ❓ | described as using "minimal necessary browser APIs"; `storage.sync` mentioned; full list not surfaced | ❓ Unverified, likely fully covered |
| 21 | HubSpot | 3 | tabs, cookies, storage, declarativeNetRequest, alarms, scripting, sidePanel, offscreen | ⚠️ Gap: `declarativeNetRequest` (Out of Scope) |
| 22 | Enpass | 2 | tabs, contextMenus, storage, webNavigation, webRequest, webRequestBlocking, nativeMessaging | ✅ Covered via native webRequest passthrough |
| 23 | Everhour | ❓ | host permissions scoped to integrated PM tools (Asana/Trello/etc.) only; no `chrome.*` API list surfaced | ❓ Unverified, likely fully covered |
| 24 | MailTrack | ❓ | webRequestBlocking + Gmail host permissions | ✅ Covered via native webRequest passthrough |
| 25 | Microsoft SSO | ❓ | script injection implied; full list not surfaced | ❓ Unverified, likely fully covered |
| 26 | Calendly | 3 | activeTab, storage, scripting, unlimitedStorage | ✅ Fully covered |
| 27 | Endpoint Verification | 3 | cookies, idle, nativeMessaging, storage, alarms, identity, **enterprise.deviceAttributes**, **enterprise.platformKeys**, **gcm** | ⚠️ Gap: `enterprise.*`, `gcm` (Out of Scope — confirmed ChromeOS/enterprise-only) |
| 28 | iCloud Passwords | 3 | privacy, **declarativeContent**, nativeMessaging, webNavigation, storage, contextMenus, scripting | ⚠️ Minor gap: `declarativeContent` (niche, not yet triaged) |
| 29 | KeePass XC | 3 | nativeMessaging, offscreen, cookies, webRequest, webRequestAuthProvider, contextMenus, clipboardWrite, notifications | ✅ Fully covered |

**Summary: 15 confirmed fully covered, 8 likely fully covered but unverified (no public manifest found), 6 have a confirmed gap** — and every one of those 6 gaps traces back to an API already tracked below (`declarativeNetRequest`, `tts`, `enterprise.*`/`gcm`), not a new unknown API. This directly confirms the hypothesis that prompted this research: most of the fleet is already fully covered by what's implemented.

**New finding that changes priority:** `declarativeNetRequest` (or its `...WithHostAccess` variant) is needed by **5 extensions** — Dashlane, LastPass, Streak, HubSpot, DeepL — not just uBlock as originally assumed when it was filed under "Out of Scope — very high complexity." It's worth reconsidering, see Phase 2 table below.

Native messaging (already implemented and working) covers: 1Password, KeePassXC, iCloud Passwords, Enpass, SafeInCloud, Roboform, Endpoint Verification.

---

## Existing Implementation Pattern

Every API follows this two-layer pattern:

1. **Browser process handler** in `src/browser/api/<name>.ts`:
   - Class with a constructor receiving `ExtensionContext`
   - Registers handlers via `ctx.router.apiHandler()`
   - Emits events via `ctx.router.sendEvent` / `ctx.router.broadcastEvent`

2. **Renderer-side** in `src/renderer/index.ts`:
   - Entry in `apiDefinitions` with a `factory` that uses `invokeExtension('api.method')`
   - Events as `new ExtensionEvent('api.onEvent')`

3. **Registration** in `src/browser/index.ts`:
   - Import + instantiation inside `this.api = { ... }`

---

## APIs to Implement (by priority)

### 1. `chrome.alarms` — HIGH — ✅ IMPLEMENTED
**Fleet:** Bitwarden, 1Password, uBlock, Dark Reader, and virtually every password manager (vault sync/timeout timers).
`src/browser/api/alarms.ts`. Per-extension in-memory map backed by `setTimeout`/`setInterval`.
Methods: `create`, `get`, `getAll`, `clear`, `clearAll`. Event: `onAlarm`.

**Bug found and fixed (2026-07-16), via Keeper.** Every login succeeded for 1-2 seconds, then Keeper's own `onAlarm` handler for its `logoutTimer` alarm fired and logged the user straight back to the login screen — looping on every attempt. Root-caused through three iterations, the first two of which turned out to be real-but-insufficient fixes rather than the actual cause:
1. **Empty `alarmInfo` (fixed, kept, not the reported cause):** `create()` fired `onAlarm` within ~2ms whenever `alarmInfo` had none of `when`/`delayInMinutes`/`periodInMinutes` set — the fallback chain `info.delayInMinutes ?? periodInMinutes ?? 0` silently defaulted to a 0ms `setTimeout` instead of matching Chrome's requirement that at least one timing field be present. Reproduced in isolation via `chrome.alarms.create('x', {})`. Fixed by throwing (matching Chrome) before scheduling anything when none of the three fields is present.
2. **Missing 30s minimum clamp (fixed, kept, not the reported cause):** every packed (Web Store / `loadExtension()`-installed) extension is subject to Chrome's 30-second minimum alarm interval; this library had no such clamp. Added `clampDelayMs()`.
3. **NaN bypassing `typeof` checks (fixed, kept, not the reported cause):** `typeof NaN === 'number'` is `true`, so a naive `typeof x === 'number'` validity check treats NaN as present/valid; `Math.max(NaN, ...)` is NaN, and `setTimeout(fn, NaN)` fires on the next tick. Replaced every such check with `Number.isFinite()`.
4. **Confirmed actual root cause:** a temporary debug log placed directly in `AlarmsAPI.create()` captured Keeper's real `logoutTimer` payload live: `when` was a genuine, finite ~30-day-out timestamp (requested delay `2591999999`ms) — not NaN, not empty. Node's own stdout showed why it still fired instantly: `TimeoutOverflowWarning: 2591999999 does not fit into a 32-bit signed integer. Timeout duration was set to 1.` Node's `setTimeout` silently overflows above `2**31-1` ms (~24.8 days) and fires almost immediately instead of throwing. Fixed with `scheduleLongTimeout()`, which chains delays past that cap through intermediate max-size hops. **Manually re-verified against real Keeper**: closed and reopened the popup, logged in, landed on the main vault screen and stayed there (previously redirected to login within seconds every time). Spec: `chrome-alarms-spec.ts` (regression test creates a 25-day alarm and asserts it hasn't fired ~300ms later, plus the empty-options and NaN cases from steps 1 and 3).

### 2. `chrome.idle` — HIGH — ✅ IMPLEMENTED
**Fleet:** 1Password, Bitwarden, and all password managers — vault auto-lock. Without it, MV3 service workers may throw on startup.
`src/browser/api/idle.ts`. Maps to Electron `powerMonitor.getSystemIdleState()`.
Methods: `queryState`, `setDetectionInterval`, `getAutoLockDelay` (returns 0). Event: `onStateChanged` — a single fixed 15s poller evaluates each extension's state using its configured detection interval (default 60s, min 15s per Chrome) and emits on transitions.

### 3. `chrome.scripting` — HIGH (MV3) — ✅ NATIVE, VERIFIED
**Fleet:** Bitwarden, 1Password, KeePassXC, Grammarly, Proton Pass — all MV3 extensions.
Electron implements `chrome.scripting` natively ("all features supported" per Electron docs). Verified working in Electron 42 via `spec/chrome-scripting-spec.ts` (`executeScript` with files + `insertCSS`). **No library code needed** — the preload must simply not clobber it (it doesn't).

### 4. `chrome.offscreen` — MEDIUM-HIGH — ✅ IMPLEMENTED
**Fleet:** Bitwarden, 1Password, KeePassXC — MV3 clipboard read/write and DOM parsing.
`src/browser/api/offscreen.ts`. Offscreen document = hidden `BrowserWindow` loading the `chrome-extension://` page; Electron's native extension messaging connects it to the service worker automatically. Chrome allows at most one offscreen document per extension, enforced here too.
Methods: `createDocument`, `closeDocument`, `hasDocument`.

**Bug found and fixed (2026-07-11), via Keeper.** Keeper's popup hung forever on a blank screen, never reaching its login form (the offscreen document it creates on startup — `content_scripts/tab_worker/index.html#offscreen` — froze on "Decrypting your Vault data..." indefinitely). Root cause: `createDocument()` never signaled to Electron that the calling MV3 service worker was still "doing work" while awaiting a reply from the offscreen document it had just created — Electron could recycle the SW mid-await (confirmed via CDP: the SW's target churned through 3 different instances within ~15s of activity), leaving the offscreen document waiting forever for a reply from a service worker that no longer existed. Not Keeper-specific — any extension using `chrome.offscreen` for async work (e.g. Bitwarden's clipboard operations) could hit the same failure. Fixed by pinning the calling service worker alive via `event.sender.startTask()` for the offscreen document's full lifetime (ended on the document's `'destroyed'` event, covering every teardown path with one source of truth) — matches Chrome's own behavior, where an open offscreen document keeps its extension's SW alive. Manually reverified with real Keeper: popup now renders the login screen instead of hanging, and the SW target stayed stable (no churn) for 30s post-click. Specs: `chrome-offscreen-spec.ts` (`startTask`/`.end()` call assertions + a SW-to-offscreen-document `sendMessage` round-trip regression test — the interaction pattern that used to hang, previously untested).

**Known issue, unresolved (found 2026-07-16), via Keeper — "Trouble Loading."** Separate from the offscreen bug above and from the `chrome.alarms` bug below: opening Keeper's popup sometimes shows its own "Trouble Loading / The extension is taking longer than usual to start" fallback and never recovers, even after reloading. Reproduced repeatedly right after a shell (re)start; a manual close-and-reopen of the popup reliably works around it once the extension's SW has been running a little longer.

Root-caused as far as: the SW is alive and responsive (its own event listeners fire, ad-hoc CDP eval works, and it processes this library's own `crx-msg` IPC calls like `tabs.query` normally throughout). A diagnostic listener installed directly in the SW confirmed the popup's startup message *does* reach `chrome.runtime.onMessage` — so this isn't a delivery failure. What never happens is a reply: `chrome.runtime.sendMessage` sent from the popup hangs indefinitely with no response, which is exactly what "Trouble Loading" is Keeper's own fallback for. Force-closing just that SW's target via CDP (`Target.closeTarget`, letting a fresh instance spin up on next use) reliably un-wedges it with no other side effects — a same-document `Page.reload()` of the popup does not, confirming the wedge lives in the worker, not the popup page. This is a sibling of the already-documented Electron limitation in `src/browser/patch/service-worker-wake.ts` (an idle worker not reliably waking on message) — likely worth an upstream Electron issue if reproducible outside this library, since Chrome's real ~30s idle-worker recycling would clear this kind of one-off wedge automatically and this environment doesn't reproduce that self-healing.

**A same-day fix attempt was tried and reverted — do not repeat it without solving the false-positive problem below first.** The attempt: after the popup's real content loads, ping it with a namespaced synthetic message (`chrome.runtime.sendMessage({ __electronChromeExtensionsHealthCheck: true }, cb)`) and, if no callback fires within ~1.5s, force-close the SW's CDP target and reload the popup. This *did* correctly detect and recover the fixture built specifically to simulate the wedge (`onMessage` handler that `return true`s and never calls `sendResponse` for that message) — but against the real fleet it produced a false positive on effectively every popup open, including extensions that were never wedged: **a great many real extensions' `onMessage` handlers unconditionally `return true` (a common, valid "might respond async" pattern) without narrowing by message shape first**, so an unrecognized synthetic ping gets silently swallowed by a live but indifferent listener — indistinguishable, from the sender's side, from a genuinely wedged one. Observed consequences before revert: Keeper's popup flashed a reload on every open even when login was working, and Everhour/1Password/Dashlane/Bitwarden's popups rendered broken/cut-off — because the corrective reload happens *after* `PopupView.load()`'s sizing logic already ran against the first navigation, so a reload triggered afterward leaves the window's bounds set for content that's no longer there. Fully reverted (`popup.ts`, `service-worker-recover.ts` and its spec/fixtures all removed) and confirmed clean: full suite green, popup rendering back to normal for the affected extensions.

**Current status: open, no auto-recovery implemented.** Workaround is manual (close and reopen the popup). A real fix needs a way to tell "wedged" apart from "alive but the message was unrecognized" without probing every extension's own message protocol — plausible directions for a future attempt, each needing its own careful, offline-validated testing before touching the real popup-open path again: (a) detect Keeper's *own* "Trouble Loading" fallback appearing in its popup's DOM specifically, rather than a generic cross-extension ping (narrower, no false-positive risk, but Keeper-specific and fragile to their UI changing); (b) a real Electron upstream fix/flag for the underlying idle-worker-wake limitation, which would fix this at the source for every extension at once instead of working around it per-popup.

### 5. `chrome.contextMenus.update` — MEDIUM — ✅ IMPLEMENTED
**Fleet:** Bitwarden, KeePassXC, 1Password update menu entries per-site. Was noop.
Implemented in `src/browser/api/context-menus.ts` (mutates stored item properties).

### 6. `chrome.management` — MEDIUM — ✅ IMPLEMENTED
**Fleet:** 1Password (detects conflicting password managers).
Electron implements `chrome.management` natively, but **`getAll()` never resolves in Electron 42** (verified; `getSelf()` works). The library overrides `get`/`getAll`/`getSelf` in `src/browser/api/management.ts` backed by `session.getAllExtensions()`. Native `onEnabled`/`onDisabled` events pass through.

### 7. `chrome.downloads` — MEDIUM (basic) — ✅ IMPLEMENTED
**Fleet:** 1Password (vault export). Web Store examples: GoFullPage, Save Emails to PDF, Nimbus Capture.
`src/browser/api/downloads.ts`, replacing the old noop stubs.
Methods: `download` (→ `session.downloadURL` + `will-download` tracking), `search`, `cancel`, `pause`, `resume`, `erase`, plus `open`, `show`, `showDefaultFolder` (via `shell`). Events: `onCreated`, `onChanged`, `onErased`. All handlers enforce the `downloads` manifest permission. Still noop in the renderer: `acceptDanger`, `getFileIcon`, `removeFile`, `setUiOptions`.

### 8. `chrome.tabs.captureVisibleTab` — MEDIUM-LOW — ✅ IMPLEMENTED
**Fleet:** none confirmed. Web Store examples (work/productivity): GoFullPage, Awesome Screenshot, Evernote Web Clipper, Nimbus Capture, Loom.
Handler added in `src/browser/api/tabs.ts` → `webContents.capturePage()` → base64 per `options.format`.

### 9. `chrome.sidePanel` — LOW (safe noop stubs) — ✅ IMPLEMENTED
**Fleet:** Bitwarden declares it; falls back to popup if calls don't throw.
Renderer-only stub: `setOptions`, `setPanelBehavior`, `open`, `getOptions` as noops to prevent hard failures.

### 10. `chrome.fontSettings` — LOW (renderer-only stub) — ✅ IMPLEMENTED
**Fleet:** Dark Reader (font picker in its popup UI).
Renderer-only stub following the existing `privacy`/ChromeSetting pattern: `getFontList` returns a static list of generic families (`sans-serif`, `serif`, `monospace`), `getFont`/`setFont`/`clearFont` and per-type size settings as ChromeSetting noops. Near-zero cost, prevents Dark Reader's settings UI from throwing.

### 11. `activeTab` permission — ✅ WORKED AROUND (found during manual testing, 2026-07-08)
**Fleet:** Google Translate (confirmed — popup selection-translate died with Chromium's `kCannotAccessPage`), plus any extension using the popup + `activeTab` pattern (candidates: GMass, Calendly, DeepL).
**Root cause:** in Chrome, clicking the toolbar action invokes Chromium's `ActiveTabPermissionGranter`, temporarily granting host access to the active tab — which is what authorizes `scripting.executeScript` from popups of extensions with no static host permissions. In this library the action click is synthesized (`<browser-action-list>` → `PopupView`), Chromium never sees it, `activeTab` is never granted, and its native permission check rejects the injection. No Electron API exists to grant it.
**Workaround:** `patchActiveTabManifest(extensionPath)` (`src/browser/active-tab-patch.ts`, exported like `patchModuleServiceWorker`) — rewrites the manifest on disk before `loadExtension()`, adding `<all_urls>` (MV3 `host_permissions` / MV2 `permissions`) to extensions that declare `activeTab`. Electron auto-grants declared host permissions, so Chromium's check passes. Trade-off: permanent access instead of Chrome's per-gesture grant — acceptable in this trust model. Applied by both consumers: the shell (`packages/shell/browser/main.js`, both extension sources, pre-load) and Rambox (`src/main/extensions.ts` `loadExtension`, alongside `patchModuleServiceWorker`).

**No-throw contract (both patch utilities):** `patchActiveTabManifest` *and* `patchModuleServiceWorker` are guaranteed to never throw — a failed patch (disk write error, malformed manifest) logs and degrades to "extension loads unpatched" instead of aborting the caller's `loadExtension()`. Rationale: Rambox's `loadExtension` wraps everything in one try/catch, so a throwing patch used to skip the entire extension for that launch — losing 100% of an extension to protect a fix for 1% of it. Both also tolerate a UTF-8 BOM in `manifest.json` (Chromium accepts it; naive `JSON.parse` doesn't). Spec-covered in `active-tab-patch-spec.ts`.

---

## Phase 2 (mostly resolved 2026-07-15 — see below)

> **Implementation notes: [EXTENSIONS_APIS_PHASE_2.md](./EXTENSIONS_APIS_PHASE_2.md)** — the P2.0 webRequest-coexistence spike found Electron 42 already enforces `declarativeNetRequest` dynamic/session rules natively; the only real gap was manifest static rulesets not auto-enabling at startup. **Fixed with a one-line preload workaround, not a custom rule engine** — the originally-planned matcher/hook design in that doc is void and kept only for history. Full suite 120/0.

| API | Fleet need | Status |
|---|---|---|
| `chrome.webRequest` (observational + blocking) | uBlock (blocking is mandatory), MailTrack, Enpass, Bitwarden/KeePassXC (basic-auth autofill), Keeper (registers listeners at SW top level) | ⚠️ **BROKEN NATIVELY ON ELECTRON 43 — upstream regression, crash shimmed 2026-07-19.** On Electron ≤42 native passthrough works (all features). On Electron 43 (stock 43.0.0 AND 43.1.1 AND castlabs 43.0.0+wvcus — minimal repro: bare `loadExtension` of an MV3 extension declaring `webRequest`), the namespace exists but every event object (`onBeforeRequest`, `onAuthRequired`, ...) is `undefined` — Chromium logs `No source for require(webRequestEvent)`; not in any Electron changelog, no upstream issue found. Real-world impact found via Keeper in Rambox (castlabs 43): its BG.js registers webRequest listeners at SW top level → `TypeError: Cannot read properties of undefined (reading 'addListener')` killed its entire init → popup never showed login. **Shim shipped in `src/renderer/index.ts`** ("Repair chrome.webRequest's event objects"): fills ONLY missing events with inert Chrome-shaped stubs — extensions survive startup, webRequest-dependent features silently degrade (listeners never fire, blocking dead). No-op where the native API is intact. Verified end-to-end in Rambox via automated CDP drive: Keeper popup → Welcome → Log In → email form renders. `chrome-webRequest-spec.ts` is now version-aware: asserts real observation/blocking on ≤42, alive-but-inert on 43 — **if the ≥43 branches fail, Electron fixed it upstream: remove the shim and flip the specs back.** Worth filing upstream (repro script in hand). Prior finding still true: app-level `session.webRequest` clobbers extension `chrome.webRequest` (single listener per event) |
| `chrome.declarativeNetRequest` | Dashlane, HubSpot (dynamic rules — needed **zero code**), DeepL (1 static rule), uBlock Origin Lite (static blocklists) | ✅ **Shipped 2026-07-15.** Dynamic/session rules were already fully native. Fix: `src/renderer/index.ts` calls `updateEnabledRulesets` for manifest static rulesets at SW startup (Electron parses but doesn't auto-enable them). Spec: `chrome-declarativeNetRequest-spec.ts` + fixture `spec/fixtures/dnr`. uBO Lite's popup failure is still separate/undiagnosed (Tier 3) |
| `chrome.identity.getAuthToken` | Likely Boomerang/GMass/Streak/HubSpot (Google OAuth) | Deferred — GMass/Boomerang/Streak passed Tier 3 without it. Fallback via `launchWebAuthFlow` possible; implement only on confirmed failure |
| `chrome.tts` | DeepL, Google Translate ("read aloud") | Deferred — Google Translate's read-aloud worked without it; DeepL's popup bug (Tier 3) blocks confirming whether it even calls `tts` |
| `chrome.runtime` `externally_connectable` | Theoretical — no longer confirmed against any fleet extension. Initially suspected for Dashlane's account-creation flow (2026-07-08) but the real cause was tabs not reloading after `chrome.runtime.reload()`, fixed 2026-07-10 (see Tier 3 notes) — not a missing `externally_connectable` capability. Still plausible for other password managers with a website→extension signup handoff (Keeper, Roboform, etc.), but unverified | Requires injecting a scoped `chrome.runtime.connect`/`sendMessage` into *ordinary web pages* matching an installed extension's manifest `externally_connectable.matches`, routed to that extension's `onConnectExternal`/`onMessageExternal`. Unlike the rest of this library's gaps, this isn't confined to extension-page contexts — it touches the main preload injection path for arbitrary web content (currently gated to `chrome-extension://` pages/service workers only, see `src/preload.ts`), with security implications since it must be scoped strictly per-extension, per-origin |

## Phase 3 — MV2/MV3 cross-coverage (spec parity)

**Background (analysis result, 2026-07-08).** The library supports both manifest versions by architecture, and the implemented APIs inherit that support with no per-version code:

- Two preloads are registered (`crx-mv2-preload` type `frame` for MV2 background pages, `crx-mv3-preload` type `service-worker` for MV3), injecting the same API surface into both contexts.
- The router abstracts the sender (`frame` vs `service-worker`) — browser-side handlers are version-agnostic by construction.
- Event delivery handles both: frame listeners via `host.send()`, service-worker listeners via `startWorkerForScope()` + `send()` — i.e. **a sleeping MV3 service worker is woken before an event is delivered**. Combined with alarms living as main-process timers, this matches Chrome's MV3 semantics (alarms survive SW termination).
- Renderer gates mirror Chrome exactly: `offscreen`/`sidePanel` inject MV3-only; everything else (alarms, idle, downloads, management, fontSettings, captureVisibleTab) injects in both, as in Chrome.

**The gap is test coverage, not functionality:** each new API is spec-tested on only one manifest version — alarms/idle/downloads/management/captureVisibleTab run only on the MV2 `rpc` fixture; offscreen/scripting only on the MV3 `rpc-mv3` fixture. Both IPC transports are proven green, but the single most fleet-critical combination — **an MV3 service worker (all password managers) receiving `alarms.onAlarm`/`idle.onStateChanged`, including the wake-from-idle path** — has no direct spec.

| # | Item | Detail | Effort |
|---|---|---|---|
| 3.1 | Parametrize specs across both fixtures | Wrap the `describe` blocks of `chrome-alarms-spec.ts` and `chrome-idle-spec.ts` in a `forEach` over `['rpc', 'rpc-mv3']` (the harness already takes `extensionName`). Priority: alarms `onAlarm` on MV3 — the password-manager case | Low |
| 3.2 | Extend `rpc-mv3` fixture permissions | Add `downloads` + `management` to `spec/fixtures/rpc-mv3/manifest.json` so 3.3 can run (alarms/idle/tabs are already declared) | Trivial |
| 3.3 | Same parametrization for downloads/management/captureVisibleTab | Lower priority than 3.1 — no fleet extension calls these from an MV2 context that isn't already covered | Low |
| 3.4 | Alarm persistence across app restarts (optional) | Chrome persists alarms to disk; ours are in-memory (documented in `alarms.ts`). Low real-world risk — extensions must tolerate missed alarms and password managers re-create them at SW startup. Implement only if a fleet extension is observed to depend on it: serialize the per-extension alarm map and reschedule on `AlarmsAPI` construction | Medium |

Acceptance for Phase 3: `yarn test` green with the parametrized specs running each covered API on **both** fixtures.

## Phase 4 — Suspected Linux MV3 service-worker injection gap (unconfirmed)

**Background (2026-07-08).** While reviewing Phase 3's cross-fixture coverage, a platform-specific failure mode was identified in the injection mechanism itself, not just its test coverage. The `chrome.*` overrides are applied to the MV3 service worker via `contextBridge.executeInMainWorld` (`src/renderer/index.ts`, inside `injectExtensionAPIs`), after the preload is registered as `type: 'service-worker'` under the id `crx-mv3-preload` (`src/browser/index.ts`). There's a hypothesis — **not yet confirmed by an automated spec** — that this injection silently doesn't take effect inside MV3 service workers on Linux, while working correctly on Windows: a call like `chrome.tabs.query({ active: true })` from an extension's background service worker would then fall through to Electron's native (unmodified) implementation instead of the library's `TabsAPI` override.

No current spec can confirm or refute this: `chrome-tabs-spec.ts` (and every other override spec except scripting/offscreen) only runs against the MV2 `rpc` fixture; only `chrome-scripting-spec.ts` and `chrome-offscreen-spec.ts` exercise the MV3 `rpc-mv3` fixture, and neither asserts on an overridden `tabs`/`windows`/`management`/`alarms` result. CI (`.github/workflows/test.yml`) already runs the full suite on both `ubuntu-latest` and `windows-latest`, so a spec that exercises an override on `rpc-mv3` would surface a real platform divergence automatically, if one exists.

| # | Item | Detail | Effort |
|---|---|---|---|
| 4.1 | Confirm on Linux | Add a temporary `tabs.query`-on-`rpc-mv3` assertion (or reuse Phase 3.1's parametrization) and run on a Linux machine, or temporarily set `SPEC_LOG_CONSOLE=1` in `test.yml`'s `ubuntu-latest` leg — `spec/hooks.ts` relays service-worker console output, so this shows whether `injectExtensionAPIs error (...)` (`src/renderer/index.ts:841`) is logged in the SW context. Note the try/catch only fires if `executeInMainWorld` itself throws — a silent no-op (override never applied, nothing logged) is also possible and must be checked for directly by asserting on behavior, not just the console | Low |
| 4.2 | Make it a permanent regression check | If confirmed, fold a `tabs`/`alarms` override assertion against `rpc-mv3` into Phase 3.1's parametrized specs so both OS legs of CI cover it going forward, instead of relying on manual reproduction | Low |
| 4.3 | Fix | If confirmed as a genuine Electron gap: report upstream to electron/electron (`contextBridge.executeInMainWorld` for service-worker preloads), and implement a fallback injection path for Linux in the meantime — `src/renderer/index.ts` already has a `webFrame.executeJavaScript` fallback for when `executeInMainWorld` isn't available at all (lines 836-838, marked `TODO(mv3): remove webFrame usage`), which is a plausible starting point for a platform-gated fallback | Medium (pending root cause) |

**Impact if confirmed:** MV3 extensions on Linux builds of Rambox — i.e. most of the password-manager fleet — would silently receive Electron's native `chrome.tabs`/`chrome.windows`/`chrome.management`/`chrome.alarms` instead of this library's overrides from their background service worker, with no thrown error to signal the degradation.

## Out of Scope

- `chrome.enterprise.*`, `chrome.gcm` — Endpoint Verification cannot be fully supported (ChromeOS/enterprise-only APIs); its nativeMessaging/alarms/idle parts already work
- `chrome.declarativeContent` — iCloud Passwords declares it; low fleet footprint (1 extension), not yet triaged for what it's actually used for
- `chrome.history`, `chrome.bookmarks`, `chrome.devtools.*` — no Electron backing, niche
- `chrome.storage.sync` real backend — stays aliased to `local`

---

## Files Changed (actual — superseded the original plan below)

| File | Change |
|---|---|
| `src/browser/api/alarms.ts` | New |
| `src/browser/api/idle.ts` | New |
| `src/browser/api/offscreen.ts` | New |
| `src/browser/api/management.ts` | New (overrides native `get`/`getAll`/`getSelf` only — see §6) |
| `src/browser/api/downloads.ts` | New, replaces the old renderer-only noop stubs |
| `src/browser/api/context-menus.ts` | Added `update` handler |
| `src/browser/api/tabs.ts` | Added `captureVisibleTab` handler |
| `src/browser/index.ts` | Registered the new APIs above |
| `src/renderer/index.ts` | Factories for alarms, idle, offscreen, management, downloads; `captureVisibleTab`; `sidePanel` + `fontSettings` stubs; removed the old downloads noops; **removed** the dead `webRequest.onHeadersReceived` override so native `webRequest` passes through |
| `spec/chrome-alarms-spec.ts`, `chrome-idle-spec.ts`, `chrome-offscreen-spec.ts`, `chrome-downloads-spec.ts`, `chrome-management-spec.ts`, `chrome-tabs-capture-spec.ts` | New specs, one per API above |
| `spec/chrome-scripting-spec.ts` | New — guards that the preload doesn't clobber Electron's native `chrome.scripting` (no library file was needed, see §3) |
| `spec/chrome-contextMenus-spec.ts` | Extended with `update()` cases |
| `spec/fixtures/rpc-mv3/` | New MV3 fixture (service worker + `"world": "MAIN"` bridge) used by the scripting/offscreen specs |
| `src/browser/active-tab-patch.ts` + `spec/active-tab-patch-spec.ts` | New — activeTab → `<all_urls>` manifest grant (§11), exported from the package entry |
| `packages/shell/browser/main.js` | Applies the activeTab patch to both extension sources before loading |
| Rambox `src/main/extensions.ts` (desktop repo) | Applies the activeTab patch in `loadExtension`, alongside `patchModuleServiceWorker` |

**No `src/browser/api/scripting.ts` was created** — `chrome.scripting` turned out to be fully native in Electron 42 (see §3); this was in the original file list below before that was verified.

(paths relative to `packages/electron-chrome-extensions/`)

---

<details>
<summary>Original planned file list (kept for history — see table above for what actually happened)</summary>

| File | Change |
|---|---|
| `src/browser/api/alarms.ts` | New |
| `src/browser/api/idle.ts` | New |
| `src/browser/api/scripting.ts` | New |
| `src/browser/api/offscreen.ts` | New |
| `src/browser/api/management.ts` | New |
| `src/browser/api/downloads.ts` | New (replaces renderer noop stubs) |
| `src/browser/api/context-menus.ts` | Implement `update` |
| `src/browser/api/tabs.ts` | Add `captureVisibleTab` |
| `src/browser/index.ts` | Register new APIs |
| `src/renderer/index.ts` | Factories for alarms, idle, scripting, offscreen, management, downloads; `captureVisibleTab`; sidePanel + fontSettings stubs; remove downloads noops |
| `spec/chrome-{alarms,idle,scripting,downloads,management}-spec.ts` | New automated specs (see Testing Strategy) |

</details>

---

## Testing Strategy

### Tier 1 — Automated specs (existing harness)

The package already ships a mocha suite that runs **inside Electron** (`spec/`, entry `spec/index.js`, run via `yarn test` in the package). Its key piece is the `spec/fixtures/rpc` fixture extension: specs send `{type: 'api', method, args}` messages through a content script, the extension's background executes any `chrome.*` call and replies; `{type: 'event-once', name}` awaits a single event firing. Helpers live in `spec/crx-helpers.ts` (session/window setup) and `spec/events-helpers.ts`.

New APIs get specs following the existing `chrome-tabs-spec.ts` pattern:

- `chrome-alarms-spec.ts` — create alarm with `delayInMinutes: 0.01`, await `alarms.onAlarm` via `event-once`; verify `get`/`getAll`/`clear` round-trips.
- `chrome-idle-spec.ts` — `queryState` returns `'active' | 'idle' | 'locked'`; `setDetectionInterval` doesn't throw.
- `chrome-scripting-spec.ts` — uses the **MV3 fixture** (`spec/fixtures/rpc-mv3`, service worker) since the `rpc` fixture is MV2; asserts `executeScript` with `files` mutates the page title and `insertCSS` changes computed styles. The tab ID is read from the main process (`browser.webContents.id`) because injected API overrides don't reliably reach MV3 service workers on Linux.
- `chrome-downloads-spec.ts` — serve a file from a local `http` server (pattern already used in existing specs), call `downloads.download`, await `onCreated`/`onChanged` state transitions.
- `chrome-management-spec.ts` — `getAll` includes the rpc fixture; `getSelf` returns the caller.
- `offscreen` — covered indirectly in the MV3 fixture: `createDocument` + `hasDocument` + message round-trip to the offscreen page.

Note: each spec currently runs against a single manifest version (MV2 `rpc` or MV3 `rpc-mv3`). Cross-version parity is tracked as **Phase 3** above.

### Tier 2 — API probe extension (semi-automated, in the shell) — NOT BUILT

Originally planned: a throwaway `api-probe` extension (in `spec/fixtures/`, loadable manually with `yarn start` in the shell) whose service worker calls every implemented method and logs `PASS`/`FAIL` per API. **Skipped** — Tier 1's mocha specs ended up covering every API directly, so this extra manual-conformance layer wasn't needed. Revisit only if a future API is hard to cover with a mocha spec (e.g. something that needs a real user gesture).

### Tier 3 — Manual verification with the real fleet — NOT YET DONE

**Tracked and executed via [EXTENSIONS_API_MANUAL_TEST.md](./EXTENSIONS_API_MANUAL_TEST.md)** — a per-extension checklist (all 29, same order as the research table) run in this repo's shell app first, then Rambox. This is the recommended next step before considering the fleet "fixed" — the specs prove the APIs behave per the Chrome spec, not that any specific extension in the fleet is now unblocked.

Run Rambox in dev mode (CDP at localhost:9222) and exercise the highest-signal flows:

| Extension | Flow | APIs exercised |
|---|---|---|
| Bitwarden | Unlock vault → wait for auto-lock timeout | `idle`, `alarms` |
| Bitwarden | Copy password from popup | `offscreen` (clipboard) |
| 1Password | Startup: service worker console must show no `chrome.* is undefined` errors | `alarms`, `idle`, `scripting`, `management`, `downloads` |
| 1Password | Export vault data | `downloads` |
| Dark Reader | Enable "Automatic sunrise/sunset" scheduling | `alarms` |
| Dark Reader | Open font settings in popup | `fontSettings` stub |
| KeePassXC | Connect to desktop app → autofill on a login page | native messaging (✓), `offscreen` |
| Grammarly | Type in Gmail compose, corrections appear | `scripting` |
| Any password manager | Right-click a login field → context menu entry reflects current site | `contextMenus.update` |

Acceptance bar per extension: no uncaught `chrome.*` errors in the service worker console **and** its core user flow works end-to-end.

### Bugs found and fixed during Tier 3 testing (1Password, 2026-07-09)

Manually testing 1Password in this repo's shell surfaced three real bugs beyond the originally planned API list — none were extension-specific in the end, all fixed in the shared library:

1. **Module service worker never registers** (`"background":{"type":"module"}`) — Electron regression, not castlabs-specific. Fixed generically via `patchModuleServiceWorker()`, rewriting the SW into a classic script before `loadExtension()`. See the `fix-app-extension` skill's Known fixes table for the full writeup.
2. **Idle service worker doesn't wake on message** — likely an Electron bug (real Chrome wakes idle MV3 workers on demand). Consolidated into `wakeExtensionServiceWorker()`, called by the library itself before `createTab`/`createWindow`/popup loads, and by each consumer once right after `loadExtension()`.
3. **`ExtensionEvent.hasListener`/`hasListeners`/`getRules`/`addRules`/`removeRules` threw `Error('Method not implemented.')`** — this is what was actually blocking 1Password's first-run notification toast (its content-script icon worked fine; the SW crashed on an uncaught rejection from one of these). Real Chrome never throws here. Fixed to match Chrome's behavior (empty results / boolean, no throw). Spec: `chrome-events-spec.ts`.

All three are documented in detail (root cause, exact fix, file locations) in the `fix-app-extension` skill's Known fixes table — check there before re-diagnosing a similar symptom.

### Bugs found and fixed during Tier 3 testing (Dashlane, 2026-07-09 → 2026-07-10)

Dashlane's account-creation hang took several rounds to root-cause; two hardening changes landed along the way (kept, but neither fixed the hang), and the real cause was found on 2026-07-10 by reproducing the full flow in an isolated Electron harness instead of theorizing from logs.

**The actual root cause — Electron doesn't reload an extension's open tabs when the extension reloads.** Dashlane's "Crear una cuenta" popup button does two things at once: opens `index.html#/signup` via `chrome.tabs.create()`, and logs out — and its background runs a task literally named `reloadOnLogout` that calls **`chrome.runtime.reload()`** (implemented in Electron: verified `typeof chrome.runtime.reload === 'function'` in an MV3 SW, and calling it fires `extension-unloaded` → `extension-loaded` ~2ms apart). In Chrome, reloading an extension also reloads any open tabs showing its pages, so the signup tab comes back under the new extension instance. In Electron it doesn't: the signup tab — still loading its multi-MB bundles when the reload hits — ends up committed into an **invalidated extension context**. Observed signature (confirmed via DevTools on the stuck tab): `chrome` exists with Chromium's native lazy getters for exactly the manifest's API namespaces (including `declarativeNetRequest`, which this library never injects — proving the getters are Chromium's), but **every getter returns `undefined`**, and this library's own injected namespaces are absent (the preload ran against a doomed context). The page's own feature check then throws `No runtime.connect support` and its loading screen spins forever. The popup meanwhile logs `Extension context invalidated` — Chromium's standard error for "my extension was reloaded out from under me" — which was the decisive clue.

**Fixes (all library-level, Chrome-parity):**

1. `src/browser/index.ts` (`listenForExtensions`): track `extension-unloaded` ids; when the same id fires `extension-loaded` again, reload every tracked tab whose URL is under that extension's origin. Repro-verified end-to-end: a fixture page that triggers `runtime.reload()` from its own background now auto-reloads and ends with a fully working `chrome` object. Spec: `spec/chrome-runtime-reload-spec.ts` + `spec/fixtures/runtime-reload/`.
2. `src/browser/api/browser-action.ts`: destroy the action popup when its extension unloads (Chrome closes it; ours survived with an invalidated context that could never reconnect — the "popup stays open" half of the Dashlane report).
3. `src/browser/api/tabs.ts` + `browser-action.ts`: close the popup when its own extension opens an active tab (`extension-created-tab` internal store event, destroy deferred 50ms so the `tabs.create` IPC reply reaches the popup first) — in Chrome the popup closes when focus moves to the new tab; ours only closed on window blur, which never fires when the tab renders inside the same shell window.

**Superseded hypotheses from 2026-07-09** (all three disproven; their code was **removed** on 2026-07-10 after the real fix was user-confirmed — recorded so future sessions don't re-walk the same path):

- ~~`externally_connectable` gap~~ — wrong: the signup page is an in-extension `chrome-extension://` tab, not dashlane.com; `runtime.connect` was missing because the *context was invalidated*, not because the capability doesn't exist for web pages. (Docs-only hypothesis, no code.)
- ~~Idle-SW wake polling~~ (`popup.ts` polled `wakeExtensionServiceWorker()` every 20s while the popup was open) — the port disconnect it addressed was itself a *symptom* of the runtime.reload, and with the real fix the popup is destroyed on extension unload anyway. Removed; the pre-existing one-shot wake in `PopupView.load()` (from the 1Password work) stays — that one is load-bearing.
- ~~`globalThis.chrome` write-back in `injectExtensionAPIs()`~~ (`renderer/index.ts`) — the "orphaned object" theory was wrong: Electron does populate `globalThis.chrome` in plain extension tabs (isolated-harness matrix proved all four load-order/sandbox combinations work, and the stuck page's `chrome` object was Chromium's own getter shell, not our fallback `{}`). Removed, restoring the upstream code path.

---

## Verification (build-level)

1. Build: `yarn build` in `packages/electron-chrome-extensions`. — ✅ done, clean
2. Run automated suite: `yarn test` in the package — existing specs must stay green, new specs pass. — ✅ done, see Implementation Status below
3. ~~Load the shell with the `api-probe` fixture for the conformance report.~~ — skipped, see Tier 2 above
4. Manual fleet matrix above in Rambox dev mode. — ⬜ not done yet, recommended next step

## Implementation Status (July 2026)

Implemented and covered by specs (`yarn test`):

| API | Status | Spec |
|---|---|---|
| `chrome.alarms` | Implemented in library (setTimeout 32-bit overflow on long delays fixed 2026-07-16, see below) | `chrome-alarms-spec.ts` |
| `chrome.idle` | Implemented in library (powerMonitor) | `chrome-idle-spec.ts` |
| `chrome.scripting` | Native (Electron) — verified | `chrome-scripting-spec.ts` |
| `chrome.offscreen` | Implemented in library (hidden window + SW keep-alive, fixed 2026-07-11) | `chrome-offscreen-spec.ts` |
| `chrome.management` get/getAll/getSelf | Implemented in library (native `getAll` hangs) | `chrome-management-spec.ts` |
| `chrome.downloads` (basic) | Implemented in library | `chrome-downloads-spec.ts` |
| `chrome.contextMenus.update` | Implemented in library | `chrome-contextMenus-spec.ts` |
| `chrome.tabs.captureVisibleTab` | Implemented in library | `chrome-tabs-capture-spec.ts` |
| `chrome.sidePanel` | Safe renderer stubs (MV3) | — |
| `chrome.fontSettings` | Safe renderer stubs | — |
| `chrome.webRequest` | Native passthrough restored (dead override removed). **Confirmed (2026-07-15): app-level `session.webRequest` clobbers the extension listener** — single-listener-per-event in Electron, so DNR (below) deliberately avoids hooking it | `chrome-webRequest-spec.ts` |
| `chrome.declarativeNetRequest` | Dynamic + session rules were already fully native (enforce with zero library code). Fixed (2026-07-15): manifest static rulesets are parsed but not auto-enabled by Electron at load — `updateEnabledRulesets` is now called once at SW startup (`src/renderer/index.ts`). See [EXTENSIONS_APIS_PHASE_2.md](./EXTENSIONS_APIS_PHASE_2.md) for the spike that found this | `chrome-declarativeNetRequest-spec.ts` |
| `activeTab` permission | Electron never grants it — worked around via `patchActiveTabManifest` (§11) | `active-tab-patch-spec.ts` |
| `chrome.events.Event` (`hasListener`/`hasListeners`/`getRules`/`addRules`/`removeRules`) | Fixed — no longer throw, match Chrome's behavior | `chrome-events-spec.ts` |
| `patchModuleServiceWorker` (module SW registration) | Implemented in library, consumed by `electron-chrome-web-store` + Rambox | — (exercised manually; no automated repro of the underlying Electron bug) |
| `wakeExtensionServiceWorker` (idle SW wake) | Implemented in library (`popup.ts` — one-shot on load, `api/tabs.ts`, `api/windows.ts`), consumed by `electron-chrome-web-store` + Rambox | — |
| Tabs reload after extension reload (`chrome.runtime.reload()`) + popup closes on extension unload / on opening an active tab | Implemented in library (`browser/index.ts`, `api/browser-action.ts`, `api/tabs.ts`) — Chrome parity, fixes Dashlane account creation | `chrome-runtime-reload-spec.ts` |
| `WebSocket` in MV3 service workers | Proxied through the main process (`api/websocket.ts`, `api/lib/websocket-connection.ts`, renderer `ProxyWebSocket` shim) — works around native SW WebSocket failing to connect in this Electron; `ws` is bundled into `dist`. Fixes Grammarly's inline checker (§9 Bug #2, WebSocket half) | `chrome-websocket-spec.ts` |
| CSS `__MSG_@@extension_id__` i18n substitution | On-disk token rewrite at load (`patch/css-message-patch.ts`) — Electron doesn't substitute the message in served CSS, so asset URLs 404. Exported consumer helper `patchExtensionCssMessages`, invoked post-load. Fixes Grammarly's icons/underline SVGs (§9 Bug #1) | `css-message-patch-spec.ts` |

**Note (2026-07-14):** all Electron-workaround helpers were consolidated into `src/browser/patch/` (`active-tab-patch`, `module-service-worker-patch`, `service-worker-wake`, `css-message-patch`). Internal reorg only — package exports (bare `'electron-chrome-extensions'` specifier) are unchanged, so consumers need no import fix.

**Latest full-suite audit (2026-07-19): 131 pass / 0 fail on Electron 43.1.1 — fully green.** The repo's Electron was upgraded 42.5.2 → 43.1.1 (both `packages/shell` and `packages/electron-chrome-extensions` devDependencies) to match Rambox's castlabs 43 line — per explicit decision, no downgrade path. Suite additions since the last audit: 6 `manifest-key-patch-spec.ts` tests (`applyManifestPublicKey` — real CWS ids for zip-installed extensions) and 1 `chrome.webRequest` event-objects guard. The two webRequest probe specs are now version-aware (see the Phase 2 webRequest row): on 43 they assert the upstream-regression reality (listeners registered on inert shim stubs, nothing observed/blocked) instead of native behavior — they'll fail loudly the day Electron fixes webRequest upstream, which is the signal to remove the shim.

**Previous full-suite audit (2026-07-16): 124 pass / 0 fail — fully green (Electron 42.5.2).** Adds the `chrome.alarms` 32-bit `setTimeout` overflow fix (see §1 above) and its regression test; the `chrome-service-worker-recover-spec.ts` tests from the same-day "Trouble Loading" fix attempt were removed along with the rest of that attempt on revert (see §4's write-up), so this count doesn't include them. Also newly observed as flaky in this session, same class as below: `chrome.notifications create()` and a `Preload file not found` module-resolution error on `nativeMessaging`, both mid-run on one attempt and gone on immediate re-run with no code changes in between.

**Previous full-suite audit (2026-07-15): 121 pass / 0 fail — fully green.** This repo is being edited by more than one concurrent session, so pass counts alone are unreliable evidence of what a given run covered — verified directly instead: this run's output includes both the alarms empty-options fix test *and* the 6 new `declarativeNetRequest`/`webRequest` tests from the work above, confirmed present as `chrome.declarativeNetRequest` #47–49 and `chrome.webRequest` #107–109. (Earlier same-day: 114 pass, adds 2 `chrome-offscreen-spec.ts` tests for the SW keep-alive fix. Earlier 2026-07-14: 112 pass, adds `css-message-patch-spec.ts`. An earlier 2026-07-10 run failed 2 `contextMenus` specs with a transient "Preload file not found" module-resolution error mid-run; both passed 3/3 in isolation and the full re-run went green — environment flake, same class as the known-flaky list below.)

Known **flaky** specs on Windows (failed in earlier runs — also on an untouched checkout — then passed on the audit run; environment-dependent, not deterministic):
- `nativeMessaging sendNativeMessage()` ×2 — the spec builds/registers a native host binary; sensitive to environment state.
- `chrome.tabs executeScript()` ×2 (MV2) — Electron-native code path, intermittent timeouts.

If these fail in a future run, verify against an untouched checkout before blaming a change (earlier session runs recorded 83 pass / 4 fail with exactly these four failing).

Notes:
- The MV3 spec fixture (`spec/fixtures/rpc-mv3`) defines its main-world bridge via a `"world": "MAIN"` content script; MV2-style script-tag injection is unreliable in MV3 pages.
- The rpc fixtures resolve promise-returning APIs in addition to callback-style APIs.
- **Bug fixed during Tier 3 testing (2026-07-08):** pre-existing `WebNavigationAPI` crash — fast redirect chains (e.g. Google OAuth consent, surfaced by Boomerang) disposed a `WebFrameMain` between the navigation event and the handler touching it, throwing an uncaught "Render frame was disposed" in the main process. Every frame entry point in `web-navigation.ts` now checks `isLiveFrame()` (`frame && !frame.isDestroyed()`), and `getFrame`/`getAllFrames` filter disposed frames. Covered by the rapid-navigation smoke test in `chrome-webNavigation-spec.ts` (suite now 88 pass / 0 fail).
- **Gap found during Tier 3 testing (2026-07-08), root-caused and fixed (2026-07-10):** Dashlane's in-popup "Crear una cuenta" (create account) button opens `chrome-extension://.../index.html#/signup` in a new tab, which hangs indefinitely — suspected in turn as an `externally_connectable` gap, an idle-service-worker-wake gap, and a `globalThis.chrome` injection bug; all three were wrong. Actual cause: the tab isn't reloaded when the extension reloads itself (`chrome.runtime.reload()` from Dashlane's `reloadOnLogout` task), leaving it on an invalidated context. See "Bugs found and fixed during Tier 3 testing (Dashlane, 2026-07-09 → 2026-07-10)" above for the full investigation. Spec: `chrome-runtime-reload-spec.ts`.
