import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.offscreen', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  it('creates, detects and closes an offscreen document', async () => {
    let hasDocument = await browser.crx.exec('offscreen.hasDocument')
    expect(hasDocument).to.be.false

    await browser.crx.exec('offscreen.createDocument', {
      url: 'offscreen.html',
      reasons: ['TESTING'],
      justification: 'spec',
    })

    hasDocument = await browser.crx.exec('offscreen.hasDocument')
    expect(hasDocument).to.be.true

    await browser.crx.exec('offscreen.closeDocument')

    hasDocument = await browser.crx.exec('offscreen.hasDocument')
    expect(hasDocument).to.be.false
  })
})
