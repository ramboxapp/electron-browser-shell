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

  describe('onBeforeRequest (native)', () => {
    it('observes requests made by a page', async () => {
      const started = await browser.crx.raw({ type: 'webrequest-probe-start' })
      expect(started).to.deep.equal({ ok: true })

      await browser.webContents.loadURL(server.getUrl() + 'probe-observe')

      const { observed } = await browser.crx.raw({ type: 'webrequest-probe-results' })
      expect(observed.some((url: string) => url.includes('probe-observe'))).to.be.true
    })

    it('blocking listener cancels matching requests (MV2 webRequestBlocking)', async () => {
      await browser.crx.raw({ type: 'webrequest-probe-start', blockPath: 'blocked-path' })

      const blocked = await browser.webContents.executeJavaScript(
        `fetch('${server.getUrl()}blocked-path').then(() => 'fetched', () => 'blocked')`,
      )
      expect(blocked).to.equal('blocked')

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
