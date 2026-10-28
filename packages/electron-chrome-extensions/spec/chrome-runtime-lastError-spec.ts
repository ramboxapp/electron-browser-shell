import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

/*
  `chrome.runtime.lastError` reaches the extension, and so do the errors of a native port.

  The preload replaces `chrome.runtime` with `{ ...base, ... }`. Chromium defines `lastError` on ITS
  runtime object only while one of its callbacks runs, so the spread never carried it, and on the
  replacement `chrome.runtime.lastError` was always undefined: a failed callback-style call read as
  a success. Chromium, whose getter was never reached, also logged "Unchecked runtime.lastError" for
  every caller that did check — RoboForm 10.0.2.0 left 11 to 18 "Could not establish connection.
  Receiving end does not exist." per boot that way, one per broadcast to a popup that was not open.

  The native port is the preload's own JavaScript, so it gets lastError from the preload. Measured in
  Edge 156 against a host that is not installed: onDisconnect is called with the port and lastError
  "Specified native messaging host not found."; a port's own disconnect() does not fire it.
*/
describe('chrome.runtime.lastError', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  it('is readable inside a callback Chromium failed, and cleared after it', async () => {
    const result = await browser.crx.raw({ type: 'last-error-in-callback' })
    expect(result.lastError, 'runtime.lastError inside the failed callback').to.be.a('string')
    expect(result.lastError).to.match(/Receiving end does not exist/)
    expect(result.afterCallback).to.equal('undefined')
  })

  describe('a native port to a host that is not installed', () => {
    it('calls onDisconnect with the port, with lastError set', async () => {
      const result = await browser.crx.raw({ type: 'native-port-missing-host' })
      expect(result.timedOut, 'onDisconnect never fired').to.not.equal(true)
      expect(result.argIsPort, 'onDisconnect was not called with the port').to.equal(true)
      expect(result.lastError).to.equal('Specified native messaging host not found.')
    })

    it('does not fire onDisconnect for its own disconnect()', async () => {
      const result = await browser.crx.raw({ type: 'native-port-own-disconnect' })
      expect(result.fired).to.equal(false)
    })
  })
})
