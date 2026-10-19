import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

/**
 * The two ways an extension runs code off its main thread, and whether either works here.
 *
 * This came from a hunch that extensions break in Electron for want of worker support, and it is
 * worth a spec either way: both are on the boot path of real extensions and nothing covered them.
 *
 *  - `importScripts` during a service worker's initial evaluation, which is the only moment a
 *    service worker allows it. Dashlane loads its argon2, libsodium and opaque modules exactly this
 *    way, inside a `try` that swallows any failure — so a break here looks like an extension that
 *    starts, answers messages and quietly does nothing.
 *  - a dedicated `Worker` from a content script, pointed at a web-accessible file of the extension.
 *    Dashlane's zip and crypto vendors create those.
 *
 * The second one FAILS, and that is correct: a worker script must be same-origin with the document,
 * and a content script runs with the page's origin. Verified against a real Chromium with this same
 * fixture, which refuses it with the identical message. The test pins that down rather than wishing
 * otherwise, because "make it work" here would mean diverging from Chrome.
 *
 * A service worker cannot create a nested Worker in Chrome either, so that combination is not
 * tested: it is supposed to fail.
 */
describe('worker support', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  it('runs importScripts during the service worker initial evaluation', async () => {
    const result: any = await browser.crx.raw({ type: 'import-scripts' })
    expect(result.result, `importScripts said: ${result.result}`).to.equal('loaded')
    expect(result.chunk).to.equal('string')
  })

  it('refuses a content script a Worker from an extension file, as Chrome does', async () => {
    const result: any = await browser.crx.raw({ type: 'content-script-worker' })
    expect(result.ok, 'this used to be expected to work; Chrome refuses it too').to.be.false
    // Same wording as Chromium's: an extension URL is not the page's origin.
    expect(result.error).to.contain('cannot be accessed from origin')
  })
})
