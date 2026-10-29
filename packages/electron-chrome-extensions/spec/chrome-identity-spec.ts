import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

/*
  The account half of chrome.identity, which only existed as `getRedirectURL` and
  `launchWebAuthFlow`. An extension built for a signed-in Google account (an enterprise agent, a
  Workspace add-on) calls `getAuthToken` and `getProfileUserInfo` at worker start, and a namespace
  without them threw there. Chrome's own answers in a browser with no account signed in are what is
  asserted here: nothing is pretended, there is simply no account.
*/
describe('chrome.identity', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  it('answers like a browser with no account signed in', async () => {
    const result = await browser.crx.raw({ type: 'identity-shapes' })
    expect(result.profile).to.deep.equal({ email: '', id: '' })
    expect(result.tokenPromise).to.equal('rejected: The user is not signed in.')
    expect(result.tokenCallback.token).to.equal('undefined')
    expect(result.tokenCallback.lastError).to.equal('The user is not signed in.')
    expect(result.accounts).to.deep.equal([])
    expect(result.cleared).to.equal('ok')
    expect(result.onSignInChanged).to.equal('function')
    expect(result.redirect).to.equal(`https://${browser.extension.id}.chromiumapp.org/done`)
    expect(result.accountStatus).to.deep.equal({ ANY: 'ANY', SYNC: 'SYNC' })
  })
})

/*
  The namespaces a worker reads at its top level and that a browser without their backend still
  defines: gcm (no GCM client here, so a registration fails the way Chrome's fails), proxy (the
  embedder owns the proxy, so the setting is one no extension controls) and the constants of
  storage.sync. Measured on 29/10/2026: Endpoint Verification died on `gcm.onMessage`, NordVPN got
  "Access to extension API denied." from `proxy.settings.get`, LanguageTool read
  `sync.MAX_ITEMS` as undefined.
*/
describe('platform namespaces a worker reads at start-up', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  it('gcm, proxy and the storage.sync constants answer in Chrome\'s shapes', async () => {
    const result = await browser.crx.raw({ type: 'platform-shapes' })
    expect(result.gcm.onMessage).to.equal('function')
    expect(result.gcm.maxSize).to.equal(4096)
    expect(result.gcm.register).to.equal('rejected: UNKNOWN_ERROR')
    expect(result.gcm.registerCallback).to.equal('UNKNOWN_ERROR')

    expect(result.proxy.get).to.deep.equal({
      value: { mode: 'system' },
      levelOfControl: 'not_controllable',
    })
    expect(result.proxy.set).to.equal('resolved')
    expect(result.proxy.after.value).to.deep.equal({ mode: 'system' })
    expect(result.proxy.onProxyError).to.equal('function')
    expect(result.proxy.mode).to.equal('system')

    expect(result.sync.maxItems).to.equal(512)
    expect(result.sync.perItem).to.equal(8192)
    expect(result.sync.quota).to.equal(102400)
    expect(result.sync.readBack).to.equal('via-sync')
    expect(result.sync.onChanged).to.equal('function')

    expect(result.events.onSignInChangedHasListener).to.equal('function')
    expect(result.events.privacyOnChangeHasListeners).to.equal('function')
  })
})
