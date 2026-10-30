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
    handle('tabs.move', this.move.bind(this))
    handle('tabs.discard', this.discard.bind(this))
    handle('tabs.group', this.group.bind(this))
    handle('tabs.ungroup', this.ungroup.bind(this))
    handle('tabs.reportZoomChange', this.reportZoomChange.bind(this))
    // Only reached when Electron's own getZoom/setZoom are missing (see the preload).
    handle('tabs.getZoom', this.getZoom.bind(this))
    handle('tabs.setZoom', this.setZoom.bind(this))

    this.ctx.store.on('tab-added', this.observeTab.bind(this))
  }

  /*
    What Chrome keeps about a tab and Electron has no notion of: whether it is pinned, whether the
    browser may discard it on its own, whether it is discarded, who opened it, when it was last
    active and the URL it is navigating to. Pinning and auto-discarding change nothing on screen
    here — the embedder's tabs have no pin and nothing discards them behind its back — but they are
    the extension's own state, and Chrome reports back what it was told (measured in Chromium 147:
    `update({ pinned: true })` answers `pinned: true` and fires onUpdated `{ pinned: true }`).
  */
  private tabState = new Map<
    number,
    {
      pinned: boolean
      autoDiscardable: boolean
      discarded: boolean
      openerTabId?: number
      lastAccessed: number
      pendingUrl?: string
    }
  >()

  private stateOf(tabId: number) {
    let state = this.tabState.get(tabId)
    if (!state) {
      state = { pinned: false, autoDiscardable: true, discarded: false, lastAccessed: Date.now() }
      this.tabState.set(tabId, state)
    }
    return state
  }

  /** The zoom factor each tab was last reported at, so onZoomChange can say what it changed from. */
  private zoomFactors = new Map<number, number>()

  private tabOrThrow(tabId: unknown) {
    const tab = typeof tabId === 'number' ? this.ctx.store.getTabById(tabId) : undefined
    if (!tab) throw new Error(`No tab with id: ${tabId}.`)
    return tab
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

    const navigationHandler = (
      event: Electron.Event & {
        frame?: Electron.WebFrameMain
        url?: string
        isSameDocument?: boolean
        isMainFrame?: boolean
      },
    ) => {
      // Only the top frame maps to the tab's own navigation state.
      const frame = event?.frame
      if (frame && !frame.isDestroyed() && frame !== frame.top) return
      // A main-frame navigation to a new document: what Chrome reports as `pendingUrl` until it
      // commits, and the end of a discard (a discarded tab comes back by loading again).
      if (event?.isMainFrame !== false && event?.isSameDocument === false && event.url) {
        const state = this.stateOf(tabId)
        state.pendingUrl = event.url
        state.discarded = false
      }
      this.onUpdated(tabId)
    }

    // The pending navigation committed, or failed: either way there is nothing pending anymore.
    const settledHandler = () => {
      const state = this.tabState.get(tabId)
      if (state) state.pendingUrl = undefined
    }
    const settledEvents = ['did-navigate', 'did-fail-load', 'did-stop-loading']
    settledEvents.forEach((eventName) => tab.on(eventName as any, settledHandler))

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

    // tabs.onZoomChange from the user's own zoom gesture, the one zoom signal Electron gives. An
    // extension's tabs.setZoom reports through reportZoomChange; a zoom the embedder sets on its own
    // is not reported, which is a gap, not a lie.
    this.zoomFactors.set(tabId, tab.getZoomFactor())
    const zoomHandler = () => {
      if (tab.isDestroyed()) return
      const newZoomFactor = tab.getZoomFactor()
      const oldZoomFactor = this.zoomFactors.get(tabId) ?? 1
      if (newZoomFactor === oldZoomFactor) return
      this.zoomFactors.set(tabId, newZoomFactor)
      this.ctx.router.broadcastEvent('tabs.onZoomChange', {
        tabId,
        oldZoomFactor,
        newZoomFactor,
        // Chrome's event carries these two and not defaultZoomFactor (measured in Chromium 147).
        zoomSettings: { mode: 'automatic', scope: 'per-origin' },
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
      settledEvents.forEach((eventName) => tab.off(eventName as any, settledHandler))
      this.zoomFactors.delete(tabId)

      this.ctx.store.removeTab(tab)
      this.onRemoved(tabId)
      this.tabState.delete(tabId)
    })

    this.stateOf(tabId)
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
    const state = this.stateOf(tabId)
    const loading = tab.isLoadingMainFrame()

    const details: chrome.tabs.Tab = {
      active: activeTab?.id === tabId,
      audible: tab.isCurrentlyAudible(),
      autoDiscardable: state.autoDiscardable,
      discarded: state.discarded,
      favIconUrl: tab.favicon || undefined,
      frozen: false,
      height,
      // Chrome reports the active tab as highlighted. Some extensions (e.g.
      // password managers) gate their behavior on `highlighted || active`, so
      // leaving this hardcoded to false made them treat every tab as inactive.
      highlighted: activeTab?.id === tabId,
      id: tabId,
      incognito: false,
      // Its position within its own window, as Chrome counts it. It used to be -1 here and then
      // overwritten by query() with the position in the RESULT, so `query({ index: 0 })` matched
      // every tab and two tabs of one window could both claim index 0.
      index: this.ctx.store.getTabIndex(tab),
      // The embedder's tabs are never grouped (see group() below): TAB_GROUP_ID_NONE.
      groupId: -1,
      lastAccessed: state.lastAccessed,
      mutedInfo: { muted: tab.audioMuted },
      pinned: state.pinned,
      selected: activeTab?.id === tabId,
      // No split views here: SPLIT_VIEW_ID_NONE, which Chrome reports for every tab outside one.
      splitViewId: -1,
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
      status: state.discarded ? 'unloaded' : loading ? 'loading' : 'complete',
      title: tab.getTitle(),
      url: tab.getURL(), // TODO: tab.mainFrame.url (Electron 12)
      width,
      windowId: win ? win.id : -1,
    } as chrome.tabs.Tab

    // Present only when there is something to say, as in Chrome: a tab that has not committed the
    // URL it is loading, and a tab that was opened (or told it was opened) by another.
    if (loading && state.pendingUrl && state.pendingUrl !== details.url) {
      details.pendingUrl = state.pendingUrl
    }
    if (typeof state.openerTabId === 'number') details.openerTabId = state.openerTabId

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
    // A tab that is not there fails as in Chrome ("No tab with id: N."): the promise rejects and the
    // callback gets undefined with lastError set. It used to answer {id: -1}, which is truthy, so an
    // extension that asks "is this tab still open?" (uBlock's expiring filters, Proton Pass's
    // stale tab ids) was told yes forever. Chrome throws synchronously for a negative id or a
    // missing argument (schema check); here those reject too, which is the safer side.
    if (!tab) throw new Error(`No tab with id: ${tabId}.`)
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
    // The tab started loading before it was observed, so its navigation was never seen: what it is
    // loading is the URL it was asked for, which Chrome answers as `pendingUrl` (Chromium 147).
    if (url && tab.isLoadingMainFrame() && tab.getURL() !== url) {
      this.stateOf(tab.id).pendingUrl = url
      this.ctx.store.tabDetailsCache.delete(tab.id)
    }
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
        if (isSet(info.index) && info.index !== tab.index) return false
        if (isSet((info as any).splitViewId) && (info as any).splitViewId !== -1) return false
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
        if (isSet(info.windowType)) {
          const win =
            typeof tab.windowId === 'number'
              ? this.ctx.store.getWindowById(tab.windowId)
              : undefined
          if (!win || this.ctx.store.getWindowType(win) !== info.windowType) return false
        }
        return true
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

    // A tab that is not there fails, as in Chrome ("No tab with id: N."), instead of answering
    // nothing; an omitted id means the active tab of the current window.
    const tab =
      typeof tabId === 'number'
        ? this.tabOrThrow(tabId)
        : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) return

    tabId = tab.id

    const props = updateProperties
    const state = this.stateOf(tabId)

    // Validated before anything changes, so a bad opener does not leave a half-applied update.
    if (typeof props.openerTabId === 'number') this.tabOrThrow(props.openerTabId)

    const url = props.url ? validateExtensionUrl(props.url, event.extension) : undefined
    if (url) await tab.loadURL(url)

    if (typeof props.muted === 'boolean') tab.setAudioMuted(props.muted)
    if (typeof props.pinned === 'boolean') state.pinned = props.pinned
    if (typeof props.autoDiscardable === 'boolean') state.autoDiscardable = props.autoDiscardable
    if (typeof props.openerTabId === 'number') state.openerTabId = props.openerTabId

    // Chrome makes a tab it is asked to highlight the active one (measured in Chromium 147), and
    // here the active tab is the only highlighted one, so both mean the same activation.
    if (props.active || props.highlighted) this.onActivated(tabId)

    this.onUpdated(tabId)

    return this.createTabDetails(tab)
  }

  /*
    `tabs.move`: a new position within the tab's own window, with tabs.onMoved for each tab whose
    index changed (Chromium 147 fires nothing for a move to where the tab already is). The order is
    the library's model of the window — the embedder's tab strip, if it has one, is not reordered.

    A tab cannot change windows: the embedder's WebContents live in the view that holds them. Chrome
    refuses a move it cannot make with this message.
  */
  private move(event: ExtensionEvent, tabIds: number | number[], moveProperties?: any) {
    if (!moveProperties || typeof moveProperties.index !== 'number') {
      throw new Error(
        "Error in invocation of tabs.move([integer|array] tabIds, object moveProperties, optional function callback): Error at parameter 'moveProperties': Missing required property 'index'.",
      )
    }
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
    const tabs = ids.map((id) => this.tabOrThrow(id))

    if (
      typeof moveProperties.windowId === 'number' &&
      moveProperties.windowId !== TabsAPI.WINDOW_ID_CURRENT
    ) {
      const target = this.ctx.store.getWindowById(moveProperties.windowId)
      if (!target) throw new Error(`No window with id: ${moveProperties.windowId}.`)
      if (tabs.some((tab) => this.ctx.store.tabToWindow.get(tab) !== target)) {
        throw new Error('Tabs can only be moved to and from normal windows.')
      }
    }

    let toIndex: number = moveProperties.index
    const moved = tabs.map((tab) => {
      const win = this.ctx.store.tabToWindow.get(tab)
      const last = this.ctx.store.getTabsOfWindow(win).length - 1
      const fromIndex = this.ctx.store.getTabIndex(tab)
      const target = toIndex < 0 || toIndex > last ? last : toIndex
      if (target !== fromIndex) {
        this.ctx.store.moveTabWithinWindow(tab, target)
        this.refreshIndexes(win)
        this.ctx.router.broadcastEvent('tabs.onMoved', tab.id, {
          windowId: win?.id,
          fromIndex,
          toIndex: target,
        })
      }
      // The next tab of a multi-tab move goes right after this one, as in Chrome.
      if (toIndex >= 0) toIndex = target + 1
      return this.createTabDetails(tab)
    })
    return Array.isArray(tabIds) && moved.length !== 1 ? moved : moved[0]
  }

  /** The cached details of a window's tabs carry their index, so a move changes them all. */
  private refreshIndexes(win: Electron.BaseWindow | undefined) {
    for (const tab of this.ctx.store.getTabsOfWindow(win)) {
      const cached = this.ctx.store.tabDetailsCache.get(tab.id)
      if (cached) cached.index = this.ctx.store.getTabIndex(tab)
    }
  }

  /*
    `tabs.discard`, through the embedder: discarding means unloading the page, and only the app
    knows how its pages unload (Rambox hibernates its services). Without the hook — or when the hook
    refuses — the call fails as Chrome fails it for a tab it will not discard. Chrome discards the
    active tab too (measured in Chromium 147 and Edge 156), so it is not refused here either.

    Chrome picks the least important tab when no id is given; the library has no measure of that,
    so it answers the way Chrome does when there is nothing it can pick.
  */
  private async discard(event: ExtensionEvent, tabId?: number) {
    if (typeof tabId !== 'number') throw new Error('Cannot find a tab to discard.')
    const tab = this.tabOrThrow(tabId)
    const state = this.stateOf(tab.id)
    const hook = this.ctx.store.impl.discardTab
    if (state.discarded || typeof hook !== 'function') {
      throw new Error(`Cannot discard tab with id: ${tabId}.`)
    }
    const result = await hook.call(this.ctx.store.impl, tab)
    if (result === false) throw new Error(`Cannot discard tab with id: ${tabId}.`)

    // The embedder replaced the tab: what Edge 156 reports, a new id and onReplaced(added, removed).
    // Chromium 147 keeps the id instead; both are Chrome, and the embedder decides which this is.
    if (result && typeof result === 'object' && (result as Electron.WebContents).id !== tab.id) {
      const replacement = result as Electron.WebContents
      Object.assign(this.stateOf(replacement.id), {
        ...state,
        discarded: true,
        pendingUrl: undefined,
      })
      this.ctx.router.broadcastEvent('tabs.onReplaced', replacement.id, tab.id)
      return this.createTabDetails(replacement)
    }

    state.discarded = true
    state.pendingUrl = undefined
    // onUpdated reports { discarded: true, status: 'unloaded' }, as Chrome does.
    this.onUpdated(tab.id)
    return this.createTabDetails(tab)
  }

  /*
    Tab groups do not exist here (chrome.tabGroups is a stub: no group is ever found), so grouping
    fails with Chrome's own message for a window whose tabs cannot be grouped. Everything Chrome
    checks first is checked first, with its messages (measured in Chromium 147): an unknown tab, an
    unknown group, an unknown window.
  */
  private group(event: ExtensionEvent, options?: any) {
    const ids = Array.isArray(options?.tabIds) ? options.tabIds : [options?.tabIds]
    if (ids.length === 0 || ids.some((id: unknown) => typeof id !== 'number')) {
      throw new Error(
        "Error in invocation of tabs.group(object options, optional function callback): Error at parameter 'options': Error at property 'tabIds': Value did not match any choice.",
      )
    }
    ids.forEach((id: number) => this.tabOrThrow(id))
    if (typeof options.groupId === 'number') {
      throw new Error(`No group with id: ${options.groupId}.`)
    }
    const windowId = options.createProperties?.windowId
    if (typeof windowId === 'number' && !this.ctx.store.getWindowById(windowId)) {
      throw new Error(`No window with id: ${windowId}.`)
    }
    throw new Error('Grouping is not supported by tabs in this window.')
  }

  /** Every tab here is already ungrouped, which Chrome answers by resolving (Chromium 147). */
  private ungroup(event: ExtensionEvent, tabIds: number | number[]) {
    const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
    ids.forEach((id) => this.tabOrThrow(id))
  }

  /*
    tabs.onZoomChange for a zoom an extension set. Electron implements getZoom/setZoom/
    getZoomSettings/setZoomSettings natively but never dispatches the event (measured on 44.9.3:
    zero events for seven zoom changes, where Chromium 147 fires one per successful setZoom and one
    per setZoomSettings). The preload calls this after each of those succeeds; the factor is read
    here, from the tab, rather than taken from the caller, except in manual mode, where Chrome
    leaves the page as it is and only reports what the extension asked for.
  */
  private reportZoomChange(
    event: ExtensionEvent,
    tabId: number,
    zoomSettings: { mode?: string; scope?: string } = {},
    requestedFactor?: number,
  ) {
    const tab = this.tabOrThrow(tabId)
    const mode = ['automatic', 'manual', 'disabled'].includes(zoomSettings.mode as string)
      ? zoomSettings.mode
      : 'automatic'
    const scope = zoomSettings.scope === 'per-tab' ? 'per-tab' : 'per-origin'
    const oldZoomFactor = this.zoomFactors.get(tab.id) ?? 1
    const newZoomFactor =
      mode === 'manual' && typeof requestedFactor === 'number'
        ? requestedFactor
        : tab.getZoomFactor()
    this.zoomFactors.set(tab.id, newZoomFactor)
    this.ctx.router.broadcastEvent('tabs.onZoomChange', {
      tabId: tab.id,
      oldZoomFactor,
      newZoomFactor,
      zoomSettings: { mode, scope },
    })
  }

  private getZoom(event: ExtensionEvent, tabId?: number) {
    const tab =
      typeof tabId === 'number'
        ? this.tabOrThrow(tabId)
        : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) throw new Error(`No tab with id: ${tabId}.`)
    return tab.getZoomFactor()
  }

  private setZoom(event: ExtensionEvent, tabId: number | undefined, zoomFactor: number) {
    const tab =
      typeof tabId === 'number'
        ? this.tabOrThrow(tabId)
        : this.ctx.store.getActiveTabOfCurrentWindow()
    if (!tab) throw new Error(`No tab with id: ${tabId}.`)
    // 0 resets to the default, as in Chrome.
    tab.setZoomFactor(zoomFactor === 0 ? 1 : zoomFactor)
    this.reportZoomChange(event, tab.id)
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

    this.stateOf(tabId).lastAccessed = Date.now()

    // invalidate cache since 'active' has changed — within this window only: another window keeps
    // its own active tab.
    this.ctx.store.tabDetailsCache.forEach((tabInfo, cacheTabId) => {
      if (win && tabInfo.windowId !== win.id) return
      const isActive = tabId === cacheTabId
      tabInfo.active = isActive
      tabInfo.highlighted = isActive
      tabInfo.selected = isActive
      if (isActive) tabInfo.lastAccessed = this.stateOf(tabId).lastAccessed
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
