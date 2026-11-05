import { BrowserWindow, webContents } from 'electron'
import { EventEmitter } from 'node:events'
import { ContextMenuType } from './api/common'
import { ChromeExtensionImpl } from './impl'
import { ExtensionEvent } from './router'

export class ExtensionStore extends EventEmitter {
  /** Tabs observed by the extensions system. */
  tabs = new Set<Electron.WebContents>()

  /** Windows observed by the extensions system. */
  windows = new Set<Electron.BaseWindow>()

  lastFocusedWindowId?: number

  /**
   * Map of tabs to their parent window.
   *
   * It's not possible to access the parent of a BrowserView so we must manage
   * this ourselves.
   */
  tabToWindow = new WeakMap<Electron.WebContents, Electron.BaseWindow>()

  /** Map of windows to their active tab. */
  private windowToActiveTab = new WeakMap<Electron.BaseWindow, Electron.WebContents>()

  tabDetailsCache = new Map<number, Partial<chrome.tabs.Tab>>()
  windowDetailsCache = new Map<number, Partial<chrome.windows.Window>>()

  urlOverrides: Record<string, string> = {}

  /**
   * The extension documents that are not tabs, by what Chromium calls them in
   * `runtime.getContexts()`. Anything else showing an extension URL is reported as a TAB.
   */
  extensionContextTypes = new WeakMap<Electron.WebContents, 'POPUP' | 'OFFSCREEN_DOCUMENT'>()

  /**
   * Whether a webContents is the embedder's view of an extension's open side panel, reported as
   * SIDE_PANEL by `runtime.getContexts()`. Set by the sidePanel API.
   */
  isSidePanelContents: (wc: Electron.WebContents, extensionId: string) => boolean = () => false

  /**
   * A user-initiated event reached an extension (action click, context menu, command, notification):
   * what lets it call `sidePanel.open()`, as Chrome's user gesture does.
   */
  noteUserGesture(extensionId: string) {
    this.emit('user-gesture', extensionId)
  }

  /**
   * A user action reached an extension ON a tab — the action click, a context menu item, a keyboard
   * command — which is what grants Chrome's `activeTab` for that tab: the one thing that lets the
   * extension capture it (`tabCapture.getMediaStreamId`). Listened to by the desktopCapture API.
   */
  noteInvocation(extensionId: string, tab: Electron.WebContents) {
    this.emit('invoked', extensionId, tab)
  }

  /**
   * The type a window was created with through `windows.create` (`'popup'` for a popup or a panel,
   * as Chrome reports both). Windows the embedder registers itself are `'normal'`.
   */
  windowTypes = new Map<number, 'normal' | 'popup'>()

  constructor(public impl: ChromeExtensionImpl) {
    super()
  }

  getWindowById(windowId: number) {
    return Array.from(this.windows).find(
      (window) => !window.isDestroyed() && window.id === windowId,
    )
  }

  getLastFocusedWindow() {
    return this.lastFocusedWindowId ? this.getWindowById(this.lastFocusedWindowId) : null
  }

  getCurrentWindow() {
    return this.getLastFocusedWindow()
  }

  addWindow(window: Electron.BaseWindow) {
    if (this.windows.has(window)) return

    this.windows.add(window)

    if (typeof this.lastFocusedWindowId !== 'number') {
      this.lastFocusedWindowId = window.id
    }

    this.emit('window-added', window)
  }

  async createWindow(event: ExtensionEvent, details: chrome.windows.CreateData) {
    if (typeof this.impl.createWindow !== 'function') {
      throw new Error('createWindow is not implemented')
    }

    const win = await this.impl.createWindow(details)

    this.addWindow(win)

    return win
  }

  async removeWindow(window: Electron.BaseWindow) {
    if (!this.windows.has(window)) return

    this.windows.delete(window)
    this.windowTypes.delete(window.id)
    this.forgetFocusedWindow(window)

    if (typeof this.impl.removeWindow === 'function') {
      await this.impl.removeWindow(window)
    } else {
      window.destroy()
    }
  }

  /**
   * Hands "last focused" to a window that is still observed when the one holding it goes away, as
   * Chrome moves focus to the next window. Otherwise every "current window" lookup — the action
   * click, `tabs.query({ currentWindow: true })`, `windows.getCurrent()` — kept answering with a
   * window that no longer existed, until some other window happened to take focus.
   */
  private forgetFocusedWindow(window: Electron.BaseWindow) {
    if (!window || this.lastFocusedWindowId !== window.id) return
    const candidates = Array.from(this.windows).filter((other) => !other.isDestroyed())
    const withActiveTab = candidates.filter((other) => this.getActiveTabFromWindow(other))
    const next = withActiveTab[withActiveTab.length - 1] || candidates[candidates.length - 1]
    this.lastFocusedWindowId = next?.id
  }

  getTabById(tabId: number) {
    return Array.from(this.tabs).find((tab) => !tab.isDestroyed() && tab.id === tabId)
  }

  /** What `windows.Window.type` reports for a window. */
  getWindowType(window: Electron.BaseWindow): 'normal' | 'popup' {
    return this.windowTypes.get(window.id) ?? 'normal'
  }

  /**
   * A window's tabs, in their order: the order they were registered in, as the embedder's tab
   * strip has no order the library can read, changed only by `tabs.move`. A tab's `index` is its
   * position here, as in Chrome, where it is the position within its own window.
   */
  getTabsOfWindow(window: Electron.BaseWindow | undefined) {
    if (!window) return []
    return Array.from(this.tabs).filter(
      (tab) => !tab.isDestroyed() && this.tabToWindow.get(tab) === window,
    )
  }

  getTabIndex(tab: Electron.WebContents) {
    return this.getTabsOfWindow(this.tabToWindow.get(tab)).indexOf(tab)
  }

  /**
   * Puts a tab at `toIndex` within its window, keeping the other windows' tabs where they were.
   * The set is rebuilt in place, not replaced, because callers hold on to `tabs`.
   */
  moveTabWithinWindow(tab: Electron.WebContents, toIndex: number) {
    const window = this.tabToWindow.get(tab)
    const siblings = this.getTabsOfWindow(window).filter((other) => other !== tab)
    siblings.splice(Math.max(0, Math.min(toIndex, siblings.length)), 0, tab)
    const ordered: Electron.WebContents[] = []
    let next = 0
    for (const other of this.tabs) {
      const sameWindow = !other.isDestroyed() && this.tabToWindow.get(other) === window
      ordered.push(sameWindow ? siblings[next++] : other)
    }
    this.tabs.clear()
    for (const other of ordered) this.tabs.add(other)
  }

  addTab(tab: Electron.WebContents, window: Electron.BaseWindow) {
    if (this.tabs.has(tab)) return

    this.tabs.add(tab)
    this.tabToWindow.set(tab, window)
    this.addWindow(window)

    this.emit('tab-added', tab)

    // The first tab of a window is its active one. After 'tab-added', so an extension hears
    // tabs.onCreated before the tabs.onActivated this announces (see 'active-tab-changed' in TabsAPI),
    // as in Chrome.
    if (!this.getActiveTabFromWebContents(tab)) {
      this.setActiveTab(tab)
    }
  }

  removeTab(tab: Electron.WebContents) {
    if (!this.tabs.has(tab)) return

    const tabId = tab.id
    const win = this.tabToWindow.get(tab)!

    this.tabs.delete(tab)
    this.tabToWindow.delete(tab)

    const remainingTabs = Array.from(this.tabs).filter(
      (other) => !other.isDestroyed() && this.tabToWindow.get(other) === win,
    )

    // A removed tab cannot stay its window's active tab: Chrome activates another tab of the same
    // window. Without this the window kept answering with the removed tab — or, once it was
    // destroyed, with nothing — and a click on an extension icon failed with "Unable to get active
    // tab".
    if (win && this.windowToActiveTab.get(win) === tab) {
      const next = remainingTabs[remainingTabs.length - 1]
      if (next) {
        this.setActiveTab(next)
      } else {
        this.windowToActiveTab.delete(win)
      }
    }

    // Clear window if it has no remaining tabs
    if (remainingTabs.length === 0) {
      this.windows.delete(win)
      this.forgetFocusedWindow(win)
    }

    if (typeof this.impl.removeTab === 'function') {
      this.impl.removeTab(tab, win)
    }

    this.emit('tab-removed', tabId)
  }

  async createTab(details: chrome.tabs.CreateProperties) {
    if (typeof this.impl.createTab !== 'function') {
      throw new Error('createTab is not implemented')
    }

    // Fallback to current window
    if (!details.windowId) {
      details.windowId = this.lastFocusedWindowId
    }

    const result = await this.impl.createTab(details)

    if (!Array.isArray(result)) {
      throw new Error('createTab must return an array of [tab, window]')
    }

    const [tab, window] = result

    if (typeof tab !== 'object' || !webContents.fromId(tab.id)) {
      throw new Error('createTab must return a WebContents')
    } else if (typeof window !== 'object') {
      throw new Error('createTab must return a BrowserWindow')
    }

    this.addTab(tab, window)

    return tab
  }

  getActiveTabFromWindow(win: Electron.BaseWindow) {
    const activeTab = win && !win.isDestroyed() && this.windowToActiveTab.get(win)
    return (activeTab && !activeTab.isDestroyed() && activeTab) || undefined
  }

  getActiveTabFromWebContents(wc: Electron.WebContents): Electron.WebContents | undefined {
    const win = this.tabToWindow.get(wc) || BrowserWindow.fromWebContents(wc)
    const activeTab = win ? this.getActiveTabFromWindow(win) : undefined
    return activeTab
  }

  getActiveTabOfCurrentWindow() {
    const win = this.getCurrentWindow()
    return win ? this.getActiveTabFromWindow(win) : undefined
  }

  setActiveTab(tab: Electron.WebContents) {
    const win = this.tabToWindow.get(tab)
    if (!win) {
      throw new Error('Active tab has no parent window')
    }

    const prevActiveTab = this.getActiveTabFromWebContents(tab)

    this.windowToActiveTab.set(win, tab)

    if (tab.id !== prevActiveTab?.id) {
      this.emit('active-tab-changed', tab, win)

      if (typeof this.impl.selectTab === 'function') {
        this.impl.selectTab(tab, win)
      }
    }
  }

  buildMenuItems(extensionId: string, menuType: ContextMenuType): Electron.MenuItem[] {
    // This function is overwritten by ContextMenusAPI
    return []
  }

  async requestPermissions(
    extension: Electron.Extension,
    permissions: chrome.permissions.Permissions,
  ) {
    if (typeof this.impl.requestPermissions !== 'function') {
      // Default to allowed.
      return true
    }
    const result: unknown = await this.impl.requestPermissions(extension, permissions)
    return typeof result === 'boolean' ? result : false
  }
}
