import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

// Electron 42 implements chrome.declarativeNetRequest natively: dynamic and
// session rules store, retrieve, and ENFORCE with no library code. The one gap
// is that manifest static rulesets are parsed but left disabled (their
// `"enabled": true` flag is ignored at load) — the library's preload works
// around this by calling updateEnabledRulesets at service-worker startup.
//
// The `dnr` fixture declares a static ruleset (rules.json) that blocks any
// request whose URL contains "dnr-static-blocked".
describe('chrome.declarativeNetRequest', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'dnr' })

  const fetchResult = (pathMarker: string) =>
    browser.webContents.executeJavaScript(
      `fetch('${server.getUrl()}${pathMarker}').then(() => 'fetched', () => 'blocked')`,
    ) as Promise<'fetched' | 'blocked'>

  const getEnabledRulesets = () =>
    browser.crx.raw({ type: 'api', method: 'declarativeNetRequest.getEnabledRulesets', args: [] })

  describe('static rulesets (library startup-enable workaround)', () => {
    it('enables and enforces a manifest static ruleset without an explicit call', async () => {
      // The startup enable is fire-and-forget; wait for it to take effect.
      let enabled: string[] = []
      for (let i = 0; i < 40 && !enabled.includes('static_block'); i++) {
        enabled = await getEnabledRulesets()
        if (!enabled.includes('static_block')) await new Promise((r) => setTimeout(r, 50))
      }
      expect(enabled).to.include('static_block')

      expect(await fetchResult('dnr-static-blocked')).to.equal('blocked')
      expect(await fetchResult('dnr-static-allowed')).to.equal('fetched')
    })
  })

  describe('dynamic rules (native)', () => {
    it('stores, retrieves, and enforces a dynamic block rule', async () => {
      await browser.crx.raw({
        type: 'api',
        method: 'declarativeNetRequest.updateDynamicRules',
        args: [
          {
            addRules: [
              {
                id: 101,
                priority: 1,
                action: { type: 'block' },
                condition: { urlFilter: 'dnr-dynamic-blocked', resourceTypes: ['xmlhttprequest'] },
              },
            ],
          },
        ],
      })

      const stored = await browser.crx.raw({
        type: 'api',
        method: 'declarativeNetRequest.getDynamicRules',
        args: [],
      })
      expect(stored).to.be.an('array').with.lengthOf(1)
      expect(stored[0].id).to.equal(101)

      expect(await fetchResult('dnr-dynamic-blocked')).to.equal('blocked')
    })
  })

  describe('session rules (native)', () => {
    it('enforces a session block rule', async () => {
      await browser.crx.raw({
        type: 'api',
        method: 'declarativeNetRequest.updateSessionRules',
        args: [
          {
            addRules: [
              {
                id: 201,
                priority: 1,
                action: { type: 'block' },
                condition: { urlFilter: 'dnr-session-blocked', resourceTypes: ['xmlhttprequest'] },
              },
            ],
          },
        ],
      })

      expect(await fetchResult('dnr-session-blocked')).to.equal('blocked')
    })
  })
})
