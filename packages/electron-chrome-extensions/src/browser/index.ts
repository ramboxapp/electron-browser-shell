import { session as electronSession } from 'electron'
import { EventEmitter } from 'node:events'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'

import { AlarmsAPI } from './api/alarms'
import { BrowserActionAPI } from './api/browser-action'
import { TabsAPI } from './api/tabs'
import { WindowsAPI } from './api/windows'
import { WebNavigationAPI } from './api/web-navigation'
import { ExtensionStore } from './store'
import { ContextMenusAPI } from './api/context-menus'
import { DownloadsAPI } from './api/downloads'
import { FontSettingsAPI } from './api/font-settings'
import { IdentityAPI } from './api/identity'
import { IdleAPI } from './api/idle'
import { ManagementAPI } from './api/management'
import { OffscreenAPI } from './api/offscreen'
import { RuntimeAPI } from './api/runtime'
import { CookiesAPI } from './api/cookies'
import { NotificationsAPI } from './api/notifications'
import { ChromeExtensionImpl } from './impl'
import { CommandsAPI } from './api/commands'
import { ExtensionContext } from './context'
import { ExtensionRouter } from './router'
import { checkLicense, License } from './license'
import { readLoadedExtensionManifest } from './manifest'
import { PermissionsAPI } from './api/permissions'
import { WebSocketAPI } from './api/websocket'
import { BrowsingDataAPI } from './api/browsing-data'
import { InstanceIDAPI } from './api/instance-id'
import { PageCaptureAPI } from './api/page-capture'
import { SystemAPI } from './api/system'
import { StorageAPI } from './api/storage'
import { SidePanelAPI, SidePanelShowDetails } from './api/side-panel'
import { resolvePartition } from './partition'

function checkVersion() {
  const electronVersion = process.versions.electron
  if (electronVersion && parseInt(electronVersion.split('.')[0], 10) < 35) {
    console.warn('electron-chrome-extensions requires electron@>=35.0.0')
  }
}

function resolvePreloadPath(modulePath?: string) {
  const preloadFilename = 'chrome-extension-api.preload.js'

  /*
    An explicit modulePath wins over module resolution.

    Deprecated, but it is the caller saying where the preload IS, and resolution can find a different
    copy of this package than the one running. That is what happened in Rambox: its main process is
    bundled from a local checkout of this library while `node_modules/electron-chrome-extensions`
    still holds the published build, so resolving from __dirname handed the extension contexts the
    PUBLISHED preload while the browser side ran the checkout. Every chrome.* namespace was still
    there, with another build's behaviour, and nothing said so — the browser-global mirror and the
    content-script storage alias simply did not exist in the preload that ran, which reads exactly
    like "the fix does not work".
  */
  if (modulePath) {
    process.emitWarning(
      'electron-chrome-extensions: "modulePath" is deprecated and will be removed in future versions.',
      { type: 'DeprecationWarning' },
    )
    return path.join(modulePath, 'dist', preloadFilename)
  }

  // Attempt to resolve preload path from module exports
  try {
    return createRequire(__dirname).resolve('electron-chrome-extensions/preload')
  } catch (error) {
    if (process.env.NODE_ENV !== 'production') {
      console.error(error)
    }
  }

  // Fallback to preload relative to entrypoint directory
  return path.join(__dirname, preloadFilename)
}

export type { SidePanelShowDetails, SidePanelHideDetails } from './api/side-panel'

export interface ChromeExtensionOptions extends ChromeExtensionImpl {
  /**
   * License used to distribute electron-chrome-extensions.
   *
   * See LICENSE.md for more details.
   */
  license: License

  /**
   * Session to add Chrome extension support in.
   * Defaults to `session.defaultSession`.
   */
  session?: Electron.Session

  /**
   * Path to electron-chrome-extensions module files. Might be needed if
   * JavaScript bundlers like Webpack are used in your build process.
   *
   * @deprecated See "Packaging the preload script" in the readme.
   */
  modulePath?: string
}

const sessionMap = new WeakMap<Electron.Session, ElectronChromeExtensions>()

/**
 * Provides an implementation of various Chrome extension APIs to a session.
 */
export class ElectronChromeExtensions extends EventEmitter {
  /** Retrieve an instance of this class associated with the given session. */
  static fromSession(session: Electron.Session) {
    return sessionMap.get(session)
  }

  /**
   * Handles the 'crx://' protocol in the session.
   *
   * This is required to display <browser-action-list> extension icons.
   */
  static handleCRXProtocol(session: Electron.Session) {
    if (session.protocol.isProtocolHandled('crx')) {
      session.protocol.unhandle('crx')
    }
    session.protocol.handle('crx', function handleCRXRequest(request) {
      let url
      try {
        url = new URL(request.url)
      } catch {
        return new Response('Invalid URL', { status: 404 })
      }

      const partition = url?.searchParams.get('partition') || '_self'
      const remoteSession = partition === '_self' ? session : resolvePartition(partition)
      const extensions = ElectronChromeExtensions.fromSession(remoteSession)
      if (!extensions) {
        return new Response(`ElectronChromeExtensions not found for "${partition}"`, {
          status: 404,
        })
      }

      return extensions.api.browserAction.handleCRXRequest(request)
    })
  }

  private ctx: ExtensionContext

  private api: {
    alarms: AlarmsAPI
    browserAction: BrowserActionAPI
    browsingData: BrowsingDataAPI
    contextMenus: ContextMenusAPI
    commands: CommandsAPI
    cookies: CookiesAPI
    downloads: DownloadsAPI
    fontSettings: FontSettingsAPI
    identity: IdentityAPI
    idle: IdleAPI
    instanceID: InstanceIDAPI
    management: ManagementAPI
    notifications: NotificationsAPI
    offscreen: OffscreenAPI
    pageCapture: PageCaptureAPI
    permissions: PermissionsAPI
    runtime: RuntimeAPI
    storage: StorageAPI
    sidePanel: SidePanelAPI
    system: SystemAPI
    tabs: TabsAPI
    webNavigation: WebNavigationAPI
    webSocket: WebSocketAPI
    windows: WindowsAPI
  }

  constructor(opts: ChromeExtensionOptions) {
    super()

    const { license, session = electronSession.defaultSession, ...impl } = opts || {}

    checkVersion()
    checkLicense(license)

    if (sessionMap.has(session)) {
      throw new Error(`Extensions instance already exists for the given session`)
    }

    sessionMap.set(session, this)

    const router = new ExtensionRouter(session)
    const store = new ExtensionStore(impl)

    this.ctx = {
      emit: this.emit.bind(this),
      router,
      session,
      store,
    }

    this.api = {
      alarms: new AlarmsAPI(this.ctx),
      browserAction: new BrowserActionAPI(this.ctx),
      browsingData: new BrowsingDataAPI(this.ctx),
      contextMenus: new ContextMenusAPI(this.ctx),
      commands: new CommandsAPI(this.ctx),
      cookies: new CookiesAPI(this.ctx),
      downloads: new DownloadsAPI(this.ctx),
      fontSettings: new FontSettingsAPI(this.ctx),
      identity: new IdentityAPI(this.ctx),
      idle: new IdleAPI(this.ctx),
      instanceID: new InstanceIDAPI(this.ctx),
      management: new ManagementAPI(this.ctx),
      notifications: new NotificationsAPI(this.ctx),
      offscreen: new OffscreenAPI(this.ctx),
      pageCapture: new PageCaptureAPI(this.ctx),
      permissions: new PermissionsAPI(this.ctx),
      storage: new StorageAPI(this.ctx),
      runtime: new RuntimeAPI(this.ctx),
      sidePanel: new SidePanelAPI(this.ctx),
      system: new SystemAPI(this.ctx),
      tabs: new TabsAPI(this.ctx),
      webNavigation: new WebNavigationAPI(this.ctx),
      webSocket: new WebSocketAPI(this.ctx),
      windows: new WindowsAPI(this.ctx),
    }

    this.api.browserAction.actionClickInterceptor = (extensionId, tab) =>
      this.api.sidePanel.handleActionClick(extensionId, tab)

    this.listenForExtensions()
    this.prependPreload(opts.modulePath)
  }

  private listenForExtensions() {
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session

    // This library plus its consumers legitimately attach a dozen or so
    // listeners to session.extensions (one per API module), which trips
    // EventEmitter's default limit of 10 and logs a spurious leak warning.
    sessionExtensions.setMaxListeners?.(100)

    // Chrome reloads any open tabs showing an extension's pages when that
    // extension is reloaded — via chrome.runtime.reload(), an unpacked
    // reload, or an update. Electron doesn't: the old document survives with
    // an invalidated extension context (every native chrome.* getter returns
    // undefined), and a page that is still loading when the reload hits
    // commits into that dead context with no working chrome APIs at all.
    // This happens in practice: Dashlane's account-creation flow logs out
    // first, its "reloadOnLogout" background task calls
    // chrome.runtime.reload(), and the signup tab it just opened hangs
    // forever on its loading screen (diagnosed 2026-07-09). Track unloads
    // and reload the extension's tabs once it finishes loading again.
    const unloadedExtensionIds = new Set<string>()

    sessionExtensions.addListener('extension-unloaded', (_event, extension) => {
      unloadedExtensionIds.add(extension.id)
    })

    sessionExtensions.addListener('extension-loaded', (_event, extension) => {
      readLoadedExtensionManifest(this.ctx, extension)

      if (unloadedExtensionIds.delete(extension.id)) {
        for (const tab of this.ctx.store.tabs) {
          if (!tab.isDestroyed() && tab.getURL().startsWith(extension.url)) {
            this.reloadTabWhenIdle(tab)
          }
        }
      }
    })
  }

  // Reloading a tab while its own navigation is still in flight (e.g. an
  // extension page that calls chrome.runtime.reload() from a synchronous
  // <script> during its own initial parse, before the page has finished
  // loading) races Electron's internal navigation bookkeeping for that
  // WebContents and can surface an uncaught ERR_ABORTED. Defer the reload
  // until the current navigation settles instead of firing it immediately.
  private reloadTabWhenIdle(tab: Electron.WebContents) {
    if (!tab.isLoading()) {
      tab.reload()
      return
    }

    const onSettled = () => {
      tab.removeListener('did-finish-load', onSettled)
      tab.removeListener('did-fail-load', onSettled)
      if (!tab.isDestroyed()) tab.reload()
    }
    tab.once('did-finish-load', onSettled)
    tab.once('did-fail-load', onSettled)
  }

  private async prependPreload(modulePath?: string) {
    const { session } = this.ctx

    const preloadPath = resolvePreloadPath(modulePath)

    if ('registerPreloadScript' in session) {
      session.registerPreloadScript({
        id: 'crx-mv2-preload',
        type: 'frame',
        filePath: preloadPath,
      })
      session.registerPreloadScript({
        id: 'crx-mv3-preload',
        type: 'service-worker',
        filePath: preloadPath,
      })
    } else {
      // @ts-expect-error Deprecated electron@<35
      session.setPreloads([...session.getPreloads(), preloadPath])
    }

    if (!existsSync(preloadPath)) {
      console.error(
        new Error(
          `electron-chrome-extensions: Preload file not found at "${preloadPath}". ` +
            'See "Packaging the preload script" in the readme.',
        ),
      )
    }
  }

  private checkWebContentsArgument(wc: Electron.WebContents) {
    if (this.ctx.session !== wc.session) {
      throw new TypeError(
        'Invalid WebContents argument. Its session must match the session provided to ElectronChromeExtensions constructor options.',
      )
    }
  }

  /** Add webContents to be tracked as a tab. */
  addTab(tab: Electron.WebContents, window: Electron.BaseWindow) {
    this.checkWebContentsArgument(tab)
    this.ctx.store.addTab(tab, window)
  }

  /** Remove webContents from being tracked as a tab. */
  removeTab(tab: Electron.WebContents) {
    this.checkWebContentsArgument(tab)
    this.ctx.store.removeTab(tab)
  }

  /**
   * The user closed the side panel the embedder shows (its close button): closes it as
   * `sidePanel.close({windowId})` does, with `sidePanel.onClosed`. The library tells the embedder what
   * to show through the `'side-panel-show'` and `'side-panel-hide'` events.
   */
  closeSidePanel(windowId?: number) {
    this.api.sidePanel.closeFromEmbedder(windowId)
  }

  /** What the side panel of a window shows now (the last `'side-panel-show'`), or undefined. */
  getSidePanel(windowId?: number): SidePanelShowDetails | undefined {
    return this.api.sidePanel.getShown(windowId)
  }

  /** Notify extension system that the active tab has changed. */
  selectTab(tab: Electron.WebContents) {
    this.checkWebContentsArgument(tab)
    if (this.ctx.store.tabs.has(tab)) {
      this.api.tabs.onActivated(tab.id)
    }
  }

  /**
   * The commands an extension declared in its manifest, each with the shortcut it asks for.
   *
   * Here so an embedder can bind keyboard shortcuts for extensions: this library does not register
   * accelerators of its own, because they compete with the host application's and only the host knows
   * which ones it is willing to give up.
   * @see https://developer.chrome.com/docs/extensions/reference/api/commands
   */
  getCommands(extensionId: string) {
    return this.api.commands.getCommands(extensionId)
  }

  /**
   * Fire `chrome.commands.onCommand` for an extension, the way a keypress would.
   *
   * Returns false when the extension never declared that command, so a typo is distinguishable from a
   * delivered event. `_execute_action` is not dispatched: in Chrome it opens the popup, which is the
   * toolbar-click path the host already drives.
   */
  dispatchCommand(extensionId: string, command: string, tab?: chrome.tabs.Tab) {
    return this.api.commands.dispatch(extensionId, command, tab)
  }

  /**
   * Add webContents to be tracked as an extension host which will receive
   * extension events when a chrome-extension:// resource is loaded.
   *
   * This is usually reserved for extension background pages and popups, but
   * can also be used in other special cases.
   *
   * @deprecated Extension hosts are now tracked lazily when they send
   * extension IPCs to the main process.
   */
  addExtensionHost(host: Electron.WebContents) {
    console.warn('ElectronChromeExtensions.addExtensionHost() is deprecated')
  }

  /**
   * Get collection of menu items managed by the `chrome.contextMenus` API.
   * @see https://developer.chrome.com/extensions/contextMenus
   */
  getContextMenuItems(webContents: Electron.WebContents, params: Electron.ContextMenuParams) {
    this.checkWebContentsArgument(webContents)
    return this.api.contextMenus.buildMenuItemsForParams(webContents, params)
  }

  /**
   * Gets map of special pages to extension override URLs.
   *
   * @see https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/chrome_url_overrides
   */
  getURLOverrides(): Record<string, string> {
    return this.ctx.store.urlOverrides
  }

  /**
   * Handles the 'crx://' protocol in the session.
   *
   * @deprecated Call `ElectronChromeExtensions.handleCRXProtocol(session)`
   * instead. The CRX protocol is no longer one-to-one with
   * ElectronChromeExtensions instances. Instead, it should now be handled only
   * on the sessions where <browser-action-list> extension icons will be shown.
   */
  handleCRXProtocol(session: Electron.Session) {
    throw new Error(
      'extensions.handleCRXProtocol(session) is deprecated, call ElectronChromeExtensions.handleCRXProtocol(session) instead.',
    )
  }

  /**
   * Add extensions to be visible as an extension action button.
   *
   * @deprecated Not needed in Electron >=12.
   */
  addExtension(extension: Electron.Extension) {
    console.warn('ElectronChromeExtensions.addExtension() is deprecated')
    this.api.browserAction.processExtension(extension)
  }

  /**
   * Remove extensions from the list of visible extension action buttons.
   *
   * @deprecated Not needed in Electron >=12.
   */
  removeExtension(extension: Electron.Extension) {
    console.warn('ElectronChromeExtensions.removeExtension() is deprecated')
    this.api.browserAction.removeActions(extension.id)
  }
}
