import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { AddressInfo } from 'node:net'
import { expect } from 'chai'

import { emittedOnce } from './events-helpers'
import { useExtensionBrowser, useServer } from './hooks'

/*
  A popup must never show its page a viewport other than the page's own size, because some pages
  size themselves from it.

  Proton Pass does: once started, its popup reads documentElement.clientWidth/Height and, if they
  differ from its declared 600x430, adopts them as its size — and again on every resize. In Chrome
  that is harmless, since auto-resize sizes the frame to the content inside the layout itself. In
  Electron preferred-size mode only starts when the load stops, and PopupView used to shrink the
  window to the 25x25 minimum (32x39 once Windows clamps it) right then, at did-finish-load: exactly
  when Proton's start-up code runs. When it ran before the preferred size came back, it adopted 32x39,
  the preferred size became 32x39, and the popup stayed a dark 32x39 box with a spinner. Measured in
  Rambox on 28/10/2026: 3 of 10 opens.

  The fixture reduces Proton's sizing to the same rule, and looks at its viewport on its load event,
  which the spec delays with a slow image so that the timing is not left to chance.
*/
describe('browserAction popup size', () => {
  const server = useServer()

  const SLOW_MS = 800
  let slowServer: http.Server
  let slowUrl: string
  let dir: string

  before(async () => {
    slowServer = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'image/gif' })
        // 1x1 transparent GIF
        res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
      }, SLOW_MS)
    })
    await new Promise<void>((resolve) => slowServer.listen(0, '127.0.0.1', () => resolve()))
    slowUrl = `http://127.0.0.1:${(slowServer.address() as AddressInfo).port}/slow.gif`

    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crx-popup-size-'))
    await fs.cp(path.join(__dirname, 'fixtures', 'chrome-browserAction-popup-sized'), dir, {
      recursive: true,
    })
    const html = await fs.readFile(path.join(dir, 'popup.html'), 'utf-8')
    await fs.writeFile(path.join(dir, 'popup.html'), html.replace('__SLOW_URL__', slowUrl))
  })

  after(async () => {
    slowServer.close()
    await fs.rm(dir, { recursive: true, force: true })
  })

  const browser = useExtensionBrowser({ url: server.getUrl, extensionPath: () => dir })

  const openPopup = async () => {
    const popupPromise = emittedOnce(browser.extensions, 'browser-action-popup-created')
    const details = {
      eventType: 'click',
      extensionId: browser.extension.id,
      tabId: -1,
      anchorRect: { x: 0, y: 0, width: 16, height: 16 },
    }
    await browser.webContents.executeJavaScript(
      `browserAction.activate('${browser.partition}', ${JSON.stringify(details)})`,
    )
    const [popup] = await popupPromise
    await popup.whenReady()
    // Let the preferred size that follows the load arrive, and anything it sets off settle.
    await new Promise((resolve) => setTimeout(resolve, 500))
    return popup
  }

  it('opens at the size the page declares, even when the page sizes itself from its viewport', async () => {
    const popup = await openPopup()
    const { width, height } = popup.browserWindow.getContentBounds()
    // The old code: 800x600 here, the window's default size the page found at load and adopted.
    expect({ width, height }).to.deep.equal({ width: 300, height: 200 })
    expect(popup.browserWindow.isVisible(), 'the popup must be shown').to.be.true
  })

  it('never makes the page adopt a viewport other than its own size', async () => {
    const popup = await openPopup()
    const adopted = await popup.browserWindow.webContents.executeJavaScript(
      `document.documentElement.style.getPropertyValue('--popup-width')`,
    )
    // The page adopts any viewport it is shown; with the old reset after the load it adopted the
    // 25x25 minimum (32x39 on Windows) whenever its start-up code ran before the preferred size.
    expect(adopted, 'the page adopted a viewport other than its own size').to.equal('')
  })
})
