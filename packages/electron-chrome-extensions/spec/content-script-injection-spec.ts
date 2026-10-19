import { expect } from 'chai'
import * as http from 'node:http'
import { AddressInfo } from 'node:net'

import { webContents } from 'electron'

import { useExtensionBrowser } from './hooks'

/**
 * Whether a manifest content script runs, and whether it can reach its own background.
 *
 * Measured in Rambox with four password managers loaded in one session and a login page open: only
 * Keeper left any trace on the page at all. Dashlane, LastPass and 1Password marked no field,
 * injected no element and filled nothing, while their service workers were healthy and their vaults
 * unlocked — Dashlane's popup even listed the saved credential for that very site.
 *
 * "The content script never ran" and "it ran and could not reach its background" look identical from
 * the page, so this pins both down separately:
 *
 *  - an entry whose `matches` is the http scheme wildcard rather than `<all_urls>`, since the
 *    three that failed declare the scheme wildcards and Keeper declares `<all_urls>`
 *  - `runtime.connect` and `runtime.sendMessage` from inside a content script
 *
 * A guest `<webview>` is covered separately (dnr-webview-guest-spec, scripting-webview-guest-spec);
 * this is the plain case, which has to hold first.
 */
describe('content script injection', () => {
  let server: http.Server
  let url: string

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      const requestUrl = req.url || ''
      if (requestUrl.startsWith('/guest-host')) {
        // The guest must share the extension's partition, or it is another session entirely.
        const partition = new URL(requestUrl, url).searchParams.get('partition') || ''
        res.end(
          `<!doctype html><meta charset="utf-8"><title>host</title>` +
            `<webview id="guest" partition="${partition}" src="${url}" style="width:600px;height:400px"></webview>`,
        )
        return
      }
      res.end(
        '<!doctype html><html><title>cs</title><body><input name="user"><input type="password">',
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

  const browser = useExtensionBrowser({ url: () => url, extensionName: 'rpc-mv3' })

  const attr = async (name: string, timeoutMs = 6000): Promise<string | null> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await browser.window.webContents.executeJavaScript(
        `document.documentElement.getAttribute(${JSON.stringify(name)})`,
      )
      if (value !== null || Date.now() > deadline) return value
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

  it('runs a content script declared with http://*/* rather than <all_urls>', async () => {
    expect(await attr('data-crx-http-matches')).to.equal('ran')
  })

  it('runs EVERY main-world entry, not just the first', async () => {
    // Written while chasing a Dashlane that declares three of these and did nothing in Rambox. The
    // hypothesis was that only the first ran; the oracle then ruled it out (the same extension marks
    // the same form in a real Chromium, in plain Electron and in a guest alike). The coverage stays
    // because nothing tested it and a password manager's autofill rides on it.
    expect(await attr('data-crx-main-world-first'), 'the first main-world entry').to.equal('ran')
    expect(await attr('data-crx-main-world-second'), 'the second main-world entry').to.equal('ran')
    expect(
      await attr('data-crx-main-world-third'),
      'a main-world entry with two match patterns',
    ).to.equal('ran')
  })

  it('matches on any pattern of an entry, not only the first', async () => {
    // Dashlane's shadow-DOM entry lists http first and https second, and on an https page it did
    // not run while a sibling entry listing https first did — which looked like only matches[0]
    // being honoured. It is not: this reproduces that shape (schemes swapped, so no TLS is needed)
    // and passes. Kept as coverage for a rule nothing else pins down.
    expect(await attr('data-crx-second-pattern')).to.equal('ran')
  })

  it('lets a content script open a port to its background and hear back', async () => {
    expect(
      await attr('data-crx-port-opened'),
      'runtime.connect threw in the content script',
    ).to.equal('yes')
    expect(
      await attr('data-crx-port-reply'),
      'the port never delivered the background reply',
    ).to.equal('pong')
  })

  it('lets a content script inject a script of the extension origin into the page', async () => {
    // A password manager reaches page internals this way, and Dashlane's form classification waits
    // on a handshake with exactly such a script. It needs web_accessible_resources to be honoured.
    expect(await attr('data-crx-page-script-loaded'), 'the <script> tag never loaded').to.equal(
      'yes',
    )
    expect(
      await attr('data-crx-page-script'),
      'it loaded but never executed in the main world',
    ).to.equal('ran')
  })

  it('delivers a tabs.sendMessage from the background to the content script', async () => {
    // The direction an extension uses to tell a page to act: autofill is the background deciding
    // and the content script doing. Dashlane's background logs "Could not establish connection.
    // Receiving end does not exist." in Rambox, which is what sent me here — measured afterwards,
    // delivery works there too, so that log is not the failure. Untested before this either way.
    const reply: any = await browser.crx.raw({
      type: 'tabs-send-message',
      tabId: browser.window.webContents.id,
    })
    expect(reply, `the background got: ${JSON.stringify(reply)}`).to.deep.equal({
      reply: 'pong-from-content-script',
    })
  })

  it('lets a content script round-trip a sendMessage to its background', async () => {
    expect(await attr('data-crx-sendmessage-reply')).to.equal('pong')
  })
})

/**
 * The same fixture, in the shape an embedder actually serves: a `<webview>` guest.
 *
 * Rambox runs every service inside one, and a guest is a different kind of webContents from the
 * window above — the difference has bitten this library before (declarativeNetRequest treats a guest
 * in another partition as invisible). A password manager that works in a window and does nothing in
 * a guest is the failure mode this pins down.
 */
describe('content script injection in a <webview> guest', () => {
  let server: http.Server
  let url: string

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      const requestUrl = req.url || ''
      if (requestUrl.startsWith('/guest-host')) {
        const partition = new URL(requestUrl, url).searchParams.get('partition') || ''
        res.end(
          `<!doctype html><meta charset="utf-8"><title>host</title>` +
            `<webview id="guest" partition="${partition}" src="${url}guest-page" style="width:600px;height:400px"></webview>`,
        )
        return
      }
      res.end(
        '<!doctype html><html><title>guest</title><body><input name="user"><input type="password">',
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

  const guestAttr = async (name: string, timeoutMs = 8000): Promise<string | null> => {
    const guest = await guestContents()
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const value = await guest.executeJavaScript(
        `document.documentElement.getAttribute(${JSON.stringify(name)})`,
      )
      if (value !== null || Date.now() > deadline) return value
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }

  it('runs the content script inside the guest', async () => {
    expect(await guestAttr('data-crx-http-matches')).to.equal('ran')
  })

  it('runs every main-world entry inside the guest too', async () => {
    // The shape Rambox serves, which is where the question came from. Both halves hold here, so a
    // main-world entry is not what Dashlane was missing — see EXTENSION_CATALOG_HEALTH.md.
    expect(await guestAttr('data-crx-main-world-first'), 'the first main-world entry').to.equal(
      'ran',
    )
    expect(await guestAttr('data-crx-main-world-second'), 'the second main-world entry').to.equal(
      'ran',
    )
    expect(
      await guestAttr('data-crx-main-world-third'),
      'a main-world entry with two match patterns',
    ).to.equal('ran')
  })

  it('reaches the background from inside the guest', async () => {
    expect(await guestAttr('data-crx-port-reply'), 'the port never delivered a reply').to.equal(
      'pong',
    )
    expect(await guestAttr('data-crx-sendmessage-reply')).to.equal('pong')
  })

  it('delivers a tabs.sendMessage from the background into the guest', async () => {
    const guest = await guestContents()
    browser.extensions.addTab(guest, browser.window)
    browser.extensions.selectTab(guest)
    const reply: any = await browser.crx.raw({ type: 'tabs-send-message', tabId: guest.id })
    expect(reply, `the background got: ${JSON.stringify(reply)}`).to.deep.equal({
      reply: 'pong-from-content-script',
    })
    expect(await guestAttr('data-crx-got-background-message')).to.equal('yes')
  })

  it('injects a script of the extension origin into the guest page', async () => {
    expect(await guestAttr('data-crx-page-script-loaded')).to.equal('yes')
    expect(await guestAttr('data-crx-page-script')).to.equal('ran')
  })
})
