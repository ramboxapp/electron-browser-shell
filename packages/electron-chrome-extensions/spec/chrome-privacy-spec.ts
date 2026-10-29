import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

/*
  `chrome.privacy`'s settings have to answer, even though nothing here can change them.

  Every one of its `get`/`set`/`clear` used to return `undefined`. An extension that writes
  `chrome.privacy.services.passwordSavingEnabled.get({}).then(…)` then gets a TypeError for reading
  'then' of undefined — and when the call sits in a comma-sequenced run of start-up calls, as it does
  in NordPass 7.11.9, that throw takes the whole background init down with it: the extension's state
  machine never leaves LOADING, its UI shows a loading spinner forever, and clicking its toolbar icon
  does nothing. There was nothing in the console either way; the diagnosis came from a stock
  Chromium, where the same call answers `{ value: false, levelOfControl: 'not_controllable' }`.

  So the assertions below are about the shape of the answer, not about controlling a preference:
  these are Chrome profile settings and Electron exposes no way to read or write them.
  `not_controllable` is the truthful level for that, and an extension that checks the level before
  writing leaves the setting alone instead of fighting a write that goes nowhere.
*/
describe('chrome.privacy', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  // Every setting Chrome 156 lists (read from Edge). Ten of them were missing until 2026-10-29, and a
  // `.get` on a missing one threw — NordPass's failure, one level down.
  const settings = [
    'privacy.services.alternateErrorPagesEnabled',
    'privacy.services.autofillAddressEnabled',
    'privacy.services.autofillCreditCardEnabled',
    'privacy.services.autofillEnabled',
    'privacy.services.autofillSettings',
    'privacy.services.passwordSavingEnabled',
    'privacy.services.safeBrowsingEnabled',
    'privacy.services.safeBrowsingExtendedReportingEnabled',
    'privacy.services.searchSuggestEnabled',
    'privacy.services.spellingServiceEnabled',
    'privacy.services.translationServiceEnabled',
    'privacy.network.networkPredictionEnabled',
    'privacy.websites.adMeasurementEnabled',
    'privacy.websites.doNotTrackEnabled',
    'privacy.websites.fledgeEnabled',
    'privacy.websites.hyperlinkAuditingEnabled',
    'privacy.websites.protectedContentEnabled',
    'privacy.websites.referrersEnabled',
    'privacy.websites.thirdPartyCookiesAllowed',
    'privacy.websites.topicsEnabled',
  ]

  for (const setting of settings) {
    it(`${setting}.get() resolves with a value and a level of control`, async () => {
      const details: any = await browser.crx.exec(`${setting}.get`, {})
      expect(details, `${setting}.get() answered nothing`).to.be.an('object')
      expect(details).to.have.property('value')
      expect(details.levelOfControl).to.equal('not_controllable')
    })
  }

  it('reports the string policy, not a boolean, for webRTCIPHandlingPolicy', async () => {
    const details: any = await browser.crx.exec('privacy.network.webRTCIPHandlingPolicy.get', {})
    expect(details.value).to.be.a('string')
    expect(details.levelOfControl).to.equal('not_controllable')
  })

  it('set() and clear() resolve instead of returning undefined', async () => {
    // The return value is what matters: an extension chains onto these, and `undefined` is what
    // used to break the caller.
    const afterSet = await browser.crx.exec('privacy.services.passwordSavingEnabled.set', {
      value: false,
    })
    expect(afterSet, 'set() rejected or never settled').to.be.oneOf([undefined, null])

    const afterClear = await browser.crx.exec('privacy.services.passwordSavingEnabled.clear', {})
    expect(afterClear, 'clear() rejected or never settled').to.be.oneOf([undefined, null])
  })

  it('is shaped like a ChromeSetting, onChange included', async () => {
    const shape: any = await browser.crx.raw({ type: 'privacy-setting-shape' })
    expect(shape).to.deep.equal({
      get: 'function',
      set: 'function',
      clear: 'function',
      // Never fires, but an extension that adds a listener on start-up removes it on teardown.
      addListener: 'function',
      removeListener: 'function',
      hasListener: 'function',
      getReturnsPromise: true,
    })
  })
})
