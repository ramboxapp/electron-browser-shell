import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

// chrome.scripting is implemented natively by Electron. These specs guard
// against the preload accidentally clobbering it.
describe('chrome.scripting', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  // Tab IDs are WebContents IDs, so read it from the main process instead of
  // calling the injected tabs.query: API overrides don't reliably reach MV3
  // service workers on Linux, where the query resolves empty.
  const getActiveTabId = () => browser.webContents.id

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
