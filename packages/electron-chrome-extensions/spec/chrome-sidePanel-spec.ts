import { expect } from 'chai'
import { BrowserWindow, WebContentsView } from 'electron'

import { useExtensionBrowser, useServer } from './hooks'

/*
  chrome.sidePanel as Chromium 147 answers it (measured on 29/10/2026 with a probe extension, and the
  action click through Extensions.triggerAction): the options global and per tab, the action-click
  behavior, open() behind a user gesture, close(), onOpened/onClosed firing once per document, the
  embedder events that tell the host what to show, and SIDE_PANEL in runtime.getContexts().
*/

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))

describe('chrome.sidePanel', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })
  const extra: BrowserWindow[] = []
  const views: WebContentsView[] = []

  afterEach(() => {
    for (const win of extra.splice(0)) if (!win.isDestroyed()) win.destroy()
    for (const view of views.splice(0))
      if (!view.webContents.isDestroyed()) view.webContents.close()
  })

  const outcome = (method: string, ...args: any[]): Promise<any> =>
    browser.crx.raw({ type: 'outcome', method, args })
  const outcomeCallback = (method: string, ...args: any[]): Promise<any> =>
    browser.crx.raw({ type: 'outcome-callback', method, args })
  const record = (...names: string[]) => browser.crx.raw({ type: 'record-events', names })
  const recorded = (name: string): Promise<any[]> => browser.crx.raw({ type: 'recorded', name })
  const tabId = () => browser.webContents.id
  const windowId = () => browser.window.id
  const url = (path: string) => `chrome-extension://${browser.extension.id}/${path}`

  /** A real input in a page of the session: what Chrome's user gesture is made of. */
  const gesture = () => {
    browser.webContents.sendInputEvent({
      type: 'mouseDown',
      x: 2,
      y: 2,
      button: 'left',
      clickCount: 1,
    })
    browser.webContents.sendInputEvent({
      type: 'mouseUp',
      x: 2,
      y: 2,
      button: 'left',
      clickCount: 1,
    })
  }

  /** Every 'side-panel-show' and 'side-panel-hide' the embedder gets, in order. */
  const embedderEvents = () => {
    const seen: any[] = []
    browser.extensions.on('side-panel-show', (details) => seen.push({ show: details }))
    browser.extensions.on('side-panel-hide', (details) => seen.push({ hide: details }))
    return seen
  }

  const addSibling = async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { session: browser.session, nodeIntegration: false, contextIsolation: true },
    })
    extra.push(win)
    await win.loadURL(server.getUrl())
    browser.extensions.addTab(win.webContents, browser.window)
    return win.webContents
  }

  const clickAction = () =>
    browser.webContents.executeJavaScript(
      `browserAction.activate('${browser.partition}', ${JSON.stringify({
        eventType: 'click',
        extensionId: browser.extension.id,
        tabId: -1,
        anchorRect: { x: 0, y: 0, width: 16, height: 16 },
      })})`,
    )

  describe('options and behavior', () => {
    it('starts from the manifest default_path, and getOptions needs its argument', async () => {
      expect(await outcome('sidePanel.getOptions', {})).to.deep.equal({
        value: { enabled: true, path: 'sidepanel.html' },
      })
      // A tab with no options of its own answers the global ones, without tabId.
      expect(await outcome('sidePanel.getOptions', { tabId: tabId() })).to.deep.equal({
        value: { enabled: true, path: 'sidepanel.html' },
      })
      expect((await outcome('sidePanel.getOptions')).error).to.match(/No matching signature/)
    })

    it("merges a tab's options over the global ones, and validates nothing", async () => {
      expect(
        await outcome('sidePanel.setOptions', { tabId: tabId(), path: 'other-panel.html' }),
      ).to.deep.equal({
        value: '__undefined__',
      })
      expect(await outcome('sidePanel.getOptions', { tabId: tabId() })).to.deep.equal({
        value: { enabled: true, path: 'other-panel.html', tabId: tabId() },
      })
      await outcome('sidePanel.setOptions', { tabId: tabId(), enabled: false })
      expect(await outcome('sidePanel.getOptions', { tabId: tabId() })).to.deep.equal({
        value: { enabled: false, path: 'other-panel.html', tabId: tabId() },
      })
      expect(await outcome('sidePanel.getOptions', {})).to.deep.equal({
        value: { enabled: true, path: 'sidepanel.html' },
      })
      // Chrome resolves an unknown tab and a missing file alike.
      expect(
        await outcome('sidePanel.setOptions', { tabId: 987654, path: 'x.html' }),
      ).to.deep.equal({
        value: '__undefined__',
      })
      expect(await outcomeCallback('sidePanel.setOptions', { path: 'nope.html' })).to.deep.equal({
        value: '__undefined__',
        lastError: null,
      })
    })

    it('keeps the action-click behavior, and answers the layout', async () => {
      expect(await outcome('sidePanel.getPanelBehavior')).to.deep.equal({
        value: { openPanelOnActionClick: false },
      })
      await outcome('sidePanel.setPanelBehavior', { openPanelOnActionClick: true })
      await outcome('sidePanel.setPanelBehavior', {})
      expect(await outcome('sidePanel.getPanelBehavior')).to.deep.equal({
        value: { openPanelOnActionClick: true },
      })
      expect(await outcome('sidePanel.getLayout')).to.deep.equal({ value: { side: 'right' } })
    })
  })

  describe('open() and close()', () => {
    it('refuses open() without a user gesture, before any other check', async () => {
      const message = '`sidePanel.open()` may only be called in response to a user gesture.'
      expect(await outcome('sidePanel.open', { windowId: windowId() })).to.deep.equal({
        error: message,
      })
      expect(await outcome('sidePanel.open', {})).to.deep.equal({ error: message })
      expect(await outcome('sidePanel.open', { tabId: 987654 })).to.deep.equal({ error: message })
      expect(await outcomeCallback('sidePanel.open', { windowId: windowId() })).to.deep.equal({
        value: '__undefined__',
        lastError: message,
      })
    })

    it("fails with Chrome's errors once there is a gesture", async () => {
      gesture()
      await settle(100)
      expect(await outcome('sidePanel.open', {})).to.deep.equal({
        error: 'At least one of `tabId` and `windowId` must be provided',
      })
      expect(await outcome('sidePanel.open', { tabId: 987654 })).to.deep.equal({
        error: 'No tab with id: 987654.',
      })
      expect(await outcome('sidePanel.open', { windowId: 987654 })).to.deep.equal({
        error: 'No window with id: 987654.',
      })
      await outcome('sidePanel.setOptions', { tabId: tabId(), enabled: false })
      expect(await outcome('sidePanel.open', { tabId: tabId() })).to.deep.equal({
        error: `No active side panel for tabId: ${tabId()}`,
      })
      expect(await outcome('sidePanel.close', {})).to.deep.equal({
        error: 'At least one of `tabId` and `windowId` must be provided',
      })
      expect(await outcome('sidePanel.close', { tabId: 987654 })).to.deep.equal({
        error: 'No tab with id: 987654.',
      })
      // Closing a panel that is not open resolves.
      expect(await outcome('sidePanel.close', { windowId: windowId() })).to.deep.equal({
        value: '__undefined__',
      })
    })

    it('opens with a gesture: the embedder is told what to show, and onOpened fires once', async () => {
      const seen = embedderEvents()
      await record('sidePanel.onOpened', 'sidePanel.onClosed')
      gesture()
      await settle(100)
      expect(await outcome('sidePanel.open', { windowId: windowId() })).to.deep.equal({
        value: '__undefined__',
      })
      await settle()
      expect(seen).to.deep.equal([
        {
          show: {
            extensionId: browser.extension.id,
            windowId: windowId(),
            path: 'sidepanel.html',
            url: url('sidepanel.html'),
          },
        },
      ])
      expect(browser.extensions.getSidePanel(windowId())?.url).to.equal(url('sidepanel.html'))
      expect(await recorded('sidePanel.onOpened')).to.deep.equal([
        [{ path: '/sidepanel.html', windowId: windowId() }],
      ])

      // Opening what is already open fires nothing.
      await outcome('sidePanel.open', { windowId: windowId() })
      await settle()
      expect(await recorded('sidePanel.onOpened')).to.have.length(1)
      expect(seen).to.have.length(1)

      // A new path navigates the open panel, without events.
      await outcome('sidePanel.setOptions', { path: 'other-panel.html' })
      await settle()
      expect(seen[1]).to.deep.include({
        show: {
          extensionId: browser.extension.id,
          windowId: windowId(),
          path: 'other-panel.html',
          url: url('other-panel.html'),
        },
      })
      expect(await recorded('sidePanel.onOpened')).to.have.length(1)
      expect(await recorded('sidePanel.onClosed')).to.deep.equal([])

      // Disabling the open document closes it; a path given with the change is the one reported.
      await outcome('sidePanel.setOptions', { path: 'sidepanel.html', enabled: false })
      await settle()
      expect(await recorded('sidePanel.onClosed')).to.deep.equal([
        [{ path: '/sidepanel.html', windowId: windowId() }],
      ])
      expect(seen[seen.length - 1]).to.deep.equal({
        hide: { extensionId: browser.extension.id, windowId: windowId() },
      })
      expect(browser.extensions.getSidePanel(windowId())).to.equal(undefined)
    })

    it('closes with close() and from the embedder, firing onClosed', async () => {
      const seen = embedderEvents()
      await record('sidePanel.onClosed')
      gesture()
      await settle(100)
      await outcome('sidePanel.open', { windowId: windowId() })
      expect(await outcome('sidePanel.close', { windowId: windowId() })).to.deep.equal({
        value: '__undefined__',
      })
      await settle()
      expect(await recorded('sidePanel.onClosed')).to.deep.equal([
        [{ path: '/sidepanel.html', windowId: windowId() }],
      ])
      expect(seen.map((event) => Object.keys(event)[0])).to.deep.equal(['show', 'hide'])

      await outcome('sidePanel.open', { windowId: windowId() })
      browser.extensions.closeSidePanel(windowId())
      await settle()
      expect(await recorded('sidePanel.onClosed')).to.have.length(2)
      expect(seen.map((event) => Object.keys(event)[0])).to.deep.equal([
        'show',
        'hide',
        'show',
        'hide',
      ])
    })

    it("lets an embedder that refuses the panel close it from inside 'side-panel-show'", async () => {
      // Rambox does this for a basic user: extensions are Pro, so the panel is closed as soon as it
      // opens, and the extension must see onClosed after its onOpened instead of staying "open".
      const seen = embedderEvents()
      browser.extensions.on('side-panel-show', (details) =>
        browser.extensions.closeSidePanel(details.windowId),
      )
      await record('sidePanel.onOpened', 'sidePanel.onClosed')
      gesture()
      await settle(100)
      expect(await outcome('sidePanel.open', { windowId: windowId() })).to.deep.equal({
        value: '__undefined__',
      })
      await settle()
      expect(await recorded('sidePanel.onOpened')).to.deep.equal([
        [{ path: '/sidepanel.html', windowId: windowId() }],
      ])
      expect(await recorded('sidePanel.onClosed')).to.deep.equal([
        [{ path: '/sidepanel.html', windowId: windowId() }],
      ])
      expect(seen.map((event) => Object.keys(event)[0])).to.deep.equal(['show', 'hide'])
      expect(browser.extensions.getSidePanel(windowId())).to.equal(undefined)

      // Nothing is left half-open: the next open() goes through the same cycle again.
      await outcome('sidePanel.open', { windowId: windowId() })
      await settle()
      expect(await recorded('sidePanel.onOpened')).to.have.length(2)
      expect(await recorded('sidePanel.onClosed')).to.have.length(2)
    })

    it("keeps a tab's own document across tab switches, and closes it with its tab", async () => {
      const seen = embedderEvents()
      const sibling = await addSibling()
      await outcome('tabs.update', sibling.id, { active: true })
      await outcome('sidePanel.setOptions', { tabId: sibling.id, path: 'other-panel.html' })
      await record('sidePanel.onOpened', 'sidePanel.onClosed')
      gesture()
      await settle(100)
      await outcome('sidePanel.open', { tabId: sibling.id })
      await settle()
      expect(await recorded('sidePanel.onOpened')).to.deep.equal([
        [{ path: '/other-panel.html', tabId: sibling.id, windowId: windowId() }],
      ])
      expect(seen[0].show).to.deep.include({ tabId: sibling.id, url: url('other-panel.html') })

      // To a tab with no options of its own: Chrome opens the global document for it.
      await outcome('tabs.update', tabId(), { active: true })
      await settle()
      expect((await recorded('sidePanel.onOpened'))[1]).to.deep.equal([
        { path: '/sidepanel.html', windowId: windowId() },
      ])
      expect(seen[1].show).to.deep.equal({
        extensionId: browser.extension.id,
        windowId: windowId(),
        path: 'sidepanel.html',
        url: url('sidepanel.html'),
      })

      // And back: both documents are open, so nothing fires, and the embedder shows the tab's again.
      await outcome('tabs.update', sibling.id, { active: true })
      await settle()
      expect(await recorded('sidePanel.onOpened')).to.have.length(2)
      expect(seen[2].show).to.deep.include({ tabId: sibling.id, url: url('other-panel.html') })

      // The tab goes: its document closes.
      browser.extensions.removeTab(sibling)
      await settle()
      expect(await recorded('sidePanel.onClosed')).to.deep.equal([
        [{ path: '/other-panel.html', tabId: sibling.id, windowId: windowId() }],
      ])
    })

    it('reports the panel the embedder shows as SIDE_PANEL in runtime.getContexts', async () => {
      gesture()
      await settle(100)
      await outcome('sidePanel.open', { windowId: windowId() })
      const view = new WebContentsView({ webPreferences: { session: browser.session } })
      views.push(view)
      await view.webContents.loadURL(browser.extensions.getSidePanel(windowId())!.url)

      const contexts: any[] = await browser.crx.exec('runtime.getContexts', {
        contextTypes: ['SIDE_PANEL'],
      })
      expect(contexts, JSON.stringify(contexts)).to.have.length(1)
      expect(contexts[0]).to.deep.include({
        contextType: 'SIDE_PANEL',
        documentUrl: url('sidepanel.html'),
        documentOrigin: `chrome-extension://${browser.extension.id}`,
        tabId: -1,
        windowId: -1,
        frameId: 0,
        incognito: false,
      })

      // Closed, the same page is no longer the side panel.
      await outcome('sidePanel.close', { windowId: windowId() })
      const after: any[] = await browser.crx.exec('runtime.getContexts', {
        contextTypes: ['SIDE_PANEL'],
      })
      expect(after).to.deep.equal([])
    })
  })

  describe('the action click', () => {
    it('toggles the panel with openPanelOnActionClick, and onClicked does not fire', async () => {
      const seen = embedderEvents()
      await outcome('sidePanel.setPanelBehavior', { openPanelOnActionClick: true })
      await record('action.onClicked', 'sidePanel.onOpened', 'sidePanel.onClosed')
      await clickAction()
      await settle()
      expect(await recorded('sidePanel.onOpened')).to.deep.equal([
        [{ path: '/sidepanel.html', windowId: windowId() }],
      ])
      expect(seen[0].show.url).to.equal(url('sidepanel.html'))
      await clickAction()
      await settle()
      expect(await recorded('sidePanel.onClosed')).to.have.length(1)
      expect(seen[1]).to.have.property('hide')
      expect(await recorded('action.onClicked')).to.deep.equal([])
    })

    it('goes to onClicked when the behavior is off or the panel is disabled, and lets it open()', async () => {
      await record('action.onClicked')
      await clickAction()
      await settle()
      expect(await recorded('action.onClicked')).to.have.length(1)

      await outcome('sidePanel.setPanelBehavior', { openPanelOnActionClick: true })
      await outcome('sidePanel.setOptions', { enabled: false })
      await clickAction()
      await settle()
      expect(await recorded('action.onClicked')).to.have.length(2)

      // The click is a gesture: the extension may open its panel from onClicked.
      await outcome('sidePanel.setOptions', { enabled: true })
      expect(await outcome('sidePanel.open', { windowId: windowId() })).to.deep.equal({
        value: '__undefined__',
      })
    })
  })
})
