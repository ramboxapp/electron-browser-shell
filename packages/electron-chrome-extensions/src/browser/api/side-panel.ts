import { app, webContents as allWebContents } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { SessionStateFile } from './lib/session-state'
import debug from 'debug'

const d = debug('electron-chrome-extensions:sidePanel')

/** What `sidePanel.getOptions` answers: Chrome's `PanelOptions`. */
interface PanelOptions {
  enabled?: boolean
  path?: string
  tabId?: number
}

interface PanelBehavior {
  openPanelOnActionClick?: boolean
}

/** The key of one panel document: the extension's global panel, or the one of a tab. */
type DocumentKey = 'global' | number

/** The extension whose panel a window shows, and the documents it has opened in it. */
interface OpenPanel {
  extensionId: string
  /** The path each open document was opened with. */
  documents: Map<DocumentKey, string>
  /** What the embedder was last told to show, so a repeat is not re-sent. */
  shown?: { key: DocumentKey; url: string }
}

/** What the embedder gets in `'side-panel-show'`: one document of one extension, in one window. */
export interface SidePanelShowDetails {
  extensionId: string
  windowId: number
  /** The tab the document belongs to, when the extension set options for that tab. */
  tabId?: number
  /** The path as the extension gave it (`popup/index.html?uilocation=sidepanel`). */
  path: string
  /** The full `chrome-extension://` URL to load. */
  url: string
}

export interface SidePanelHideDetails {
  extensionId: string
  windowId: number
}

/**
 * How long a user gesture lets `sidePanel.open()` through. Chrome checks the caller's transient user
 * activation, which lasts five seconds in Chromium (and is forwarded with `runtime.sendMessage` from a
 * content script: that is how HubSpot opens its panel from a click in Gmail). The library cannot read
 * a renderer's activation from the main process, so it counts a gesture as either a user-initiated
 * event it dispatched to the extension (action click, context menu, command, notification) or a real
 * input (mouse down, key down, touch) in any page of the session, within that window. That is looser
 * than Chrome — any recent input in the session counts, not only one in the calling frame — and never
 * stricter, which is the side that does not break an extension.
 */
const GESTURE_LIFESPAN_MS = 5000
const GESTURE_INPUT_TYPES = new Set([
  'mouseDown',
  'keyDown',
  'rawKeyDown',
  'touchStart',
  'gestureTap',
])

const GESTURE_ERROR = '`sidePanel.open()` may only be called in response to a user gesture.'

/**
 * chrome.sidePanel: the extension's panel state (global and per tab, as Chrome keeps it), the action
 * click behavior, open/close with Chrome's errors and events, and the `SIDE_PANEL` context.
 *
 * The library has no panel UI. It tells the embedder what to show through two events on the
 * `ElectronChromeExtensions` instance, `'side-panel-show'` (a URL to load for a window) and
 * `'side-panel-hide'`, and the embedder reports a user closing it with `closeSidePanel(windowId)`.
 * The embedder's view of the panel is reported as `SIDE_PANEL` in `runtime.getContexts()`: any
 * non-tab webview of the session showing the extension's open panel document.
 *
 * Measured against Chromium 147 on 29/10/2026 (and the action click through `Extensions.triggerAction`):
 * - `getOptions({})` is the global options; `getOptions({tabId})` merges the tab's over the global ones
 *   and adds `tabId`, or answers the global ones when the tab has none. Neither checks the tab exists.
 * - `setOptions` validates nothing: an unknown tab or a missing file resolves.
 * - `open()` without a gesture fails with the gesture error before any other check.
 * - `onOpened` fires once per document, with the document's pathname, `windowId` and, for a tab's own
 *   panel, `tabId`. Switching tabs while the panel is open opens the other tab's document (the global
 *   one if it has none of its own), and keeps the old one alive: switching back fires nothing.
 * - `onClosed` fires on `close()`, on disabling an open document, and when its tab is removed.
 * - With `openPanelOnActionClick`, an action click toggles the panel and neither the popup nor
 *   `action.onClicked` runs. With the panel disabled for the tab, the click goes to the popup or
 *   `onClicked` as usual.
 */
export class SidePanelAPI {
  private globalOptions = new Map<string, PanelOptions>()
  private tabOptions = new Map<string, Map<number, PanelOptions>>()
  private behavior: SessionStateFile<Record<string, PanelBehavior>>
  /** The open panel of each window, by window id. */
  private open = new Map<number, OpenPanel>()

  private gestureAt = new Map<string, number>()
  private sessionInputAt = 0

  constructor(private ctx: ExtensionContext) {
    // Chrome keeps the action-click behavior in the extension's prefs, so it survives a restart: an
    // extension that sets it once in onInstalled keeps it. The options are in memory, as in Chrome.
    this.behavior = new SessionStateFile(ctx.session, 'side-panel-behavior', () => ({}))

    const handle = this.ctx.router.apiHandler()
    handle('sidePanel.getOptions', this.getOptions)
    handle('sidePanel.setOptions', this.setOptions)
    handle('sidePanel.getPanelBehavior', this.getPanelBehavior)
    handle('sidePanel.setPanelBehavior', this.setPanelBehavior)
    handle('sidePanel.open', this.openPanel)
    handle('sidePanel.close', this.closePanel)
    handle('sidePanel.getLayout', () => ({ side: 'right' }))

    this.trackInput()
    this.ctx.store.on('user-gesture', (extensionId: string) => this.noteUserGesture(extensionId))
    this.ctx.store.isSidePanelContents = (wc, extensionId) => this.isPanelContents(wc, extensionId)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.forgetExtension(extension.id)
    })

    this.ctx.store.on(
      'active-tab-changed',
      (_tab: Electron.WebContents, win: Electron.BaseWindow) => {
        if (win && !win.isDestroyed()) this.refresh(win.id)
      },
    )
    this.ctx.store.on('tab-removed', (tabId: number) => this.onTabRemoved(tabId))
  }

  // --- the user gesture --------------------------------------------------------------------------

  /** Marks a user-initiated event dispatched to an extension: it may open its panel now. */
  noteUserGesture(extensionId: string) {
    this.gestureAt.set(extensionId, Date.now())
  }

  private hasUserGesture(extensionId: string) {
    const now = Date.now()
    const own = this.gestureAt.get(extensionId) ?? 0
    return now - own <= GESTURE_LIFESPAN_MS || now - this.sessionInputAt <= GESTURE_LIFESPAN_MS
  }

  private trackInput() {
    const watch = (wc: Electron.WebContents) => {
      if (wc.isDestroyed() || wc.session !== this.ctx.session) return
      wc.on('input-event', (_event, input) => {
        if (GESTURE_INPUT_TYPES.has(input.type)) this.sessionInputAt = Date.now()
      })
    }
    for (const wc of allWebContents.getAllWebContents()) watch(wc)
    app.on('web-contents-created', (_event, wc) => watch(wc))
  }

  // --- options and behavior ------------------------------------------------------------------------

  private manifestPath(extensionId: string): string | undefined {
    const extension = this.ctx.session.extensions.getExtension(extensionId)
    const sidePanel = (extension?.manifest as any)?.side_panel
    return typeof sidePanel?.default_path === 'string' ? sidePanel.default_path : undefined
  }

  private global(extensionId: string): PanelOptions {
    let options = this.globalOptions.get(extensionId)
    if (!options) {
      const path = this.manifestPath(extensionId)
      // Chrome: a manifest with side_panel.default_path starts enabled with that path; without one,
      // enabled with no path (nothing to show until setOptions gives one).
      options = { enabled: true, ...(path !== undefined && { path }) }
      this.globalOptions.set(extensionId, options)
    }
    return options
  }

  private tabsOf(extensionId: string) {
    let tabs = this.tabOptions.get(extensionId)
    if (!tabs) {
      tabs = new Map()
      this.tabOptions.set(extensionId, tabs)
    }
    return tabs
  }

  /** The options that apply to a tab: the tab's own over the global ones. */
  private resolve(extensionId: string, tabId?: number) {
    const global = this.global(extensionId)
    const own = typeof tabId === 'number' ? this.tabOptions.get(extensionId)?.get(tabId) : undefined
    const merged = { ...global, ...own }
    return {
      key: (own ? tabId : 'global') as DocumentKey,
      enabled: merged.enabled !== false && typeof merged.path === 'string' && merged.path !== '',
      path: merged.path,
    }
  }

  private getOptions = ({ extension }: ExtensionEvent, options?: { tabId?: number }) => {
    if (!options || typeof options !== 'object') {
      throw new Error(
        'Error in invocation of sidePanel.getOptions(sidePanel.GetPanelOptions options, function callback): No matching signature.',
      )
    }
    const global = this.global(extension.id)
    const own =
      typeof options.tabId === 'number'
        ? this.tabOptions.get(extension.id)?.get(options.tabId)
        : undefined
    if (!own) return { ...global }
    return { ...global, ...own, tabId: options.tabId }
  }

  private setOptions = ({ extension }: ExtensionEvent, options: PanelOptions = {}) => {
    const { tabId, ...rest } = options || {}
    const update: PanelOptions = {}
    if (typeof rest.enabled === 'boolean') update.enabled = rest.enabled
    if (typeof rest.path === 'string') update.path = rest.path

    if (typeof tabId === 'number') {
      const tabs = this.tabsOf(extension.id)
      tabs.set(tabId, { ...tabs.get(tabId), ...update })
    } else {
      this.globalOptions.set(extension.id, { ...this.global(extension.id), ...update })
    }
    this.onOptionsChanged(extension.id)
  }

  private getPanelBehavior = ({ extension }: ExtensionEvent) => ({
    openPanelOnActionClick: this.behavior.get()[extension.id]?.openPanelOnActionClick === true,
  })

  private setPanelBehavior = ({ extension }: ExtensionEvent, behavior: PanelBehavior = {}) => {
    if (typeof behavior?.openPanelOnActionClick !== 'boolean') return
    const record = this.behavior.get()
    this.behavior.set({
      ...record,
      [extension.id]: { openPanelOnActionClick: behavior.openPanelOnActionClick },
    })
  }

  // --- open and close ------------------------------------------------------------------------------

  private target(details: { tabId?: number; windowId?: number } | undefined) {
    const { tabId, windowId } = details || {}
    if (typeof tabId !== 'number' && typeof windowId !== 'number') {
      throw new Error('At least one of `tabId` and `windowId` must be provided')
    }
    if (typeof tabId === 'number') {
      const tab = this.ctx.store.getTabById(tabId)
      if (!tab) throw new Error(`No tab with id: ${tabId}.`)
      const win = this.ctx.store.tabToWindow.get(tab)
      if (!win || win.isDestroyed()) throw new Error(`No tab with id: ${tabId}.`)
      return { tabId, windowId: win.id }
    }
    const win = this.ctx.store.getWindowById(windowId!)
    if (!win) throw new Error(`No window with id: ${windowId}.`)
    return { tabId: undefined, windowId: win.id }
  }

  private openPanel = (
    { extension }: ExtensionEvent,
    details?: { tabId?: number; windowId?: number },
  ) => {
    if (!this.hasUserGesture(extension.id)) throw new Error(GESTURE_ERROR)
    const target = this.target(details)
    const resolved = this.resolve(extension.id, target.tabId)
    if (!resolved.enabled) {
      throw new Error(
        typeof target.tabId === 'number'
          ? `No active side panel for tabId: ${target.tabId}`
          : `No active side panel for windowId: ${target.windowId}`,
      )
    }
    this.openFor(extension.id, target.windowId, target.tabId)
  }

  private closePanel = (
    { extension }: ExtensionEvent,
    details?: { tabId?: number; windowId?: number },
  ) => {
    const target = this.target(details)
    const panel = this.open.get(target.windowId)
    if (!panel || panel.extensionId !== extension.id) return
    if (typeof target.tabId === 'number' && panel.documents.has(target.tabId)) {
      this.closeDocument(target.windowId, target.tabId)
    } else {
      this.closeWindow(target.windowId)
    }
  }

  /**
   * Opens an extension's panel in a window, with the document of the given tab (or of the window's
   * active tab). Another extension's panel in that window closes, as Chrome shows one entry at a time.
   */
  private openFor(extensionId: string, windowId: number, tabId?: number) {
    const current = this.open.get(windowId)
    if (current && current.extensionId !== extensionId) this.closeWindow(windowId)
    if (!this.open.has(windowId)) {
      this.open.set(windowId, { extensionId, documents: new Map() })
    }
    if (typeof tabId === 'number') this.ensureDocument(windowId, tabId)
    this.refresh(windowId)
  }

  /** Opens the document a tab shows, once, firing `onOpened` the first time. */
  private ensureDocument(windowId: number, tabId?: number) {
    const panel = this.open.get(windowId)
    if (!panel) return undefined
    const resolved = this.resolve(panel.extensionId, tabId)
    if (!resolved.enabled) return undefined
    if (!panel.documents.has(resolved.key)) {
      panel.documents.set(resolved.key, resolved.path!)
      this.dispatch(panel.extensionId, 'sidePanel.onOpened', windowId, resolved.key, resolved.path!)
    }
    return resolved
  }

  private closeDocument(windowId: number, key: DocumentKey, { quiet = false } = {}) {
    const panel = this.open.get(windowId)
    if (!panel) return
    const path = panel.documents.get(key)
    if (path === undefined) return
    panel.documents.delete(key)
    if (!quiet) this.dispatch(panel.extensionId, 'sidePanel.onClosed', windowId, key, path)
    if (panel.documents.size === 0) {
      this.open.delete(windowId)
      this.hide(windowId, panel)
    } else {
      this.refresh(windowId)
    }
  }

  private closeWindow(windowId: number, { quiet = false } = {}) {
    const panel = this.open.get(windowId)
    if (!panel) return
    const keys = Array.from(panel.documents.keys()).sort((a, b) =>
      a === 'global' ? -1 : b === 'global' ? 1 : 0,
    )
    for (const key of keys) {
      const path = panel.documents.get(key)!
      panel.documents.delete(key)
      if (!quiet) this.dispatch(panel.extensionId, 'sidePanel.onClosed', windowId, key, path)
    }
    this.open.delete(windowId)
    this.hide(windowId, panel)
  }

  /** Tells the embedder what a window should show now, for its active tab. */
  private refresh(windowId: number) {
    const panel = this.open.get(windowId)
    if (!panel) return
    const win = this.ctx.store.getWindowById(windowId)
    const activeTab = win ? this.ctx.store.getActiveTabFromWindow(win) : undefined
    const resolved = this.ensureDocument(windowId, activeTab?.id)
    if (!resolved) {
      // Disabled for this tab: nothing to show here, the documents of other tabs stay open.
      if (panel.shown) {
        panel.shown = undefined
        this.ctx.emit('side-panel-hide', { extensionId: panel.extensionId, windowId })
      }
      return
    }
    const path = panel.documents.get(resolved.key)!
    const extension = this.ctx.session.extensions.getExtension(panel.extensionId)
    if (!extension) return
    const url = new URL(path, extension.url).href
    if (!url.startsWith(extension.url)) {
      d('refusing to show %s for %s: not an extension page', url, panel.extensionId)
      return
    }
    if (panel.shown?.key === resolved.key && panel.shown.url === url) return
    panel.shown = { key: resolved.key, url }
    const details: SidePanelShowDetails = {
      extensionId: panel.extensionId,
      windowId,
      ...(typeof resolved.key === 'number' && { tabId: resolved.key }),
      path,
      url,
    }
    d('show %o', details)
    this.ctx.emit('side-panel-show', details)
  }

  private hide(windowId: number, panel: OpenPanel) {
    panel.shown = undefined
    const details: SidePanelHideDetails = { extensionId: panel.extensionId, windowId }
    d('hide %o', details)
    this.ctx.emit('side-panel-hide', details)
  }

  private dispatch(
    extensionId: string,
    eventName: string,
    windowId: number,
    key: DocumentKey,
    path: string,
  ) {
    const extension = this.ctx.session.extensions.getExtension(extensionId)
    // Chrome reports the document's pathname: "/panel.html" for "panel.html?x=1#y".
    const pathname = extension ? new URL(path, extension.url).pathname : `/${path}`
    this.ctx.router.sendEvent(extensionId, eventName, {
      path: pathname,
      ...(typeof key === 'number' && { tabId: key }),
      windowId,
    })
  }

  /** An options change: open documents follow a new path, and a disabled one closes. */
  private onOptionsChanged(extensionId: string) {
    for (const [windowId, panel] of Array.from(this.open)) {
      if (panel.extensionId !== extensionId) continue
      for (const [key, path] of Array.from(panel.documents)) {
        const resolved = this.resolve(extensionId, key === 'global' ? undefined : key)
        // A tab whose own options were just set shows its own document from now on; its global
        // document stays open for the other tabs, as in Chrome.
        if (resolved.key !== key) continue
        // A path given with the change is the document's path from now on, also for the onClosed of
        // a `setOptions({path, enabled: false})` (Chromium 147 reports the new path).
        if (typeof resolved.path === 'string' && resolved.path !== path) {
          panel.documents.set(key, resolved.path)
        }
        if (!resolved.enabled) this.closeDocument(windowId, key)
      }
      if (this.open.has(windowId)) this.refresh(windowId)
    }
  }

  private onTabRemoved(tabId: number) {
    for (const [windowId, panel] of Array.from(this.open)) {
      if (panel.documents.has(tabId)) this.closeDocument(windowId, tabId)
    }
    for (const tabs of this.tabOptions.values()) tabs.delete(tabId)
  }

  private forgetExtension(extensionId: string) {
    for (const [windowId, panel] of Array.from(this.open)) {
      if (panel.extensionId === extensionId) this.closeWindow(windowId, { quiet: true })
    }
    this.globalOptions.delete(extensionId)
    this.tabOptions.delete(extensionId)
    this.gestureAt.delete(extensionId)
  }

  // --- the embedder's side ---------------------------------------------------------------------------

  /**
   * The action click: with `openPanelOnActionClick` and a panel enabled for the tab, toggles the panel
   * and answers true (the popup and `onClicked` do not run). Otherwise answers false.
   */
  handleActionClick(extensionId: string, tab: Electron.WebContents): boolean {
    if (this.behavior.get()[extensionId]?.openPanelOnActionClick !== true) return false
    if (!this.resolve(extensionId, tab.id).enabled) return false
    const win = this.ctx.store.tabToWindow.get(tab)
    if (!win || win.isDestroyed()) return false
    const panel = this.open.get(win.id)
    if (panel && panel.extensionId === extensionId && panel.shown) {
      this.closeWindow(win.id)
    } else {
      this.noteUserGesture(extensionId)
      this.openFor(extensionId, win.id, tab.id)
    }
    return true
  }

  /** The embedder closed the panel (its close button): as `sidePanel.close({windowId})`. */
  closeFromEmbedder(windowId?: number) {
    const id = windowId ?? this.ctx.store.getCurrentWindow()?.id
    if (typeof id === 'number') this.closeWindow(id)
  }

  /** What a window shows now, for an embedder that renders after the fact. */
  getShown(windowId?: number): SidePanelShowDetails | undefined {
    const id = windowId ?? this.ctx.store.getCurrentWindow()?.id
    if (typeof id !== 'number') return undefined
    const panel = this.open.get(id)
    if (!panel?.shown) return undefined
    return {
      extensionId: panel.extensionId,
      windowId: id,
      ...(typeof panel.shown.key === 'number' && { tabId: panel.shown.key }),
      path: panel.documents.get(panel.shown.key)!,
      url: panel.shown.url,
    }
  }

  /** Whether a webContents is the embedder's view of an open panel document (for `getContexts`). */
  isPanelContents(wc: Electron.WebContents, extensionId: string): boolean {
    if (this.ctx.store.tabs.has(wc)) return false
    const type = wc.getType()
    if (type !== 'webview' && type !== 'browserView' && type !== 'window') return false
    let url: string
    try {
      url = wc.getURL()
    } catch {
      return false
    }
    for (const panel of this.open.values()) {
      if (panel.extensionId !== extensionId || !panel.shown) continue
      if (stripHash(panel.shown.url) === stripHash(url)) return true
    }
    return false
  }
}

const stripHash = (url: string) => url.split('#')[0]
