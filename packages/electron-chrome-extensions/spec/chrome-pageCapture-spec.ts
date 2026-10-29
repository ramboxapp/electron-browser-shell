import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

/* chrome.pageCapture.saveAsMHTML on webContents.savePage: a Blob of the page, as Chrome's. */
describe('chrome.pageCapture', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'floor-mv3' })

  it('saveAsMHTML() answers a multipart/related Blob of the tab', async () => {
    const result: any = await browser.crx.raw({ type: 'page-capture' })
    expect(result.error, result.error).to.equal(undefined)
    expect(result.isBlob).to.equal(true)
    expect(result.type).to.equal('multipart/related')
    expect(result.size).to.be.greaterThan(0)
    expect(result.head).to.match(/MIME-Version|multipart\/related/i)
  })

  it('fails for a tab that does not exist', async () => {
    const result: any = await browser.crx.raw({
      type: 'api',
      method: 'pageCapture.saveAsMHTML',
      args: [{ tabId: 987654 }],
    })
    expect(result).to.deep.equal({ ok: false, error: 'No tab with id: 987654.' })
  })
})
