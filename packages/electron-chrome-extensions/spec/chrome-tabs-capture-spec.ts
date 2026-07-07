import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.tabs.captureVisibleTab', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })

  it('captures the active tab as a jpeg data URL by default', async () => {
    const result = await browser.crx.exec('tabs.captureVisibleTab')
    expect(result).to.be.a('string')
    expect(result).to.match(/^data:image\/jpeg;base64,/)
  })

  it('supports the png format', async () => {
    const result = await browser.crx.exec('tabs.captureVisibleTab', browser.window.id, {
      format: 'png',
    })
    expect(result).to.be.a('string')
    expect(result).to.match(/^data:image\/png;base64,/)
  })
})
