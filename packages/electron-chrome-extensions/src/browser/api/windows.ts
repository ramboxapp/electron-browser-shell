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
    handle('windows.getCurrent', this.getCurrent.bind(this))
    handle('windows.getLastFocused', this.getLastFocused.bind(this))
    handle('windows.getAll', this.getAll.bind(this))
    handle('windows.create', this.create.bind(this))
    handle('windows.update', this.update.bind(this))
    handle('windows.remove', this.remove.bind(this))

    this.ctx.store.on('window-added', this.observeWindow.bind(this))
    this.ctx.store.on('window-focused', this.onFocusChanged.bind(this))
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
      // 'popup' for a window an extension opened as one, 'normal' for the rest.
      type: this.ctx.store.getWindowType(win),
      state: getWindowState(win),
      alwaysOnTop: win.isAlwaysOnTop(),
      // No `sessionId`: Chrome only gives one to a window chrome.sessions can restore, and there are
      // none here. It used to be 'default' on every window, a field Chrome never sends (measured in
      // Edge 156 and Chromium 147: ten fields, this was the eleventh).
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

  /*
    A window that is not there fails with Chrome's message. It used to answer `{ id: -1 }`, written
    when a failure in the main process could not reach the extension as a rejection (it came back
    `undefined`); now that it does, the honest answer is Chrome's. `WINDOW_ID_CURRENT` keeps the
    fallback getLastFocused documents, since Chrome always has a current window to give.
  */
  private get(event: ExtensionEvent, windowId: number, queryOptions?: chrome.windows.QueryOptions) {
    if (windowId === WindowsAPI.WINDOW_ID_CURRENT) return this.getCurrent(event, queryOptions)
    const win = this.getWindowFromId(windowId)
    if (!win) throw new Error(`No window with id: ${windowId}.`)
    return this.getWindowDetails(win, queryOptions)
  }

  private windowOrThrow(windowId: number) {
    const win = this.getWindowFromId(windowId)
    if (!win || win.isDestroyed()) throw new Error(`No window with id: ${windowId}.`)
    return win
  }

  /**
   * The window the calling code runs in: for a page that is a tab, that tab's window; for anything
   * else (the worker, a popup), the last focused one — which is what Chrome answers there too.
   */
  private getCurrent(event: ExtensionEvent, queryOptions?: chrome.windows.QueryOptions) {
    if (event.type === 'frame' && this.ctx.store.tabs.has(event.sender)) {
      const win = this.ctx.store.tabToWindow.get(event.sender)
      if (win && !win.isDestroyed()) return this.getWindowDetails(win, queryOptions)
    }
    return this.getLastFocused(event, queryOptions)
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

  /** `windowTypes` filters by the type each window reports; without it Chrome lists every type here. */
  private getAll(event: ExtensionEvent, queryOptions?: chrome.windows.QueryOptions) {
    const types = Array.isArray(queryOptions?.windowTypes) ? queryOptions!.windowTypes : undefined
    return Array.from(this.ctx.store.windows)
      .filter((win) => !win.isDestroyed())
      .filter((win) => !types || types.includes(this.ctx.store.getWindowType(win)))
      .map((win) => this.getWindowDetails(win, queryOptions))
  }

  /*
    The URL a window opens with, the way Chrome reads it: one string or a list (the first entry is
    what a single-tab embedder can show), relative to the extension's own origin, and never a
    chrome:, javascript: or file: URL. The embedder's createWindow used to receive it untouched, so
    `windows.create({ url: 'login.html' })` — relative, as Chrome allows — loaded a URL no window
    could resolve.
  */
  private resolveCreateUrl(
    details: chrome.windows.CreateData,
    extension: Electron.Extension,
  ): string | undefined {
    const first = Array.isArray(details.url) ? details.url[0] : details.url
    if (!first) return undefined
    let url: string
    try {
      url = new URL(first, extension.url).href
    } catch {
      throw new Error(`Invalid url: "${first}".`)
    }
    if (/^(chrome|javascript|file):/i.test(url)) {
      throw new Error(`Invalid url: "${first}".`)
    }
    return url
  }

  private async create(event: ExtensionEvent, details: chrome.windows.CreateData = {}) {
    const url = this.resolveCreateUrl(details, event.extension)
    // See service-worker-wake.ts: the new window's page is likely to message
    // this extension shortly after loading, which can hang if its service
    // worker went idle — wake it before the consumer's createWindow() runs.
    await wakeExtensionServiceWorker(this.ctx.session, event.extension.id)
    const win = await this.ctx.store.createWindow(event, { ...details, url })
    // Chrome reports a panel as a popup.
    if (details.type === 'popup' || details.type === 'panel') {
      this.ctx.store.windowTypes.set(win.id, 'popup')
    }
    return this.getWindowDetails(win, { populate: true })
  }

  /*
    Everything `windows.update` can change, not only `state`. `focused: true` is the one extensions
    lean on: a password manager that already has its unlock window open calls update({ focused:
    true }) to bring it forward instead of opening a second one, and with this a no-op the window
    stayed behind the app and looked like nothing happened. Bounds and `drawAttention` are the rest
    of what Chrome honours here. A window the embedder has since destroyed answers nothing, as before.
  */
  private async update(
    event: ExtensionEvent,
    windowId: number,
    updateProperties: chrome.windows.UpdateInfo = {},
  ) {
    const win = this.windowOrThrow(windowId)

    const props = updateProperties

    /*
      Combinations Chrome refuses before touching the window, all with this one message (measured in
      Chromium 147): a bounds change on a minimized, maximized or fullscreen window, focusing a
      window that is being minimized, and unfocusing one that is being maximized or made fullscreen.
    */
    const hasBounds = ['left', 'top', 'width', 'height'].some(
      (key) => typeof (props as any)[key] === 'number',
    )
    const exclusiveState =
      props.state === 'minimized' ||
      props.state === 'maximized' ||
      props.state === 'fullscreen' ||
      (props.state as string) === 'locked-fullscreen'
    if (
      (exclusiveState && hasBounds) ||
      (props.state === 'minimized' && props.focused === true) ||
      ((props.state === 'maximized' || props.state === 'fullscreen') && props.focused === false)
    ) {
      throw new Error('Invalid value for state')
    }

    if (props.state) {
      switch (props.state) {
        case 'maximized':
          win.maximize()
          break
        case 'minimized':
          win.minimize()
          break
        case 'fullscreen':
          win.setFullScreen(true)
          break
        case 'normal': {
          if (win.isFullScreen()) win.setFullScreen(false)
          if (win.isMinimized() || win.isMaximized()) {
            win.restore()
          }
          break
        }
      }
    }

    const bounds: Partial<Electron.Rectangle> = {}
    if (typeof props.left === 'number') bounds.x = Math.round(props.left)
    if (typeof props.top === 'number') bounds.y = Math.round(props.top)
    if (typeof props.width === 'number') bounds.width = Math.round(props.width)
    if (typeof props.height === 'number') bounds.height = Math.round(props.height)
    if (Object.keys(bounds).length > 0) {
      win.setBounds({ ...win.getBounds(), ...bounds })
    }

    if (props.focused === true) {
      if (win.isMinimized()) win.restore()
      if (!win.isVisible()) win.show()
      win.focus()
      // The embedder's focus event follows, but the extension reads the answer first.
      this.onFocusChanged(win.id)
    } else if (props.focused === false) {
      win.blur()
    }

    if (typeof props.drawAttention === 'boolean' && 'flashFrame' in win) {
      ;(win as Electron.BrowserWindow).flashFrame(props.drawAttention)
    }

    // Without `tabs`, as Chrome answers update (measured in Chromium 147).
    return this.getWindowDetails(win)
  }

  private async remove(event: ExtensionEvent, windowId: number = WindowsAPI.WINDOW_ID_CURRENT) {
    const win = this.windowOrThrow(windowId)
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
