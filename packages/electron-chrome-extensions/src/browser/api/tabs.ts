import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { getAllWindows, matchesPattern, matchesTitlePattern, TabContents } from './common'
import { WindowsAPI } from './windows'
import { wakeExtensionServiceWorker } from '../patch/service-worker-wake'
import debug from 'debug'

const d = debug('electron-chrome-extensions:tabs')

const validateExtensionUrl = (url: string, extension: Electron.Extension) => {
  // Convert relative URLs to absolute if needed
  try {
    url = new URL(url, extension.url).href
  } catch (e) {
    throw new Error('Invalid URL')
  }

  // Prevent creating chrome://kill or other debug commands. file: is refused too: Chrome only lets an
  // extension open one with file access the user granted, which nothing here can grant.
  if (/^(chrome|javascript|file):/i.test(url)) {
    throw new Error('Invalid URL')
  }

  return url
}

export class TabsAPI {
  static TAB_ID_NONE = -1
  static WINDOW_ID_NONE = -1
  static WINDOW_ID_CURRENT = -2

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('tabs.get', this.get.bind(this))
    handle('tabs.getAllInWindow', this.getAllInWindow.bind(this))
    handle('tabs.getCurrent', this.getCurrent.bind(this))
    handle('tabs.create', this.create.bind(this))
    handle('tabs.captureVisibleTab', this.captureVisibleTab.bind(this))
    handle('tabs.insertCSS', this.insertCSS.bind(this))
    handle('tabs.query', this.query.bind(this))
    handle('tabs.reload', this.reload.bind(this))
    handle('tabs.update', this.update.bind(this))
    handle('tabs.remove', this.remove.bind(this))
    handle('tabs.goForward', this.goForward.bind(this))
    handle('tabs.goBack', this.goBack.bind(this))
    handle('tabs.detectLanguage', this.detectLanguage.bind(this))
    handle('tabs.duplicate', this.duplicate.bind(this))
    handle('tabs.highlight', this.highlight.bind(this))

    this.ctx.store.on('tab-added', this.observeTab.bind(this))
  }

  /**
   * The window a caller means by "current": for a page that is itself a tab, that tab's window; for
   * anything else — the service worker, a popup, an offscreen document — the last focused one, which
   * is also what Chrome resolves `currentWindow` to outside a tab.
   */
  private currentWindowIdFor(event: ExtensionEvent): number | undefined {
    if (event.type === 'frame' && this.ctx.store.tabs.has(event.sender)) {
      const win = this.ctx.store.tabToWindow.get(event.sender)
      if (win && !win.isDestroyed()) return win.id
    }
    return this.ctx.store.lastFocusedWindowId
  }

  private observeTab(tab: TabContents) {
    const tabId = tab.id

    // Tab-level events. did-start-loading and did-stop-loading are NOT top-level only: they fire
    // when any frame starts or stops loading. That is harmless here only because the status they
    // feed is read from the main frame (see createTabDetails), so an iframe changes nothing and
    // onUpdated, which only reports differences, stays quiet.
    const updateEvents = [
      'page-title-updated', // title
      'did-start-loading', // status
      'did-stop-loading', // status
      'media-started-playing', // audible
      'media-paused', // audible

      // Listen for 'tab-updated' to handle all other cases which don't have
      // an official Electron API such as discarded tabs. App developers can
      // emit this event to trigger chrome.tabs.onUpdated if a property has
      // changed.
      'tab-updated',
    ]

    // Navigation events fire once per frame, including subframes. Chrome's
    // chrome.tabs.onUpdated only reflects top-level navigations, so ignore
    // subframe navigations here. Otherwise pages with busy iframes (ads,
    // trackers) emit a storm of onUpdated events — enough to prevent
    // extensions like Bitwarden from finishing an async context-menu rebuild
    // before the next event tears it down.
    const navigationEvents = [
      'did-start-navigation', // url
      'did-redirect-navigation', // url
      'did-navigate-in-page', // url
    ]

    const updateHandler = () => {
      this.onUpdated(tabId)
    }

    const navigationHandler = (event: Electron.Event & { frame?: Electron.WebFrameMain }) => {
      // Only the top frame maps to the tab's own navigation state.
      const frame = event?.frame
      if (frame && !frame.isDestroyed() && frame !== frame.top) return
      this.onUpdated(tabId)
    }

    updateEvents.forEach((eventName) => {
      tab.on(eventName as any, updateHandler)
    })
    navigationEvents.forEach((eventName) => {
      tab.on(eventName as any, navigationHandler)
    })

    const faviconHandler = (event: Electron.Event, favicons: string[]) => {
      ;(tab as TabContents).favicon = favicons[0]
      this.onUpdated(tabId)
    }
    tab.on('page-favicon-updated', faviconHandler)

    // tabs.onZoomChange, from the one zoom signal Electron gives: the user's own zoom gesture. A zoom
    // the embedder sets programmatically is not reported here, which is a gap, not a lie.
    let lastZoomFactor = tab.getZoomFactor()
    const zoomHandler = () => {
      if (tab.isDestroyed()) return
      const newZoomFactor = tab.getZoomFactor()
      if (newZoomFactor === lastZoomFactor) return
      const oldZoomFactor = lastZoomFactor
      lastZoomFactor = newZoomFactor
      this.ctx.router.broadcastEvent('tabs.onZoomChange', {
        tabId,
        oldZoomFactor,
        newZoomFactor,
        zoomSettings: { mode: 'automatic', scope: 'per-origin', defaultZoomFactor: 1 },
      })
    }
    tab.on('zoom-changed', zoomHandler)

    tab.once('destroyed', () => {
      updateEvents.forEach((eventName) => {
        tab.off(eventName as any, updateHandler)
      })
      navigationEvents.forEach((eventName) => {
        tab.off(eventName as any, navigationHandler)
      })
      tab.off('page-favicon-updated', faviconHandler)
      tab.off('zoom-changed', zoomHandler)

      this.ctx.store.removeTab(tab)
      this.onRemoved(tabId)
    })

    this.onCreated(tabId)
    this.onActivated(tabId)

    d(`Observing tab[${tabId}][${tab.getType()}] ${tab.getURL()}`)
  }

  private createTabDetails(tab: TabContents) {
    const tabId = tab.id
    const activeTab = this.ctx.store.getActiveTabFromWebContents(tab)
    let win = this.ctx.store.tabToWindow.get(tab)
    if (win?.isDestroyed()) win = undefined
    const [width = 0, height = 0] = win ? win.getSize() : []

    const details: chrome.tabs.Tab = {
      active: activeTab?.id === tabId,
      audible: tab.isCurrentlyAudible(),
      autoDiscardable: true,
      discarded: false,
      favIconUrl: tab.favicon || undefined,
      frozen: false,
      height,
      // Chrome reports the active tab as highlighted. Some extensions (e.g.
      // password managers) gate their behavior on `highlighted || active`, so
      // leaving this hardcoded to false made them treat every tab as inactive.
      highlighted: activeTab?.id === tabId,
      id: tabId,
      incognito: false,
      index: -1, // TODO
      groupId: -1, // TODO(mv3): implement?
      mutedInfo: { muted: tab.audioMuted },
      pinned: false,
      selected: true,
      /*
        The tab's status is its own document's, not its iframes'. `isLoading()` is true while ANY
        frame loads, so a page that merely adds an iframe went 'loading' → 'complete' and every
        extension got two tabs.onUpdated for a navigation that never happened. Chromium sends none
        (measured in Edge 156: inserting an iframe, web or extension, fires no tabs.onUpdated).

        That is what kept Keeper's in-field prompt from opening: the prompt IS an iframe, and
        Keeper's onUpdated handler closes any open prompt on `status: 'complete'`, reading it as the
        page having navigated. `isLoadingMainFrame()` is Electron's name for Chromium's
        ShouldShowLoadingUI(), which is the main-frame loading state Chrome reports here.
      */
      status: tab.isLoadingMainFrame() ? 'loading' : 'complete',
      title: tab.getTitle(),
      url: tab.getURL(), // TODO: tab.mainFrame.url (Electron 12)
      width,
      windowId: win ? win.id : -1,
    }

    if (typeof this.ctx.store.impl.assignTabDetails === 'function') {
      this.ctx.store.impl.assignTabDetails(details, tab)
    }

    this.ctx.store.tabDetailsCache.set(tab.id, details)
    return details
  }

  private getTabDetails(tab: TabContents) {
    if (this.ctx.store.tabDetailsCache.has(tab.id)) {
      return this.ctx.store.tabDetailsCache.get(tab.id)
    }
    const details = this.createTabDetails(tab)
    return details
  }

  private get(event: ExtensionEvent, tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return { id: TabsAPI.TAB_ID_NONE }
    return this.getTabDetails(tab)
  }

  private getAllInWindow(event: ExtensionEvent, windowId: number = TabsAPI.WINDOW_ID_CURRENT) {
    if (windowId === TabsAPI.WINDOW_ID_CURRENT) windowId = this.ctx.store.lastFocusedWindowId!

    const tabs = Array.from(this.ctx.store.tabs).filter((tab) => {
      if (tab.isDestroyed()) return false

      const browserWindow = this.ctx.store.tabToWindow.get(tab)
      if (!browserWindow || browserWindow.isDestroyed()) return

      return browserWindow.id === windowId
    })

    return tabs.map(this.getTabDetails.bind(this))
  }

  /**
   * The tab the caller is running in — not "the active tab".
   *
   * Chrome answers `undefined` outside of a tab: from a service worker, from a popup, from an
   * extension page that is not itself a tab. This used to return the active tab of the current window
   * to everyone, so an extension asking "which tab am I?" from its worker got a tab object and acted
   * on it. Measured against a real Chromium, where the same call in a service worker is `undefined`.
   */
  private getCurrent(event: ExtensionEvent) {
    if (event.type !== 'frame') return undefined
    const tab = this.ctx.store.tabs.has(event.sender) ? event.sender : undefined
    return tab ? this.getTabDetails(tab) : undefined
  }

  private async create(event: ExtensionEvent, details: chrome.tabs.CreateProperties = {}) {
    const url = details.url ? validateExtensionUrl(details.url, event.extension) : undefined
    // See service-worker-wake.ts: the new tab's page is likely to message
    // this extension shortly after loading, which can hang if its service
    // worker went idle — wake it before the consumer's createTab() runs.
    await wakeExtensionServiceWorker(this.ctx.session, event.extension.id)
    const tab = await this.ctx.store.createTab({ ...details, url })
    const tabDetails = this.getTabDetails(tab)
    if (details.active) {
      queueMicrotask(() => this.onActivated(tab.id))
    }
    // Consumed by BrowserActionAPI to close the extension's popup, matching
    // Chrome's behavior when a popup opens a focused tab.
    this.ctx.store.emit('extension-created-tab', event.extension.id, details.active !== false)
    return tabDetails
  }

  private async captureVisibleTab(event: ExtensionEvent, arg1?: unknown, arg2?: unknown) {
    // The signature is overloaded: captureVisibleTab(windowId?, options?).
    const windowId: number = typeof arg1 === 'number' ? arg1 : TabsAPI.WINDOW_ID_CURRENT
    const options: chrome.tabs.CaptureVisibleTabOptions =
      (typeof arg1 === 'object' ? arg1 : typeof arg2 === 'object' ? arg2 : {}) || {}

    const win =
      windowId === TabsAPI.WINDOW_ID_CURRENT
        ? this.ctx.store.getCurrentWindow()
        : this.ctx.store.getWindowById(windowId)
    if (!win) throw new Error(`No window with id: ${windowId}`)

    const tab = this.ctx.store.getActiveTabFromWindow(win)
    if (!tab) throw new Error('No active tab in window')

    const image = await tab.capturePage()

    if (options.format === 'png') {
      return image.toDataURL()
    } else {
      // Chrome defaults to JPEG at quality 92.
      const quality = typeof options.quality === 'number' ? options.quality : 92
      return `data:image/jpeg;base64,${image.toJPEG(quality).toString('base64')}`
    }
  }

  private insertCSS(event: ExtensionEvent, tabId: number, details: chrome.tabs.InjectDetails) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return

    // TODO: move to webFrame in renderer?
    if (details.code) {
      tab.insertCSS(details.code)
    }
  }

  private query(event: ExtensionEvent, info: chrome.tabs.QueryInfo = {}) {
    const isSet = (value: any) => typeof value !== 'undefined'
    /*
      `currentWindow` and `lastFocusedWindow` were ignored, so `query({ active: true, currentWindow:
      true })` — the single most common tabs call there is — answered one tab PER WINDOW. With an
      extension's own login window registered as a window, a password manager asking for "the page
      in front of the user" got two tabs and had to guess; `tabs[0]` happened to be right only while
      the app's window was registered first.
    */
    const currentWindowId = this.currentWindowIdFor(event)
    const lastFocusedWindowId = this.ctx.store.lastFocusedWindowId

    const filteredTabs = Array.from(this.ctx.store.tabs)
      .map(this.getTabDetails.bind(this))
      .filter((tab) => {
        if (!tab) return false
        if (isSet(info.active) && info.active !== tab.active) return false
        if (isSet(info.pinned) && info.pinned !== tab.pinned) return false
        if (isSet(info.audible) && info.audible !== tab.audible) return false
        if (isSet(info.muted) && info.muted !== tab.mutedInfo?.muted) return false
        if (isSet(info.highlighted) && info.highlighted !== tab.highlighted) return false
        if (isSet(info.discarded) && info.discarded !== tab.discarded) return false
        if (isSet(info.autoDiscardable) && info.autoDiscardable !== tab.autoDiscardable)
          return false
        if (isSet(info.currentWindow) && info.currentWindow !== (tab.windowId === currentWindowId))
          return false
        if (
          isSet(info.lastFocusedWindow) &&
          info.lastFocusedWindow !== (tab.windowId === lastFocusedWindowId)
        )
          return false
        if (isSet(info.frozen) && info.frozen !== tab.frozen) return false
        if (isSet(info.groupId) && info.groupId !== tab.groupId) return false
        if (isSet(info.status) && info.status !== tab.status) return false
        if (isSet(info.title) && typeof info.title === 'string' && typeof tab.title === 'string') {
          if (!matchesTitlePattern(info.title, tab.title)) return false
        }
        if (isSet(info.url) && typeof tab.url === 'string') {
          if (typeof info.url === 'string' && !matchesPattern(info.url, tab.url!)) {
            return false
          } else if (
            Array.isArray(info.url) &&
            !info.url.some((pattern) => matchesPattern(pattern, tab.url!))
          ) {
            return false
          }
        }
        if (isSet(info.windowId)) {
          if (info.windowId === TabsAPI.WINDOW_ID_CURRENT) {
            if (this.ctx.store.lastFocusedWindowId !== tab.windowId) return false
          } else if (info.windowId !== tab.windowId) {
            return false
          }
        }
        // if (isSet(info.windowType) && info.windowType !== tab.windowType) return false
        // if (isSet(info.index) && info.index !== tab.index) return false
        return true
      })
      .map((tab, index) => {
        if (tab) {
          tab.index = index
        }
        return tab
      })
    return filteredTabs
  }

  /**
   * The language of a tab's content.
   *
   * Chrome runs CLD over the page's text. Electron exposes nothing like it, so this reads what the
   * page DECLARES — `<html lang>`, then a `content-language` meta — and answers `'und'` when it
   * declares nothing. `'und'` is Chrome's own answer for "could not determine", so a caller written
   * against Chrome already handles it.
   *
   * That makes this a weaker detector, not a different contract: it never invents a language. The
   * alternative was what the library did before, which is not have the method at all — in Rambox's
   * catalog that threw `chrome.tabs.detectLanguage is not a function` for Dashlane (3 call sites)
   * and Google Translate (1).
   */
  private async detectLanguage(event: ExtensionEvent, tabId?: number) {
    // `typeof`, not truthiness, the way reload() and update() below decide: a tabId of 0 is a tabId,
    // and treating it as "none given" would answer about the active tab instead. Unreachable while
    // Electron's webContents ids start at 1, which is exactly how long such a thing stays quiet.
    const tab =
      typeof tabId === 'number'
        ? this.ctx.store.getTabById(tabId)
        : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab || tab.isDestroyed()) return 'und'

    let declared = ''
    try {
      declared = await tab.executeJavaScript(
        `(function () {
          var lang = document.documentElement && document.documentElement.getAttribute('lang')
          if (lang) return lang
          var meta = document.querySelector('meta[http-equiv="content-language" i]')
          return (meta && meta.getAttribute('content')) || ''
        })()`,
        false,
      )
    } catch {
      // A page that is gone, or one that refuses script, is simply undetermined.
      return 'und'
    }

    return TabsAPI.normalizeLanguage(declared)
  }

  /**
   * A declared language in the shape Chrome reports: the language subtag lowercased, the region
   * uppercased (`EN_us` and `en-us` both read `en-US`), and only the first entry of a list.
   */
  private static normalizeLanguage(declared: unknown): string {
    if (typeof declared !== 'string') return 'und'
    const first = declared.split(',')[0]?.trim().replace(/_/g, '-') ?? ''
    const match = /^([a-z]{2,3})(?:-([a-z0-9]{2,8}))?$/i.exec(first)
    if (!match) return 'und'
    const [, language, region] = match
    return region ? `${language.toLowerCase()}-${region.toUpperCase()}` : language.toLowerCase()
  }

  private reload(event: ExtensionEvent, arg1?: unknown, arg2?: unknown) {
    const tabId: number | undefined = typeof arg1 === 'number' ? arg1 : undefined
    const reloadProperties: chrome.tabs.ReloadProperties | null =
      typeof arg1 === 'object' ? arg1 : typeof arg2 === 'object' ? arg2 : {}

    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return

    if (reloadProperties?.bypassCache) {
      tab.reloadIgnoringCache()
    } else {
      tab.reload()
    }
  }

  private async update(event: ExtensionEvent, arg1?: unknown, arg2?: unknown) {
    let tabId = typeof arg1 === 'number' ? arg1 : undefined
    const updateProperties: chrome.tabs.UpdateProperties =
      (typeof arg1 === 'object' ? (arg1 as any) : (arg2 as any)) || {}

    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return

    tabId = tab.id

    const props = updateProperties

    const url = props.url ? validateExtensionUrl(props.url, event.extension) : undefined
    if (url) await tab.loadURL(url)

    if (typeof props.muted === 'boolean') tab.setAudioMuted(props.muted)

    if (props.active) this.onActivated(tabId)

    this.onUpdated(tabId)

    return this.createTabDetails(tab)
  }

  /** A new tab on the same URL, next to the original, as Chrome's `tabs.duplicate`. */
  private async duplicate(event: ExtensionEvent, tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) throw new Error(`No tab with id: ${tabId}.`)
    const win = this.ctx.store.tabToWindow.get(tab)
    return this.create(event, {
      url: tab.getURL(),
      windowId: win && !win.isDestroyed() ? win.id : undefined,
      active: true,
    })
  }

  /*
    `tabs.highlight` selects tabs by INDEX within a window, and the embedder's tabs have no order of
    their own: the index is the one `query()` reports, which is the registration order of the
    window's tabs. Chrome makes the first highlighted tab active, and that is the part an extension
    calling this from a tab list depends on ("show me this tab").
  */
  private async highlight(event: ExtensionEvent, info: chrome.tabs.HighlightInfo) {
    const windowId =
      typeof info?.windowId === 'number' && info.windowId !== TabsAPI.WINDOW_ID_CURRENT
        ? info.windowId
        : this.currentWindowIdFor(event)
    const win = typeof windowId === 'number' ? this.ctx.store.getWindowById(windowId) : undefined
    if (!win) throw new Error(`No window with id: ${windowId}.`)
    const indexes = Array.isArray(info?.tabs) ? info.tabs : [info?.tabs]
    const first = indexes.find((index) => typeof index === 'number')
    const tabs = Array.from(this.ctx.store.tabs).filter(
      (tab) => !tab.isDestroyed() && this.ctx.store.tabToWindow.get(tab) === win,
    )
    const tab = typeof first === 'number' ? tabs[first] : undefined
    if (!tab) throw new Error('No tab at the given index.')
    this.onActivated(tab.id)
    const details: Partial<chrome.windows.Window> = {
      id: win.id,
      focused: win.isFocused(),
      tabs: tabs.map(this.getTabDetails.bind(this)) as chrome.tabs.Tab[],
    }
    return details
  }

  private remove(event: ExtensionEvent, id: number | number[]) {
    const ids = Array.isArray(id) ? id : [id]

    ids.forEach((tabId) => {
      const tab = this.ctx.store.getTabById(tabId)
      if (tab) this.ctx.store.removeTab(tab)
      this.onRemoved(tabId)
    })
  }

  private goForward(event: ExtensionEvent, arg1?: unknown) {
    const tabId = typeof arg1 === 'number' ? arg1 : undefined
    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return
    tab.navigationHistory.goForward()
  }

  private goBack(event: ExtensionEvent, arg1?: unknown) {
    const tabId = typeof arg1 === 'number' ? arg1 : undefined
    const tab = tabId
      ? this.ctx.store.getTabById(tabId)
      : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return
    tab.navigationHistory.goBack()
  }

  onCreated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return
    const tabDetails = this.getTabDetails(tab)
    this.ctx.router.broadcastEvent('tabs.onCreated', tabDetails)
  }

  onUpdated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return

    let prevDetails
    if (this.ctx.store.tabDetailsCache.has(tab.id)) {
      prevDetails = this.ctx.store.tabDetailsCache.get(tab.id)
    }
    if (!prevDetails) return

    const details = this.createTabDetails(tab)

    const compareProps: (keyof chrome.tabs.Tab)[] = [
      'audible',
      'autoDiscardable',
      'discarded',
      'favIconUrl',
      'frozen',
      'groupId',
      'pinned',
      'status',
      'title',
      'url',
    ]

    let didUpdate = false
    const changeInfo: chrome.tabs.TabChangeInfo = {}

    for (const prop of compareProps) {
      if (details[prop] !== prevDetails[prop]) {
        ;(changeInfo as any)[prop] = details[prop]
        didUpdate = true
      }
    }

    if (details.mutedInfo?.muted !== prevDetails.mutedInfo?.muted) {
      changeInfo.mutedInfo = details.mutedInfo
      didUpdate = true
    }

    if (!didUpdate) return

    this.ctx.router.broadcastEvent('tabs.onUpdated', tab.id, changeInfo, details)
  }

  onRemoved(tabId: number) {
    const details = this.ctx.store.tabDetailsCache.has(tabId)
      ? this.ctx.store.tabDetailsCache.get(tabId)
      : null
    this.ctx.store.tabDetailsCache.delete(tabId)

    const windowId = details ? details.windowId : WindowsAPI.WINDOW_ID_NONE
    const win =
      typeof windowId !== 'undefined' && windowId > -1
        ? getAllWindows().find((win) => win.id === windowId)
        : null

    this.ctx.router.broadcastEvent('tabs.onRemoved', tabId, {
      windowId,
      isWindowClosing: win ? win.isDestroyed() : false,
    })
  }

  onActivated(tabId: number) {
    const tab = this.ctx.store.getTabById(tabId)
    if (!tab) return

    const activeTab = this.ctx.store.getActiveTabFromWebContents(tab)
    const activeChanged = activeTab?.id !== tabId
    if (!activeChanged) return

    const win = this.ctx.store.tabToWindow.get(tab)

    this.ctx.store.setActiveTab(tab)

    // invalidate cache since 'active' has changed
    this.ctx.store.tabDetailsCache.forEach((tabInfo, cacheTabId) => {
      tabInfo.active = tabId === cacheTabId
    })

    this.ctx.router.broadcastEvent('tabs.onActivated', {
      tabId,
      windowId: win?.id,
    })
    // Chrome highlights the active tab, so an activation changes the highlighted set too and
    // onHighlighted follows onActivated with the new set: here, the one active tab.
    this.ctx.router.broadcastEvent('tabs.onHighlighted', {
      tabIds: [tabId],
      windowId: win?.id,
    })
  }
}
