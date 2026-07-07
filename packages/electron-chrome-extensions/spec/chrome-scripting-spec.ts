import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

// chrome.scripting is implemented natively by Electron. These specs guard
// against the preload accidentally clobbering it.
describe('chrome.scripting', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  const getActiveTabId = async () => {
    const tabs = await browser.crx.exec('tabs.query', { active: true })
    expect(tabs).to.have.lengthOf(1)
    return tabs[0].id
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
