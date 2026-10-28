import { expect } from 'chai'
import { app, webContents } from 'electron'
import { emittedOnce } from './events-helpers'

import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.windows', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })

  describe('get()', () => {
    it('gets details on the window', async () => {
      const windowId = browser.window.id
      const result = await browser.crx.exec('windows.get', windowId)
      expect(result).to.be.an('object')
      expect(result.id).to.equal(windowId)
    })
  })

  describe('getLastFocused()', () => {
    it('gets the last focused window', async () => {
      // HACK: focus() doesn't actually emit this in tests
      browser.window.emit('focus')
      const windowId = browser.window.id
      const result = await browser.crx.exec('windows.getLastFocused')
      expect(result).to.be.an('object')
      expect(result.id).to.equal(windowId)
    })

    /*
      Never null, even with nothing focused.

      Chrome answers getLastFocused/getCurrent with a window or rejects, so extensions dereference
      the result without guarding. Rejecting is not available here — a throw in a browser-side
      handler comes back to the caller as `undefined`, which crashes an extension exactly like the
      `null` did — so the answer is the window-shaped `{ id: WINDOW_ID_NONE }` that `get()` already
      uses. Grammarly 14.1339.0 does `getCurrent().then((w) => w.focused)` and
      died on `Cannot read properties of null (reading 'focused')` when this resolved null. An
      embedder that registers its window lazily has exactly this shape — windows exist, none is
      marked focused — so the answer falls back to a known window instead of to null.
    */
    it('answers with a window when none is focused', async () => {
      const result = await browser.crx.exec('windows.getLastFocused')
      expect(result, 'getLastFocused resolved null with a window open').to.be.an('object')
      expect(result.id).to.equal(browser.window.id)
    })

    it('answers getCurrent() with a window when none is focused', async () => {
      const result = await browser.crx.exec('windows.getCurrent')
      expect(result, 'getCurrent resolved null with a window open').to.be.an('object')
      expect(result.id).to.equal(browser.window.id)
    })
  })

  /*
    A window's details are live state, read on every call.

    They used to be cached the first time anything asked and refreshed only on 'resized', so the
    answer froze at the moment the window was first seen. In Rambox that is the first addTab() at
    boot: every extension was then told, for the whole session, that the window held no tabs and was
    not focused — while tabs.query() listed four tabs in it and the window had OS focus (measured in
    the app on 28/10/2026). Grammarly 14.1342.0 reads `getCurrent().focused` to decide whether there
    is an active tab at all.
  */
  describe('details are live', () => {
    it('lists a tab added after the window was first read', async () => {
      // Read once first: this is what used to freeze the answer.
      await browser.crx.exec('windows.getAll', { populate: true })

      // Same session as the extension host, or addTab rejects it outright.
      const tab = (webContents as any).create({ sandbox: true, session: browser.session })
      try {
        browser.extensions.addTab(tab, browser.window)
        await tab.loadURL(server.getUrl())

        const [win] = await browser.crx.exec('windows.getAll', { populate: true })
        const tabIds = win.tabs.map((t: chrome.tabs.Tab) => t.id)
        expect(tabIds).to.include(tab.id)
        expect(tabIds).to.include(browser.webContents.id)
      } finally {
        tab.destroy()
      }
    })

    it('reports focus as it is now, not as it was when first read', async () => {
      const before = await browser.crx.exec('windows.getCurrent')
      expect(before.id).to.equal(browser.window.id)

      // focus() does not move OS focus under the spec runner, so the window's own answer is stubbed.
      const original = browser.window.isFocused
      const focused = !before.focused
      browser.window.isFocused = () => focused
      try {
        expect((await browser.crx.exec('windows.getCurrent')).focused).to.equal(focused)
        expect((await browser.crx.exec('windows.getLastFocused')).focused).to.equal(focused)
        expect((await browser.crx.exec('windows.get', browser.window.id)).focused).to.equal(focused)
        const [win] = await browser.crx.exec('windows.getAll')
        expect(win.focused).to.equal(focused)
      } finally {
        browser.window.isFocused = original
      }
    })

    // Chrome only puts `tabs` on a window when asked (measured in Edge 156).
    it('includes tabs only with populate: true', async () => {
      const [plain] = await browser.crx.exec('windows.getAll')
      expect(plain).to.not.have.property('tabs')
      expect(await browser.crx.exec('windows.getCurrent')).to.not.have.property('tabs')
      expect(await browser.crx.exec('windows.get', browser.window.id)).to.not.have.property('tabs')

      const [populated] = await browser.crx.exec('windows.getAll', { populate: true })
      expect(populated.tabs).to.be.an('array').that.is.not.empty
      const current = await browser.crx.exec('windows.getCurrent', { populate: true })
      expect(current.tabs).to.be.an('array').that.is.not.empty
    })
  })

  describe('remove()', () => {
    it('removes the window', async () => {
      const windowId = browser.window.id
      const closedPromise = emittedOnce(browser.window, 'closed')
      browser.crx.exec('windows.remove', windowId)
      await closedPromise
    })

    it('removes the current window', async () => {
      const closedPromise = emittedOnce(browser.window, 'closed')
      browser.crx.exec('windows.remove')
      await closedPromise
    })
  })
})
