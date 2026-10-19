import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

/**
 * `chrome.storage.managed`: the administrator's policy store.
 *
 * It used to alias `chrome.storage.local`, with a `TODO` for a real backend. That is worse than
 * empty in two ways, and both were measured in Rambox with the real Grammarly extension.
 *
 * It reported an extension's own data as administrator policy — `managed.get(null)` came back
 * holding Grammarly's alarms, its cached config and the active tab's URL. Password managers read
 * this area for vault policy.
 *
 * And it answered from the main process. Grammarly reads three policy keys while its service worker
 * starts and races each against a 3s timeout; under the load of twenty extensions booting, the reply
 * lost that race on every launch (`Manage storage timeout to get "GrammarlyExtensionMode"`, three
 * times per start). With the worker's loop blocked past the deadline the IPC answer never arrives at
 * all and the timer wins — so the area now answers in a microtask and never leaves the renderer.
 *
 * Empty is not a stub standing in for a backend: it is what Chrome answers on a machine with no
 * policy installed, which is every machine Electron runs on.
 */
describe('chrome.storage.managed', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  // The probe runs inside the worker, because `managed.get` is three levels deep and the fixture's
  // generic `api` call can only address `namespace.method`. Per test, not once: the harness builds a
  // fresh browser for each one, so a single `before` would run with no window to talk to.
  let probe: any
  beforeEach(async () => {
    probe = await browser.crx.raw({ type: 'managed-storage' })
  })

  it('answers a policy read with nothing, the way Chrome does unmanaged', () => {
    expect(probe.getKey).to.deep.equal({})
  })

  it('returns the defaults the caller passed, overriding none of them', () => {
    expect(probe.getDefaults).to.deep.equal({ PolicyKey: 'fallback' })
  })

  it("does not report the extension's own local data as policy", () => {
    // The fixture wrote `managedLeakProbe` into local immediately before asking.
    expect(probe.getAll).to.deep.equal({})
    expect(Object.keys(probe.getAll)).to.not.include('managedLeakProbe')
    expect(probe.getKeys).to.deep.equal([])
    expect(probe.bytesInUse).to.equal(0)
  })

  it('refuses a write, as a read-only store', () => {
    expect(probe.setRejection, 'set() resolved instead of rejecting').to.be.a('string')
    expect(probe.setRejection).to.contain('read-only')
    expect(probe.afterWrite, 'the write landed somewhere').to.deep.equal({})
  })

  it('answers even when the worker blocked past the deadline its caller set', () => {
    // The regression itself. 'timer' here is Grammarly's "Manage storage timeout".
    expect(probe.beatsTimer).to.equal('answer')
  })
})
