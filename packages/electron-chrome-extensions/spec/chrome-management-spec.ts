import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

// chrome.management is implemented natively by Electron. These specs guard
// against the preload accidentally clobbering it.
describe('chrome.management', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })

  describe('getSelf()', () => {
    it('returns info about the calling extension', async () => {
      const info = await browser.crx.exec('management.getSelf')
      expect(info).to.be.an('object')
      expect(info.id).to.equal(browser.extension.id)
    })
  })

  describe('getAll()', () => {
    it('includes the loaded extension', async () => {
      const extensions = await browser.crx.exec('management.getAll')
      expect(extensions).to.be.an('array')
      expect(extensions.map((info: any) => info.id)).to.include(browser.extension.id)
    })
  })
})
