import { expect } from 'chai'
import { BrowserWindow } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { ElectronChromeExtensions } from '../'
import { createCrxSession } from './crx-helpers'
import { useServer } from './hooks'

/*
  `chrome.runtime.onInstalled`, and the context menu an extension creates in it.

  Electron never fires onInstalled: measured on 43.0.0 with a worker that only listens for it, not on
  the first load into a fresh persistent partition, not on the next one, not on a reload. Extensions do
  their one-time setup there — Google Translate 2.0.18 creates its only menu item ("Translate") in it
  and nowhere else — so in Rambox it never had a context menu.

  Chrome then keeps that item across restarts for a lazy background, which is why the extension never
  creates it again. The library kept menus in memory only, so the item has to survive an unload and
  load of the same version too, without onInstalled firing a second time.

  The fixture mirrors that extension: it creates its menu in onInstalled, and reports each delivery on
  the console.
*/
describe('chrome.runtime.onInstalled', () => {
  const server = useServer()
  const fixture = path.join(__dirname, 'fixtures', 'runtime-oninstalled')

  let session: Electron.Session
  let extensions: ElectronChromeExtensions
  let extensionDir: string
  let extension: Electron.Extension
  let win: BrowserWindow
  let deliveries: any[]
  let storageWritten: boolean

  const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 10000) => {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

  const load = async () => {
    extension = await session.extensions.loadExtension(extensionDir)
    // The worker starts on its own; touching its scope makes sure it does even if Electron waits.
    await session.serviceWorkers.startWorkerForScope(extension.url).catch(() => {})
  }

  const reload = async () => {
    session.extensions.removeExtension(extension.id)
    await load()
  }

  const selectionMenu = () =>
    extensions.getContextMenuItems(win.webContents, {
      selectionText: 'hola',
      pageURL: server.getUrl(),
      frameURL: '',
      linkURL: '',
      srcURL: '',
      mediaType: 'none',
      isEditable: false,
    } as any)

  beforeEach(async () => {
    session = createCrxSession().session
    deliveries = []
    storageWritten = false
    session.serviceWorkers.on('console-message', (_event, details) => {
      const message = details.message
      if (message.startsWith('oninstalled ')) deliveries.push(JSON.parse(message.slice(12)))
      if (message === 'storage-written') storageWritten = true
    })

    // A copy per test, so a test can change the version on disk the way an update does.
    extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-oninstalled-'))
    for (const file of fs.readdirSync(fixture)) {
      fs.copyFileSync(path.join(fixture, file), path.join(extensionDir, file))
    }

    extensions = new ElectronChromeExtensions({
      license: 'internal-license-do-not-use' as any,
      session,
    })

    win = new BrowserWindow({ show: false, webPreferences: { session } })
    extensions.addTab(win.webContents, win)
    await win.loadURL(server.getUrl())

    await load()
  })

  afterEach(() => {
    if (!win.isDestroyed()) win.destroy()
  })

  it("fires with reason 'install' on an extension's first load into a session", async () => {
    await waitFor(() => deliveries.length > 0, 'onInstalled')
    expect(deliveries).to.deep.equal([{ reason: 'install' }])
  })

  it('lets the extension create its context menu there', async () => {
    await waitFor(() => deliveries.length > 0, 'onInstalled')
    await waitFor(() => selectionMenu().length > 0, 'the menu item')
    const items = selectionMenu()
    expect(items.map((item) => item.label)).to.deep.equal(['Translate'])
  })

  it('does not fire again for the same version, and the menu is still there', async () => {
    await waitFor(() => selectionMenu().length > 0, 'the menu item')
    await reload()
    // Long enough for the worker to start, subscribe and be answered.
    await sleep(1500)
    expect(deliveries, 'onInstalled fired on a reload of the same version').to.have.lengthOf(1)
    expect(selectionMenu().map((item) => item.label)).to.deep.equal(['Translate'])
  })

  it('keeps the menu on disk, where a restart reads it back', async () => {
    await waitFor(() => selectionMenu().length > 0, 'the menu item')
    // The write is debounced; give it time rather than reaching into the library to flush it.
    const file = path.join(session.storagePath!, 'electron-chrome-extensions', 'context-menus.json')
    await waitFor(() => fs.existsSync(file), 'the stored menu', 3000)
    const stored = JSON.parse(fs.readFileSync(file, 'utf-8'))
    expect(stored[extension.id].map((item: any) => item.id)).to.deep.equal(['translate'])
  })

  it("fires with reason 'update' and the previous version when the version changes", async () => {
    await waitFor(() => deliveries.length > 0, 'onInstalled')
    const manifestPath = path.join(extensionDir, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, version: '1.1' }))
    await reload()
    await waitFor(() => deliveries.length > 1, 'the second onInstalled')
    expect(deliveries[1]).to.deep.equal({ reason: 'update', previousVersion: '1.0' })
  })

  it("fires 'chrome_update', not 'install', for an extension that ran here before the record existed", async () => {
    // What a profile looks like the first time this library version runs on it: the extension's
    // data on disk, and no record of having seen it.
    await waitFor(() => storageWritten, 'the storage write')
    await waitFor(
      () =>
        fs.existsSync(path.join(session.storagePath!, 'Local Extension Settings', extension.id)),
      'the storage folder',
    )
    fs.rmSync(path.join(session.storagePath!, 'electron-chrome-extensions', 'installed.json'))
    // The instance keeps the record in memory; a new process would not have it.
    ;((extensions as any).api.runtime as any).installed.value = undefined
    ;((extensions as any).api.runtime as any).seen.clear()

    await reload()
    await waitFor(() => deliveries.length > 1, 'the second onInstalled')
    expect(deliveries[1]).to.deep.equal({ reason: 'chrome_update' })
  })
})
