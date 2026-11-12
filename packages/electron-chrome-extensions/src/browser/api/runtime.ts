import { randomUUID } from 'node:crypto'
import { BrowserWindow, webContents as allWebContents } from 'electron'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { getExtensionManifest } from './common'
import { NativeMessagingHost } from './lib/native-messaging-host'
import { SessionStateFile } from './lib/session-state'

type InstalledDetails = chrome.runtime.InstalledDetails

/** What this session last saw of each extension: its version, and the browser's when it saw it. */
type InstalledRecord = Record<string, { version: string; browserVersion: string }>

const BROWSER_VERSION = process.versions.chrome

/**
 * The extensions whose service worker Electron has started in this session, read from the session's
 * `Preferences` file (`extensions.settings.<id>.has_started_service_worker`). Read once, when the
 * library attaches to the session, so it describes earlier launches and not the loads of this one.
 */
const readStartedWorkers = (session: Electron.Session) => {
  const started = new Set<string>()
  if (!session.storagePath) return started
  try {
    const prefs = JSON.parse(
      fs.readFileSync(path.join(session.storagePath, 'Preferences'), 'utf-8'),
    )
    const settings = prefs?.extensions?.settings ?? {}
    for (const [id, value] of Object.entries<any>(settings)) {
      if (value?.has_started_service_worker === true) started.add(id)
    }
  } catch {
    // No Preferences yet: a session that never ran an extension.
  }
  return started
}

export class RuntimeAPI extends EventEmitter {
  private hostMap = new Map<string, NativeMessagingHost>()

  /*
    `runtime.onInstalled`, which Electron never fires.

    Measured on Electron 43.0.0 with a bare MV3 worker that only listens for it: not on the first
    load into a fresh persistent partition, not on the second, not on a reload. Chrome fires it on
    install, on an update and when the browser itself updates — and it is where extensions do their
    one-time setup, above all `contextMenus.create`, because Chrome keeps the menu afterwards. Google
    Translate 2.0.18 registers its only menu item ("Translate") there and nowhere else, so in Rambox
    it never had one.

    The reason is computed when the extension loads, against a record kept in the session's folder,
    and handed once to the extension's background when it subscribes (see `takeInstalledDetails`).
  */
  private installed: SessionStateFile<InstalledRecord>
  private pendingInstalled = new Map<string, InstalledDetails>()
  // Extensions whose load this instance has already compared against the record, this launch.
  private seen = new Set<string>()

  constructor(private ctx: ExtensionContext) {
    super()

    const handle = this.ctx.router.apiHandler()
    handle('runtime.connectNative', this.connectNative, { permission: 'nativeMessaging' })
    handle('runtime.disconnectNative', this.disconnectNative, { permission: 'nativeMessaging' })
    handle('runtime.openOptionsPage', this.openOptionsPage)
    handle('runtime.sendNativeMessage', this.sendNativeMessage, { permission: 'nativeMessaging' })
    handle('runtime.takeInstalledDetails', this.takeInstalledDetails)
    handle('runtime.getDocumentContexts', this.getDocumentContexts)

    this.installed = new SessionStateFile(ctx.session, 'installed', () => ({}))
    this.startedWorkersBefore = readStartedWorkers(ctx.session)
    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-loaded', (_event, extension) =>
      this.onExtensionLoaded(extension),
    )
    for (const extension of sessionExtensions.getAllExtensions()) this.onExtensionLoaded(extension)
    sessionExtensions.on('extension-unloaded', (_event, extension) =>
      this.closeNativePorts(extension.id),
    )
  }

  // Extensions whose worker Electron had already started in this session before this launch.
  private startedWorkersBefore: Set<string>

  /**
   * Whether an extension with no entry in the record has run in this session before. That is the
   * case for every extension the first time this library version runs on an existing profile, and
   * telling it apart from a real first install is what keeps an update of the host app from opening
   * every extension's welcome page.
   *
   * Electron's own per-session Preferences say it best (`has_started_service_worker`); the
   * extension's `chrome.storage` or IndexedDB data on disk cover a background that is not a worker.
   * Storage alone is not enough: measured on the catalog, 4 of 20 keep nothing there on their first
   * run — Boomerang, Drag and GMass among them — and each opened its welcome page again.
   */
  private hasRunHereBefore(extensionId: string) {
    if (this.startedWorkersBefore.has(extensionId)) return true
    const storagePath = this.ctx.session.storagePath
    if (!storagePath) return false
    return [
      path.join(storagePath, 'Local Extension Settings', extensionId),
      path.join(storagePath, 'IndexedDB', `chrome-extension_${extensionId}_0.indexeddb.leveldb`),
    ].some((p) => fs.existsSync(p))
  }

  private onExtensionLoaded(extension: Electron.Extension) {
    this.seen.add(extension.id)
    const record = this.installed.get()
    const previous = record[extension.id]
    const version: string = extension.version || getExtensionManifest(extension).version
    let details: InstalledDetails | undefined

    if (!previous) {
      // Chrome reports 'chrome_update' when the browser, not the extension, changed — which is what
      // happened to an extension that was already here before this record existed.
      details = this.hasRunHereBefore(extension.id)
        ? { reason: 'chrome_update' as chrome.runtime.OnInstalledReason }
        : { reason: 'install' as chrome.runtime.OnInstalledReason }
    } else if (previous.version !== version) {
      details = {
        reason: 'update' as chrome.runtime.OnInstalledReason,
        previousVersion: previous.version,
      }
    } else if (previous.browserVersion !== BROWSER_VERSION) {
      details = { reason: 'chrome_update' as chrome.runtime.OnInstalledReason }
    }

    if (!details) return
    this.pendingInstalled.set(extension.id, details)
    this.installed.set({ ...record, [extension.id]: { version, browserVersion: BROWSER_VERSION } })
    // Written now: losing it to a quit inside the debounce would replay the event on the next launch.
    this.installed.flush()
  }

  /**
   * Hands the pending `onInstalled` details to the extension's background, once. The preload asks on
   * the first `addListener` of a background context, so the event reaches the listeners registered
   * while the worker starts — as in Chrome, which dispatches it after the script has evaluated.
   */
  // A stable id per document, as Chromium's contextId is for the document's lifetime.
  private contextIds = new WeakMap<Electron.WebContents, string>()

  /**
   * The extension's documents for `runtime.getContexts()`: every one of its pages open in this
   * session, as OFFSCREEN_DOCUMENT, POPUP, SIDE_PANEL or TAB. The BACKGROUND entry is not here — Electron's own
   * binding answers that one, with its real id, and the preload joins both lists and applies the
   * filter.
   */
  private getDocumentContexts = ({ extension }: ExtensionEvent) => {
    const origin = `chrome-extension://${extension.id}`
    const contexts: chrome.runtime.ExtensionContext[] = []
    for (const wc of allWebContents.getAllWebContents()) {
      if (wc.isDestroyed() || wc.session !== this.ctx.session) continue
      if (wc.getType() === 'remote' || wc.getType() === 'backgroundPage') continue
      let url: string
      try {
        url = wc.getURL()
      } catch {
        continue
      }
      if (!url.startsWith(`${origin}/`)) continue
      if (url.includes('_generated_background_page.html')) continue

      const contextType =
        this.ctx.store.extensionContextTypes.get(wc) ||
        (this.ctx.store.isSidePanelContents(wc, extension.id) ? 'SIDE_PANEL' : 'TAB')
      let contextId = this.contextIds.get(wc)
      if (!contextId) {
        contextId = randomUUID()
        this.contextIds.set(wc, contextId)
      }
      // Chromium gives a tab and window only to a document in a tab (its documentation: -1 for the
      // offscreen document, the popup and the background).
      const isTab = contextType === 'TAB'
      const win = isTab
        ? this.ctx.store.tabToWindow.get(wc) || BrowserWindow.fromWebContents(wc)
        : undefined
      contexts.push({
        contextType: contextType as chrome.runtime.ContextType,
        contextId,
        tabId: isTab ? wc.id : -1,
        windowId: win && !win.isDestroyed() ? win.id : -1,
        frameId: 0,
        documentUrl: url,
        documentOrigin: origin,
        incognito: false,
      })
    }
    return contexts
  }

  private takeInstalledDetails = ({ extension }: ExtensionEvent) => {
    // A worker can ask before 'extension-loaded' reached this instance; settle the reason first then.
    if (!this.seen.has(extension.id)) this.onExtensionLoaded(extension)
    const details = this.pendingInstalled.get(extension.id)
    this.pendingInstalled.delete(extension.id)
    return details ?? null
  }

  private connectNative = async (
    event: ExtensionEvent,
    connectionId: string,
    application: string,
  ) => {
    const host = new NativeMessagingHost(
      event.extension.id,
      event.sender!,
      connectionId,
      application,
      true,
      this.ctx.session,
    )
    // Dropped however the port ends: disconnect, host exit, or the sender going away.
    host.onClosed = () => {
      if (this.hostMap.get(connectionId) === host) this.hostMap.delete(connectionId)
    }
    this.hostMap.set(connectionId, host)
  }

  private disconnectNative = (event: ExtensionEvent, connectionId: string) => {
    const host = this.hostMap.get(connectionId)
    // A port is only its own extension's to close.
    if (!host || host.extensionId !== event.extension.id) return
    host.destroy()
    this.hostMap.delete(connectionId)
  }

  /** Ends every native port an extension still has open (it was unloaded or reloaded). */
  private closeNativePorts(extensionId: string) {
    for (const [connectionId, host] of this.hostMap) {
      if (host.extensionId !== extensionId) continue
      this.hostMap.delete(connectionId)
      host.destroy()
    }
  }

  private sendNativeMessage = async (event: ExtensionEvent, application: string, message: any) => {
    const connectionId = randomUUID()
    const host = new NativeMessagingHost(
      event.extension.id,
      event.sender!,
      connectionId,
      application,
      false,
    )
    try {
      await host.ready
      return await host.sendAndReceive(message)
    } finally {
      // One message, one answer: Chrome closes the host after the response. This left the process
      // running, one more per call, for the life of the app.
      host.destroy()
    }
  }

  private openOptionsPage = async ({ extension }: ExtensionEvent) => {
    // TODO: options page shouldn't appear in Tabs API
    // https://developer.chrome.com/extensions/options#tabs-api

    const manifest = getExtensionManifest(extension)

    if (manifest.options_ui) {
      // Embedded option not support (!options_ui.open_in_new_tab)
      const url = `chrome-extension://${extension.id}/${manifest.options_ui.page}`
      await this.ctx.store.createTab({ url, active: true })
    } else if (manifest.options_page) {
      const url = `chrome-extension://${extension.id}/${manifest.options_page}`
      await this.ctx.store.createTab({ url, active: true })
    }
  }
}
