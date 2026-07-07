# Chrome Extension API Implementation Plan

## Context

Rambox embeds Chrome extensions via `electron-chrome-extensions`. Many extensions in the current fleet fail because certain `chrome.*` namespaces are absent or stubbed as noops. Research against the actual manifests of the fleet (Bitwarden, 1Password, KeePassXC, uBlock, Dark Reader are open-source or auditable) revealed two critical APIs missing from the original assessment: **`chrome.idle`** (password-manager auto-lock) and **`chrome.offscreen`** (MV3 clipboard operations).

**Current version:** electron-chrome-extensions 4.9.0, Electron 42.5.2
**Package location:** `packages/electron-chrome-extensions/src/`

---

## Current Extension Fleet

- **Password managers:** 1Password, Bitwarden, Dashlane, Keeper, LastPass, NordPass, NordPass2, Roboform, SafeInCloud, Proton Pass, Enpass, iCloud Passwords, KeePass XC
- **Gmail/email tools:** Boomerang, GMass, Streak, MailTrack, DragApp, HubSpot
- **Writing/translation:** Grammarly, Google Translate, DeepL, Language Tool
- **Productivity/other:** Dark Reader, uBlock, Everhour, Calendly, Microsoft SSO, Endpoint Verification

### Verified manifest permissions (research findings)

| Extension | Relevant permissions |
|---|---|
| Bitwarden (MV3) | alarms, idle, offscreen, scripting, sidePanel, webRequest, webRequestAuthProvider, clipboardRead/Write, nativeMessaging (opt), contextMenus, notifications, webNavigation |
| 1Password | alarms, idle, offscreen, scripting, management, downloads, nativeMessaging, privacy, contextMenus, notifications |
| KeePassXC-Browser (MV3) | nativeMessaging, offscreen, cookies, webRequest, webRequestAuthProvider, contextMenus, clipboardWrite, notifications |
| uBlock Origin (MV2) | webRequest, webRequestBlocking, alarms, privacy, contextMenus, webNavigation, unlimitedStorage |
| Dark Reader (MV2) | alarms, fontSettings, contextMenus (opt) |
| Mailtrack | webRequestBlocking + Gmail host permissions |
| Grammarly | scripting, activeTab |

Closed-source password managers (Dashlane, Keeper, LastPass, NordPass, Roboform, Proton Pass, Enpass) follow the same pattern as 1Password/Bitwarden: alarms + idle + scripting + offscreen (+ nativeMessaging for desktop-app integration, which is **already implemented**).

Native messaging (already working) covers: 1Password, KeePassXC, iCloud Passwords, Enpass, SafeInCloud, Roboform, Microsoft SSO, Endpoint Verification.

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

### 1. `chrome.alarms` — HIGH
**Fleet:** Bitwarden, 1Password, uBlock, Dark Reader, and virtually every password manager (vault sync/timeout timers).
**New file** `src/browser/api/alarms.ts`. Per-extension in-memory map backed by `setTimeout`/`setInterval`.
Methods: `create`, `get`, `getAll`, `clear`, `clearAll`. Event: `onAlarm`.

### 2. `chrome.idle` — HIGH
**Fleet:** 1Password, Bitwarden, and all password managers — vault auto-lock. Without it, MV3 service workers may throw on startup.
**New file** `src/browser/api/idle.ts`. Maps to Electron `powerMonitor.getSystemIdleState()` / `getSystemIdleTime()`.
Methods: `queryState`, `setDetectionInterval`, `getAutoLockDelay` (returns 0). Event: `onStateChanged` (poll with the detection interval, emit on transitions).

### 3. `chrome.scripting` — HIGH (MV3) — ✅ NATIVE, VERIFIED
**Fleet:** Bitwarden, 1Password, KeePassXC, Grammarly, Proton Pass — all MV3 extensions.
Electron implements `chrome.scripting` natively ("all features supported" per Electron docs). Verified working in Electron 42 via `spec/chrome-scripting-spec.ts` (`executeScript` with files + `insertCSS`). **No library code needed** — the preload must simply not clobber it (it doesn't).

### 4. `chrome.offscreen` — MEDIUM-HIGH
**Fleet:** Bitwarden, 1Password, KeePassXC — MV3 clipboard read/write and DOM parsing.
**New file** `src/browser/api/offscreen.ts`. Offscreen document = hidden `WebContentsView`/`BrowserWindow` loading the `chrome-extension://` page; Electron's native extension messaging connects it to the service worker automatically.
Methods: `createDocument`, `closeDocument`, `hasDocument`.

### 5. `chrome.contextMenus.update` — MEDIUM
**Fleet:** Bitwarden, KeePassXC, 1Password update menu entries per-site. Currently noop.
**Change:** implement `update` in `src/browser/api/context-menus.ts` (mutate stored item properties).

### 6. `chrome.management` — MEDIUM
**Fleet:** 1Password (detects conflicting password managers).
Electron implements `chrome.management` natively, but **`getAll()` never resolves in Electron 42** (verified; `getSelf()` works). The library overrides `get`/`getAll`/`getSelf` in `src/browser/api/management.ts` backed by `session.getAllExtensions()`. Native `onEnabled`/`onDisabled` events pass through.

### 7. `chrome.downloads` — MEDIUM (basic)
**Fleet:** 1Password (vault export). Web Store examples: GoFullPage, Save Emails to PDF, Nimbus Capture.
**Rewrite** `src/browser/api/downloads.ts` replacing noops.
Methods: `download` (→ `session.downloadURL` + `will-download` tracking), `search`, `cancel`, `pause`, `resume`, `erase`. Events: `onCreated`, `onChanged`, `onErased`.

### 8. `chrome.tabs.captureVisibleTab` — MEDIUM-LOW
**Fleet:** none confirmed. Web Store examples (work/productivity): GoFullPage, Awesome Screenshot, Evernote Web Clipper, Nimbus Capture, Loom.
**Change:** add handler in `src/browser/api/tabs.ts` → `webContents.capturePage()` → base64 per `options.format`.

### 9. `chrome.sidePanel` — LOW (safe noop stubs)
**Fleet:** Bitwarden declares it; falls back to popup if calls don't throw.
Renderer-only stub: `setOptions`, `setPanelBehavior`, `open`, `getOptions` as noops to prevent hard failures.

### 10. `chrome.fontSettings` — LOW (renderer-only stub)
**Fleet:** Dark Reader (font picker in its popup UI).
Renderer-only stub following the existing `privacy`/ChromeSetting pattern: `getFontList` returns a static list of generic families (`sans-serif`, `serif`, `monospace`), `getFont`/`setFont`/`clearFont` and per-type size settings as ChromeSetting noops. Near-zero cost, prevents Dark Reader's settings UI from throwing.

---

## Phase 2 (explicitly deferred)

| API | Fleet need | Reason to defer |
|---|---|---|
| `chrome.webRequest` (observational + blocking) | uBlock (blocking is mandatory), Mailtrack, Bitwarden/KeePassXC (basic-auth autofill) | Electron implements extension `webRequest` natively ("all features supported" per docs). The preload used to clobber `onHeadersReceived` with a dead stub — that override was removed so the native API passes through. Re-test uBlock/Mailtrack before writing any library code here |
| `chrome.identity.getAuthToken` | Likely Boomerang/GMass/Streak/HubSpot (Google OAuth) | Chrome-specific Google account integration; fallback via `launchWebAuthFlow` possible but needs per-extension testing first |
| `chrome.tts` | Google Translate ("read aloud") | Nice-to-have; core translate works without it |

## Out of Scope

- `chrome.declarativeNetRequest` (uBO Lite) — very high complexity
- `chrome.enterprise.*` — Endpoint Verification cannot be fully supported (ChromeOS/enterprise-only APIs); its nativeMessaging part already works
- `chrome.history`, `chrome.bookmarks`, `chrome.devtools.*` — no Electron backing, niche
- `chrome.storage.sync` real backend — stays aliased to `local`

---

## Files to Change

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

(paths relative to `packages/electron-chrome-extensions/`)

---

## Testing Strategy

### Tier 1 — Automated specs (existing harness)

The package already ships a mocha suite that runs **inside Electron** (`spec/`, entry `spec/index.js`, run via `yarn test` in the package). Its key piece is the `spec/fixtures/rpc` fixture extension: specs send `{type: 'api', method, args}` messages through a content script, the extension's background executes any `chrome.*` call and replies; `{type: 'event-once', name}` awaits a single event firing. Helpers live in `spec/crx-helpers.ts` (session/window setup) and `spec/events-helpers.ts`.

New APIs get specs following the existing `chrome-tabs-spec.ts` pattern:

- `chrome-alarms-spec.ts` — create alarm with `delayInMinutes: 0.01`, await `alarms.onAlarm` via `event-once`; verify `get`/`getAll`/`clear` round-trips.
- `chrome-idle-spec.ts` — `queryState` returns `'active' | 'idle' | 'locked'`; `setDetectionInterval` doesn't throw.
- `chrome-scripting-spec.ts` — needs a new **MV3 fixture** (`spec/fixtures/rpc-mv3` with a service worker) since the current `rpc` fixture is MV2; assert `executeScript` returns injection results and `insertCSS`/`removeCSS` mutate a loaded page.
- `chrome-downloads-spec.ts` — serve a file from a local `http` server (pattern already used in existing specs), call `downloads.download`, await `onCreated`/`onChanged` state transitions.
- `chrome-management-spec.ts` — `getAll` includes the rpc fixture; `getSelf` returns the caller.
- `offscreen` — covered indirectly in the MV3 fixture: `createDocument` + `hasDocument` + message round-trip to the offscreen page.

### Tier 2 — API probe extension (semi-automated, in the shell)

A throwaway `api-probe` extension (in `spec/fixtures/`, loadable manually with `yarn start` in the shell): its service worker runs a checklist calling every implemented method with valid arguments and logs a single `PASS`/`FAIL: <error>` line per API to its console. Opening the service worker DevTools gives an at-a-glance conformance report. Useful for quick regression checks without running the full suite.

### Tier 3 — Manual verification with the real fleet (in Rambox)

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

---

## Verification (build-level)

1. Build: `yarn build` in `packages/electron-chrome-extensions`.
2. Run automated suite: `yarn test` in the package — existing specs must stay green, new specs pass.
3. Load the shell (`yarn start`) with the `api-probe` fixture for the conformance report.
4. Manual fleet matrix above in Rambox dev mode.

## Implementation Status (July 2026)

Implemented and covered by specs (`yarn test`):

| API | Status | Spec |
|---|---|---|
| `chrome.alarms` | Implemented in library | `chrome-alarms-spec.ts` |
| `chrome.idle` | Implemented in library (powerMonitor) | `chrome-idle-spec.ts` |
| `chrome.scripting` | Native (Electron) — verified | `chrome-scripting-spec.ts` |
| `chrome.offscreen` | Implemented in library (hidden window) | `chrome-offscreen-spec.ts` |
| `chrome.management` get/getAll/getSelf | Implemented in library (native `getAll` hangs) | `chrome-management-spec.ts` |
| `chrome.downloads` (basic) | Implemented in library | `chrome-downloads-spec.ts` |
| `chrome.contextMenus.update` | Implemented in library | `chrome-contextMenus-spec.ts` |
| `chrome.tabs.captureVisibleTab` | Implemented in library | `chrome-tabs-capture-spec.ts` |
| `chrome.sidePanel` | Safe renderer stubs (MV3) | — |
| `chrome.fontSettings` | Safe renderer stubs | — |
| `chrome.webRequest` | Native passthrough restored (dead override removed) | — |

Known pre-existing test failures on Windows (fail identically on an untouched checkout):
- `nativeMessaging sendNativeMessage()` ×2 — the spec builds/registers a native host binary and fails in this environment. Native messaging itself works (fleet extensions use it in production).
- `chrome.tabs executeScript()` ×2 (MV2) — Electron-native code path, flaky/timing out in this environment.

Final suite result after implementation: **83 pass / 4 fail (all 4 pre-existing)**.

Notes:
- The MV3 spec fixture (`spec/fixtures/rpc-mv3`) defines its main-world bridge via a `"world": "MAIN"` content script; MV2-style script-tag injection is unreliable in MV3 pages.
- The rpc fixtures resolve promise-returning APIs in addition to callback-style APIs.
