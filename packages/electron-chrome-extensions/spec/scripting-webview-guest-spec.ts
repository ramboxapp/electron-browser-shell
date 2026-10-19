import { expect } from 'chai'
import { webContents } from 'electron'
import * as http from 'node:http'
import { AddressInfo } from 'node:net'

import { useExtensionBrowser } from './hooks'

/**
 * Running an extension's code inside a `<webview>` guest.
 *
 * This is the path almost everything a user notices goes through — a password manager filling a form,
 * a translator reading the selection, a blocker rewriting a page — and inside an embedder every page
 * a user browses is a guest, which is a different kind of webContents from the one
 * `webContents.create()` makes. chrome-scripting-spec covers the created kind; this covers the real
 * one, because the difference has already mattered: declarativeNetRequest treats a guest in another
 * partition as invisible (dnr-webview-guest-spec).
 *
 * Measured in Rambox against a live service webview before writing this: `tabs.query({ active: true
 * })` answered with the guest and `scripting.executeScript` came back with the page's real selection.
 * The spec keeps that honest from the library alone.
 */
describe('scripting in a <webview> guest', () => {
  let server: http.Server
  let url: string

  before(async () => {
    server = http.createServer((req, res) => {
      const requestUrl = req.url || ''
      res.writeHead(200, { 'Content-Type': 'text/html' })
      if (requestUrl.startsWith('/guest-host')) {
        // The guest must share the extension's partition, or it is a different session and the test
        // would prove nothing (that is exactly the trap dnr-webview-guest-spec pins down).
        const partition = new URL(requestUrl, url).searchParams.get('partition') || ''
        res.end(
          `<!doctype html><meta charset="utf-8"><title>host</title>` +
            `<webview id="guest" partition="${partition}" src="${url}guest-page" style="width:600px;height:400px"></webview>`,
        )
        return
      }
      res.end(
        '<!doctype html><meta charset="utf-8"><title>guest</title><b id="pick">pick me</b><p>other</p>',
      )
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

  // The partition is only known once the hook has created the session, and `url` is called after
  // that, so reading it off the returned object inside the closure is what makes this work.
  let browserRef: ReturnType<typeof useExtensionBrowser>
  const browser = useExtensionBrowser({
    url: () => `${url}guest-host?partition=${encodeURIComponent(browserRef.partition)}`,
    extensionName: 'rpc-mv3',
    webPreferences: { webviewTag: true },
  })
  browserRef = browser

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

  it('injects a file into the guest', async () => {
    const guest = await guestContents()
    browser.extensions.addTab(guest, browser.window)
    browser.extensions.selectTab(guest)

    // Tab ids are webContents ids, which is what an extension gets back from tabs.query.
    await browser.crx.exec('scripting.executeScript', {
      target: { tabId: guest.id },
      files: ['injected.js'],
    })

    expect(await guest.executeJavaScript('document.title')).to.equal('injected')
  })

  it('reads the guest page back through a function result', async () => {
    const guest = await guestContents()
    browser.extensions.addTab(guest, browser.window)
    browser.extensions.selectTab(guest)

    // A real selection in the guest, the way a user makes one before asking for a translation. The
    // injected file reports it back through the title, since exec() cannot serialize a function.
    await guest.executeJavaScript(
      `(function(){const node=document.getElementById('pick');const range=document.createRange();` +
        `range.selectNodeContents(node);const selection=window.getSelection();selection.removeAllRanges();` +
        `selection.addRange(range);return String(selection)})()`,
    )
    expect(await guest.executeJavaScript('String(window.getSelection())')).to.equal('pick me')

    await browser.crx.exec('scripting.executeScript', {
      target: { tabId: guest.id },
      files: ['report-selection.js'],
    })

    expect(
      await guest.executeJavaScript('document.title'),
      'the injected script read the selection',
    ).to.equal('selection:pick me')
  })
})
