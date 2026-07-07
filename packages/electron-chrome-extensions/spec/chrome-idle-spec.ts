import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.idle', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })

  describe('queryState()', () => {
    it('returns a valid idle state', async () => {
      const state = await browser.crx.exec('idle.queryState', 15)
      expect(['active', 'idle', 'locked']).to.include(state)
    })
  })

  describe('setDetectionInterval()', () => {
    it('accepts an interval without throwing', async () => {
      await browser.crx.exec('idle.setDetectionInterval', 30)
    })
  })

  describe('getAutoLockDelay()', () => {
    it('returns 0 on desktop platforms', async () => {
      const delay = await browser.crx.exec('idle.getAutoLockDelay')
      expect(delay).to.equal(0)
    })
  })
})
