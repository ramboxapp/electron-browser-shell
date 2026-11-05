import { expect } from 'chai'

import { WebContentsView } from 'electron'

import { useExtensionBrowser, useServer } from './hooks'

/**
 * The `browser` global, as seen from an extension's service worker.
 *
 * Chrome has none — that is what webextension-polyfill exists for — but Electron defines one in
 * extension contexts carrying only its natively implemented namespaces. Cross-browser extensions
 * read `globalThis.browser` first precisely because its presence is meant to signal "this browser
 * has the WebExtension API", so every namespace this library injects onto `chrome` has to be
 * mirrored onto it as well.
 *
 * Measured consequence of not doing that, against Rambox's extension catalog: LastPass 4.154.2 and
 * NordPass 7.8.15 both threw at service-worker top level (`browser.windows.onFocusChanged` /
 * `browser.webRequest.<event>` being undefined), their workers never registered — "Service worker
 * registration failed. Status code: 15" — and both extensions did nothing at all, with no error
 * visible to the user or to the host app.
 */
describe('browser global', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  const report = () =>
    browser.crx.raw({ type: 'browser-global' }) as Promise<{
      exists: boolean
      isChrome: boolean
      namespaces: string[]
      mirrored: string[]
      windowsEvent: boolean
      webRequestEvent: boolean
    }>

  it('carries the namespaces this library injects onto chrome', async () => {
    const result = await report()
    // If Electron ever stops defining `browser`, extensions fall back to `chrome` on their own and
    // there is nothing to mirror — but then this assumption has changed and the spec should say so.
    expect(result.exists, 'Electron no longer defines a `browser` global in extension contexts').to
      .be.true
    expect(result.namespaces).to.include('windows')
    expect(result.namespaces).to.include('webNavigation')
  })

  it('shares the injected objects with chrome rather than copying them', async () => {
    const result = await report()
    // Same object identity, so a listener registered through `browser` reaches the same event.
    expect(result.mirrored).to.include('windows')
    expect(result.mirrored).to.include('webNavigation')
  })

  it('exposes windows events, which an extension registers at top level', async () => {
    const result = await report()
    expect(result.windowsEvent).to.be.true
  })

  it('carries, in an extension page, the namespaces injected there that the worker has natively', async () => {
    // `action` is native in the worker and injected by this library in a page: Clockify's popup read
    // `browser.action.setIcon` and found `browser.action` undefined (05/11/2026, against Edge, where
    // browser.action and chrome.action are the same object in both contexts).
    const view = new WebContentsView({ webPreferences: { session: browser.session } })
    try {
      await view.webContents.loadURL(`chrome-extension://${browser.extension.id}/sidepanel.html`)
      const result = await view.webContents.executeJavaScript(`({
        action: typeof browser.action,
        sameAction: browser.action === chrome.action,
        sameScripting: browser.scripting === chrome.scripting,
        sameWindows: browser.windows === chrome.windows,
      })`)
      expect(result).to.deep.equal({
        action: 'object',
        sameAction: true,
        sameScripting: true,
        sameWindows: true,
      })
    } finally {
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
  })

  it('carries the repaired webRequest events too', async () => {
    const result = await report()
    // Electron 43 leaves every chrome.webRequest event undefined ("No source for
    // require(webRequestEvent)"); the repair has to reach `browser.webRequest` as well, because an
    // extension that took the `browser` path never sees the repaired `chrome` one.
    expect(result.webRequestEvent).to.be.true
  })
})
