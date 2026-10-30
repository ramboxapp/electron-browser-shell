import { expect } from 'chai'
import { AddressInfo } from 'node:net'

import { useExtensionBrowser, useServer } from './hooks'

// ws is a transitive dependency hoisted to the repo root; require() sidesteps
// the ws@7 (runtime) vs @types/ws@8 named-export skew.
const WebSocketServer = require('ws').Server

/*
  The browser's own WebSocket, in an MV3 service worker.

  The library used to replace it there with a proxy that opened the socket in the main process,
  after a measurement of 11/07/2026 read "a WebSocket from a worker fails for every host but
  capi.grammarly.com" as an Electron bug. Measured again on 30/10/2026 with a bare main process (no
  library) on Electron 43.0.0, 44.9.3+wvcus and 44.10.0: the native WebSocket connects from an MV3
  worker, to a local ws:// server and to a public wss:// one, and exchanges text and binary frames.
  The one host that worked then is the only WebSocket host in Grammarly's own `connect-src`, and that
  was the cause: in Rambox on 44.9.3+wvcus, with the proxy gone, Grammarly's worker opens
  wss://capi.grammarly.com and fails wss://ws.postman-echo.com with a `securitypolicyviolation` for
  `connect-src` — its CSP doing what Chrome's does. The proxy went, and with it a socket that
  skipped the extension's CSP.

  This is the scenario the proxy existed for; it has to pass with the native constructor.
*/
describe('WebSocket in an MV3 service worker', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  let wss: any
  let wsUrl: string

  beforeEach(async () => {
    wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await new Promise<void>((resolve) => wss.once('listening', resolve))
    wsUrl = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`

    wss.on('connection', (socket: any) => {
      // Unsolicited text frame on connect — tests inbound text delivery.
      socket.send('server-text')
      socket.on('message', (data: any) => {
        const str = Buffer.isBuffer(data) ? data.toString() : String(data)
        // On request, reply with a binary frame — tests inbound binary.
        if (str === 'want-binary') socket.send(Buffer.from([1, 2, 3]), { binary: true })
      })
    })
  })

  afterEach(() => {
    wss?.close()
  })

  it('is the native constructor, and connects, exchanges text + binary frames, and closes', async () => {
    const got: string[] = await browser.crx.raw({ type: 'websocket-test', url: wsUrl })

    expect(got[0], 'the worker keeps the browser WebSocket').to.equal('native')
    expect(got, 'onopen fired').to.include('open')
    expect(got, 'received the server text frame').to.include('text:server-text')
    expect(
      got.some((entry) => entry.startsWith('binary:1,2,3')),
      'received the binary frame intact',
    ).to.be.true
    expect(
      got.some((entry) => entry.startsWith('close:3001:true')),
      'closed cleanly with the extension-supplied code',
    ).to.be.true
  })
})
