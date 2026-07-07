import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.alarms', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })

  describe('create()', () => {
    it('creates an alarm retrievable by get()', async () => {
      await browser.crx.exec('alarms.create', 'test-alarm', { delayInMinutes: 1 })
      const alarm = await browser.crx.exec('alarms.get', 'test-alarm')
      expect(alarm).to.be.an('object')
      expect(alarm.name).to.equal('test-alarm')
      expect(alarm.scheduledTime).to.be.a('number')
    })

    it('replaces an existing alarm of the same name', async () => {
      await browser.crx.exec('alarms.create', 'dupe', { delayInMinutes: 1 })
      await browser.crx.exec('alarms.create', 'dupe', { delayInMinutes: 2 })
      const alarms = await browser.crx.exec('alarms.getAll')
      expect(alarms).to.have.lengthOf(1)
    })

    it('fires onAlarm', async () => {
      await browser.crx.exec('alarms.create', 'quick-alarm', { delayInMinutes: 0.01 })
      const [alarm] = await browser.crx.eventOnce('alarms.onAlarm')
      expect(alarm.name).to.equal('quick-alarm')
    })
  })

  describe('getAll()', () => {
    it('returns all alarms for the extension', async () => {
      await browser.crx.exec('alarms.create', 'one', { delayInMinutes: 1 })
      await browser.crx.exec('alarms.create', 'two', { delayInMinutes: 1 })
      const alarms = await browser.crx.exec('alarms.getAll')
      expect(alarms.map((alarm: any) => alarm.name)).to.have.members(['one', 'two'])
    })
  })

  describe('clear()', () => {
    it('clears an alarm by name', async () => {
      await browser.crx.exec('alarms.create', 'to-clear', { delayInMinutes: 1 })
      const cleared = await browser.crx.exec('alarms.clear', 'to-clear')
      expect(cleared).to.be.true
      const alarm = await browser.crx.exec('alarms.get', 'to-clear')
      // undefined becomes null when serialized through the messaging channel
      expect(alarm).to.not.exist
    })

    it('returns false for unknown alarms', async () => {
      const cleared = await browser.crx.exec('alarms.clear', 'unknown')
      expect(cleared).to.be.false
    })
  })

  describe('clearAll()', () => {
    it('clears all alarms', async () => {
      await browser.crx.exec('alarms.create', 'one', { delayInMinutes: 1 })
      await browser.crx.exec('alarms.create', 'two', { delayInMinutes: 1 })
      const cleared = await browser.crx.exec('alarms.clearAll')
      expect(cleared).to.be.true
      const alarms = await browser.crx.exec('alarms.getAll')
      expect(alarms).to.be.empty
    })
  })
})
