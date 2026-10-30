import { expect } from 'chai'
import * as path from 'node:path'
import { session as electronSession, WebContentsView } from 'electron'

import { useExtensionBrowser, useServer } from './hooks'
import { uuid } from './spec-helpers'

const fixture = path.join(__dirname, 'fixtures', 'storage-events-mv3')
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The same answer as the preload's `workerStorageEventsAreNative` (src/renderer/index.ts): whether
 * this Electron delivers `storage.onChanged` to a service worker by itself. Measured 30/10/2026:
 * 43.0.0 and 44.9.3+wvcus no, 44.10.0 and 45.1.0 stock yes (electron/electron#55146).
 */
const binaryDeliversToWorkers = () => {
  const [major, minor] = process.versions.electron.split('.').map((part) => parseInt(part, 10))
  if (major >= 46) return true
  if (major === 45) return minor >= 1
  if (major === 44) return minor >= 10
  return false
}

/** An extension page of the fixture, in the given session, to write from and listen in. */
/*
  Views kept alive until their test closes them: a WebContentsView nothing references is collected,
  and its webContents with it, mid-test ("Object has been destroyed"; one run in three of the suite).
*/
const openViews = new Set<WebContentsView>()
const openPage = async (session: Electron.Session, extensionId: string) => {
  const view = new WebContentsView({ webPreferences: { session } })
  openViews.add(view)
  view.webContents.once('destroyed', () => openViews.delete(view))
  await view.webContents.loadURL(`chrome-extension://${extensionId}/page.html`)
  return view.webContents
}

/**
 * What the worker heard since the last call, read through the page. Sorted by event name: Chromium
 * dispatches the area's event before `onChanged` (44.10, measured), the relay the other way round,
 * and nothing depends on that order.
 */
const workerHeard = async (page: Electron.WebContents, settleMs = 400): Promise<any[]> => {
  await sleep(settleMs)
  const rank = ({ entry, index }: { entry: any; index: number }) =>
    (entry.event === 'onChanged' ? 0 : 1e6) + index
  const heard: any[] = await page.executeJavaScript(`chrome.runtime.sendMessage({ type: 'heard' })`)
  return heard
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => rank(a) - rank(b))
    .map(({ entry }) => entry)
}

/**
 * `storage.onChanged` in an MV3 service worker.
 *
 * Chrome tells every context of an extension about every change to its storage, the worker
 * included; Electron below 44.10 tells pages and never the worker. Extensions keep the worker in
 * step with their popup and options page through this event (Google Translate's target language,
 * SafeInCloud's storage cache and its logout, RoboForm's options, HubSpot's portal), so the library
 * relays the writes of every extension context to the worker on those binaries.
 *
 * The first case is the expiry date of that relay: it measures the binary without the library. When
 * it fails, the gate in the preload and this file disagree with the binary — on a fixed binary with
 * the relay still on, a worker would hear a change twice until the first native delivery switches
 * the relay off. Update both, and once every supported binary delivers, remove the relay
 * (src/browser/api/storage.ts and the `storage` definition in the preload).
 */
describe('chrome.storage.onChanged in a service worker', () => {
  describe('the binary, without the library', () => {
    it(`delivers to the worker: ${binaryDeliversToWorkers()} on Electron ${process.versions.electron}`, async () => {
      const bare = electronSession.fromPartition(`persist:bare-${uuid()}`)
      const extension = await bare.extensions.loadExtension(fixture)
      const page = await openPage(bare, extension.id)
      try {
        await sleep(500)
        await page.executeJavaScript(`(async () => {
          await chrome.storage.local.set({ fromPage: 1 })
          await chrome.storage.session.set({ inSession: 1 })
          await chrome.runtime.sendMessage({ type: 'write', area: 'local', method: 'set', args: [{ fromWorker: 1 }] })
        })()`)
        const heard = await workerHeard(page, 800)
        const pageHeard = await page.executeJavaScript('window.heardByPage.length')
        expect(pageHeard, 'the page hears every change natively').to.equal(3)
        if (binaryDeliversToWorkers()) {
          expect(heard.length, JSON.stringify(heard)).to.be.greaterThan(0)
        } else {
          expect(heard, 'this binary delivers natively now: move the gate').to.deep.equal([])
        }
      } finally {
        page.close()
        await bare.extensions.removeExtension(extension.id)
      }
    })
  })

  describe('with the library', () => {
    const server = useServer()
    const browser = useExtensionBrowser({
      url: server.getUrl,
      extensionPath: () => fixture,
    })

    let page: Electron.WebContents
    beforeEach(async () => {
      page = await openPage(browser.session, browser.extension.id)
      await workerHeard(page, 300)
    })
    afterEach(() => {
      if (!page.isDestroyed()) page.close()
    })

    const fromPage = (code: string) => page.executeJavaScript(`(async () => { ${code} })()`)
    const inWorker = (area: string, method: string, ...args: any[]) =>
      fromPage(
        `return chrome.runtime.sendMessage(${JSON.stringify({ type: 'write', area, method, args })})`,
      )

    it("hears a page's write once, in onChanged and in the area's onChanged", async () => {
      await fromPage(`await chrome.storage.local.set({ a: 1 })`)
      const heard = await workerHeard(page)
      expect(heard).to.deep.equal([
        { event: 'onChanged', areaName: 'local', changes: { a: { newValue: 1 } } },
        { event: 'local', changes: { a: { newValue: 1 } } },
      ])
    })

    it('hears its own write', async () => {
      expect(await inWorker('local', 'set', { own: 'x' })).to.deep.equal({ ok: true })
      const heard = await workerHeard(page)
      expect(heard.filter((entry) => entry.event === 'onChanged')).to.deep.equal([
        { event: 'onChanged', areaName: 'local', changes: { own: { newValue: 'x' } } },
      ])
    })

    it('reports oldValue, skips writes that change nothing, and covers remove and clear', async () => {
      await fromPage(`await chrome.storage.local.set({ k: { b: 1, a: 2 }, other: true })`)
      await fromPage(`await chrome.storage.local.set({ k: { a: 2, b: 1 } })`) // same value
      await fromPage(`await chrome.storage.local.set({ k: 'new' })`)
      await fromPage(`await chrome.storage.local.remove(['k', 'missing'])`)
      await inWorker('local', 'clear')
      const changes = (await workerHeard(page))
        .filter((entry) => entry.event === 'onChanged')
        .map((entry) => entry.changes)
      expect(changes).to.deep.equal([
        { k: { newValue: { a: 2, b: 1 } }, other: { newValue: true } },
        { k: { oldValue: { a: 2, b: 1 }, newValue: 'new' } },
        { k: { oldValue: 'new' } },
        { other: { oldValue: true } },
      ])
    })

    it('names the session area', async () => {
      await fromPage(`await chrome.storage.session.set({ s: 1 })`)
      const heard = await workerHeard(page)
      expect(heard).to.deep.equal([
        { event: 'onChanged', areaName: 'session', changes: { s: { newValue: 1 } } },
        { event: 'session', changes: { s: { newValue: 1 } } },
      ])
    })

    it('leaves the page with the native event only, once per change', async () => {
      await fromPage(`await chrome.storage.local.set({ p: 1 })`)
      await inWorker('local', 'set', { p: 2 })
      await workerHeard(page)
      const pageHeard = await page.executeJavaScript('window.heardByPage')
      expect(pageHeard).to.deep.equal([
        { areaName: 'local', keys: ['p'] },
        { areaName: 'local', keys: ['p'] },
      ])
    })

    it('keeps the callback form, and its lastError, on a write that fails', async () => {
      const ok = await fromPage(
        `return chrome.runtime.sendMessage({ type: 'write-callback', items: { cb: 1 } })`,
      )
      expect(ok).to.deep.equal({ lastError: null })
      // Over the per-item quota of nothing — local has no per-item quota — so fail it by size.
      const failing = await fromPage(
        `return chrome.runtime.sendMessage({ type: 'write', area: 'session', method: 'set', args: [{ big: 'x'.repeat(11 * 1024 * 1024) }] })`,
      )
      expect(failing.ok, JSON.stringify(failing)).to.be.false
      const heard = await workerHeard(page)
      expect(heard.map((entry) => Object.keys(entry.changes))).to.deep.equal([['cb'], ['cb']])
    })

    it('throws synchronously on a call Chrome rejects by its schema, as before', async () => {
      const result = await fromPage(
        `try { chrome.storage.local.set('not an object'); return 'no throw' } catch (e) { return 'threw' }`,
      )
      expect(result).to.equal('threw')
    })
  })
})
