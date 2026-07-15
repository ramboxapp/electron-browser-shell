import { expect } from 'chai'
import { BrowserWindow } from 'electron'
import * as path from 'node:path'

import { ElectronChromeExtensions } from '../'
import { createCrxSession } from './crx-helpers'
import { emittedOnce } from './events-helpers'

describe('extension reload', () => {
  it('reloads the extension tabs after chrome.runtime.reload()', async () => {
    const { session: customSession } = createCrxSession()

    const extensions = new ElectronChromeExtensions({
      license: 'internal-license-do-not-use' as any,
      session: customSession,
      async createTab() {
        throw new Error('createTab not implemented')
      },
    })

    const extension = await customSession.extensions.loadExtension(
      path.join(__dirname, 'fixtures', 'runtime-reload'),
    )

    // The fixture page messages its service worker on load; make sure the
    // worker is running first since loadExtension() doesn't wait for MV3
    // service worker registration to complete.
    await customSession.serviceWorkers
      .startWorkerForScope(extension.url)
      .catch(() => new Promise((resolve) => setTimeout(resolve, 1000)))

    const w = new BrowserWindow({
      show: false,
      webPreferences: { session: customSession, nodeIntegration: false, contextIsolation: true },
    })

    try {
      extensions.addTab(w.webContents, w)

      // The page asks its background to chrome.runtime.reload() on first
      // load. Electron leaves open extension tabs with an invalidated
      // context after a reload, so the library must reload them once the
      // extension finishes loading again (Chrome parity).
      const reloaded = emittedOnce(customSession.extensions, 'extension-loaded')
      await w.loadURL(`${extension.url}page.html`)
      await reloaded

      // Wait for the library-triggered tab reload to finish.
      await emittedOnce(w.webContents, 'did-finish-load')

      const typeofGetManifest = await w.webContents.executeJavaScript(
        'typeof chrome.runtime.getManifest',
      )
      expect(typeofGetManifest).to.equal('function')
    } finally {
      w.destroy()
    }
  })
})
