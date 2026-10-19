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
