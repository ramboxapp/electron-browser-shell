import { expect } from 'chai'
import { screen } from 'electron'

import { useExtensionBrowser, useServer } from './hooks'

/*
  chrome.system: storage and display answered from the main process, cpu and memory left to
  Electron. Electron's own `system.storage.getInfo()` crashes the process (0xC0000005, measured on
  43.0.0 and 44.9.3+wvcus), so the first assertion here is that the call comes back at all.
*/
describe('chrome.system', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'floor-mv3' })

  const exec = (method: string, ...args: any[]) => browser.crx.raw({ type: 'api', method, args })

  it('storage.getInfo() answers the profile’s volume instead of crashing', async () => {
    const result: any = await exec('system.storage.getInfo')
    expect(result.ok).to.equal(true)
    expect(result.value).to.have.length(1)
    const [unit] = result.value
    expect(unit.type).to.equal('fixed')
    expect(unit.capacity).to.be.greaterThan(0)

    const capacity: any = await exec('system.storage.getAvailableCapacity', unit.id)
    expect(capacity.value.id).to.equal(unit.id)
    expect(capacity.value.availableCapacity).to.be.greaterThan(0)

    expect((await exec('system.storage.ejectDevice', unit.id)).value).to.equal('in_use')
    expect((await exec('system.storage.ejectDevice', 'nope')).value).to.equal('no_such_device')
  })

  it('display.getInfo() lists the screens Electron sees, one of them primary', async () => {
    const result: any = await exec('system.display.getInfo')
    expect(result.ok).to.equal(true)
    expect(result.value).to.have.length(screen.getAllDisplays().length)
    expect(result.value.filter((d: any) => d.isPrimary)).to.have.length(1)
    const primary = result.value.find((d: any) => d.isPrimary)
    expect(primary.id).to.equal(String(screen.getPrimaryDisplay().id))
    expect(primary.bounds).to.have.keys('left', 'top', 'width', 'height')
  })

  it('answers the ChromeOS-only methods as desktop Chrome does', async () => {
    expect(await exec('system.display.getDisplayLayout')).to.deep.equal({
      ok: false,
      error: 'Function available only on ChromeOS.',
    })
  })

  it('fires display.onDisplayChanged when the screen configuration changes', async () => {
    const fired = browser.crx.raw({ type: 'await-event', name: 'system.display.onDisplayChanged' })
    // The listener has to be registered before the change; give the round trip a moment.
    await new Promise((resolve) => setTimeout(resolve, 300))
    screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['bounds'])
    expect(await fired).to.include({ fired: true })
  })

  it('keeps Electron’s own cpu and memory', async () => {
    const cpu: any = await exec('system.cpu.getInfo')
    expect(cpu.value.numOfProcessors).to.be.greaterThan(0)
    const memory: any = await exec('system.memory.getInfo')
    expect(memory.value.capacity).to.be.greaterThan(0)
  })
})
