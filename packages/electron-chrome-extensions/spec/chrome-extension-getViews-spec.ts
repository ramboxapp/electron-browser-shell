import { expect } from 'chai'
import { WebContentsView } from 'electron'

import { useExtensionBrowser, useServer } from './hooks'

/**
 * `chrome.extension.getViews` was a stub answering `[]` everywhere. Measured against Chrome
 * (docs/EXTENSION_COMPAT.md): an options page gets one view — itself — and a service worker has no
 * `getViews` at all. An extension that looks for its own page among the views, or that feature-tests
 * the function in its worker, was told something Chrome never says.
 */
describe('chrome.extension.getViews', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  it('is not there in a service worker, as in Chrome', async () => {
    const result: any = await browser.crx.raw({ type: 'extension-get-views-in-worker' })
    expect(result.type).to.equal('undefined')
  })

  it('lists the calling extension page among its views', async () => {
    const view = new WebContentsView({ webPreferences: { session: browser.session } })
    try {
      await view.webContents.loadURL(`chrome-extension://${browser.extension.id}/offscreen.html`)
      const result = await view.webContents.executeJavaScript(`(() => {
        const views = chrome.extension.getViews()
        return { length: views.length, includesSelf: views.includes(window) }
      })()`)
      expect(result.includesSelf, JSON.stringify(result)).to.be.true
    } finally {
      view.webContents.close()
    }
  })
})
