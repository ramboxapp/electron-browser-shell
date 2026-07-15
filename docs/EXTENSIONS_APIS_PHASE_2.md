# Phase 2 Implementation Plan

Companion to [EXTENSIONS_APIS.md](./EXTENSIONS_APIS.md) (its "Phase 2" section) and [EXTENSIONS_API_MANUAL_TEST.md](./EXTENSIONS_API_MANUAL_TEST.md) (whose Tier 3 results re-prioritized this phase). Written 2026-07-15.

## Context — what changed since Phase 2 was drafted

Phase 2 originally listed four deferred items: `webRequest` extras, `declarativeNetRequest`, `identity.getAuthToken`, `tts`. Tier 3 manual testing plus a scan of the **actually-installed manifests** (`%APPDATA%/shell/Extensions`, 2026-07-15) changed the picture substantially:

| Evidence | Consequence |
|---|---|
| uBlock Origin (MV2) is dead upstream; the fleet's ad-blocker is now **uBlock Origin Lite** (`ddkjiahejlhfcafbddmgiahcphecmpfh`), which is **pure declarativeNetRequest** — and its popup currently doesn't load | DNR is promoted to the centerpiece of Phase 2; the MV2 `webRequestBlocking` question is largely moot |
| **LastPass 4.154.2 installed manifest has NO `declarativeNetRequest*` permission** (only `webRequest` + `webRequestAuthProvider`) — chrome-stats data was stale | LastPass is *removed* from the DNR consumer list; its "login page doesn't load" failure is undiagnosed and belongs to Tier 3 debugging (fix-app-extension), not Phase 2 |
| Dashlane (`declarativeNetRequest`, **no static rulesets**, calls `get/updateDynamicRules`) · HubSpot (same) · DeepL (**one** static ruleset: 1 `modifyHeaders` rule with `urlFilter`/`excludedDomains`/`resourceTypes`, plus `updateDynamicRules`) | The fleet's DNR need (excluding uBO Lite) is **dynamic rules + tiny static rulesets** — a tractable v1, not Chromium's full rule engine |
| GMass ✅ and Boomerang ✅ passed without `identity.getAuthToken`; Streak ✅ | No confirmed fleet blocker on `getAuthToken` — demoted to "on first real failure" |
| Google Translate read-aloud **worked** (uses its own audio path, not `chrome.tts`); DeepL's popup is broken *before* any tts call | `tts` demoted to "verify after DeepL's popup bug is fixed" |
| Proton Pass installed manifest: `webRequest` only — no DNR | Its popup failure is also Tier 3 debugging, not Phase 2 |

**Resulting scope: Phase 2 = one spike + one real implementation (DNR v1) + two verifications + two deferred design sketches.**

---

## P2.0 — Spike: webRequest coexistence (prerequisite, do first)

**Question to answer:** in Electron 42, can the app-level `session.webRequest` (single listener per event) coexist with the native extensions `chrome.webRequest`? And therefore: can the library hook `session.webRequest` for DNR without breaking Bitwarden/KeePassXC (`webRequestAuthProvider`) or Rambox's own interceptors?

**Method (½ session):** a spec/probe that simultaneously (a) registers `session.webRequest.onBeforeRequest` in the main process, (b) has the `rpc` fixture register `chrome.webRequest.onBeforeRequest`, then loads a page and asserts **both** fire, and blocking from (a) still lets (b) observe. Also probe `onBeforeSendHeaders`/`onHeadersReceived` header mutation.

**Outcomes:**
- Both fire → DNR v1 can safely hook `session.webRequest` from the library. Document the ordering.
- They clobber each other → DNR v1 must expose a **multiplexer** (library owns the single listener; consumers register through it — export from `src/index.ts` like the patch helpers, consumer-invoked). This also becomes the documented answer for the long-standing "may conflict with Rambox's own network interceptors" concern.

---

## P2.1 — `chrome.declarativeNetRequest` v1 (the real work)

**Consumers (verified):** Dashlane + HubSpot (dynamic rules only), DeepL (1 static `modifyHeaders` rule + dynamic), Streak (`declarativeNetRequestWithHostAccess` per chrome-stats — not installed locally; re-verify at implementation time), uBlock Origin Lite (full static engine — **explicitly out of v1**, see gate below).

### Scope v1 (matches the evidence)

- **Rule sources:** dynamic rules (persisted), session rules (in-memory), static rulesets from `manifest.declarative_net_request.rule_resources` (loaded per `enabled` flag + `updateEnabledRulesets`).
- **Actions:** `block`, `allow`, `redirect` (incl. `transform`/`regexSubstitution` minimal), `upgradeScheme`, `modifyHeaders`. (`allowAllRequests` parse-but-log.)
- **Conditions:** `urlFilter` (Chrome DNR syntax: `||`, `|`, `^`, `*` — hand-rolled matcher, no deps), `regexFilter` + `isUrlFilterCaseSensitive`, `initiatorDomains`/`excludedInitiatorDomains` (+legacy `domains` aliases), `requestDomains`/`excluded…`, `resourceTypes`/`excluded…`, `requestMethods`.
- **Precedence:** per Chrome docs — rule `priority` first; at equal priority `allow`/`allowAllRequests` > `block` > `upgradeScheme`/`redirect`; `modifyHeaders` applies for rules not outranked by an `allow`/`block`.
- **API surface** (`src/browser/api/declarative-net-request.ts`): `updateDynamicRules`, `getDynamicRules`, `updateSessionRules`, `getSessionRules`, `updateEnabledRulesets`, `getEnabledRulesets`, `isRegexSupported`, `getAvailableStaticRuleCount` (constant), `getMatchedRules` (empty result), `setExtensionActionOptions` (noop), event stub `onRuleMatchedDebug`. Constants (`MAX_NUMBER_OF_DYNAMIC_RULES`, `DYNAMIC_RULESET_ID`, `SESSION_RULESET_ID`, …) in the renderer factory.
- **Permission gating:** accept `declarativeNetRequest` **or** `declarativeNetRequestWithHostAccess` (the router's `permission` option takes one string — do the two-permission check inside the handlers instead).

### Architecture

- `src/browser/api/lib/dnr-matcher.ts` — **pure engine** (parse rules, index, match a request `{url, initiator, resourceType, method}` → winning actions). Unit-testable without Electron, mirroring the `patch/` pure-core convention.
- `src/browser/api/declarative-net-request.ts` — API handlers + rule storage + the `session.webRequest` hookup (`onBeforeRequest` → cancel/redirect, `onBeforeSendHeaders` → request-header mods, `onHeadersReceived` → response-header mods), shaped by the P2.0 spike outcome (direct hook vs multiplexer).
- **Dynamic-rule persistence:** JSON per extension under `app.getPath('userData')/crx-dnr/<extensionId>.json` (Chrome persists dynamic rules across restarts; alarms' in-memory precedent is *not* right here — extensions set dynamic rules once at install). Session rules in-memory. Static rulesets re-read from disk at load via the existing `readLoadedExtensionManifest` flow (`src/browser/manifest.ts`) or `extension-loaded`.
- **Renderer factory:** gated by `shouldInject: () => manifest has declarativeNetRequest*` permission; spread `base` (golden rule) — if a future Electron ships native DNR, delete library code.
- Resource-type mapping: Electron `webRequest` details `resourceType` → DNR `ResourceType` (`main_frame`, `sub_frame`, `stylesheet`, `script`, `image`, `font`, `xmlhttprequest`, `media`, `websocket`, `other`).

### Specs (`spec/chrome-declarativeNetRequest-spec.ts` + fixture changes)

- Fixture: add `declarativeNetRequest` permission to `rpc-mv3`; new tiny fixture static ruleset (1 block rule + 1 modifyHeaders rule) declared in its manifest.
- Cases: dynamic rules CRUD roundtrip (`update`/`get`, persistence file written); `block` rule blocks a page `fetch()` to the local `useServer` URL; `redirect` rule rewrites to a second server path (assert final body); `modifyHeaders` adds a request header (assert via server-side echo); `updateEnabledRulesets` toggles the static ruleset on/off; `isRegexSupported` sanity. Matcher unit spec (`dnr-matcher-spec.ts`) for urlFilter syntax + precedence table.
- Harness notes: page-side `fetch` via `webContents.executeJavaScript` (not `crx.exec`, which is for `chrome.*`); the server from `useServer` already echoes — extend it to echo headers if needed.

### uBlock Origin Lite gate (v2, decide after v1)

uBO Lite ships ~50 static rulesets totaling hundreds of thousands of rules — matching them per-request in JS without Chromium's flatbuffer index is a real perf risk. **Do not attempt in v1.** After v1 lands: load uBO Lite behind a measurement (rules loaded, per-request match latency on an ad-heavy page). If unacceptable, v2 options: domain-keyed pre-index of urlFilters, lazy ruleset compilation, or documenting uBO Lite as unsupported and recommending a network-level blocker. **First diagnose its popup failure** — "popup no carga" may be an unrelated SW/offscreen bug (same signature family as Keeper's, already fixed) rather than DNR absence; check its SW console before attributing.

**Estimate:** 2–3 sessions (spike ½, matcher+API 1–1.5, specs+suite ½–1).

---

## P2.2 — `webRequest` verification (no code unless evidence demands)

MV2-blocking consumers left: Enpass + MailTrack (both currently failing on *unrelated* things: native-host code-signing check, account recognition). Live consumers of `webRequestAuthProvider`: Bitwarden, KeePassXC, Dashlane, LastPass.

- [ ] After P2.0's probe: retest Bitwarden basic-auth (`httpbin.org/basic-auth/u/p`) and KeePassXC basic-auth — the only webRequest feature a fleet extension observably depends on.
- [ ] Only if a concrete failure appears → scope a library shim then (the P2.0 multiplexer is the likely vehicle). No speculative implementation.

**Estimate:** folded into P2.0/P2.1 sessions.

---

## P2.3 — `identity.getAuthToken` — DEFERRED (no confirmed blocker)

GMass/Boomerang/Streak passed without it. Keep the design on file, implement only when a fleet extension observably fails on `getAuthToken` (signature: SW console `getAuthToken is not a function` / OAuth popup never opens while login works in Chrome):

> Implement on top of the existing `launchWebAuthFlow` (`src/browser/api/identity.ts`): build the Google OAuth URL from `manifest.oauth2.client_id` + `scopes`, redirect to `https://<extensionId>.chromiumapp.org/`, parse `access_token` from the fragment, cache per extension+scopes in memory, `removeCachedAuthToken` evicts. Caveat to verify per extension: Chrome-App-type OAuth client IDs only accept the chromiumapp redirect when the extension ID matches the CWS ID (holds in Electron when the manifest has `key`, which CWS-installed copies do).

## P2.4 — `chrome.tts` — DEFERRED (verify need first)

Google Translate's read-aloud worked without it; DeepL declares `tts` but its popup is broken earlier (Tier 3 row 20). Order of operations: fix DeepL's popup (Tier 3 debugging) → check whether read-aloud actually calls `chrome.tts` (grep its bundle: `chrome.tts.speak`) → only then implement. Design sketch if needed:

> Main-process-proxied like WebSocket: `TtsAPI` keeps a hidden `BrowserWindow` (or reuses the offscreen-document machinery) whose page runs `speechSynthesis`; `speak`/`stop`/`pause`/`resume`/`isSpeaking`/`getVoices` route over IPC; `onEvent` relayed back with `start`/`end`/`error` events. Renderer factory gated on the `tts` permission.

---

## Sequencing

| Order | Item | Gate |
|---|---|---|
| 1 | P2.0 spike (webRequest coexistence probe) | — |
| 2 | P2.1 DNR v1 (matcher → API → specs → full suite) | spike outcome shapes the hook |
| 3 | P2.2 basic-auth retests (Bitwarden/KeePassXC) | after spike; file findings in the manual-test doc |
| 4 | uBO Lite: diagnose popup, then perf gate for DNR v2 | after DNR v1 |
| 5 | P2.3 / P2.4 | only on confirmed fleet evidence |

## Acceptance

- Full suite green (baseline 105+/0; new: `dnr-matcher-spec.ts`, `chrome-declarativeNetRequest-spec.ts`).
- Manual: Dashlane & HubSpot SW consoles clean of `declarativeNetRequest` errors; DeepL's static ruleset loads (1 rule) and its `updateDynamicRules` calls succeed.
- Docs updated on completion: EXTENSIONS_APIS.md (status table + Phase 2 rows), manual-test rows 5/20/22 retested, fix-app-extension limitations table, extensions-api-implementation skill backlog mirror.

## Out of scope for Phase 2 (unchanged)

`enterprise.*`/`gcm`, `declarativeContent` (iCloud icon-state only), `history`/`bookmarks`/`devtools.*`, real `storage.sync`. The remaining Tier 3 ❌ rows (LastPass, NordPass2, Roboform, SafeInCloud, Proton Pass, Calendly, KeePassXC status-loop, Everhour timer-loop, MailTrack account, Enpass code-signing) are **per-extension debugging** (fix-app-extension workflow), not API-gap work — several may share already-fixed root causes (Keeper's offscreen keep-alive, WebSocket proxy) and just need retests.
