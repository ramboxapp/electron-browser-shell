import { expect } from 'chai'
import { BrowserWindow } from 'electron'

import { useExtensionBrowser, useServer } from './hooks'

/*
  The part of chrome.tabs that Chrome has and the library did not — zoom events, move, discard,
  group, the full update and query, and the Tab object's own fields — asked from an MV3 worker, with
  what each answer must be read from Chromium 147 (and Edge 156 where they differ). Every event is
  asserted to FIRE, and to stay quiet where Chrome stays quiet.
*/

const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))

const useTabsBrowser = (discardTab?: (tab: Electron.WebContents) => any) => {
  const server = useServer()
  const browser = useExtensionBrowser({
    url: server.getUrl,
    extensionName: 'rpc-mv3',
    ...(discardTab ? { discardTab } : {}),
  })
  const extra: BrowserWindow[] = []

  afterEach(() => {
    for (const win of extra.splice(0)) if (!win.isDestroyed()) win.destroy()
  })

  const newWindow = async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { session: browser.session, nodeIntegration: false, contextIsolation: true },
    })
    extra.push(win)
    await win.loadURL(server.getUrl())
    return win
  }

  return {
    server,
    browser,
    outcome: (method: string, ...args: any[]): Promise<any> =>
      browser.crx.raw({ type: 'outcome', method, args }),
    outcomeCallback: (method: string, ...args: any[]): Promise<any> =>
      browser.crx.raw({ type: 'outcome-callback', method, args }),
    record: (...names: string[]) => browser.crx.raw({ type: 'record-events', names }),
    recorded: (name: string): Promise<any[]> => browser.crx.raw({ type: 'recorded', name }),
    tabId: () => browser.webContents.id,
    newWindow,
    /** A second tab in the test's window, the way Rambox registers every service in its one window. */
    addSibling: async () => {
      const win = await newWindow()
      browser.extensions.addTab(win.webContents, browser.window)
      return win.webContents
    },
    /** A tab with a window of its own. */
    addOwnWindowTab: async () => {
      const win = await newWindow()
      browser.extensions.addTab(win.webContents, win)
      return win
    },
  }
}

describe('chrome.tabs zoom', () => {
  const { browser, outcome, record, recorded, tabId } = useTabsBrowser()

  it('answers getZoom without a tab id for the active tab', async () => {
    const result = await outcome('tabs.getZoom')
    expect(result).to.deep.equal({ value: 1 })
  })

  it('fires onZoomChange for setZoom, and setZoom(0) resets to the default', async () => {
    await record('tabs.onZoomChange')
    expect(await outcome('tabs.setZoom', tabId(), 1.5)).to.deep.equal({ value: '__undefined__' })
    await settle()
    expect(browser.webContents.getZoomFactor()).to.equal(1.5)
    expect(await outcome('tabs.setZoom', tabId(), 0)).to.deep.equal({ value: '__undefined__' })
    await settle()
    expect(await outcome('tabs.getZoom', tabId())).to.deep.equal({ value: 1 })

    const events = await recorded('tabs.onZoomChange')
    expect(events).to.deep.equal([
      [
        {
          tabId: tabId(),
          oldZoomFactor: 1,
          newZoomFactor: 1.5,
          zoomSettings: { mode: 'automatic', scope: 'per-origin' },
        },
      ],
      [
        {
          tabId: tabId(),
          oldZoomFactor: 1.5,
          newZoomFactor: 1,
          zoomSettings: { mode: 'automatic', scope: 'per-origin' },
        },
      ],
    ])
  })

  it('fires onZoomChange for setZoomSettings, and refuses setZoom in disabled mode', async () => {
    await record('tabs.onZoomChange')
    await outcome('tabs.setZoomSettings', tabId(), { mode: 'disabled' })
    await settle()
    const [[change]] = await recorded('tabs.onZoomChange')
    expect(change.zoomSettings.mode).to.equal('disabled')
    expect(await outcome('tabs.setZoom', tabId(), 1.25)).to.deep.equal({
      error: 'Cannot zoom a tab in disabled mode.',
    })
    await outcome('tabs.setZoomSettings', tabId(), { mode: 'automatic', scope: 'per-origin' })
    expect((await outcome('tabs.getZoomSettings', tabId())).value).to.deep.equal({
      defaultZoomFactor: 1,
      mode: 'automatic',
      scope: 'per-origin',
    })
  })

  it("reads Chrome's message for a tab that is not there", async () => {
    expect(await outcome('tabs.getZoom', 987654)).to.deep.equal({
      error: 'No tab with id: 987654.',
    })
    expect(await outcome('tabs.setZoom', 987654, 1.1)).to.deep.equal({
      error: 'No tab with id: 987654.',
    })
  })
})

describe('chrome.tabs.move()', () => {
  const { browser, outcome, record, recorded, tabId, addSibling, addOwnWindowTab } =
    useTabsBrowser()

  it('moves a tab within its window and fires onMoved', async () => {
    const sibling = await addSibling()
    await record('tabs.onMoved')
    const before = (await outcome('tabs.query', { windowId: browser.window.id })).value
    expect(before.map((tab: any) => [tab.id, tab.index])).to.deep.equal([
      [tabId(), 0],
      [sibling.id, 1],
    ])

    const moved = await outcome('tabs.move', sibling.id, { index: 0 })
    expect(moved.value.id).to.equal(sibling.id)
    expect(moved.value.index).to.equal(0)
    await settle()
    expect(await recorded('tabs.onMoved')).to.deep.equal([
      [sibling.id, { windowId: browser.window.id, fromIndex: 1, toIndex: 0 }],
    ])
    const after = (await outcome('tabs.query', { windowId: browser.window.id })).value
    expect(after.map((tab: any) => [tab.id, tab.index])).to.deep.equal([
      [sibling.id, 0],
      [tabId(), 1],
    ])
  })

  it('fires nothing for a move to where the tab already is, and -1 means the end', async () => {
    const sibling = await addSibling()
    await record('tabs.onMoved')
    await outcome('tabs.move', sibling.id, { index: 1 })
    await settle()
    expect(await recorded('tabs.onMoved')).to.deep.equal([])
    await outcome('tabs.move', sibling.id, { index: 0 })
    const back = await outcome('tabs.move', sibling.id, { index: -1 })
    expect(back.value.index).to.equal(1)
  })

  it('answers a list with a list', async () => {
    const sibling = await addSibling()
    const one = await outcome('tabs.move', [sibling.id], { index: 0 })
    expect(one.value).to.be.an('object').that.has.property('id', sibling.id)
    const both = await outcome('tabs.move', [tabId(), sibling.id], { index: 0 })
    expect(both.value.map((tab: any) => tab.id)).to.deep.equal([tabId(), sibling.id])
  })

  it('refuses another window, an unknown window and a missing index', async () => {
    const other = await addOwnWindowTab()
    expect(await outcome('tabs.move', tabId(), { windowId: other.id, index: 0 })).to.deep.equal({
      error: 'Tabs can only be moved to and from normal windows.',
    })
    expect(await outcome('tabs.move', tabId(), { windowId: 987654, index: 0 })).to.deep.equal({
      error: 'No window with id: 987654.',
    })
    const noIndex = await outcome('tabs.move', tabId(), {})
    expect(noIndex.error).to.contain("Missing required property 'index'.")
    expect(await outcome('tabs.move', 987654, { index: 0 })).to.deep.equal({
      error: 'No tab with id: 987654.',
    })
  })
})

describe('chrome.tabs.update() fields', () => {
  const { outcome, outcomeCallback, record, recorded, tabId, addSibling } = useTabsBrowser()

  it('keeps pinned and autoDiscardable, and reports them through onUpdated', async () => {
    await record('tabs.onUpdated')
    const pinned = await outcome('tabs.update', tabId(), { pinned: true })
    expect(pinned.value.pinned).to.equal(true)
    const notDiscardable = await outcome('tabs.update', tabId(), { autoDiscardable: false })
    expect(notDiscardable.value.autoDiscardable).to.equal(false)
    await settle()
    const changes = (await recorded('tabs.onUpdated')).map(([, changeInfo]: any[]) => changeInfo)
    expect(changes).to.deep.include({ pinned: true })
    expect(changes).to.deep.include({ autoDiscardable: false })
    expect(
      (await outcome('tabs.query', { pinned: true })).value.map((t: any) => t.id),
    ).to.deep.equal([tabId()])
  })

  it('sets openerTabId, and refuses an opener that is not there', async () => {
    const sibling = await addSibling()
    const result = await outcome('tabs.update', sibling.id, { openerTabId: tabId() })
    expect(result.value.openerTabId).to.equal(tabId())
    expect(await outcome('tabs.update', sibling.id, { openerTabId: 987654 })).to.deep.equal({
      error: 'No tab with id: 987654.',
    })
  })

  it('fails for a tab that is not there, with lastError for a callback', async () => {
    expect(await outcome('tabs.update', 987654, { pinned: true })).to.deep.equal({
      error: 'No tab with id: 987654.',
    })
    const callback = await outcomeCallback('tabs.update', 987654, { muted: true })
    expect(callback.lastError).to.equal('No tab with id: 987654.')
  })

  it('makes a tab it highlights the active one', async () => {
    const sibling = await addSibling()
    await outcome('tabs.update', tabId(), { active: true })
    await record('tabs.onActivated')
    const result = await outcome('tabs.update', sibling.id, { highlighted: true })
    expect(result.value.active).to.equal(true)
    await settle()
    const activations = await recorded('tabs.onActivated')
    expect(activations.map(([info]: any[]) => info.tabId)).to.deep.equal([sibling.id])
  })
})

describe('chrome.tabs.query() filters and the Tab object', () => {
  const { browser, outcome, outcomeCallback, tabId, addSibling } = useTabsBrowser()

  it('filters by the index within the window', async () => {
    const sibling = await addSibling()
    const second = await outcome('tabs.query', { windowId: browser.window.id, index: 1 })
    expect(second.value.map((tab: any) => tab.id)).to.deep.equal([sibling.id])
    const first = await outcome('tabs.query', { index: 0 })
    expect(first.value.map((tab: any) => tab.id)).to.deep.equal([tabId()])
  })

  it('filters by window type', async () => {
    await addSibling()
    expect((await outcome('tabs.query', { windowType: 'normal' })).value).to.have.length(2)
    expect((await outcome('tabs.query', { windowType: 'popup' })).value).to.deep.equal([])
  })

  it("carries Chrome's fields", async () => {
    const { value: tab } = await outcome('tabs.get', tabId())
    expect(tab.index).to.equal(0)
    expect(tab.groupId).to.equal(-1)
    expect(tab.splitViewId).to.equal(-1)
    expect(tab.lastAccessed).to.be.a('number')
    expect(tab.pinned).to.equal(false)
    expect(tab.discarded).to.equal(false)
    expect(tab.autoDiscardable).to.equal(true)
    expect(tab).to.not.have.property('pendingUrl')
    expect(tab).to.not.have.property('openerTabId')
  })

  // Chromium 147: the promise rejects with "No tab with id: N.", and the callback gets undefined
  // with lastError set. It used to answer {id: -1}.
  it('fails get for a tab that is not there, with lastError for a callback', async () => {
    expect(await outcome('tabs.get', 987654)).to.deep.equal({ error: 'No tab with id: 987654.' })
    expect(await outcomeCallback('tabs.get', 987654)).to.deep.equal({
      value: '__undefined__',
      lastError: 'No tab with id: 987654.',
    })
    expect((await outcome('tabs.get', tabId())).value.id).to.equal(tabId())
  })
})

describe('chrome.tabs.group() and ungroup()', () => {
  const { outcome, outcomeCallback, tabId } = useTabsBrowser()

  it("fails grouping as Chrome does where tabs cannot be grouped, after Chrome's own checks", async () => {
    expect(await outcome('tabs.group', { tabIds: tabId() })).to.deep.equal({
      error: 'Grouping is not supported by tabs in this window.',
    })
    expect(await outcome('tabs.group', { tabIds: 987654 })).to.deep.equal({
      error: 'No tab with id: 987654.',
    })
    expect(await outcome('tabs.group', { tabIds: tabId(), groupId: 5 })).to.deep.equal({
      error: 'No group with id: 5.',
    })
    const callback = await outcomeCallback('tabs.group', { tabIds: 987654 })
    expect(callback.lastError).to.equal('No tab with id: 987654.')
  })

  it('ungroups a tab that is in no group, and fails for one that is not there', async () => {
    expect(await outcome('tabs.ungroup', tabId())).to.deep.equal({ value: '__undefined__' })
    expect(await outcome('tabs.ungroup', 987654)).to.deep.equal({
      error: 'No tab with id: 987654.',
    })
  })
})

describe('chrome.tabs.discard() without an embedder hook', () => {
  const { outcome, tabId } = useTabsBrowser()

  it('fails as Chrome does for a tab it will not discard', async () => {
    expect(await outcome('tabs.discard', tabId())).to.deep.equal({
      error: `Cannot discard tab with id: ${tabId()}.`,
    })
    expect(await outcome('tabs.discard')).to.deep.equal({
      error: 'Cannot find a tab to discard.',
    })
    expect(await outcome('tabs.discard', 987654)).to.deep.equal({
      error: 'No tab with id: 987654.',
    })
  })
})

describe('chrome.tabs.discard() through the embedder', () => {
  let hook: (tab: Electron.WebContents) => any = () => undefined
  const { browser, outcome, record, recorded, addSibling, newWindow } = useTabsBrowser((tab) =>
    hook(tab),
  )

  it('asks the embedder, then reports the tab discarded through onUpdated', async () => {
    const asked: number[] = []
    hook = (tab) => {
      asked.push(tab.id)
    }
    const sibling = await addSibling()
    await record('tabs.onUpdated')
    const result = await outcome('tabs.discard', sibling.id)
    expect(asked).to.deep.equal([sibling.id])
    expect(result.value.discarded).to.equal(true)
    expect(result.value.status).to.equal('unloaded')
    await settle()
    const changes = (await recorded('tabs.onUpdated')).map(([, changeInfo]: any[]) => changeInfo)
    expect(changes).to.deep.include({ discarded: true, status: 'unloaded' })
    expect(
      (await outcome('tabs.query', { discarded: true })).value.map((tab: any) => tab.id),
    ).to.deep.equal([sibling.id])
    expect(await outcome('tabs.discard', sibling.id)).to.deep.equal({
      error: `Cannot discard tab with id: ${sibling.id}.`,
    })
  })

  it('fails when the embedder refuses', async () => {
    hook = () => false
    const sibling = await addSibling()
    expect(await outcome('tabs.discard', sibling.id)).to.deep.equal({
      error: `Cannot discard tab with id: ${sibling.id}.`,
    })
  })

  it('fires onReplaced when the embedder replaces the tab', async () => {
    const sibling = await addSibling()
    let replacementId = -1
    hook = async () => {
      const win = await newWindow()
      browser.extensions.addTab(win.webContents, browser.window)
      replacementId = win.webContents.id
      return win.webContents
    }
    await record('tabs.onReplaced')
    const result = await outcome('tabs.discard', sibling.id)
    expect(result.value.id).to.equal(replacementId)
    expect(result.value.discarded).to.equal(true)
    await settle()
    expect(await recorded('tabs.onReplaced')).to.deep.equal([[replacementId, sibling.id]])
  })
})
