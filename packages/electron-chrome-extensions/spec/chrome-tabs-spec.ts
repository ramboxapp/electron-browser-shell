import { expect } from 'chai'
import { app, BrowserWindow, webContents } from 'electron'
import { emittedOnce } from './events-helpers'

import { useExtensionBrowser, useServer } from './hooks'
import { ChromeExtensionImpl } from '../dist/types/browser/impl'

describe('chrome.tabs', () => {
  let assignTabDetails: ChromeExtensionImpl['assignTabDetails']

  const server = useServer()
  const browser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'rpc',
    assignTabDetails(details, tab) {
      assignTabDetails?.(details, tab)
    },
  })

  afterEach(() => {
    assignTabDetails = undefined
  })

  describe('get()', () => {
    it('returns tab details', async () => {
      const tabId = browser.window.webContents.id
      const result = await browser.crx.exec('tabs.get', tabId)
      expect(result).to.be.an('object')
      expect(result.id).to.equal(tabId)
      expect(result.windowId).to.equal(browser.window.id)
    })
  })

  describe('getCurrent()', () => {
    it('is undefined in a service worker, as in Chrome', async () => {
      /*
        getCurrent answers "the tab you are running in", not "the active tab". Chrome returns
        undefined outside of a tab — from a service worker, a popup, or an extension page that is not
        itself a tab — and this used to hand everyone the active tab of the current window instead, so
        an extension asking "which tab am I?" from its worker got an answer and acted on it.
        `browser.crx.exec` runs in the fixture's service worker, which is exactly that context.
      */
      const result = await browser.crx.exec('tabs.getCurrent')
      // The fixture relays the reply over IPC, which turns undefined into null; what matters is that
      // no tab object comes back, which is what an extension branches on.
      expect(result == null, `getCurrent answered ${JSON.stringify(result)}`).to.be.true
    })
  })

  describe('create()', () => {
    it('creates a tab', async () => {
      const wcPromise = emittedOnce(app, 'web-contents-created')
      const tabInfo = await browser.crx.exec('tabs.create', { url: server.getUrl() })
      const [, wc] = await wcPromise
      expect(tabInfo).to.be.an('object')
      expect(tabInfo.id).to.equal(wc.id)
      expect(tabInfo.active).to.equal(true)
      expect(tabInfo.url).to.equal(server.getUrl())
      expect(tabInfo.windowId).to.equal(browser.window.id)
      expect(tabInfo.title).to.be.a('string')
    })

    // TODO: Navigating to chrome-extension:// receives ERR_BLOCKED_BY_CLIENT (-20)
    it.skip('resolves relative URL', async () => {
      const relativeUrl = './options.html'
      const tabInfo = await browser.crx.exec('tabs.create', { url: relativeUrl })
      const url = new URL(relativeUrl, browser.extension.url).href
      expect(tabInfo).to.be.an('object')
      expect(tabInfo.url).to.equal(url)
    })

    it('fails on chrome:// URLs', async () => {
      const tabInfo = await browser.crx.exec('tabs.create', { url: 'chrome://kill' })
      expect(tabInfo).to.be.a('null')
    })

    it('fails on javascript: URLs', async () => {
      const tabInfo = browser.crx.exec('tabs.create', { url: "javascript:alert('hacked')" })
      expect(await tabInfo).to.be.a('null')
    })
  })

  describe('query()', () => {
    it('gets the active tab', async () => {
      const result = await browser.crx.exec('tabs.query', { active: true })
      expect(result).to.be.an('array')
      expect(result).to.be.length(1)
      expect(result[0].id).to.be.equal(browser.window.webContents.id)
      expect(result[0].windowId).to.be.equal(browser.window.id)
    })

    it('gets the active tab of multiple windows', async () => {
      const secondWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          session: browser.session,
          nodeIntegration: false,
          contextIsolation: true,
        },
      })

      browser.extensions.addTab(secondWindow.webContents, secondWindow)

      const result = await browser.crx.exec('tabs.query', { active: true })
      expect(result).to.be.an('array')
      expect(result).to.be.length(2)
      expect(result[0].windowId).to.be.equal(browser.window.id)
      expect(result[1].windowId).to.be.equal(secondWindow.id)
    })

    it('matches exact title', async () => {
      const results = await browser.crx.exec('tabs.query', { title: 'title' })
      expect(results).to.be.an('array')
      expect(results).to.be.length(1)
      expect(results[0].title).to.be.equal('title')
    })

    it('matches title pattern', async () => {
      const results = await browser.crx.exec('tabs.query', { title: '*' })
      expect(results).to.be.an('array')
      expect(results).to.be.length(1)
      expect(results[0].title).to.be.equal('title')
    })

    it('matches exact url', async () => {
      const url = server.getUrl()
      const results = await browser.crx.exec('tabs.query', { url })
      expect(results).to.be.an('array')
      expect(results).to.be.length(1)
      expect(results[0].url).to.be.equal(url)
    })

    it('matches wildcard url pattern', async () => {
      const url = 'http://*/*'
      const results = await browser.crx.exec('tabs.query', { url })
      expect(results).to.be.an('array')
      expect(results).to.be.length(1)
      expect(results[0].url).to.be.equal(server.getUrl())
    })

    it('matches either url pattern', async () => {
      const patterns = ['http://foo.bar/*', `${server.getUrl()}*`]
      const results = await browser.crx.exec('tabs.query', { url: patterns })
      expect(results).to.be.an('array')
      expect(results).to.be.length(1)
      expect(results[0].url).to.be.equal(server.getUrl())
    })
  })

  describe('reload()', () => {
    it('reloads the active tab', async () => {
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.reload')
      await navigatePromise
    })

    it('reloads a specified tab', async () => {
      const tabId = browser.window.webContents.id
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.reload', tabId)
      await navigatePromise
    })
  })

  describe('update()', () => {
    it('navigates the tab', async () => {
      const tabId = browser.window.webContents.id
      const updateUrl = `${server.getUrl()}foo`
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.update', tabId, { url: updateUrl })
      await navigatePromise
      expect(browser.window.webContents.getURL()).to.equal(updateUrl)
    })

    it('navigates the active tab', async () => {
      const updateUrl = `${server.getUrl()}foo`
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.update', { url: updateUrl })
      await navigatePromise
      expect(browser.window.webContents.getURL()).to.equal(updateUrl)
    })

    it('fails on chrome:// URLs', async () => {
      const tabId = browser.webContents.id
      const tabInfo = await browser.crx.exec('tabs.update', tabId, { url: 'chrome://kill' })
      expect(tabInfo).to.be.a('null')
    })
  })

  describe('goForward()', () => {
    it('navigates the active tab forward', async () => {
      const initialUrl = browser.window.webContents.getURL()
      const targetUrl = `${server.getUrl()}foo`
      await browser.window.webContents.loadURL(targetUrl)
      expect(browser.window.webContents.navigationHistory.canGoBack()).to.be.true
      browser.window.webContents.navigationHistory.goBack()
      await emittedOnce(browser.window.webContents, 'did-navigate')
      expect(browser.window.webContents.navigationHistory.canGoForward()).to.be.true
      expect(browser.window.webContents.getURL()).to.equal(initialUrl)
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.goForward')
      await navigatePromise
      expect(browser.window.webContents.getURL()).to.equal(targetUrl)
    })

    it('navigates a specified tab forward', async () => {
      const tabId = browser.window.webContents.id
      const initialUrl = browser.window.webContents.getURL()
      const targetUrl = `${server.getUrl()}foo`
      await browser.window.webContents.loadURL(targetUrl)
      expect(browser.window.webContents.navigationHistory.canGoBack()).to.be.true
      browser.window.webContents.navigationHistory.goBack()
      await emittedOnce(browser.window.webContents, 'did-navigate')
      expect(browser.window.webContents.navigationHistory.canGoForward()).to.be.true
      expect(browser.window.webContents.getURL()).to.equal(initialUrl)
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.goForward', tabId)
      await navigatePromise
      expect(browser.window.webContents.getURL()).to.equal(targetUrl)
    })
  })

  describe('goBack()', () => {
    it('navigates the active tab back', async () => {
      const initialUrl = browser.window.webContents.getURL()
      await browser.window.webContents.loadURL(`${server.getUrl()}foo`)
      expect(browser.window.webContents.navigationHistory.canGoBack()).to.be.true
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.goBack')
      await navigatePromise
      expect(browser.window.webContents.getURL()).to.equal(initialUrl)
    })

    it('navigates a specified tab back', async () => {
      const tabId = browser.window.webContents.id
      const initialUrl = browser.window.webContents.getURL()
      await browser.window.webContents.loadURL(`${server.getUrl()}foo`)
      expect(browser.window.webContents.canGoBack()).to.be.true
      const navigatePromise = emittedOnce(browser.window.webContents, 'did-navigate')
      browser.crx.exec('tabs.goBack', tabId)
      await navigatePromise
      expect(browser.window.webContents.getURL()).to.equal(initialUrl)
    })
  })

  describe('executeScript()', () => {
    it('injects code into a tab', async () => {
      const tabId = browser.window.webContents.id
      const [result] = await browser.crx.exec('tabs.executeScript', tabId, {
        code: 'location.href',
      })
      expect(result).to.equal(browser.window.webContents.getURL())
    })

    it('injects code into the active tab', async () => {
      const [result] = await browser.crx.exec('tabs.executeScript', { code: 'location.href' })
      expect(result).to.equal(browser.window.webContents.getURL())
    })
  })

  describe('onCreated', () => {
    it('emits when tab is added', async () => {
      const p = browser.crx.eventOnce('tabs.onCreated')

      const secondWindow = new BrowserWindow({
        show: false,
        webPreferences: {
          session: browser.session,
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      const secondTab = secondWindow.webContents

      const url = `${server.getUrl()}foo`
      await secondWindow.loadURL(url)

      browser.extensions.addTab(secondTab, secondWindow)

      const [tabDetails] = await p
      expect(tabDetails).to.be.an('object')
      expect(tabDetails.id).to.equal(secondTab.id)
      expect(tabDetails.windowId).to.equal(secondWindow.id)
      expect(tabDetails.url).to.equal(secondTab.getURL())
    })
  })

  describe('onUpdated', () => {
    it('emits on "tab-updated" event', async () => {
      const p = browser.crx.eventOnce('tabs.onUpdated')

      // Wait for tabs.onUpdated listener to be set
      await new Promise((resolve) => setTimeout(resolve, 10))

      assignTabDetails = (details) => {
        details.discarded = true
      }

      browser.webContents.emit('tab-updated')

      const [_tabId, changeInfo, _tabDetails] = await p
      expect(changeInfo).to.be.an('object')
      expect(Object.keys(changeInfo)).to.have.lengthOf(1)
      expect(changeInfo).to.haveOwnProperty('discarded')
      expect(changeInfo.discarded).to.equal(true)
    })

    /*
      Every tabs.onUpdated the library broadcasts for this tab, read in the main process where it is
      dispatched. Counting absences needs this: an extension-side listener can only prove that an
      event came, never that none did.
    */
    const recordBroadcasts = () => {
      const router = (browser.extensions as any).ctx.router
      const original = router.broadcastEvent
      const seen: { tabId: number; changeInfo: { status?: string; [key: string]: unknown } }[] = []
      router.broadcastEvent = function (eventName: string, ...args: any[]) {
        if (eventName === 'tabs.onUpdated' && args[0] === browser.webContents.id) {
          seen.push({ tabId: args[0], changeInfo: args[1] })
        }
        return original.call(this, eventName, ...args)
      }
      return { seen, restore: () => (router.broadcastEvent = original) }
    }

    /*
      Chromium sends no tabs.onUpdated when a page adds an iframe — measured in Edge 156 with a web
      iframe and with an extension's own one. Electron's did-start-loading/did-stop-loading fire for
      it all the same, and `isLoading()` counts subframes, so the tab used to report 'loading' and
      then 'complete' for a navigation that never happened. Keeper's in-field prompt is an iframe and
      Keeper closes its prompt on `status: 'complete'`: the prompt opened and was shut by its own load.
    */
    it('stays quiet when the page only adds an iframe', async () => {
      const tab = browser.webContents
      const { seen, restore } = recordBroadcasts()
      // The precondition that used to produce the events: the WebContents does go through a load.
      const stopped = emittedOnce(tab, 'did-stop-loading')
      try {
        await tab.executeJavaScript(`new Promise((resolve) => {
          const frame = document.createElement('iframe')
          frame.onload = () => resolve(true)
          frame.src = ${JSON.stringify(`${server.getUrl()}subframe`)}
          document.body.appendChild(frame)
        })`)
        await stopped
        await new Promise((resolve) => setTimeout(resolve, 200))
      } finally {
        restore()
      }

      expect(seen).to.deep.equal([])
      const details = await browser.crx.exec('tabs.get', tab.id)
      expect(details.status).to.equal('complete')
    })

    it('still reports loading and complete for the tab navigating', async () => {
      const tab = browser.webContents
      const { seen, restore } = recordBroadcasts()
      // And the extension receives it, which is the half the broadcast spy cannot vouch for.
      const delivered = browser.crx.eventOnce('tabs.onUpdated')
      await new Promise((resolve) => setTimeout(resolve, 10))
      try {
        await tab.loadURL(`${server.getUrl()}navigated`)
        await new Promise((resolve) => setTimeout(resolve, 100))
      } finally {
        restore()
      }

      const statuses = seen.map((e) => e.changeInfo.status).filter(Boolean)
      expect(statuses[0]).to.equal('loading')
      expect(statuses[statuses.length - 1]).to.equal('complete')
      const [tabId, changeInfo] = await delivered
      expect(tabId).to.equal(tab.id)
      expect(changeInfo.status).to.equal('loading')
    })
  })

  /*
    query() ignored `currentWindow` and `lastFocusedWindow`, so `{ active: true, currentWindow: true }`
    — the most common tabs call there is — answered one tab per window. An extension's own login
    window counts as a window, so a password manager asking for the page in front of the user got
    two tabs and had to guess.
  */
  describe('query() by window', () => {
    const openSecondWindow = () => {
      const other = new BrowserWindow({
        show: false,
        webPreferences: {
          session: browser.session,
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      browser.extensions.addTab(other.webContents, other)
      return other
    }

    it('currentWindow: true limits active tabs to the current window', async () => {
      const other = openSecondWindow()
      try {
        // Both windows have an active tab; the last focused one is the first registered.
        const all = await browser.crx.exec('tabs.query', { active: true })
        expect(all).to.have.lengthOf(2)
        const current = await browser.crx.exec('tabs.query', { active: true, currentWindow: true })
        expect(current).to.have.lengthOf(1)
        expect(current[0].windowId).to.equal(browser.window.id)
        const others = await browser.crx.exec('tabs.query', { currentWindow: false })
        expect(others.map((tab: any) => tab.windowId)).to.deep.equal([other.id])
      } finally {
        other.destroy()
      }
    })

    it('lastFocusedWindow: true follows the focus', async () => {
      const other = openSecondWindow()
      try {
        other.emit('focus')
        const tabs = await browser.crx.exec('tabs.query', { lastFocusedWindow: true })
        expect(tabs).to.have.lengthOf(1)
        expect(tabs[0].windowId).to.equal(other.id)
      } finally {
        other.destroy()
      }
    })
  })

  describe('onHighlighted', () => {
    it('fires with the activated tab, after onActivated', async () => {
      const tab: Electron.WebContents = (webContents as any).create({
        sandbox: true,
        session: browser.session,
      })
      try {
        browser.extensions.addTab(tab, browser.window)
        const highlighted = browser.crx.eventOnce('tabs.onHighlighted')
        await new Promise((resolve) => setTimeout(resolve, 200))
        browser.extensions.selectTab(tab)
        const [info] = await highlighted
        expect(info.tabIds).to.deep.equal([tab.id])
        expect(info.windowId).to.equal(browser.window.id)
      } finally {
        tab.close()
      }
    })
  })

  /*
    Every change of a window's active tab is announced, including the ones nobody asked for: the
    first tab of a window, and the next one when the active tab goes away. Neither fired anything,
    and an embedder that registers its tabs after the extension started (Rambox does) left the
    extension's idea of the active tab — and the preload's sender.tab.active — at none: Dashlane
    then decorated no page at all.
  */
  describe('the active tab', () => {
    const newWindowTab = () => {
      const win = new BrowserWindow({ show: false, webPreferences: { session: browser.session } })
      const tab: Electron.WebContents = (webContents as any).create({
        sandbox: true,
        session: browser.session,
      })
      return { win, tab }
    }
    const activeOf = async (windowId: number) => {
      const tabs = await browser.crx.exec('tabs.query', { active: true, windowId })
      return tabs.map((tab: chrome.tabs.Tab) => tab.id)
    }

    it('announces the first tab of a window as activated', async () => {
      const { win, tab } = newWindowTab()
      try {
        const activated = browser.crx.eventOnce('tabs.onActivated')
        await new Promise((resolve) => setTimeout(resolve, 200))
        browser.extensions.addTab(tab, win)
        const [info] = await activated
        expect(info).to.deep.equal({ tabId: tab.id, windowId: win.id })
      } finally {
        tab.close()
        win.destroy()
      }
    })

    it('does not activate a tab the embedder adds to a window that has one', async () => {
      const tab: Electron.WebContents = (webContents as any).create({
        sandbox: true,
        session: browser.session,
      })
      try {
        browser.extensions.addTab(tab, browser.window)
        expect(await activeOf(browser.window.id)).to.deep.equal([browser.webContents.id])
      } finally {
        tab.close()
      }
    })

    it('announces the next tab when the active one is removed', async () => {
      const { win, tab } = newWindowTab()
      const second: Electron.WebContents = (webContents as any).create({
        sandbox: true,
        session: browser.session,
      })
      try {
        browser.extensions.addTab(tab, win)
        browser.extensions.addTab(second, win)
        browser.extensions.selectTab(second)
        const activated = browser.crx.eventOnce('tabs.onActivated')
        await new Promise((resolve) => setTimeout(resolve, 200))
        browser.extensions.removeTab(second)
        const [info] = await activated
        expect(info).to.deep.equal({ tabId: tab.id, windowId: win.id })
        expect(await activeOf(win.id)).to.deep.equal([tab.id])
      } finally {
        tab.close()
        second.close()
        win.destroy()
      }
    })
  })

  describe('duplicate()', () => {
    it('opens a tab on the same url', async () => {
      const tabId = browser.window.webContents.id
      const result = await browser.crx.exec('tabs.duplicate', tabId)
      expect(result).to.be.an('object')
      expect(result.id).to.not.equal(tabId)
      expect(result.url).to.equal(server.getUrl())
      const tab = webContents.fromId(result.id)
      expect(tab, 'the duplicate exists').to.not.equal(undefined)
      tab?.close()
    })
  })

  describe('update() with a file: url', () => {
    it('is refused like chrome://', async () => {
      const tabId = browser.webContents.id
      const tabInfo = await browser.crx.exec('tabs.update', tabId, { url: 'file:///etc/passwd' })
      expect(tabInfo).to.be.a('null')
      expect(browser.webContents.getURL()).to.equal(server.getUrl())
    })
  })
})

// The MV3 fixture: these are what a service worker registers at its top level, where a missing
// event is a TypeError that takes the worker's registration with it.
describe('chrome.tabs events in a service worker', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  it('are all present', async () => {
    const shapes = await browser.crx.raw({ type: 'event-shapes' })
    for (const [name, shape] of Object.entries<any>(shapes.tabs)) {
      expect(shape.addListener, `tabs.${name}.addListener`).to.equal('function')
      expect(shape.hasListener, `tabs.${name}.hasListener`).to.equal('function')
    }
  })
})
