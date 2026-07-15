# Extension Fleet — Phase 1 Implementation Status

_Last updated: 2026-07-14_

This document reports the current Phase 1 status of the Chrome Extension API implementation ([EXTENSIONS_APIS.md](./EXTENSIONS_APIS.md)), based on the manual testing carried out in [EXTENSIONS_API_MANUAL_TEST.md](./EXTENSIONS_API_MANUAL_TEST.md). All 29 extensions in the fleet have been tested in the **electron-browser-shell** app of this repo, which isolates the `electron-chrome-extensions` library from Rambox's integration code.

---

## Status Legend

| Symbol | Meaning                                                        |
| ------ | -------------------------------------------------------------- |
| ✅     | Pass — core flow works end-to-end                              |
| ⚠️     | Partial — core flow works, but one or more features are broken |
| ❌     | Fail — core flow does not work                                 |
| ⬜     | Not tested yet                                                 |
| ⏭️     | Skipped — missing prerequisite (account, desktop app, etc.)    |

---

## Extension Status

| #   | Extension             | Version       | MV  | Status |
| --- | --------------------- | ------------- | --- | ------ |
| 1   | 1Password             | 8.12.26.40    | 3   | ✅     |
| 2   | Bitwarden             | 2026.6.1      | 3   | ❌     |
| 3   | Boomerang             | 1.9.3         | 3   | ✅     |
| 4   | Dark Reader           | 4.9.128       | 3   | ✅     |
| 5   | Dashlane              | 6.2628        | 3   | ✅     |
| 6   | DragApp               | 19.7.0        | 3   | ✅     |
| 7   | GMass                 | 6.0.43        | 3   | ✅     |
| 8   | Google Translate      | 2.0.17        | 3   | ✅     |
| 9   | Grammarly             | 14.1311.0     | 3   | ✅     |
| 10  | Keeper                | 18.0.0        | 3   | ❌     |
| 11  | LastPass              | 4.154.2       | 3   | ❌     |
| 12  | NordPass              | 7.8.15        | 3   | ⬜     |
| 13  | NordPass2             | —             | 3   | ❌     |
| 14  | Roboform              | 9.9.8.0       | 3   | ❌     |
| 15  | SafeInCloud           | 25.1.0        | 3   | ❌     |
| 16  | Streak                | 7.86          | 3   | ✅     |
| 17  | uBlock                | 25.5.0        | 3   | ❌     |
| 18  | uBlock Origin Lite    | 2026.713.1408 | 3   | ❌     |
| 19  | Proton Pass           | 1.38.2        | 3   | ❌     |
| 20  | DeepL                 | 1.95.0        | 3   | ❌     |
| 21  | Language Tool         | 11.0.0        | 3   | ❌     |
| 22  | HubSpot               | 3.1.1.42473   | 3   | ❌     |
| 23  | Enpass                | 6.11.14       | 3   | ❌     |
| 24  | Everhour              | 1.6.319       | 3   | ❌     |
| 25  | MailTrack             | 12.82.1       | 3   | ❌     |
| 26  | Microsoft SSO         | 1.0.11        | 3   | ❌     |
| 27  | Calendly              | 4.13.0.0      | 3   | ❌     |
| 28  | Endpoint Verification | 1.140.0       | 3   | ❌     |
| 29  | iCloud Passwords      | 3.3.0         | 3   | ❌     |
| 30  | KeePass XC            | 1.10.3        | 3   | ❌     |

---

## Detailed Notes per Extension

### ✅ #1 — 1Password `8.12.26.40`

> **Note:** The module-SW regression (Electron 38–42) prevents this extension from loading in the shell. The full test is done in Rambox, which carries the `patchModuleSwToClassic` workaround.

- ❌ **Toast notifications are not shown** — outstanding, not yet fixed.
- ✅ **Fixed:** Extension icon was not appearing in login text fields.
- ✅ **Fixed:** Login idle auto-lock was not triggering.

---

### ❌ #2 — Bitwarden `2026.6.1`

- ❌ **Extension icon does not appear in login text fields** — outstanding.
- ✅ **Fixed:** Login popup was hanging indefinitely.
- ✅ **Fixed:** Context menu autofill was not working.

---

### ✅ #3 — Boomerang `1.9.3`

- ✅ **Fixed:** `WebFrameMain` was accessed after the render frame was disposed, causing a crash on fast navigation (e.g., Google OAuth redirect chains). Every frame entry point in `web-navigation.ts` now guards with `isLiveFrame()`.

---

### ✅ #4 — Dark Reader `4.9.128`

No issues found. All tested flows pass.

---

### ✅ #5 — Dashlane `6.2628`

> **Note:** `declarativeNetRequest` gap is expected as a known Phase 2 item. Some network-filtering features may not work.

- ✅ **Fixed:** Account creation hang — the "Create an account" button opens a signup tab and triggers `chrome.runtime.reload()` via Dashlane's `reloadOnLogout` task. Electron was not reloading the extension's open tabs after the reload, leaving the signup tab on an invalidated context where every `chrome.*` getter returned `undefined`. The library now reloads extension tabs on re-load and closes the popup on extension unload and when its extension opens an active tab (Chrome parity). Spec: `chrome-runtime-reload-spec.ts`.
- ✅ **Fixed:** Extension icon was not appearing in login text fields.

---

### ✅ #6 — DragApp `19.7.0`

No issues found. All tested flows pass.

---

### ✅ #7 — GMass `6.0.43`

No issues found. All tested flows pass.

---

### ✅ #8 — Google Translate `2.0.17`

> **Note:** Read-aloud is expected to be missing (`chrome.tts` — Phase 2 item).

- ✅ **Fixed:** Clicking the extension icon produced no translation. Root cause was the `activeTab` permission never being granted by Electron (the toolbar click is synthesized, Chromium never sees it). Fixed via `patchActiveTabManifest`, which grants `<all_urls>` to extensions that declare `activeTab` before loading.
- ⚠️ **Known issue:** Opening a mail via Hostinger with the extension active crashes Rambox.

---

### ✅ #9 — Grammarly `14.1311.0`

Two separate bugs were found and fixed:

**Bug #1 — CSS `__MSG_@@extension_id__` substitution not performed by Electron** _(Fixed 2026-07-14)_

Grammarly emits all visual assets (SVG icons, fonts, underline images) as `url(chrome-extension://__MSG_@@extension_id__/…)` — 330 references across its injected CSS. Electron does not perform the i18n substitution that Chrome does when serving extension CSS, causing all asset requests to 404. The underline itself is a background image, so mistyped text appeared with no visible suggestion markers.

Fix: on-disk CSS token rewrite at load time via `patch/css-message-patch.ts` (`patchExtensionCssMessages`). Verified: 330 references → 0 after loading. Spec: `css-message-patch-spec.ts`.

**Bug #2 — WebSocket connections silently fail from MV3 service workers** _(Fixed 2026-07-11)_

Grammarly's grammar checker produced zero alerts. The root cause was that arbitrary outbound `WebSocket` connections opened from a MV3 service worker silently fail in Electron (client-side, before any bytes leave the process), while the identical API from a page in the same session works fine.

Fix: a `WebSocketAPI` in the main process opens the real socket via `ws` (Node.js, not subject to the SW restriction) and relays frames over IPC. A `ProxyWebSocket` shim is installed over `globalThis.WebSocket` in service-worker contexts only; pages keep the working native implementation. Spec: `chrome-websocket-spec.ts`.

---

### ❌ #10 — Keeper `18.0.0`

- ❌ Login page does not load inside the extension popup.

---

### ❌ #11 — LastPass `4.154.2`

> **Note:** `declarativeNetRequest` gap is expected as a known Phase 2 item.

- ❌ Login page does not load inside the extension popup.

---

### ⬜ #12 — NordPass `7.8.15`

Not tested yet.

---

### ❌ #13 — NordPass2

> **Note:** Legacy Web Store listing, same codebase as NordPass.

- ❌ The login page does not open at all (the popup window itself does not appear, unlike other extensions that fail to load content).

---

### ❌ #14 — Roboform `9.9.8.0`

- ❌ Clicking the extension button shows a "Buy Now" upsell popup instead of the login page.

---

### ❌ #15 — SafeInCloud `25.1.0`

- ❌ Clicking the extension button does not load any page inside the popup.

---

### ✅ #16 — Streak `7.86`

> **Note:** `declarativeNetRequest` gap is expected as a known Phase 2 item. Some network-related features may not work.

Core flow tested and working.

---

### ❌ #17 — uBlock `25.5.0`

- ❌ No longer functional. Recommend switching to **uBlock Origin Lite** (`ddkjiahejlhfcafbddmgiahcphecmpfh`) for continued testing — the MV3 variant better fits the current native `webRequest` passthrough model.

---

### ❌ #18 — uBlock Origin Lite `2026.713.1408`

- ❌ Extension popup does not load. Likely related to native `webRequest` blocking not being active — this is the key Phase 2 retest item.

---

### ❌ #19 — Proton Pass `1.38.2`

- ❌ Login popup does not load. Extension button does not appear in text fields.

---

### ❌ #20 — DeepL `1.95.0`

> **Note:** `tts` (read-aloud) and `declarativeNetRequest` gaps are expected Phase 2 items.

- ❌ Login works, but the translation popup does not behave the same as in Chrome — the translate-selection flow is broken.

---

### ❌ #21 — Language Tool `11.0.0`

- ⚠️ Inline error underlines and correction cards are visible in text fields.
- ❌ Extension button/icon does not appear in text fields.

---

### ❌ #22 — HubSpot `3.1.1.42473`

> **Note:** `declarativeNetRequest` gap is expected as a known Phase 2 item.

- ❌ Extension icon does not render properly in the toolbar.
- ❌ HubSpot button is not visible inside Gmail.

---

### ❌ #23 — Enpass `6.11.14`

- ❌ Cannot connect to the desktop app — `"Browser requesting the data is not code signed"`. This is a native messaging trust / code-signing check enforced by the desktop app, not an API gap in the library.

---

### ❌ #24 — Everhour `1.6.319`

> **Note:** Requires an active Asana, Trello, or similar PM tool account.

- ❌ After logging in, the timer gets stuck in an infinite "loading" loop. The extension itself is likely functional once past this screen.

---

### ❌ #25 — MailTrack `12.82.1`

- ⚠️ Popup opens and leads to the registration/login page.
- ❌ After logging in, the extension does not recognize the active account, and the tracking button is not visible inside Gmail.

---

### ❌ #26 — Microsoft SSO `1.0.11`

> **Note:** Requires a Microsoft Entra ID (work/school) account on this machine. Full test can be skipped if unavailable.

- ⚠️ OAuth redirect and login flow work.
- ❌ Cannot be fully tested without an Entra account to validate the SSO handshake.

---

### ❌ #27 — Calendly `4.13.0.0`

- ❌ The sign-in side panel does not appear.
- ❌ The hover button (for inserting availability into email) is not visible.

---

### ❌ #28 — Endpoint Verification `1.140.0`

> **Note:** `enterprise.deviceAttributes`, `enterprise.platformKeys`, and `gcm` are Out of Scope — ChromeOS/enterprise-only APIs. A full pass is not possible without a Google Workspace managed account.

- ❌ The Google-account popup opens but does not load past the initial screen.

---

### ❌ #29 — iCloud Passwords `3.3.0`

> **Note:** `declarativeContent` gap is a known minor item (not yet triaged). Requires iCloud for Windows.

- ⚠️ Popup windows appear to open correctly when the iCloud for Windows desktop app is running.
- ❌ Could not complete account creation during testing.

---

### ❌ #30 — KeePass XC `1.10.3`

> **Note:** Requires KeePassXC desktop app with browser integration enabled and an unlocked database.

- ❌ Extension stays on "Checking status…" loop — cannot establish native messaging connection.
- ❌ Popup renders but configuration and customization buttons do not function.

---

## Pending Implementations

### Phase 2 — Deferred APIs

These APIs were explicitly deferred after Phase 1. They are needed by confirmed fleet extensions and are the recommended next focus.

---

#### `chrome.webRequest` (observational + blocking)

**Affected extensions:** uBlock, uBlock Origin Lite, MailTrack, Enpass, Bitwarden, KeePassXC

Electron implements extension `webRequest` natively. The dead `onHeadersReceived` override that was previously clobbering the native API has been removed, so observational usage passes through. **Blocking behavior for uBlock has not been re-validated** — this is the key retest for Phase 2. If uBlock Origin Lite's popup still fails to load, blocking may be absent or broken, which would make this a real implementation gap rather than just a passthrough issue.

---

#### `chrome.declarativeNetRequest`

**Affected extensions:** Dashlane, LastPass, Streak, HubSpot, DeepL (5 extensions)

Originally classified as Out of Scope due to high complexity, but the per-extension research revealed that 5 fleet extensions depend on it — none of them are ad-blockers. Their use likely covers lighter scenarios (auth header injection, redirect rules) rather than the full rule engine. A per-extension investigation of _why_ each one declares it is recommended before deciding on an implementation approach.

---

#### `chrome.identity.getAuthToken`

**Affected extensions:** likely Boomerang, GMass, Streak, HubSpot (Google OAuth flows)

Chrome-specific Google account integration. A fallback via `chrome.identity.launchWebAuthFlow` (already implemented) is possible for some extensions. Needs per-extension testing to determine whether `getAuthToken` is actually called or whether the web flow is sufficient.

---

#### `chrome.tts`

**Affected extensions:** DeepL ("read aloud"), Google Translate ("read aloud")

Nice-to-have. Core translation functionality works without it. Both extensions degrade gracefully — the read-aloud button is simply non-functional.

---

#### `chrome.runtime` `externally_connectable`

**Affected extensions:** theoretical — no confirmed fleet extension verified

Would allow ordinary web pages matching an extension's `externally_connectable.matches` manifest entry to call `chrome.runtime.connect`/`sendMessage` and reach the extension's `onConnectExternal`/`onMessageExternal` handlers. This requires injecting scoped messaging into non-extension web page contexts (currently the preload is gated to `chrome-extension://` contexts only), with per-extension, per-origin security scoping. Remains unverified for any specific fleet extension — implement only if a concrete extension is confirmed to need it.

---

### Phase 3 — Spec Parity

These items close test-coverage gaps in already-implemented APIs. No new API implementations required.

---

#### 3.1 — Parametrize `alarms` and `idle` specs across both MV2 and MV3 fixtures

Both specs currently run only against the MV2 `rpc` fixture. The most fleet-critical combination — an **MV3 service worker** (all password managers) receiving `alarms.onAlarm` / `idle.onStateChanged` — has no direct automated coverage. Wrap the `describe` blocks of `chrome-alarms-spec.ts` and `chrome-idle-spec.ts` in a `forEach` over `['rpc', 'rpc-mv3']`.

**Effort:** Low. **Priority:** High — this is the password-manager case.

---

#### 3.2 — Extend `rpc-mv3` fixture permissions

Add `downloads` and `management` to `spec/fixtures/rpc-mv3/manifest.json` so the parametrization in 3.3 can run. `alarms` and `idle` are already declared in that fixture.

**Effort:** Trivial.

---

#### 3.3 — Parametrize `downloads`, `management`, and `captureVisibleTab` specs

Same parametrization as 3.1 for the remaining APIs. Lower priority than 3.1 — no fleet extension currently calls these from an MV2 context that isn't already covered by existing specs.

**Effort:** Low.

---

#### 3.4 — Alarm persistence across app restarts _(optional)_

Chrome persists alarms to disk; the current implementation stores them in memory only (documented in `alarms.ts`). Low real-world risk — extensions must tolerate missed alarms, and password managers re-create their alarms at service-worker startup. Implement only if a fleet extension is observed to depend on alarm persistence across restarts: serialize the per-extension alarm map and reschedule on `AlarmsAPI` construction.

**Effort:** Medium.

---

### Out of Scope (confirmed)

The following will not be implemented. Extensions that depend on them will remain at PARTIAL status.

| API                                                                     | Reason                                                                            |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `chrome.enterprise.deviceAttributes` / `chrome.enterprise.platformKeys` | ChromeOS/enterprise-only. No Electron backing.                                    |
| `chrome.gcm`                                                            | Google Cloud Messaging — no Electron backing.                                     |
| `chrome.declarativeContent`                                             | iCloud Passwords declares it; low fleet footprint (1 extension), not yet triaged. |
| `chrome.history` / `chrome.bookmarks` / `chrome.devtools.*`             | No Electron backing, niche fleet use.                                             |
| `chrome.storage.sync` real backend                                      | Stays aliased to `local`. Settings persist locally but do not roam.               |
