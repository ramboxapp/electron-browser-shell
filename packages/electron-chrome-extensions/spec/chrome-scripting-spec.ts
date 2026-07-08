import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

// chrome.scripting is implemented natively by Electron. These specs guard
// against the preload accidentally clobbering it.
describe('chrome.scripting', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  // The extension's service worker can still be finishing startup right
  // after loadExtension() resolves, so the first tabs.query() call
  // immediately afterward can race it and see no tabs yet. Retry briefly
  // rather than gating every test on worker startup.
  const getActiveTabId = async () => {
    for (let attempt = 0; ; attempt++) {
      const tabs = await browser.crx.exec('tabs.query', { active: true })
      if (tabs.length === 1) return tabs[0].id
      if (attempt >= 5) {
        expect(tabs).to.have.lengthOf(1)
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  describe('executeScript()', () => {
    it('injects a file into the tab', async () => {
      const tabId = await getActiveTabId()
      await browser.crx.exec('scripting.executeScript', {
        target: { tabId },
        files: ['injected.js'],
      })

      const title = await browser.webContents.executeJavaScript('document.title')
      expect(title).to.equal('injected')
    })
  })

  describe('insertCSS()', () => {
    it('applies styles to the tab', async () => {
      const tabId = await getActiveTabId()
      await browser.crx.exec('scripting.insertCSS', {
        target: { tabId },
        css: 'body { background-color: rgb(255, 0, 0) !important; }',
      })

      const backgroundColor = await browser.webContents.executeJavaScript(
        'getComputedStyle(document.body).backgroundColor',
      )
      expect(backgroundColor).to.equal('rgb(255, 0, 0)')
    })
  })
})
