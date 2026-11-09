import { expect } from 'chai'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { useExtensionBrowser, useServer } from './hooks'
import { patchContentScriptStorage } from '../'

/**
 * Whether this Electron gives session frame preloads to an embedded `chrome-extension://` frame.
 * Electron documents the change for 45.0.0 and its backports to 44.3.0, 43.7.0 and 42.11.3; measured
 * here: 43.0.0 gives them, 44.9.3+wvcus and 45.2.1+wvcus do not.
 */
const embeddedFramesGetPreloads = (): boolean => {
  const [major, minor] = process.versions.electron.split('.').map((n) => parseInt(n, 10))
  if (major >= 45) return false
  if (major === 44) return minor < 3
  if (major === 43) return minor < 7
  if (major === 42) return minor < 11
  return true
}

/**
 * An extension page embedded in an ordinary web page: the in-field UI of every password manager.
 *
 * Keeper's prompt (`content_scripts/prompt/prompt.html`), 1Password's `inline/menu/menu.html`,
 * Bitwarden's `overlay/menu-list.html`, Proton Pass's `dropdown.html`, NordPass's `app.html` and
 * RoboForm's `save-forms.html` are all `chrome-extension://` documents that a content script puts in
 * an iframe of the site. They talk to their own worker, read their settings from `chrome.storage` and
 * call `chrome.tabs`/`chrome.windows` from there.
 *
 * Electron 45.0.0 changed who gets preloads there (breaking change, "chrome-extension:// frames"): a
 * `chrome-extension://` document only receives the window's preload and the session's frame
 * preloads when it is top-level or inside DevTools; embedded in a page it is treated like any other
 * subframe and follows `nodeIntegrationInSubFrames`. This library's surface (`chrome.windows`,
 * its `chrome.tabs`, the `storage.sync` alias, the locale bundle, `lastError`) arrives by exactly
 * that session frame preload, so an embedded frame that lost it would see Electron's native
 * `chrome` only — and, from 45.2 on, a native `storage.sync` that is a different store from the one
 * the worker reads through the alias.
 *
 * The spec pins what the frame actually gets on the binary it runs on, next to a top-level page of
 * the same extension as the control.
 */
const describeEmbedded = (patched: boolean) =>
  describe(`extension page embedded in a web page (${patched ? 'patched' : 'as installed'})`, () => {
    const server = useServer()
    let extensionDir: string

    before(async () => {
      extensionDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crx-frame-'))
      const manifest = {
        name: 'embedded-frame',
        version: '1.0',
        manifest_version: 3,
        background: { service_worker: 'background.js' },
        permissions: ['storage', 'tabs'],
        web_accessible_resources: [{ resources: ['frame.html'], matches: ['<all_urls>'] }],
      }
      await fs.writeFile(path.join(extensionDir, 'manifest.json'), JSON.stringify(manifest))
      await fs.writeFile(path.join(extensionDir, 'background.js'), '// nothing to do\n')
      await fs.writeFile(
        path.join(extensionDir, 'frame.html'),
        '<!doctype html><meta charset="utf-8"><body>frame<script src="frame.js"></script></body>',
      )
      await fs.writeFile(
        path.join(extensionDir, 'frame.js'),
        `(async () => {
        const c = typeof chrome === 'undefined' ? undefined : chrome
        const report = {
          topLevel: window === window.top,
          hasBridge: typeof electron !== 'undefined',
          windows: !!(c && c.windows && typeof c.windows.getAll === 'function'),
          tabsQuery: !!(c && c.tabs && typeof c.tabs.query === 'function'),
          runtimeId: c && c.runtime ? c.runtime.id : null,
          syncIsLocal: null,
          shim: self.__crxStorageShimRan || null,
          error: null,
        }
        try {
          const token = 'probe-' + Math.random()
          await c.storage.sync.set({ embeddedFrameProbe: token })
          const fromLocal = await c.storage.local.get('embeddedFrameProbe')
          report.syncIsLocal = fromLocal.embeddedFrameProbe === token
        } catch (error) {
          report.error = String(error && error.message || error)
        }
        if (window === window.top) window.__report = report
        else window.parent.postMessage({ embeddedFrameReport: report }, '*')
      })()`,
      )
      if (patched) await patchContentScriptStorage(extensionDir)
    })

    after(async () => {
      await fs.rm(extensionDir, { recursive: true, force: true })
    })

    const browser = useExtensionBrowser({ url: server.getUrl, extensionPath: () => extensionDir })

    const frameUrl = () => `chrome-extension://${browser.extension.id}/frame.html`

    it('gives a top-level extension page the library surface (control)', async () => {
      await browser.webContents.loadURL(frameUrl())
      const report: any = await browser.webContents.executeJavaScript(`new Promise((resolve) => {
      const wait = () => (window.__report ? resolve(window.__report) : setTimeout(wait, 50))
      wait()
    })`)
      expect(report.topLevel).to.be.true
      expect(report.windows, 'chrome.windows comes from this library').to.be.true
      expect(report.syncIsLocal, `storage.sync is the alias of local (${report.error})`).to.be.true
    })

    const embeddedReport = async (): Promise<any> => {
      const report: any = await browser.webContents
        .executeJavaScript(`new Promise((resolve, reject) => {
      window.addEventListener('message', (e) => {
        if (e.data && e.data.embeddedFrameReport) resolve(e.data.embeddedFrameReport)
      })
      const frame = document.createElement('iframe')
      frame.src = ${JSON.stringify(frameUrl())}
      document.body.appendChild(frame)
      setTimeout(() => reject(new Error('the embedded frame never reported')), 8000)
    })`)
      console.log(
        `[embedded-frame] electron=${process.versions.electron} patched=${patched} ${JSON.stringify(report)}`,
      )
      expect(report.topLevel).to.be.false
      expect(report.runtimeId, 'the frame is not an extension context at all').to.equal(
        browser.extension.id,
      )
      return report
    }

    if (!patched) {
      it('gets the library preload only on an Electron that still gives it to embedded frames', async () => {
        const report = await embeddedReport()
        // Pinned to what Electron does, so a binary that changes its mind fails here instead of
        // silently doubling up with the page shim.
        expect(report.windows, 'chrome.windows (from the library preload) in the frame').to.equal(
          embeddedFramesGetPreloads(),
        )
        expect(report.hasBridge).to.equal(embeddedFramesGetPreloads())
      })
    } else {
      it('keeps storage.sync on local in the embedded frame, with or without the preload', async () => {
        const report = await embeddedReport()
        // The one that loses data silently: without the preload, a native storage.sync (45.2+) is a
        // different store from the alias the worker and the top-level pages read.
        expect(report.syncIsLocal, `storage.sync split from local in the frame (${report.error})`)
          .to.be.true
        expect(report.shim).to.equal(embeddedFramesGetPreloads() ? 'preload' : 'ok')
      })

      it('leaves a top-level page, which has the preload, to the preload', async () => {
        await browser.webContents.loadURL(frameUrl())
        const report: any = await browser.webContents.executeJavaScript(`new Promise((resolve) => {
        const wait = () => (window.__report ? resolve(window.__report) : setTimeout(wait, 50))
        wait()
      })`)
        expect(report.shim, 'the page shim ran over the preload').to.equal('preload')
        expect(report.syncIsLocal).to.be.true
      })
    }
  })

describeEmbedded(false)
describeEmbedded(true)
