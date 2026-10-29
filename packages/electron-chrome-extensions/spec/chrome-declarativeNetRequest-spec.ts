import { expect } from 'chai'
import { webContents } from 'electron'

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
      for (let i = 0; i < 200 && !enabled.includes('static_block'); i++) {
        enabled = await getEnabledRulesets()
        if (!enabled.includes('static_block')) await new Promise((r) => setTimeout(r, 50))
      }
      expect(enabled).to.include('static_block')

      expect(await fetchResult('dnr-static-blocked')).to.equal('blocked')
      expect(await fetchResult('dnr-static-allowed')).to.equal('fetched')
    })
  })

  describe('dynamic rules (native)', () => {
    /*
      The rule has to be there again after the extension is unloaded and loaded back, which is what
      the persisted dynamic ruleset exists for. This covers the reload path inside one process. It
      does NOT reproduce the launch race this fixture is too small to trigger: on Electron 44, with
      uBlock's three static rulesets, the library's unconditional start-up `updateEnabledRulesets`
      wiped the persisted dynamic ruleset on every launch after the first and left updateDynamicRules
      failing with "Internal error while updating dynamic rules." — only the bench's first-launch /
      second-launch control shows that (docs/EXTENSION_CATALOG_HEALTH.md in the Rambox monorepo).
    */
    it('keeps a dynamic rule across an unload and a reload of the extension', async function () {
      this.timeout(20e3)
      await browser.crx.raw({
        type: 'api',
        method: 'declarativeNetRequest.updateDynamicRules',
        args: [
          {
            addRules: [
              {
                id: 202,
                priority: 1,
                action: { type: 'block' },
                condition: { urlFilter: 'dnr-dynamic-survives', resourceTypes: ['xmlhttprequest'] },
              },
            ],
          },
        ],
      })
      // Let the write of the persisted ruleset land before the extension goes.
      await new Promise((resolve) => setTimeout(resolve, 1000))

      const extensionPath = browser.extension.path
      browser.session.extensions.removeExtension(browser.extension.id)
      await new Promise((resolve) => setTimeout(resolve, 500))
      const reloaded = await browser.session.extensions.loadExtension(extensionPath)
      expect(reloaded.id).to.equal(browser.extension.id)
      await browser.webContents.loadURL(server.getUrl())

      // The persisted rule is back, and another one can still be added after it.
      let stored: any[] = []
      for (let i = 0; i < 40 && !stored.some((rule) => rule.id === 202); i++) {
        stored = await browser.crx.raw({
          type: 'api',
          method: 'declarativeNetRequest.getDynamicRules',
          args: [],
        })
        if (!stored.some((rule) => rule.id === 202)) await new Promise((r) => setTimeout(r, 100))
      }
      expect(
        stored.map((rule) => rule.id),
        'the persisted dynamic rule survived the reload',
      ).to.include(202)
      await browser.crx.raw({
        type: 'api',
        method: 'declarativeNetRequest.updateDynamicRules',
        args: [
          {
            addRules: [
              { id: 203, priority: 1, action: { type: 'block' }, condition: { urlFilter: 'dnr-dynamic-after' } },
            ],
          },
        ],
      })
      const after = await browser.crx.raw({
        type: 'api',
        method: 'declarativeNetRequest.getDynamicRules',
        args: [],
      })
      expect(after.map((rule: any) => rule.id), 'an update after the reload').to.include.members([
        202, 203,
      ])
      expect(await fetchResult('dnr-dynamic-survives')).to.equal('blocked')
    })

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

  /*
    The same static ruleset, from a webContents that is NOT a window's own — which is what a tab is in
    an embedder like Rambox: a <webview>/offscreen webContents registered through addTab(). uBlock
    25.5.0 reports its three manifest rulesets as enabled in Rambox and blocks nothing at all there,
    while the window-level spec above passes, so the question is whether Chromium's DNR engine filters
    requests from this kind of webContents too.
  */
  describe('static rulesets from a tab webContents (the <webview> case)', () => {
    it('enforces the ruleset for a webContents registered with addTab', async () => {
      let enabled: string[] = []
      for (let i = 0; i < 200 && !enabled.includes('static_block'); i++) {
        enabled = await getEnabledRulesets()
        if (!enabled.includes('static_block')) await new Promise((r) => setTimeout(r, 50))
      }
      expect(enabled).to.include('static_block')

      // Same session as the extension host, or addTab rejects it outright.
      const tab = (webContents as any).create({ sandbox: true, session: browser.session })
      browser.extensions.addTab(tab, browser.window)
      browser.extensions.selectTab(tab)
      await tab.loadURL(server.getUrl())

      const fetchFromTab = (marker: string) =>
        tab.executeJavaScript(
          `fetch('${server.getUrl()}${marker}').then(() => 'fetched', () => 'blocked')`,
        ) as Promise<'fetched' | 'blocked'>

      try {
        expect(await fetchFromTab('dnr-static-blocked')).to.equal('blocked')
        expect(await fetchFromTab('dnr-static-allowed')).to.equal('fetched')
      } finally {
        if (!tab.isDestroyed()) tab.destroy()
      }
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
