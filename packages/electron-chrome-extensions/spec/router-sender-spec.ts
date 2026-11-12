import { expect } from 'chai'
import * as path from 'node:path'
import { WebContentsView } from 'electron'

import { useExtensionBrowser, useServer } from './hooks'

/**
 * Who an IPC to the router speaks for.
 *
 * The extension id travelled in the message, chosen by the renderer, and the router took it at its
 * word: extension A — or any renderer of A that a page compromised — called `cookies.getAll`,
 * `tabs.executeScript` or `nativeMessaging` as extension B, with B's permissions. The id now has to
 * be the sender's own: its frame's origin or its service worker's scope.
 *
 * The raw IPC is sent through the test preload's `electronTest` bridge (crx-test-preload), which
 * runs in every frame of the session, extension pages included: what a compromised renderer can do.
 */
describe('router: the sender speaks only for itself', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })
  let otherId: string

  beforeEach(async () => {
    const other = await browser.session.extensions.loadExtension(
      path.join(__dirname, 'fixtures', 'rpc-mv3'),
    )
    otherId = other.id
  })

  /** Runs `js` in a page of the extension, then `andThen` while the page is still open. */
  const inExtensionPage = async <T>(js: string, andThen?: () => void): Promise<T> => {
    const view = new WebContentsView({ webPreferences: { session: browser.session } })
    try {
      await view.webContents.loadURL(`chrome-extension://${browser.extension.id}/popup.html`)
      const result = await view.webContents.executeJavaScript(js)
      andThen?.()
      return result
    } finally {
      view.webContents.close()
    }
  }

  const invoke = (channel: string, ...args: any[]) =>
    `electronTest.invokeIpc(${[channel, ...args].map((arg) => JSON.stringify(arg)).join(', ')})` +
    `.then((result) => ({ ok: true, result }), (error) => ({ ok: false, error: String(error.message) }))`

  it('refuses a call made for another extension', async () => {
    const answer: any = await inExtensionPage(invoke('crx-msg', otherId, 'cookies.getAll', {}))
    expect(answer.ok, JSON.stringify(answer)).to.be.false
    expect(answer.error).to.include(
      `cookies.getAll was sent for extension ${otherId} from extension ${browser.extension.id}`,
    )
  })

  it('answers the same call made for itself', async () => {
    const answer: any = await inExtensionPage(
      invoke('crx-msg', browser.extension.id, 'cookies.getAll', {}),
    )
    expect(answer.ok, JSON.stringify(answer)).to.be.true
    expect(answer.result).to.be.an('array')
  })

  it('refuses an extension id claimed by a page that is not an extension', async () => {
    const answer: any = await browser.webContents.executeJavaScript(
      invoke('crx-msg', browser.extension.id, 'cookies.getAll', {}),
    )
    expect(answer.ok, JSON.stringify(answer)).to.be.false
    expect(answer.error).to.include('from a context that is not an extension')
  })

  it('does not register a listener for another extension', async () => {
    const router = (browser.extensions as any).ctx.router
    let spoofed: string[] = []
    let own: string[] = []
    // Read while the page is open: closing it drops its listeners.
    await inExtensionPage(
      `(async () => {
        electronTest.sendIpc('crx-add-listener', ${JSON.stringify(otherId)}, 'spec.spoofedEvent')
        electronTest.sendIpc('crx-add-listener', ${JSON.stringify(browser.extension.id)}, 'spec.ownEvent')
        // A round trip through the main process, so both one-way messages were handled before it.
        await electronTest.invokeIpc('crx-msg', ${JSON.stringify(browser.extension.id)}, 'cookies.getAll', {})
      })()`,
      () => {
        spoofed = router.listeningExtensions('spec.spoofedEvent')
        own = router.listeningExtensions('spec.ownEvent')
      },
    )
    expect(spoofed).to.deep.equal([])
    expect(own).to.deep.equal([browser.extension.id])
  })

  it("refuses the embedder's browser-action calls from an extension page", async () => {
    const answer: any = await inExtensionPage(
      invoke('crx-msg-remote', '_self', 'browserAction.getState'),
    )
    expect(answer.ok, JSON.stringify(answer)).to.be.false
    expect(answer.error).to.include('browserAction.getState cannot be called from an extension')
  })

  it("still answers the embedder's own window", async () => {
    const answer: any = await browser.webContents.executeJavaScript(
      invoke('crx-msg-remote', browser.partition, 'browserAction.getState'),
    )
    expect(answer.ok, JSON.stringify(answer)).to.be.true
    expect(answer.result.actions).to.be.an('array')
  })
})
