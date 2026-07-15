import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

// Regression coverage for the ExtensionEvent methods that don't relate to a
// specific chrome.* namespace: hasListener/hasListeners/getRules/addRules/
// removeRules. Chrome never throws for these, even for events that don't
// support declarative rules — an extension (1Password, 2026-07-09) crashed
// on an uncaught "Method not implemented." from one of these, aborting an
// async flow that included its first-run notification toast.
describe('chrome.events.Event', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })

  describe('hasListener()', () => {
    it('does not throw and returns a boolean', async () => {
      const { ok, result } = await browser.crx.eventMethod('tabs.onUpdated', 'hasListener', null)
      expect(ok).to.be.true
      expect(result).to.be.a('boolean')
    })
  })

  describe('hasListeners()', () => {
    it('does not throw and returns a boolean', async () => {
      const { ok, result } = await browser.crx.eventMethod('tabs.onUpdated', 'hasListeners')
      expect(ok).to.be.true
      expect(result).to.be.a('boolean')
    })
  })

  describe('getRules()', () => {
    it('does not throw when called without a callback', async () => {
      const { ok } = await browser.crx.eventMethod('tabs.onUpdated', 'getRules')
      expect(ok).to.be.true
    })
  })

  describe('addRules()', () => {
    it('does not throw when called with an empty rule set', async () => {
      const { ok } = await browser.crx.eventMethod('tabs.onUpdated', 'addRules', [])
      expect(ok).to.be.true
    })
  })

  describe('removeRules()', () => {
    it('does not throw when called without arguments', async () => {
      const { ok } = await browser.crx.eventMethod('tabs.onUpdated', 'removeRules')
      expect(ok).to.be.true
    })
  })
})
