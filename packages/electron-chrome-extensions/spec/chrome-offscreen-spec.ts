import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.offscreen', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  it('creates, detects and closes an offscreen document', async () => {
    let hasDocument = await browser.crx.exec('offscreen.hasDocument')
    expect(hasDocument).to.be.false

    await browser.crx.exec('offscreen.createDocument', {
      url: 'offscreen.html',
      reasons: ['TESTING'],
      justification: 'spec',
    })

    hasDocument = await browser.crx.exec('offscreen.hasDocument')
    expect(hasDocument).to.be.true

    await browser.crx.exec('offscreen.closeDocument')

    hasDocument = await browser.crx.exec('offscreen.hasDocument')
    expect(hasDocument).to.be.false
  })

  it("keeps the calling service worker alive for the offscreen document's lifetime", async () => {
    // ServiceWorkerMain is type-only in Electron's ambient types — there's no
    // importable class to patch, and no spy library in devDependencies. Get a
    // real instance for this extension's own service worker (all instances
    // share one prototype) and patch that instead.
    //
    // A round-trip through the already-established message channel first
    // (rather than calling startWorkerForScope() directly) avoids racing the
    // fixture's own SW registration right after useExtensionBrowser's setup,
    // which intermittently throws 'Failed to start service worker.'
    await browser.crx.exec('offscreen.hasDocument')

    const scope = `chrome-extension://${browser.extension.id}/`
    const running = browser.session.serviceWorkers.getAllRunning()
    const versionId = Object.keys(running).find((id) => (running as any)[id].scope === scope)
    if (!versionId) throw new Error(`expected a running service worker for ${scope}`)
    const worker = browser.session.serviceWorkers.getWorkerFromVersionID(Number(versionId))
    if (!worker) throw new Error(`getWorkerFromVersionID(${versionId}) returned undefined`)
    const proto = Object.getPrototypeOf(worker)

    const original = proto.startTask
    const calls: { ended: boolean }[] = []
    proto.startTask = function () {
      const record = { ended: false }
      calls.push(record)
      return { end: () => { record.ended = true } }
    }

    try {
      await browser.crx.exec('offscreen.createDocument', {
        url: 'offscreen.html',
        reasons: ['TESTING'],
        justification: 'spec',
      })

      expect(calls, 'startTask() call on createDocument').to.have.lengthOf(1)
      expect(calls[0].ended, 'task ended before the document was closed').to.be.false

      await browser.crx.exec('offscreen.closeDocument')

      expect(calls[0].ended, 'task ended after the document was closed').to.be.true
    } finally {
      proto.startTask = original
    }
  })

  it('completes a service-worker to offscreen-document message round trip', async () => {
    await browser.crx.exec('offscreen.createDocument', {
      url: 'offscreen.html',
      reasons: ['TESTING'],
      justification: 'spec',
    })

    // Regression test for the actual interaction pattern that used to hang
    // forever: a real MV3 service worker awaiting a chrome.runtime.sendMessage
    // reply from the offscreen document it just created (see offscreen.ts).
    const response = await browser.crx.exec('runtime.sendMessage', {
      type: 'offscreen-echo',
      payload: 'ping',
    })

    expect(response).to.deep.equal({ echoed: 'ping' })

    await browser.crx.exec('offscreen.closeDocument')
  })
})
