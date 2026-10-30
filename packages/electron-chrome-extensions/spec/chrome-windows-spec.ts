import { expect } from 'chai'
import { app, BrowserWindow, webContents } from 'electron'
import { emittedOnce } from './events-helpers'

import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.windows', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })

  describe('get()', () => {
    it('gets details on the window', async () => {
      const windowId = browser.window.id
      const result = await browser.crx.exec('windows.get', windowId)
      expect(result).to.be.an('object')
      expect(result.id).to.equal(windowId)
    })
  })

  describe('getLastFocused()', () => {
    it('gets the last focused window', async () => {
      // HACK: focus() doesn't actually emit this in tests
      browser.window.emit('focus')
      const windowId = browser.window.id
      const result = await browser.crx.exec('windows.getLastFocused')
      expect(result).to.be.an('object')
      expect(result.id).to.equal(windowId)
    })

    /*
      Never null, even with nothing focused.

      Chrome answers getLastFocused/getCurrent with a window or rejects, so extensions dereference
      the result without guarding. Rejecting is not available here — a throw in a browser-side
      handler comes back to the caller as `undefined`, which crashes an extension exactly like the
      `null` did — so the answer is the window-shaped `{ id: WINDOW_ID_NONE }` that `get()` already
      uses. Grammarly 14.1339.0 does `getCurrent().then((w) => w.focused)` and
      died on `Cannot read properties of null (reading 'focused')` when this resolved null. An
      embedder that registers its window lazily has exactly this shape — windows exist, none is
      marked focused — so the answer falls back to a known window instead of to null.
    */
    it('answers with a window when none is focused', async () => {
      const result = await browser.crx.exec('windows.getLastFocused')
      expect(result, 'getLastFocused resolved null with a window open').to.be.an('object')
      expect(result.id).to.equal(browser.window.id)
    })

    it('answers getCurrent() with a window when none is focused', async () => {
      const result = await browser.crx.exec('windows.getCurrent')
      expect(result, 'getCurrent resolved null with a window open').to.be.an('object')
      expect(result.id).to.equal(browser.window.id)
    })
  })

  /*
    A window's details are live state, read on every call.

    They used to be cached the first time anything asked and refreshed only on 'resized', so the
    answer froze at the moment the window was first seen. In Rambox that is the first addTab() at
    boot: every extension was then told, for the whole session, that the window held no tabs and was
    not focused — while tabs.query() listed four tabs in it and the window had OS focus (measured in
    the app on 28/10/2026). Grammarly 14.1342.0 reads `getCurrent().focused` to decide whether there
    is an active tab at all.
  */
  describe('details are live', () => {
    it('lists a tab added after the window was first read', async () => {
      // Read once first: this is what used to freeze the answer.
      await browser.crx.exec('windows.getAll', { populate: true })

      // Same session as the extension host, or addTab rejects it outright.
      const tab = (webContents as any).create({ sandbox: true, session: browser.session })
      try {
        browser.extensions.addTab(tab, browser.window)
        await tab.loadURL(server.getUrl())

        const [win] = await browser.crx.exec('windows.getAll', { populate: true })
        const tabIds = win.tabs.map((t: chrome.tabs.Tab) => t.id)
        expect(tabIds).to.include(tab.id)
        expect(tabIds).to.include(browser.webContents.id)
      } finally {
        tab.destroy()
      }
    })

    it('reports focus as it is now, not as it was when first read', async () => {
      const before = await browser.crx.exec('windows.getCurrent')
      expect(before.id).to.equal(browser.window.id)

      // focus() does not move OS focus under the spec runner, so the window's own answer is stubbed.
      const original = browser.window.isFocused
      const focused = !before.focused
      browser.window.isFocused = () => focused
      try {
        expect((await browser.crx.exec('windows.getCurrent')).focused).to.equal(focused)
        expect((await browser.crx.exec('windows.getLastFocused')).focused).to.equal(focused)
        expect((await browser.crx.exec('windows.get', browser.window.id)).focused).to.equal(focused)
        const [win] = await browser.crx.exec('windows.getAll')
        expect(win.focused).to.equal(focused)
      } finally {
        browser.window.isFocused = original
      }
    })

    // Chrome only puts `tabs` on a window when asked (measured in Edge 156).
    it('includes tabs only with populate: true', async () => {
      const [plain] = await browser.crx.exec('windows.getAll')
      expect(plain).to.not.have.property('tabs')
      expect(await browser.crx.exec('windows.getCurrent')).to.not.have.property('tabs')
      expect(await browser.crx.exec('windows.get', browser.window.id)).to.not.have.property('tabs')

      const [populated] = await browser.crx.exec('windows.getAll', { populate: true })
      expect(populated.tabs).to.be.an('array').that.is.not.empty
      const current = await browser.crx.exec('windows.getCurrent', { populate: true })
      expect(current.tabs).to.be.an('array').that.is.not.empty
    })
  })

  describe('remove()', () => {
    it('removes the window', async () => {
      const windowId = browser.window.id
      const closedPromise = emittedOnce(browser.window, 'closed')
      browser.crx.exec('windows.remove', windowId)
      await closedPromise
    })

    it('removes the current window', async () => {
      const closedPromise = emittedOnce(browser.window, 'closed')
      browser.crx.exec('windows.remove')
      await closedPromise
    })
  })

  /*
    update() honoured `state` and nothing else. Extensions bring their own window forward with
    `update(id, { focused: true })` and size it with the bounds, and both were silently ignored.
  */
  describe('update()', () => {
    it('applies the bounds', async () => {
      const windowId = browser.window.id
      const result = await browser.crx.exec('windows.update', windowId, {
        left: 40,
        top: 50,
        width: 640,
        height: 480,
      })
      expect(result.width).to.equal(640)
      expect(result.height).to.equal(480)
      const bounds = browser.window.getBounds()
      expect(bounds.width).to.equal(640)
      expect(bounds.height).to.equal(480)
      expect(bounds.x).to.equal(40)
      expect(bounds.y).to.equal(50)
    })

    it('makes the window the last focused one with focused: true', async () => {
      const other = new BrowserWindow({
        show: false,
        webPreferences: {
          session: browser.session,
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      browser.extensions.addTab(other.webContents, other)
      try {
        await browser.crx.exec('windows.update', other.id, { focused: true })
        const current = await browser.crx.exec('windows.getLastFocused')
        expect(current.id).to.equal(other.id)
      } finally {
        other.destroy()
      }
    })
  })
})

/*
  create() handed the embedder the URL untouched. Chrome resolves a relative URL against the
  extension — `windows.create({ url: 'login.html' })` is the documented way to open an extension
  page — and refuses chrome: and file:; here a relative one was unloadable and the rest were let
  through.
*/
describe('chrome.windows.create()', () => {
  const server = useServer()
  const created: Electron.BrowserWindow[] = []
  const opened: string[] = []
  const browser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'rpc-mv3',
    async createWindow(details) {
      opened.push(String(details.url))
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          session: browser.session,
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      created.push(win)
      await win.loadURL(String(details.url))
      return win
    },
  })

  afterEach(() => {
    for (const win of created.splice(0)) if (!win.isDestroyed()) win.destroy()
    opened.length = 0
  })

  it('resolves a relative url against the extension', async () => {
    const result = await browser.crx.exec('windows.create', { url: 'offscreen.html' })
    expect(result).to.be.an('object')
    expect(opened).to.deep.equal([`chrome-extension://${browser.extension.id}/offscreen.html`])
  })

  it('opens the first url of a list', async () => {
    const url = server.getUrl()
    await browser.crx.exec('windows.create', { url: [url, `${url}second`] })
    expect(opened).to.deep.equal([url])
  })

  it('refuses a chrome: url', async () => {
    // With a callback the fixture replies what the callback got: nothing, as the call failed.
    const result = await browser.crx.exec('windows.create', { url: 'chrome://settings' })
    expect(result).to.equal(null)
    expect(opened).to.deep.equal([])
  })
})

/*
  What the rest of chrome.windows answers, against Chromium 147 and Edge 156: the Window object's
  ten fields, the windowTypes filter, Chrome's message for a window that is not there, and the
  state/bounds combinations Chrome refuses.
*/
describe('chrome.windows, as Chrome answers', () => {
  const server = useServer()
  const created: Electron.BrowserWindow[] = []
  const browser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'rpc-mv3',
    async createWindow(details) {
      const win = new BrowserWindow({
        show: false,
        webPreferences: {
          session: browser.session,
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      created.push(win)
      await win.loadURL(String(details.url))
      return win
    },
  })
  const outcome = (method: string, ...args: any[]): Promise<any> =>
    browser.crx.raw({ type: 'outcome', method, args })

  afterEach(() => {
    for (const win of created.splice(0)) if (!win.isDestroyed()) win.destroy()
  })

  it("has Chrome's ten fields and no sessionId", async () => {
    const { value } = await outcome('windows.get', browser.window.id)
    expect(Object.keys(value).sort()).to.deep.equal([
      'alwaysOnTop',
      'focused',
      'height',
      'id',
      'incognito',
      'left',
      'state',
      'top',
      'type',
      'width',
    ])
  })

  it('filters getAll by windowTypes, and reports a popup it opened as one', async () => {
    expect((await outcome('windows.getAll', { windowTypes: ['normal'] })).value).to.have.length(1)
    expect((await outcome('windows.getAll', { windowTypes: ['popup'] })).value).to.deep.equal([])
    const popup = await outcome('windows.create', { url: server.getUrl(), type: 'popup' })
    expect(popup.value.type).to.equal('popup')
    const popups = (await outcome('windows.getAll', { windowTypes: ['popup'] })).value
    expect(popups.map((win: any) => win.id)).to.deep.equal([popup.value.id])
  })

  it("fails for a window that is not there, with Chrome's message", async () => {
    const gone = { error: 'No window with id: 987654.' }
    expect(await outcome('windows.get', 987654)).to.deep.equal(gone)
    expect(await outcome('windows.update', 987654, { focused: true })).to.deep.equal(gone)
    expect(await outcome('windows.remove', 987654)).to.deep.equal(gone)
  })

  it('refuses the state combinations Chrome refuses, and answers update without tabs', async () => {
    const id = browser.window.id
    const invalid = { error: 'Invalid value for state' }
    expect(await outcome('windows.update', id, { state: 'minimized', width: 500 })).to.deep.equal(
      invalid,
    )
    expect(
      await outcome('windows.update', id, { state: 'minimized', focused: true }),
    ).to.deep.equal(invalid)
    expect(
      await outcome('windows.update', id, { state: 'maximized', focused: false }),
    ).to.deep.equal(invalid)
    const { value } = await outcome('windows.update', id, { drawAttention: false })
    expect(value.id).to.equal(id)
    expect(value).to.not.have.property('tabs')
  })
})
