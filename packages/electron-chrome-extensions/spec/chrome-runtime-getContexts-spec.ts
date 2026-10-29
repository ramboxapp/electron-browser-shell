import { expect } from 'chai'
import { WebContentsView } from 'electron'

import { useExtensionBrowser, useServer } from './hooks'

/**
 * `chrome.runtime.getContexts()` answered only `BACKGROUND` (Electron's native binding knows
 * nothing else), while Chromium lists every document the extension has open: the offscreen
 * document, the action popup and its pages in tabs. Measured on 20/10/2026 against Edge with the
 * same extension. NordPass reads it to decide whether to create its offscreen document, so a
 * missing entry means "create another one", which `offscreen.createDocument` then refuses.
 */
describe('chrome.runtime.getContexts', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  const offscreen = () =>
    browser.crx.exec('offscreen.createDocument', {
      url: 'offscreen.html',
      reasons: ['TESTING'],
      justification: 'spec',
    })

  it('still reports the background service worker', async () => {
    const contexts: any[] = await browser.crx.exec('runtime.getContexts', {})
    const background = contexts.filter((c) => c.contextType === 'BACKGROUND')
    expect(background).to.have.length(1)
  })

  it('reports an open offscreen document, in the shape Chromium gives', async () => {
    await offscreen()
    try {
      const contexts: any[] = await browser.crx.exec('runtime.getContexts', {})
      const docs = contexts.filter((c) => c.contextType === 'OFFSCREEN_DOCUMENT')
      expect(docs, JSON.stringify(contexts)).to.have.length(1)
      const [doc] = docs
      expect(doc.documentUrl).to.equal(`chrome-extension://${browser.extension.id}/offscreen.html`)
      expect(doc.documentOrigin).to.equal(`chrome-extension://${browser.extension.id}`)
      expect(doc.contextId).to.be.a('string').and.not.empty
      expect(doc.tabId).to.equal(-1)
      expect(doc.windowId).to.equal(-1)
      expect(doc.frameId).to.equal(0)
      expect(doc.incognito).to.equal(false)
    } finally {
      await browser.crx.exec('offscreen.closeDocument')
    }
  })

  it('applies the filter', async () => {
    await offscreen()
    try {
      const onlyOffscreen: any[] = await browser.crx.exec('runtime.getContexts', {
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      })
      expect(onlyOffscreen.map((c) => c.contextType)).to.deep.equal(['OFFSCREEN_DOCUMENT'])

      const onlyBackground: any[] = await browser.crx.exec('runtime.getContexts', {
        contextTypes: ['BACKGROUND'],
      })
      expect(onlyBackground.map((c) => c.contextType)).to.deep.equal(['BACKGROUND'])
    } finally {
      await browser.crx.exec('offscreen.closeDocument')
    }
  })

  it('reports an extension page open in a tab as TAB, with its tab and window', async () => {
    // The spec's createTab makes tabs in the default session, so the tab is built here, in the
    // extension's session, the way a host app's tab would be.
    const view = new WebContentsView({ webPreferences: { session: browser.session } })
    try {
      await view.webContents.loadURL(`chrome-extension://${browser.extension.id}/offscreen.html`)
      browser.extensions.addTab(view.webContents, browser.window)
      const contexts: any[] = await browser.crx.exec('runtime.getContexts', {
        contextTypes: ['TAB'],
      })
      expect(contexts, JSON.stringify(contexts)).to.have.length(1)
      expect(contexts[0].tabId).to.equal(view.webContents.id)
      expect(contexts[0].windowId).to.equal(browser.window.id)
    } finally {
      view.webContents.close()
    }
  })

  it('stops reporting the offscreen document once it is closed', async () => {
    await offscreen()
    await browser.crx.exec('offscreen.closeDocument')
    const contexts: any[] = await browser.crx.exec('runtime.getContexts', {})
    expect(contexts.map((c) => c.contextType)).to.deep.equal(['BACKGROUND'])
  })
})
