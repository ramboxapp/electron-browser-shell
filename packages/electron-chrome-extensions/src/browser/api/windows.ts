import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { wakeExtensionServiceWorker } from '../patch/service-worker-wake'
import debug from 'debug'

const d = debug('electron-chrome-extensions:windows')

const getWindowState = (win: Electron.BaseWindow): chrome.windows.Window['state'] => {
  if (win.isMaximized()) return 'maximized'
  if (win.isMinimized()) return 'minimized'
  if (win.isFullScreen()) return 'fullscreen'
  return 'normal'
}

export class WindowsAPI {
  static WINDOW_ID_NONE = -1
  static WINDOW_ID_CURRENT = -2

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('windows.get', this.get.bind(this))
    // TODO: how does getCurrent differ from getLastFocused?
    handle('windows.getCurrent', this.getLastFocused.bind(this))
    handle('windows.getLastFocused', this.getLastFocused.bind(this))
    handle('windows.getAll', this.getAll.bind(this))
    handle('windows.create', this.create.bind(this))
    handle('windows.update', this.update.bind(this))
    handle('windows.remove', this.remove.bind(this))

    this.ctx.store.on('window-added', this.observeWindow.bind(this))
  }

  private observeWindow(window: Electron.BrowserWindow) {
    const windowId = window.id

    window.on('focus', () => {
      this.onFocusChanged(windowId)
    })

    window.on('resized', () => {
      this.onBoundsChanged(windowId)
    })

    window.once('closed', () => {
      this.ctx.store.windowDetailsCache.delete(windowId)
      this.ctx.store.removeWindow(window)
      this.onRemoved(windowId)
    })

    this.onCreated(windowId)

    d(`Observing window[${windowId}]`)
  }

  private createWindowDetails(win: Electron.BaseWindow) {
    const details: Partial<chrome.windows.Window> = {
      id: win.id,
      focused: win.isFocused(),
      top: win.getPosition()[1],
      left: win.getPosition()[0],
      width: win.getSize()[0],
      height: win.getSize()[1],
      tabs: Array.from(this.ctx.store.tabs)
        .filter((tab) => {
          const ownerWindow = this.ctx.store.tabToWindow.get(tab)
          return ownerWindow?.isDestroyed() ? false : ownerWindow?.id === win.id
        })
        .map((tab) => this.ctx.store.tabDetailsCache.get(tab.id) as chrome.tabs.Tab)
        .filter(Boolean),
      incognito: !this.ctx.session.isPersistent(),
      type: 'normal', // TODO
      state: getWindowState(win),
      alwaysOnTop: win.isAlwaysOnTop(),
      sessionId: 'default', // TODO
    }

    this.ctx.store.windowDetailsCache.set(win.id, details)
    return details
  }

  /**
   * A window's details, read now — never from a cache.
   *
   * These used to come from `windowDetailsCache`, filled the first time anything asked and refreshed
   * only on 'resized'. Everything in a window's details is live state — `focused`, `state`, the tabs
   * it holds — so the cache froze the answer at the moment the window was first seen. In Rambox that
   * moment is the first addTab() at boot, before any other app is registered and usually before the
   * window has focus, so every extension was told for the whole session that the window had no tabs
   * and was not focused. Grammarly 14.1342.0 does `windows.getCurrent().then(w => w.focused ?
   * getActiveTab() : none)`, so a frozen `focused: false` makes it decide there is no active tab.
   *
   * `tabs` is only included when the caller asks with `populate: true`, which is what Chrome does
   * (measured in Edge 156: `getAll()` has no `tabs` key, `getAll({ populate: true })` lists them).
   */
  private getWindowDetails(win: Electron.BaseWindow, queryOptions?: chrome.windows.QueryOptions) {
    const details = { ...this.createWindowDetails(win) }
    if (!queryOptions?.populate) delete details.tabs
    return details
  }

  private getWindowFromId(id: number) {
    if (id === WindowsAPI.WINDOW_ID_CURRENT) {
      return this.ctx.store.getCurrentWindow()
    } else {
      return this.ctx.store.getWindowById(id)
    }
  }

  private get(event: ExtensionEvent, windowId: number, queryOptions?: chrome.windows.QueryOptions) {
    const win = this.getWindowFromId(windowId)
    if (!win) return { id: WindowsAPI.WINDOW_ID_NONE }
    return this.getWindowDetails(win, queryOptions)
  }

  /**
   * Chrome never resolves these to null. `windows.getCurrent()` and `windows.getLastFocused()`
   * either give a window or reject ("No current window"), so extensions dereference the result
   * straight away — Grammarly 14.1339.0 does `getCurrent().then((w) => w.focused)` from inside its
   * own `windows.onFocusChanged` handler and dies on the dereference. Resolving null is a shape
   * Chrome never produces, so nobody guards against it.
   *
   * An embedder can legitimately have windows but no FOCUSED one: Rambox registers a window with
   * the extensions layer lazily, and until then nothing is "last focused" while the app plainly has
   * a window. Falling back to any known window keeps the common case working and keeps the answer
   * truthful. With no window at all, Chrome would reject — which is not reachable from here, for
   * the reason the comment below the fallback gives.
   */
  private getLastFocused(event: ExtensionEvent, queryOptions?: chrome.windows.QueryOptions) {
    const win =
      this.ctx.store.getLastFocusedWindow() ?? this.ctx.store.windows.values().next().value
    // Same shape `get()` answers with above when it cannot find the window, and for the same reason:
    // throwing here does not reach the caller as a rejection — the result comes back `undefined`,
    // which crashes the extension exactly like the `null` this replaced. A window-shaped object with
    // no id lets `w.focused` read false and the extension carry on.
    if (!win) return { id: WindowsAPI.WINDOW_ID_NONE, focused: false }
    return this.getWindowDetails(win, queryOptions)
  }

  private getAll(event: ExtensionEvent, queryOptions?: chrome.windows.QueryOptions) {
    return Array.from(this.ctx.store.windows).map((win) => this.getWindowDetails(win, queryOptions))
  }

  private async create(event: ExtensionEvent, details: chrome.windows.CreateData) {
    // See service-worker-wake.ts: the new window's page is likely to message
    // this extension shortly after loading, which can hang if its service
    // worker went idle — wake it before the consumer's createWindow() runs.
    await wakeExtensionServiceWorker(this.ctx.session, event.extension.id)
    const win = await this.ctx.store.createWindow(event, details)
    return this.getWindowDetails(win, { populate: true })
  }

  private async update(
    event: ExtensionEvent,
    windowId: number,
    updateProperties: chrome.windows.UpdateInfo = {},
  ) {
    const win = this.getWindowFromId(windowId)
    if (!win) return

    const props = updateProperties

    if (props.state) {
      switch (props.state) {
        case 'maximized':
          win.maximize()
          break
        case 'minimized':
          win.minimize()
          break
        case 'normal': {
          if (win.isMinimized() || win.isMaximized()) {
            win.restore()
          }
          break
        }
      }
    }

    return this.createWindowDetails(win)
  }

  private async remove(event: ExtensionEvent, windowId: number = WindowsAPI.WINDOW_ID_CURRENT) {
    const win = this.getWindowFromId(windowId)
    if (!win) return
    const removedWindowId = win.id
    await this.ctx.store.removeWindow(win)
    this.onRemoved(removedWindowId)
  }

  onCreated(windowId: number) {
    const window = this.ctx.store.getWindowById(windowId)
    if (!window) return
    const windowDetails = this.getWindowDetails(window)
    this.ctx.router.broadcastEvent('windows.onCreated', windowDetails)
  }

  onRemoved(windowId: number) {
    this.ctx.router.broadcastEvent('windows.onRemoved', windowId)
  }

  onFocusChanged(windowId: number) {
    if (this.ctx.store.lastFocusedWindowId === windowId) return

    this.ctx.store.lastFocusedWindowId = windowId
    this.ctx.router.broadcastEvent('windows.onFocusChanged', windowId)
  }

  onBoundsChanged(windowId: number) {
    const window = this.ctx.store.getWindowById(windowId)
    if (!window) return
    const windowDetails = this.createWindowDetails(window)
    this.ctx.router.broadcastEvent('windows.onBoundsChanged', windowDetails)
  }
}
