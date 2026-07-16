# Extension Fleet — Manual Test Checklist

Companion to [EXTENSIONS_APIS.md](./EXTENSIONS_APIS.md): this document **executes its Tier 3** (manual verification with the real fleet). Extensions are listed in the same order as the per-extension research table there, so results can be cross-referenced row by row.

Testing happens in the **electron-browser-shell app of this repo** — this isolates the `electron-chrome-extensions` library from Rambox's integration code. An extension that fails here _and_ works in real Chrome points at the library (or Electron itself); an extension that works here but fails in Rambox points at Rambox's integration.

---

## 1. Environment setup

```bash
# From the repo root — builds the packages, then launches the shell
yarn start

# With library debug logs
yarn start:debug

# With CDP access for inspecting extension service workers / background pages
yarn start -- --remote-debugging-port=9223
```

**Installing extensions** (two options):

- Drop the **unpacked** extension folder into `extensions/` at the repo root — auto-loaded on startup.
- Or install directly from the Chrome Web Store inside the shell (electron-chrome-web-store is wired in): navigate to the extension's CWS page and install.

**Inspecting the background context:** with the debugging port open, `curl http://localhost:9223/json` and look for `chrome-extension://` targets — `service_worker` type for MV3, `backgroundPage` for MV2. The popup target only exists while the popup is open.

**Reading version / manifest version:** from the extension's `manifest.json` (`version`, `manifest_version`), or `chrome.runtime.getManifest()` in any of its CDP targets.

---

## 2. Standard procedure (every extension)

1. Install → the icon appears in the toolbar (`<browser-action-list>`) and a background target shows up in CDP.
2. Background/SW console is clean: no uncaught `chrome.* is undefined` / `... is not a function` errors at startup.
3. Popup opens and renders (not blank), no console errors.
4. Exercise the extension-specific flows (sections below).
5. Fill the row in the master table: Version, Manifest Version, Status, Notes.

**Status legend:** `✅ PASS` · `⚠️ PARTIAL` (core flow works, some feature broken) · `❌ FAIL` · `⏭️ SKIPPED` (missing prerequisite) · `⬜` pending.

---

## 3. Known caveats — read before testing

- **Module service workers fail to register on stock Electron 38–42** (upstream regression, documented in the fix-app-extension skill). Signature: no SW target ever appears + `Service worker registration failed. Status code: 15` in the shell console. **1Password is known-affected** (`"background": {"type": "module"}`) — expected ❌ here; Rambox carries the `patchModuleSwToClassic` workaround, so 1Password's real test belongs in Rambox. Any other extension showing this exact signature: record it as this known regression, **not** as an API gap.
- **Expected PARTIALs from documented gaps** (see EXTENSIONS_APIS.md Phase 2 / Out of Scope): Dashlane, LastPass, Streak, HubSpot (`declarativeNetRequest`), DeepL (`tts` + DNR), Google Translate (`tts` read-aloud), iCloud Passwords (`declarativeContent`), Endpoint Verification (`enterprise.*`, `gcm`).
- **Extension self-reloads left open tabs on a dead context — fixed (2026-07-10), Dashlane account creation retested ✅.** When an extension calls `chrome.runtime.reload()` with pages open, Electron doesn't reload those tabs like Chrome does — they keep an invalidated context where every native `chrome.*` getter returns `undefined`. Dashlane hit this on "Crear una cuenta": its `reloadOnLogout` task reloads the extension right as the signup tab (`index.html#/signup`) is loading, so the tab hung forever and the popup stayed open showing `Extension context invalidated`. The library now reloads an extension's tabs after it re-loads, and closes its popup on unload and on opening an active tab (Chrome parity). Manually confirmed fixed 2026-07-10. Spec: `chrome-runtime-reload-spec.ts`. Full investigation (including three earlier wrong hypotheses, all removed from the code) in EXTENSIONS_APIS.md's Dashlane Tier 3 section. **Watch for this signature in other extensions too** — any "log out"/"update now" flow that reloads the extension had the same failure mode before this fix.
- **Native messaging extensions need their desktop app** installed with browser integration enabled: 1Password, KeePassXC, Enpass, SafeInCloud, Roboform, iCloud Passwords (iCloud for Windows).
- **Enterprise extensions need accounts**: Endpoint Verification (Google Workspace), Microsoft SSO (Entra ID). `⏭️ SKIPPED` is acceptable if unavailable.
- `chrome.storage.sync` is aliased to `local`: settings persist locally but don't roam. Not a failure.
- **activeTab-only popups are fixed via manifest patch (2026-07-08):** Electron never grants `activeTab` (the toolbar click is synthesized by the library), so popups calling `scripting.executeScript` on the page failed with "Cannot access contents of the page" — found via Google Translate's icon-click translate (§8). `patchActiveTabManifest` now grants those extensions `<all_urls>` at load. **Relaunch the shell after pulling the fix so already-installed extensions get patched**, then retest. If another extension's popup still can't touch the page, check its patched manifest first.

---

## 4. Master checklist

| Done  | #   | Extension             | Version       | Manifest Version | Status | Notes                                                                                                                                                                                                                                                                                                                                                                 |
| ----- | --- | --------------------- | ------------- | ---------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [x]   | 1   | 1Password             | 8.12.26.40    | 3                | ✅     | ❌ Expected FAIL here (module-SW regression) — full test in Rambox; ❌ No Toast; FIXED✅: No icon in textfield; FIXED✅: login idle (see if can be fixed in extensions and not in shell (like in desktop))                                                                                                                                                            |
| [xxx] | 2   | Bitwarden             | 2026.6.1      | 3                | ❌     | ❌ No icon in textfield; FIXED✅: login popup hangs; FIXED✅: contextMenu no autofill.                                                                                                                                                                                                                                                                                |
| [x]   | 3   | Boomerang             | 1.9.3         | 3                | ✅     | FIXED✅: Render frame was disposed before WebFrameMain could be accessed                                                                                                                                                                                                                                                                                              |
| [x]   | 4   | Dark Reader           | 4.9.128       | 3                | ✅     |                                                                                                                                                                                                                                                                                                                                                                       |
| [x]   | 5   | Dashlane              | 6.2628        | 3                | ✅     | ❌ Expect PARTIAL — DNR gap; FIXED✅: account creation hang (runtime.reload tab invalidation) + popup now hides; FIXED✅: No icon in textfield                                                                                                                                                                                                                        |
| [x]   | 6   | DragApp               | 19.7.0        | 3                | ✅     |                                                                                                                                                                                                                                                                                                                                                                       |
| [x]   | 7   | GMass                 | 6.0.43        | 3                | ✅     |                                                                                                                                                                                                                                                                                                                                                                       |
| [x]   | 8   | Google Translate      | 2.0.17        | 3                | ✅     | Worked✅: Read-aloud expected missing (tts); FIXED✅: No translation when clicking extension icon; hostinger abrir mail con la extension crashea Rambox.                                                                                                                                                                                                              |
| [x]   | 9   | Grammarly             | 14.1311.0     | 3                | ✅     | Both bugs FIXED. #2 (2026-07-11): MV3-SW WebSocket proxied through main process (`api/websocket.ts` + `ProxyWebSocket` shim). #1 (2026-07-14): CSS `__MSG_@@extension_id__` token rewritten on disk at load (`patch/css-message-patch.ts`) — verified 330→0 refs in Grammarly's CSS. Detects, underlines, and shows correction cards in Gmail; icons resolve. See §9. |
| [xxx] | 10  | Keeper                | 18.0.0        | 3                | ⚠️     | FIXED✅ (2026-07-11): popup hung forever, never loading login — root cause was `chrome.offscreen` not keeping the calling SW alive while its offscreen document awaited a reply (see `docs/EXTENSIONS_APIS.md` §4 and the `fix-app-extension` skill's Known Fixes table). FIXED✅ (2026-07-16, confirmed with a real login): logged in for ~1-2s then bounced straight back to the login screen, repeatably. Went through 3 hypotheses before the real one — empty `alarmInfo`, missing 30s clamp, then NaN bypassing validation — each real and fixed but *not* the reported cause; ground truth came from a temporary debug log in `AlarmsAPI.create()` capturing Keeper's actual `logoutTimer` payload live: a genuine ~30-day-out `when`, not NaN or empty. Node's own stdout showed why it still fired instantly: `TimeoutOverflowWarning: 2591999999 does not fit into a 32-bit signed integer` — `setTimeout` silently overflows above `2**31-1`ms (~24.8 days) and fires almost immediately instead of throwing. Fixed with `scheduleLongTimeout()` chaining delays past that cap through smaller hops (see `docs/EXTENSIONS_APIS.md` §1). **Confirmed via real login this time** (not just a synthetic repro): closed and reopened the popup, logged in with real credentials, landed on and stayed on the main vault screen. ⚠️ **New, separate, unresolved issue found the same day: "Trouble Loading."** Opening the popup sometimes shows Keeper's own "Trouble Loading" fallback and never recovers on its own (manual close+reopen works around it). Root-caused as far as: the SW is alive and receives the popup's startup message (confirmed via a diagnostic listener), but never replies — not a delivery failure, an internal wedge. A same-day fix attempt (generic health-check ping + forced SW restart before showing the popup) was implemented, found to false-positive on most of the fleet (many real extensions' `onMessage` handlers unconditionally `return true` without checking message shape, indistinguishable from a real wedge from the sender's side) — it broke Everhour/1Password/Dashlane/Bitwarden's popup rendering and made Keeper's popup flash-reload even on healthy opens — and was **fully reverted** same-day once caught (full suite reconfirmed green, rendering reconfirmed normal for all affected extensions). See `docs/EXTENSIONS_APIS.md` §4's "Known issue, unresolved" write-up for the full detail and possible future directions. Full [PM standard flow](#5-password-manager-standard-flow) otherwise passes; leave this row unchecked while Trouble Loading remains open.                                                                                                                                                                                                                                                                                                                                                        |
| [xxx] | 11  | LastPass              | 4.154.2       | 3                | ❌     | Expect PARTIAL — DNR gap; No carga login                                                                                                                                                                                                                                                                                                                              |
| [ ]   | 12  | NordPass              | 7.8.15        | 3                | ⬜     |                                                                                                                                                                                                                                                                                                                                                                       |
| [ ]   | 13  | NordPass2             |               | 3                | ❌     | Legacy listing, same codebase as NordPass; No abre la pagina de login (a diferencia de "no cargar", directamente no abre el la pagina).                                                                                                                                                                                                                               |
| [ ]   | 14  | Roboform              | 9.9.8.0       | 3                | ❌     | Al clickear el botón de extension muestra un popup de "buy now" en vez de mostrar la pagina de login.                                                                                                                                                                                                                                                                 |
| [ ]   | 15  | SafeInCloud           | 25.1.0        | 3                | ❌     | Al clickear el botón de extensión no carga la pagina en el popup.                                                                                                                                                                                                                                                                                                     |
| [x]   | 16  | Streak                | 7.86          | 3                | ✅     | Expect PARTIAL — DNR gap                                                                                                                                                                                                                                                                                                                                              |
| [ ]   | 17  | uBlock                | 25.5.0        | 3                | ❌     | **Key retest** — native webRequest blocking; No funciona más, cambiar por UBlock Origin Lite (ddkjiahejlhfcafbddmgiahcphecmpfh)                                                                                                                                                                                                                                       |
| [ ]   | 18  | uBlock Origin Lite    | 2026.713.1408 | 3                | ❌     | ddkjiahejlhfcafbddmgiahcphecmpfh; El popup no carga. probablemente sea native WebRequest blocking.                                                                                                                                                                                                                                                                    |
| [ ]   | 19  | Proton Pass           | 1.38.2        | 3                | ❌     | No carga el popup para loguearse. Por ende tampoco se ve el botón en el textfield.                                                                                                                                                                                                                                                                                    |
| [ ]   | 20  | DeepL                 | 1.95.0        | 3                | ❌     | Expect PARTIAL — tts + DNR gaps; El login anda, pero el popup no muestra lo mismo que en el chrome (no te deja traducir).                                                                                                                                                                                                                                             |
| [ ]   | 21  | Language Tool         | 11.0.0        | 3                | ❌     | Subraya los errores y se ven las correcciones, pero no se ve el botón en el textfield.                                                                                                                                                                                                                                                                                |
| [ ]   | 22  | HubSpot               | 3.1.1.42473   | 3                | ❌     | Expect PARTIAL — DNR gap; El ícono de extension no carga bien. No se v el botón en Gmail                                                                                                                                                                                                                                                                              |
| [ ]   | 23  | Enpass                | 6.11.14       | 3                | ❌     | NO se puede conectar a la app: "Browser requesting the data is not code signed"                                                                                                                                                                                                                                                                                       |
| [ ]   | 24  | Everhour              | 1.6.319       | 3                | ❌     | Needs Asana/Trello/etc. account; Después de loguearse, el timer queda en bucle de "loading". Si pasamos eso, la extensión funciona correctamente.                                                                                                                                                                                                                     |
| [ ]   | 25  | MailTrack             | 12.82.1       | 3                | ❌     | anda el popup y e lleva al registro, pero luego no reconoce la cuenta logueada ni se ve el botón en Gmail.                                                                                                                                                                                                                                                            |
| [ ]   | 26  | Microsoft SSO         | 1.0.11        | 3                | ❌     | Needs Entra ID — skippable. No se puede testear completa, pero el redirect y login anda.                                                                                                                                                                                                                                                                              |
| [ ]   | 27  | Calendly              | 4.13.0.0      | 3                | ❌     | No se ve el popup lateral de sign in. Tampoco se ve el botón hover.                                                                                                                                                                                                                                                                                                   |
| [ ]   | 28  | Endpoint Verification | 1.140.0       | 3                | ❌     | Expect PARTIAL/FAIL — enterprise.\*/gcm unsupported. Muestra el popup con google y no carga. No la pude testear en detalle                                                                                                                                                                                                                                            |
| [ ]   | 29  | iCloud Passwords      | 3.3.0         | 3                | ❌     | Expect PARTIAL — declarativeContent gap; needs iCloud for Windows. No pude crear cuenta. Popups parecen abrirse correctamente junto a la app desktop.                                                                                                                                                                                                                 |
| [ ]   | 30  | KeePass XC            | 1.10.3        | 3                | ❌     | Needs KeePassXC desktop app. No funciona; "Checking status" loop; Se ve el popup pero los botones de configuracion y personalización no funcionan.                                                                                                                                                                                                                    |

---

## 5. Password-manager standard flow

The 13 password managers share this core flow. Each PM section below references it and only lists its deltas.

- [ ] Startup: background/SW console clean (standard procedure step 2)
- [ ] Sign in / unlock the vault
- [ ] Navigate to a real login page (e.g. github.com/login) → autofill fills credentials (`scripting`)
- [ ] Right-click a login field → the extension's context-menu entry appears and reflects the current site (`contextMenus` + `update`)
- [ ] Copy a password from the popup → paste somewhere → matches (`offscreen` clipboard on MV3)
- [ ] Configure the shortest auto-lock timeout → leave the machine idle → vault locks (`idle` + `alarms`)
- [ ] Re-open popup after lock → asks for unlock again

**APIs exercised:** alarms, idle, scripting, contextMenus(.update), offscreen (MV3), storage.

---

## 6. Per-extension procedures

### §1 — 1Password

**Prereq:** 1Password desktop app installed, browser integration on.

- [ ] **Expect the module-SW failure** (see caveats): no SW target, `Status code: 15`. Record the exact console output.
- [ ] If the SW does come up (regression fixed upstream): run the [PM standard flow](#5-password-manager-standard-flow) + desktop-app unlock (`nativeMessaging`) + vault export (`downloads`).
      **Record:** whether the failure signature matches the known regression.

### §2 — Bitwarden

- [ ] [PM standard flow](#5-password-manager-standard-flow)
- [ ] Copy password specifically **from the popup** (exercises the `offscreen` clipboard path)
- [ ] Visit an HTTP basic-auth page (e.g. `httpbin.org/basic-auth/u/p`) → Bitwarden offers/fills credentials (`webRequestAuthProvider` via native webRequest)
- [ ] No crash from its `sidePanel` calls (stubbed)
      **APIs:** PM set + offscreen, webRequest(AuthProvider), sidePanel stub.

### §3 — Boomerang

**Prereq:** Gmail account.

- [ ] Open Gmail in a tab → Boomerang buttons appear in compose ("Send Later")
- [ ] Schedule a send → confirmation UI works
- [ ] Its conflicting-extension check runs without errors (`management.getAll` — check SW console)
      **APIs:** management, scripting/content scripts.

### §4 — Dark Reader

- [ ] Toggle dark mode on a bright site → page turns dark
- [ ] Enable "Automation → Sunrise/sunset" → no errors (`alarms`)
- [ ] Open the font settings in the popup → UI renders, doesn't throw (`fontSettings` stub)
- [ ] Per-site toggle works
      **APIs:** alarms, fontSettings stub, tabs, contextMenus (opt).

### §5 — Dashlane

- [ ] [PM standard flow](#5-password-manager-standard-flow)
- [ ] Note any feature that visibly breaks and whether it traces to `declarativeNetRequest` (expected PARTIAL)
- [x] **Account-creation hang, root-caused and fixed (2026-07-08 → 2026-07-10):** popup → "Crear una cuenta" opens `chrome-extension://.../index.html#/signup` in a new tab, which hung indefinitely on the loading logo, while the popup stayed open (in Chrome it closes). Investigation went through three wrong hypotheses (`externally_connectable`, idle-SW-wake, `globalThis.chrome` write-back — all disproven; their code was removed once the real fix was confirmed) before an isolated-harness repro found the real cause. **Actual root cause:** "Crear una cuenta" also logs out, Dashlane's `reloadOnLogout` background task calls `chrome.runtime.reload()`, and Electron — unlike Chrome — doesn't reload the extension's open tabs after a reload: the signup tab, still loading when the reload hit, stayed forever on an invalidated context (every native `chrome.*` getter `undefined`, DevTools screenshot signature) and its own `No runtime.connect support` check threw. The popup's `Extension context invalidated` error was Chromium's reload signature all along. **Fix (library):** reload the extension's tabs on `extension-loaded` after an `extension-unloaded` of the same id; close the popup on extension unload and when its extension opens an active tab. Spec: `chrome-runtime-reload-spec.ts` (suite 104/104 green). Full writeup: EXTENSIONS_APIS.md "Bugs found and fixed during Tier 3 testing (Dashlane, 2026-07-09 → 2026-07-10)".
- [x] **Retest confirmed (2026-07-10, manual):** signup page loads correctly and the popup hides when the tab opens.
      **APIs:** PM set + cookies, privacy stub, webRequest(AuthProvider); DNR gap (unfixed, Out of Scope); runtime.reload tab-invalidation (fixed 2026-07-10).

### §6 — DragApp

**Prereq:** Gmail account.

- [ ] Open Gmail → Drag's board UI loads over the inbox
- [ ] Switch board/list view, drag an email between columns
      **Record:** actual manifest version + permissions from its `manifest.json` (research was inconclusive — update EXTENSIONS_APIS.md row #6 with findings).

### §7 — GMass

**Prereq:** Gmail account.

- [ ] Open Gmail → GMass buttons appear next to compose
- [ ] Connect account (OAuth flow — note whether it uses `identity.getAuthToken`, currently unimplemented, or a web flow)
- [ ] Build a small campaign draft (no need to send)
      **Record:** if OAuth fails, capture whether `getAuthToken` is the culprit (Phase 2 item).

### §8 — Google Translate

- [ ] Select text on a page → translate popup/inline result appears
- [ ] Context-menu "Google Translate" entry works on selection
- [ ] Read-aloud button: **expected missing/broken** (`tts` — Phase 2). Note exact behavior.
      **Record:** actual manifest version (research inconclusive — update EXTENSIONS_APIS.md row #8).

### §9 — Grammarly

**Prereq:** Grammarly account (free tier fine).

- [ ] Type a sentence with errors in Gmail compose (or any textarea site) → underlines + correction cards appear (`scripting`)
- [ ] Accept a correction → text updates
- [ ] Popup login persists across restart (`storage`)

**Bug found (2026-07-10) — FIXED (2026-07-14): CSS `__MSG_@@extension_id__` i18n substitution not performed by Electron.**

Symptoms in the shell: the floating "Rewrite with Grammarly" green-lightbulb button icon is missing, and mistyped text is **not underlined** (no visible suggestions), while the _selection-based_ "Improve/rewrite" blue sidebar works normally. IPC is fine — the content script's `chrome.runtime.connect` ports (`message:to-priv`, `message-bus-port`) connect to the SW, verified via CDP.

Root cause (confirmed by CDP, checker-independent):

- Chrome substitutes the predefined message `__MSG_@@extension_id__` with the extension's ID when serving/injecting an extension's **CSS** (documented i18n-in-CSS behavior). Electron does **not**.
- Grammarly emits every visual asset as `url(chrome-extension://__MSG_@@extension_id__/…)` — **330 references** across its injected CSS (147 svg, 144 woff/woff2, 30 png, 9 gif). The unsubstituted authority `//__MSG_@@extension_id__/` parses as `chrome-extension://extension_id__/` (the `@@` is read as a userinfo separator), which 404s — seen in the page console as `Failed to load resource … chrome-extension://extension_id__/…/light-bulb.svg`.
- The **underline itself is a background image**, not a border: `.gr-alert.gr_spell { border-bottom: 2px solid transparent; background-image: url(…/underline-inline-cards.svg) }`. With the SVG URL broken, there is no visible underline even when the checker flags text. This is why the same gap explains _both_ the missing icon and the missing underlines.
- Proof via CDP `fetch()` from the page: the placeholder URL `chrome-extension://__MSG_@@extension_id__/src/images/…/underline-inline-cards.svg` → **"Failed to fetch"**; the same path with the real ID → **200 OK**. The asset exists and is servable; only the substitution is missing.

**Fix (2026-07-14) — on-disk CSS token substitution at load, not protocol interception.** Intercepting Electron's native `chrome-extension://` handler was rejected as too risky (would mean reimplementing `web_accessible_resources` gating). Instead the token is rewritten in the extension's `.css` files on disk — CSS is served/injected lazily per request, so a disk rewrite fixes both `<link>`-served and content-script CSS. New helper `patchExtensionCssMessages(extensionPath, extensionId)` in `src/browser/patch/css-message-patch.ts` (pure `substituteExtensionIdInCss` core + never-throw walker, `.crx-css-patched` marker, idempotent), exported and consumer-invoked **post-load** (the `@@extension_id` value = the ID Electron only assigns at `loadExtension`): shell wires it on `extension-loaded`, Rambox in its `loadExtension` wrapper. Spec: `spec/css-message-patch-spec.ts`. Suite 112/0.

**Verified end-to-end (2026-07-14):** after loading Grammarly (v14.1311.0), all `.css` files went from **330 `__MSG_@@extension_id__` refs → 0**, now referencing the real ID (`chrome-extension://kbfnbcae…/src/images/…`), and the `.crx-css-patched` marker was written. The previously-404ing assets (lightbulb icon, underline SVGs) now resolve 200. Generic — fixes any extension using `__MSG_@@extension_id__` in CSS.

Scope note: v1 handles the predefined `@@extension_id` message only (the dominant CSS case). Full `__MSG_<key>__` (`_locales`) / `@@ui_locale` substitution is a future extension.

**Bug #2 found (2026-07-11) — SEPARATE from #1, and the one actually stopping the inline checker: Grammarly's grammar-check produces zero alerts in the shell.**

Bug #1 (CSS) hides underlines/icons; bug #2 means there is nothing to hide. Confirmed in the user's real Gmail compose (text "tito puente y romulo y remoo"): Grammarly's overlay **is attached** (7 `grammarly-*` custom elements present) but produced **0 alert elements** (`gr-alert` count = 0) — versus Chrome, where the same text yields Correctness suggestions. So the checker never returns results; fixing #1 alone would restore the icon and make underlines _visible only if alerts existed_, which they don't.

**Update (2026-07-11) — pinned down further with the TLS/origin confounders eliminated.** Relaunched the shell with `--ignore-certificate-errors` (app-wide, user-confirmed for this disposable test instance) and re-ran the SW-vs-page comparison over a **local, unencrypted `ws://` server** — zero TLS, zero certificate involved at all:

- **Page** (identical code, same session): connects instantly, receives the pushed frame. Reliable control across every transport tried (plain `ws://`, self-signed `wss://`, public `wss://` echo services).
- **Service worker**: `new WebSocket('ws://127.0.0.1:8899')` → immediate `ERR`, `readyState=3` (closed) — and **the local test server's own log shows zero connection attempts arrived** (checked directly). This rules out TLS, certificates, and server-side rejection entirely: the failure happens client-side, before any bytes leave the process.
- Same failure, same signature, against three different real public `wss://` hosts with valid, publicly-trusted certificates (`echo.websocket.events`, `ws.postman-echo.com`, `libwebsockets.org`) — so it isn't specific to local/self-signed servers either.
- **Yet `wss://capi.grammarly.com/freews` opens successfully from the exact same SW** — confirmed with a full timestamped event trace: `open` fires at ~520ms, `readyState` stays `1` (OPEN) for 6+ seconds of polling. Also confirmed `WebSocket` is the untouched native constructor in that context (`WebSocket.toString()` → `"function WebSocket() { [native code] }"`), so this isn't a fake/wrapped object misreporting its state — it's a genuine, functioning connection.
- No custom network code (webRequest, proxy, certificate-verify hooks) exists anywhere in this repo (`packages/shell`, `electron-chrome-extensions`) that could explain host-specific allow/deny behavior — so this isn't something built into the shell or the library.

**Conclusion:** this is a real asymmetry in Electron's networking for MV3 service-worker contexts — arbitrary outbound `WebSocket` connections silently fail to establish from a SW (client-side, pre-TLS, pre-TCP-trace), while the identical API from an ordinary page in the same process/session works everywhere, and Grammarly's own `capi.grammarly.com` connection from the SW is a working exception rather than proof the mechanism works generally. Why `capi.grammarly.com` specifically succeeds is unresolved — it isn't explained by manifest host permissions (`<all_urls>` covers all the failing hosts equally) or by anything in this codebase.

Root cause: a real asymmetry in Electron's networking for MV3 service-worker contexts — arbitrary outbound native `WebSocket` connections silently fail from a SW, while the same API from a page works. `WebSocket` in a SW is served directly by Electron/Chromium's native network stack, so there is no JS interception point (unlike the other six MV3-SW fixes). Reportable upstream to Electron/Chromium.

**FIXED (2026-07-11) — WebSocket proxy through the main process.** The main process (Node.js) is not subject to the SW restriction, so the library now opens the real socket there and relays frames over IPC, mirroring the `NativeMessagingHost` transport:

- `src/browser/api/websocket.ts` (`WebSocketAPI`) + `src/browser/api/lib/websocket-connection.ts` (one `ws`-backed socket per connection, per-connection IPC channels; main→SW pushes go through `startWorkerForScope` so an idle SW is woken to receive frames).
- `src/renderer/index.ts` installs a `ProxyWebSocket` shim over `globalThis.WebSocket` **in service-worker contexts only** (pages keep the working native one). It implements the WHATWG interface and relays through the `electron` bridge.
- `ws` is **bundled into `dist`** (kept out of esbuild's `external` list), so Desktop needs no `npm install` — only the standard copy-`dist/` redeploy.
- Spec: `spec/chrome-websocket-spec.ts` (fixture MV3 SW: connect, text frame, binary frame, clean close) — exactly the scenario that failed with native WebSocket. Full suite 105 pass / 0 fail.

**Verified end-to-end (2026-07-11):** in the running shell, `new WebSocket('wss://echo.websocket.org')` from Grammarly's **real** service worker now `open`s (+717ms) and **receives** the server's greeting frame (+718ms) — the exact call that returned `ERR`/`readyState=3` before the fix. `WebSocket` in that SW reports `ProxyWebSocket`. The unexplained "`capi.grammarly.com` works but others don't" native quirk is now moot — all SW WebSockets route through the proxy.

**Still blocking the _visible_ checker: Bug #1 (CSS `__MSG_@@extension_id__`).** With the socket fixed, the checker can now receive corrections, but the underline SVG + suggestion-card icons still 404 (Bug #1), so corrections won't be _visible_ until Bug #1 is also fixed. A synthetic bare-`contenteditable`/`textarea` test page still shows `gr-alert=0`, but that field isn't one Grammarly checks (it was 0 before the fix too — a field-detection non-signal, not a WebSocket signal). Confirming `gr-alert > 0` needs a real Gmail compose (logged-in session) — recommended as the user-side retest.

### §10 — Keeper

**Prereq:** Keeper account.

- [ ] [PM standard flow](#5-password-manager-standard-flow)
      **Record:** actual manifest version + whether it needs its desktop app (research inconclusive — update EXTENSIONS_APIS.md row #10).

### §11 — LastPass

- [ ] [PM standard flow](#5-password-manager-standard-flow) (note: LastPass dropped `idle` — auto-lock uses `alarms`)
- [ ] Note any DNR-traceable breakage (expected PARTIAL)

### §12 — NordPass / §13 — NordPass2

- [ ] [PM standard flow](#5-password-manager-standard-flow) on NordPass (current listing)
- [ ] NordPass2 (legacy): install → loads → unlock works. Full flow only if it behaves differently.

### §14 — Roboform

**Prereq:** RoboForm desktop app (optional but preferred).

- [ ] [PM standard flow](#5-password-manager-standard-flow)
- [ ] Desktop-app connection if installed (`nativeMessaging`)

### §15 — SafeInCloud

**Prereq:** SafeInCloud desktop app **running** (extension is a thin client over `nativeMessaging`).

- [ ] Desktop app pairing succeeds
- [ ] Autofill from context menu on a login page (`contextMenus`)

### §16 — Streak

**Prereq:** Gmail account.

- [ ] Open Gmail → Streak pipelines UI loads
- [ ] Create a box/pipeline entry
- [ ] Email tracking indicator on a sent mail
- [ ] Note any DNR-traceable breakage (expected PARTIAL)

### §17 — uBlock ⭐ key retest

This is the main validation that removing the dead `webRequest.onHeadersReceived` override unlocked native blocking.

- [ ] Install uBlock Origin (MV2) → icon + badge appear
- [ ] Visit an ad-heavy site (e.g. a news portal) → ads visibly blocked, badge counter increments
- [ ] Open the logger (popup → list icon) → network requests stream in (`webRequest` events)
- [ ] Dashboard → update filter lists → completes (`alarms` + fetch)
- [ ] Disable on current site via popup power button → ads return after reload
      **Record in detail:** if blocking doesn't work, this becomes the Phase 2 `webRequest` work item's primary evidence.

### §18 — Proton Pass

- [ ] [PM standard flow](#5-password-manager-standard-flow)
      **Record:** actual manifest permissions from its `manifest.json` (update EXTENSIONS_APIS.md row #18).

### §19 — DeepL

- [ ] Select text → DeepL icon/popup translates it
- [ ] Context-menu translate entry works
- [ ] Login (`identity` — uses `launchWebAuthFlow`, implemented)
- [ ] Read-aloud: **expected missing** (`tts`). Note behavior.
- [ ] Note any DNR-traceable breakage (expected PARTIAL)

### §20 — Language Tool

- [ ] Type errored text in a textarea (e.g. Gmail compose) → corrections appear
- [ ] Settings persist across restart (`storage.sync` → aliased to local: persists locally, doesn't roam — not a failure)
      **Record:** actual manifest version + permissions (update EXTENSIONS_APIS.md row #20).

### §21 — HubSpot

**Prereq:** HubSpot account connected to Gmail.

- [ ] Open Gmail → HubSpot sidebar/sales tools load
- [ ] Email tracking toggle in compose works
- [ ] No crash from `sidePanel`/`offscreen` usage (both covered: stub + implemented)
- [ ] Note any DNR-traceable breakage (expected PARTIAL)

### §22 — Enpass

**Prereq:** Enpass desktop app **running** (`nativeMessaging`).

- [ ] Desktop pairing succeeds
- [ ] [PM standard flow](#5-password-manager-standard-flow) (MV2: background page instead of SW; clipboard without offscreen)
- [ ] Its `webRequestBlocking` path doesn't error (native passthrough — check background console while browsing)

### §23 — Everhour

**Prereq:** Everhour account + an integrated PM tool account (Asana/Trello/ClickUp…).

- [ ] Open the PM tool in a tab → Everhour timer button appears on tasks
- [ ] Start/stop a timer → time registers
      **Record:** actual manifest version + permissions (update EXTENSIONS_APIS.md row #23).

### §24 — MailTrack

**Prereq:** Gmail account.

- [ ] Open Gmail → MailTrack signature/checkmarks UI appears in compose
- [ ] Send a mail to yourself → double-check marks appear when opened
- [ ] Its `webRequestBlocking` path works (tracking pixels detected — native passthrough)

### §25 — Microsoft SSO

**Prereq:** Microsoft Entra ID (work/school) account on this Windows machine — else `⏭️ SKIPPED`.

- [ ] Navigate to an Entra-protected site (e.g. portal.office.com) → SSO with the OS account kicks in (`nativeMessaging`)

### §26 — Calendly

**Prereq:** Calendly account.

- [ ] Popup opens → shows event types
- [ ] In Gmail compose, insert availability/link via the Calendly button (`scripting`)

### §27 — Endpoint Verification

**Prereq:** Google Workspace managed account — else `⏭️ SKIPPED`.

- [ ] Install → loads without hard crash
- [ ] Attempt sync: `enterprise.deviceAttributes`/`enterprise.platformKeys`/`gcm` calls will fail (**expected** — Out of Scope). Record the exact errors.
- [ ] Its `nativeMessaging`/`alarms`/`idle`/`storage` parts should not error.

### §28 — iCloud Passwords

**Prereq:** iCloud for Windows installed and signed in.

- [ ] Pairing/verification code flow with iCloud for Windows completes (`nativeMessaging`)
- [ ] Autofill on a login page with a saved password
- [ ] Note icon-state behavior (`declarativeContent` gap — icon may not enable/disable per page; expected PARTIAL)

### §29 — KeePass XC

**Prereq:** KeePassXC desktop app running, browser integration enabled, a test database unlocked.

- [ ] Pairing with the desktop app succeeds (`nativeMessaging`)
- [ ] Autofill credentials on a matching login page
- [ ] Copy username/password via the extension (`offscreen` clipboard)
- [ ] Context-menu entries per site (`contextMenus` + `update`)
- [ ] Basic-auth page fill (`webRequestAuthProvider`)

---

## 7. After the pass

1. Update the master table above (it is the source of truth for Tier 3 completion).
2. Port confirmed findings back to `EXTENSIONS_APIS.md`: fill the ❓ rows (#6, #8, #10, #18, #20, #23, #25) with the actual manifest data observed, and update the per-extension Coverage column where reality differed.
3. Anything that failed on an API gap → file it against the Phase 2/3 backlog in `EXTENSIONS_APIS.md`; anything that failed only here but works in Chrome → new library/Electron issue; anything that later fails only in Rambox → `fix-app-extension` territory.
