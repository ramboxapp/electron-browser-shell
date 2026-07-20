import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

// chrome.webRequest is implemented natively by Electron. These specs document
// its behavior and — critically — whether the app-level session.webRequest
// (single listener per event) coexists with extension listeners. The DNR
// implementation and Rambox's own interceptors depend on the answer (P2.0
// spike in docs/EXTENSIONS_APIS_PHASE2.md).
describe('chrome.webRequest', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })

  describe('event objects', () => {
    it('are real, intact event objects when the native API works (repair must be a no-op)', async () => {
      // Guards the Electron 43 webRequest-event repair in the renderer
      // preload (see "Repair chrome.webRequest's event objects" in
      // src/renderer/index.ts): on Electron versions where the native events
      // are intact — like the one this suite runs on — the repair must leave
      // them completely untouched. The probe tests below prove listeners
      // actually observe traffic (an accidentally-installed inert stub would
      // pass a shape check but never fire); this one just proves the event
      // object exists and responds to the events.Event surface.
      const result = await browser.crx.eventMethod('webRequest.onBeforeRequest', 'hasListeners')
      expect(result.ok, `hasListeners call failed: ${result.error}`).to.be.true
      expect(result.result).to.be.a('boolean')
    })
  })

  // Upstream Electron 43 regression: chrome.webRequest's event objects are
  // undefined ("No source for require(webRequestEvent)"), so the native
  // observation/blocking layer is dead — reproduced on stock 43.0.0 and
  // still present in 43.1.1. The renderer preload fills the missing events
  // with inert stubs so extensions survive startup (see "Repair
  // chrome.webRequest's event objects" in src/renderer/index.ts), but
  // listeners registered on a stub never fire. These specs assert the
  // version-appropriate behavior: real observation/blocking on <=42, alive
  // but inert on 43. If the >=43 branches start failing, Electron fixed the
  // regression upstream — remove the shim and flip these back.
  const nativeWebRequestBroken = parseInt(process.versions.electron, 10) >= 43

  describe('onBeforeRequest (native)', () => {
    it(`observes requests made by a page (${nativeWebRequestBroken ? 'inert on Electron 43, upstream regression' : 'native'})`, async () => {
      // On 43 this also proves the shim's core purpose: addListener at the
      // fixture's top level did NOT throw, so probe-start replies ok.
      const started = await browser.crx.raw({ type: 'webrequest-probe-start' })
      expect(started).to.deep.equal({ ok: true })

      await browser.webContents.loadURL(server.getUrl() + 'probe-observe')

      const { observed } = await browser.crx.raw({ type: 'webrequest-probe-results' })
      expect(observed.some((url: string) => url.includes('probe-observe'))).to.equal(
        !nativeWebRequestBroken,
      )
    })

    it(`blocking listener ${nativeWebRequestBroken ? 'no longer blocks on Electron 43 (upstream regression)' : 'cancels matching requests (MV2 webRequestBlocking)'}`, async () => {
      await browser.crx.raw({ type: 'webrequest-probe-start', blockPath: 'blocked-path' })

      const blocked = await browser.webContents.executeJavaScript(
        `fetch('${server.getUrl()}blocked-path').then(() => 'fetched', () => 'blocked')`,
      )
      expect(blocked).to.equal(nativeWebRequestBroken ? 'fetched' : 'blocked')

      const allowed = await browser.webContents.executeJavaScript(
        `fetch('${server.getUrl()}allowed-path').then(() => 'fetched', () => 'blocked')`,
      )
      expect(allowed).to.equal('fetched')
    })
  })

  // Electron's session.webRequest supports a single listener per event, shared
  // with the native extension webRequest routing. Registering an app-level
  // listener REPLACES the extension's — so an app-level session.webRequest hook
  // silently disables extension webRequest. This is the documented reason the
  // declarativeNetRequest implementation relies on Electron's native DNR engine
  // rather than hooking session.webRequest (which would break Bitwarden /
  // KeePassXC webRequestAuthProvider and any extension using webRequest).
  //
  // If a future Electron makes these coexist, this test flips — a good signal
  // to revisit the DNR approach.
  describe('coexistence with app-level session.webRequest', () => {
    it('app-level session.webRequest clobbers the extension listener', async () => {
      await browser.crx.raw({ type: 'webrequest-probe-start' })

      const appSeen: string[] = []
      browser.session.webRequest.onBeforeRequest((details, callback) => {
        appSeen.push(details.url)
        callback({})
      })

      try {
        await browser.webContents.loadURL(server.getUrl() + 'coexist-check')

        const { observed } = await browser.crx.raw({ type: 'webrequest-probe-results' })

        expect(
          appSeen.some((url) => url.includes('coexist-check')),
          'app-level session.webRequest listener saw the request',
        ).to.be.true
        expect(
          observed.some((url: string) => url.includes('coexist-check')),
          'extension chrome.webRequest listener is clobbered (does NOT see the request)',
        ).to.be.false
      } finally {
        // Unregister so other specs aren't affected.
        browser.session.webRequest.onBeforeRequest(null)
      }
    })
  })
})
