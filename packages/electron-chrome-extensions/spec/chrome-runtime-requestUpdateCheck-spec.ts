import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

/*
  `chrome.runtime.requestUpdateCheck` answers a status, in both of Chrome's shapes, and never fails.

  Electron implements it natively and has no updater behind it: the callback got no arguments with
  lastError "Autoupdate is not enabled.", and the promise form REJECTED with that message. Chrome
  never fails this call — measured in Edge 156, an unpacked extension gets callback
  ('throttled', { version: '' }) and the promise { status: 'throttled', version: '' }.
  Grammarly 14.1342.0 calls it on every worker start without reading lastError, so every boot left an
  "Unchecked runtime.lastError" behind; a caller that awaits the promise would have had an unhandled
  rejection.

  An embedder ships extension updates itself, so the truthful status is 'no_update'. The test holds
  the shape and that nothing fails, not the particular status: 'throttled' would be as valid.
*/
describe('chrome.runtime.requestUpdateCheck', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  const STATUSES = ['no_update', 'throttled', 'update_available']

  it('answers the callback with a status and details, and no lastError', async () => {
    const { callback } = await browser.crx.raw({ type: 'request-update-check' })
    expect(callback.lastError, 'requestUpdateCheck set lastError').to.equal(null)
    expect(callback.status).to.be.oneOf(STATUSES)
    expect(callback.details).to.be.an('object').with.property('version').that.is.a('string')
  })

  it('resolves the promise with { status, version } instead of rejecting', async () => {
    const { promise } = await browser.crx.raw({ type: 'request-update-check' })
    expect(promise, 'requestUpdateCheck() rejected or threw').to.be.an('object')
    expect(promise.status).to.be.oneOf(STATUSES)
    expect(promise.version).to.be.a('string')
  })
})
