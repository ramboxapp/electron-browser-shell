import { expect } from 'chai'
import { BrowserWindow, webContents } from 'electron'
import * as http from 'node:http'
import * as path from 'node:path'
import { AddressInfo } from 'node:net'

import { createCrxSession } from './crx-helpers'
import { ElectronChromeExtensions } from '../'

/**
 * Whether declarativeNetRequest filters requests made by a `<webview>` guest.
 *
 * It does — as long as the guest runs in the SAME partition as the extension. That qualifier is the
 * whole content of this spec, because it is the difference between a blocker that works in an embedder
 * and one that is silently inert: a `<webview>` with no `partition` attribute, or one pointed at a
 * partition the extension was not loaded into, is not filtered at all. The rules load, report
 * themselves enabled, and never see the request.
 *
 * Written while chasing uBlock 25.5.0 blocking nothing in Rambox. A first measurement in the app
 * looked like "guests are never filtered" and that was wrong twice over: the guest under test ran in
 * the default session, and the embedder-page comparison it was measured against was a cross-origin
 * fetch failing CORS, not a block. Hence this spec, which pins both halves so the mistake is not
 * repeatable.
 */
describe('declarativeNetRequest and <webview> guests', () => {
  const fixtures = path.join(__dirname, 'fixtures')
  let server: http.Server
  let url: string
  let win: BrowserWindow
  let customSession: Electron.Session
  /** The guest has to run in the SAME partition as the extension, or the test proves nothing. */
  let partition: string

  before(async () => {
    server = http.createServer((req, res) => {
      const requestUrl = req.url || ''
      if (requestUrl.includes('guest-host-default-partition')) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          `<!doctype html><meta charset="utf-8"><title>guest host (default partition)</title>` +
            `<webview id="guest" src="${url}guest-page" style="width:600px;height:400px"></webview>`,
        )
        return
      }
      if (requestUrl.includes('guest-host')) {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(
          `<!doctype html><meta charset="utf-8"><title>guest host</title>` +
            `<webview id="guest" partition="${partition}" src="${url}guest-page" style="width:600px;height:400px"></webview>`,
        )
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html><title>guest</title>ok')
    })
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
        resolve()
      }),
    )
  })

  after(() => {
    server.close()
  })

  beforeEach(async () => {
    const sessionDetails = createCrxSession()
    customSession = sessionDetails.session
    partition = sessionDetails.partition
    new ElectronChromeExtensions({
      license: 'internal-license-do-not-use' as any,
      session: customSession,
      async createTab() {
        const tab = (webContents as any).create({ session: customSession })
        return [tab, win] as [Electron.WebContents, Electron.BrowserWindow]
      },
    })

    // The dnr fixture declares a static ruleset that blocks any URL containing "dnr-static-blocked",
    // and the library's preload enables it at service-worker startup.
    await customSession.loadExtension(path.join(fixtures, 'dnr'))

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: customSession,
        // The whole point: a real guest, not a webContents standing in for one.
        webviewTag: true,
        nodeIntegration: false,
        contextIsolation: true,
      },
    })
    await win.loadURL(`${url}guest-host`)
  })

  afterEach(() => {
    if (win && !win.isDestroyed()) win.destroy()
  })

  const guestContents = async (): Promise<Electron.WebContents> => {
    for (let i = 0; i < 80; i++) {
      const guest = webContents
        .getAllWebContents()
        .find(
          (wc) =>
            !wc.isDestroyed() && wc.getType() === 'webview' && wc.getURL().includes('guest-page'),
        )
      if (guest) return guest
      await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error('the <webview> guest never attached')
  }

  const fetchFrom = (wc: Electron.WebContents) =>
    wc.executeJavaScript(
      `fetch('${url}dnr-static-blocked').then(() => 'fetched', () => 'blocked')`,
    ) as Promise<'fetched' | 'blocked'>

  /** The rule is live once the embedder's own page is blocked by it; the startup enable is async. */
  const waitForRule = async () => {
    for (let i = 0; i < 80; i++) {
      if ((await fetchFrom(win.webContents)) === 'blocked') return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  it('filters a guest that shares the extension partition', async () => {
    const guest = await guestContents()
    expect(guest.getType(), 'the guest is a real webview webContents').to.equal('webview')

    expect(await waitForRule(), 'the static ruleset never took effect for the embedder').to.be.true

    const fromGuest = await fetchFrom(guest)
    console.log(`[dnr-guest] same partition: embedder=blocked guest=${fromGuest}`)
    expect(fromGuest, 'a guest in the extension partition must be filtered').to.equal('blocked')
  })

  it('does not filter a guest in another partition, and says nothing about it', async () => {
    // No `partition` attribute: the guest runs in the default session, where nothing is loaded. This
    // is the trap — the extension still reports its ruleset as enabled, and the page is wide open.
    await win.loadURL(`${url}guest-host-default-partition`)
    const guest = await guestContents()
    expect(guest.getType()).to.equal('webview')

    expect(await waitForRule(), 'the static ruleset never took effect for the embedder').to.be.true
    expect(
      await fetchFrom(guest),
      'a guest outside the extension partition is unfiltered',
    ).to.equal('fetched')
  })
})
