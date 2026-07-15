import { expect } from 'chai'
import { AddressInfo } from 'node:net'

import { useExtensionBrowser, useServer } from './hooks'

// ws is a transitive dependency hoisted to the repo root; require() sidesteps
// the ws@7 (runtime) vs @types/ws@8 named-export skew.
const WebSocketServer = require('ws').Server

// Native WebSocket fails to connect from an MV3 service worker in this Electron
// (docs/EXTENSIONS_API_MANUAL_TEST.md §9 Bug #2). The library replaces it with
// a proxy that opens the real socket in the main process. This spec runs the
// exact scenario that fails without the proxy — a green run proves the fix.
describe('WebSocket proxy (MV3 service worker)', () => {
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

  it('connects, exchanges text + binary frames, and closes', async () => {
    const got: string[] = await browser.crx.raw({ type: 'websocket-test', url: wsUrl })

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
