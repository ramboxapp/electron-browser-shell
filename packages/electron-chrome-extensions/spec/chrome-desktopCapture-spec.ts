import { expect } from 'chai'
import { BrowserWindow } from 'electron'

import { useExtensionBrowser, useServer } from './hooks'
import type {
  DesktopMediaChoice,
  DesktopMediaRequest,
} from '../dist/types/browser/api/desktop-capture'

/*
  chrome.tabCapture and chrome.desktopCapture as Edge 156 and Chromium 147 answer them (measured on
  05/11/2026 with a probe extension, the action invoked through Extensions.triggerAction): the
  activeTab gate, the errors, the Chrome-shaped stream id and its one use, the capture itself from a
  page of the extension through getUserMedia, what getCapturedTabs lists and onStatusChanged says at
  each step, tabCapture.capture in the page only, the embedder's picker for chooseDesktopMedia, and
  a cancel that never calls back.
*/

const NOT_INVOKED =
  'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.'
const STREAM_ID = /^[A-Za-z0-9+/]{22}==$/
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms))

type Picker = (
  request: DesktopMediaRequest,
) => Promise<DesktopMediaChoice | undefined> | DesktopMediaChoice | undefined

const describeCapture = (title: string, withPicker: boolean, body: (ctx: any) => void) => {
  describe(title, () => {
    const server = useServer()
    let picker: Picker = () => undefined
    const browser = useExtensionBrowser({
      url: server.getUrl,
      extensionName: 'capture-mv3',
      ...(withPicker ? { chooseDesktopMedia: (request: DesktopMediaRequest) => picker(request) } : {}),
    })
    const extra: BrowserWindow[] = []

    afterEach(() => {
      picker = () => undefined
      for (const win of extra.splice(0)) if (!win.isDestroyed()) win.destroy()
    })

    const outcome = (method: string, ...args: any[]): Promise<any> =>
      browser.crx.raw({ type: 'outcome', method, args })
    const outcomeCallback = (method: string, ...args: any[]): Promise<any> =>
      browser.crx.raw({ type: 'outcome-callback', method, args })
    const record = (...names: string[]) => browser.crx.raw({ type: 'record-events', names })
    const recorded = (name: string): Promise<any[]> => browser.crx.raw({ type: 'recorded', name })
    const tabId = () => browser.webContents.id

    /** The toolbar click on the active tab: what grants activeTab for it. */
    const clickAction = () =>
      browser.webContents.executeJavaScript(
        `browserAction.activate('${browser.partition}', ${JSON.stringify({
          eventType: 'click',
          extensionId: browser.extension.id,
          tabId: -1,
          anchorRect: { x: 0, y: 0, width: 16, height: 16 },
        })})`,
      )

    /**
     * A page of the extension, in its session: the context that captures. A hidden window rather
     * than a bare WebContentsView: a capture from a view that is in no window took Electron 43 down.
     */
    const openPage = async () => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: { session: browser.session, nodeIntegration: false, contextIsolation: true },
      })
      extra.push(win)
      await win.loadURL(`chrome-extension://${browser.extension.id}/capture.html`)
      return win.webContents
    }
    const inPage = (page: Electron.WebContents, js: string): Promise<any> =>
      page.executeJavaScript(js)

    /** Another tab of the window, never invoked on. */
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

    body({
      browser,
      outcome,
      outcomeCallback,
      record,
      recorded,
      tabId,
      clickAction,
      openPage,
      inPage,
      addSibling,
      setPicker: (next: Picker) => {
        picker = next
      },
    })
  })
}

describeCapture('chrome.tabCapture', true, (ctx) => {
  const { outcome, outcomeCallback, record, recorded, tabId, clickAction, openPage, inPage } = ctx

  it('has the worker surface, with capture in the pages only', async () => {
    const shapes: any = await ctx.browser.crx.raw({ type: 'shapes' })
    expect(shapes.tabCapture).to.deep.equal({
      getMediaStreamId: 'function',
      getCapturedTabs: 'function',
      onStatusChanged: 'event',
      TabCaptureState: { PENDING: 'pending', ACTIVE: 'active', STOPPED: 'stopped', ERROR: 'error' },
    })
    expect(shapes.desktopCapture.chooseDesktopMedia).to.equal('function')
    expect(shapes.desktopCapture.cancelDesktopMedia).to.equal(undefined)
    expect(shapes.desktopCapture.DesktopCaptureSourceType).to.deep.equal({
      SCREEN: 'screen',
      WINDOW: 'window',
      TAB: 'tab',
      AUDIO: 'audio',
    })
    const page = await openPage()
    expect(await inPage(page, 'captureTypeOf()')).to.equal('function')
    expect(await inPage(page, 'captureNoArgs()')).to.equal(
      'Error in invocation of tabCapture.capture(tabCapture.CaptureOptions options, function callback): No matching signature.',
    )
  })

  it('refuses a tab the extension was not invoked on, and an unknown one', async () => {
    expect(await outcome('tabCapture.getMediaStreamId', { targetTabId: tabId() })).to.deep.equal({
      error: NOT_INVOKED,
    })
    expect(await outcome('tabCapture.getMediaStreamId')).to.deep.equal({ error: NOT_INVOKED })
    expect(
      await outcomeCallback('tabCapture.getMediaStreamId', { targetTabId: tabId() }),
    ).to.deep.include({ cbArgs: [], lastError: NOT_INVOKED })
    expect(await outcome('tabCapture.getMediaStreamId', { targetTabId: 987654 })).to.deep.equal({
      error: 'Invalid tab specified.',
    })
    expect(await outcome('tabCapture.getCapturedTabs')).to.deep.equal({ value: [] })
  })

  it('answers a Chrome-shaped id once invoked, for that tab only', async () => {
    const sibling = await ctx.addSibling()
    await clickAction()
    await settle()
    const result = await outcome('tabCapture.getMediaStreamId', { targetTabId: tabId() })
    expect(result.value, JSON.stringify(result)).to.match(STREAM_ID)
    // The active tab is the default target.
    expect((await outcome('tabCapture.getMediaStreamId')).value).to.match(STREAM_ID)
    // Nothing is captured until getUserMedia runs with it.
    expect(await outcome('tabCapture.getCapturedTabs')).to.deep.equal({ value: [] })
    expect(await outcome('tabCapture.getMediaStreamId', { targetTabId: sibling.id })).to.deep.equal(
      { error: NOT_INVOKED },
    )
  })

  it('captures the tab from a page of the extension, reporting each status', async () => {
    await record('tabCapture.onStatusChanged')
    await clickAction()
    await settle()
    const { value: streamId } = await outcome('tabCapture.getMediaStreamId', {
      targetTabId: tabId(),
    })
    const page = await openPage()

    const captured = await inPage(page, `captureTab(${JSON.stringify(streamId)})`)
    expect(captured.ok, JSON.stringify(captured)).to.equal(true)
    expect(captured.isStream).to.equal(true)
    expect(captured.tracks.map((track: any) => track.kind)).to.deep.equal(['audio', 'video'])
    for (const track of captured.tracks) {
      expect(track.readyState).to.equal('live')
      expect(track.deviceId).to.match(/^web-contents-media-stream:\/\//)
    }
    await settle()
    expect(await outcome('tabCapture.getCapturedTabs')).to.deep.equal({
      value: [{ tabId: tabId(), status: 'active', fullscreen: false }],
    })

    // One use: the same id again is Chromium's own failure.
    const again = await inPage(page, `captureTab(${JSON.stringify(streamId)})`)
    expect(again).to.deep.include({ ok: false, error: 'Error starting tab capture' })

    expect(await inPage(page, 'stopCapture()')).to.equal(true)
    await settle()
    expect(await outcome('tabCapture.getCapturedTabs')).to.deep.equal({
      value: [{ tabId: tabId(), status: 'stopped', fullscreen: false }],
    })
    expect((await recorded('tabCapture.onStatusChanged')).map((args: any[]) => args[0])).to.deep.equal(
      [
        { tabId: tabId(), status: 'pending', fullscreen: false },
        { tabId: tabId(), status: 'active', fullscreen: false },
        { tabId: tabId(), status: 'stopped', fullscreen: false },
      ],
    )
  })

  it('keeps a tabCapture id out of a desktop constraint, as Chrome does', async () => {
    await clickAction()
    await settle()
    const { value: streamId } = await outcome('tabCapture.getMediaStreamId', {
      targetTabId: tabId(),
    })
    const page = await openPage()
    const result = await inPage(page, `captureDesktop(${JSON.stringify(streamId)})`)
    expect(result.ok, JSON.stringify(result)).to.equal(false)
  })

  it('mints an id for a consumer tab outside the extension, which that tab uses itself', async () => {
    await clickAction()
    await settle()
    const { value: streamId } = await outcome('tabCapture.getMediaStreamId', {
      targetTabId: tabId(),
      consumerTabId: tabId(),
    })
    expect(streamId).to.match(STREAM_ID)
    const result = await ctx.browser.webContents.executeJavaScript(
      `navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: ${JSON.stringify(streamId)} } } })
        .then((stream) => { const kinds = stream.getTracks().map((t) => t.kind); stream.getTracks().forEach((t) => t.stop()); return { ok: true, kinds } }, (error) => ({ ok: false, error: error.message }))`,
    )
    expect(result, JSON.stringify(result)).to.deep.equal({ ok: true, kinds: ['video'] })
    expect(
      await outcome('tabCapture.getMediaStreamId', { targetTabId: tabId(), consumerTabId: 987654 }),
    ).to.deep.equal({ error: 'Invalid tab specified.' })
  })

  it('tabCapture.capture: lastError until invoked, then the stream', async () => {
    const page = await openPage()
    expect(await inPage(page, 'capture({ video: true, audio: false })')).to.deep.equal({
      stream: null,
      lastError: NOT_INVOKED,
    })
    await clickAction()
    await settle()
    const result = await inPage(
      page,
      'capture({ video: true, audio: true, videoConstraints: { mandatory: { maxWidth: 1280, maxHeight: 720 } } })',
    )
    expect(result.lastError, JSON.stringify(result)).to.equal(null)
    expect(result.stream.isStream).to.equal(true)
    expect(result.stream.tracks.map((track: any) => track.kind)).to.deep.equal(['audio', 'video'])
    expect(await inPage(page, 'stopCapture()')).to.equal(true)
  })
})

describeCapture('chrome.desktopCapture without a picker in the embedder', false, (ctx) => {
  it('answers as a picker the user dismissed', async () => {
    const page = await ctx.openPage()
    expect(await ctx.inPage(page, "choose(['screen', 'window'])")).to.deep.equal({
      requestId: 1,
      called: { streamId: '', options: { canRequestAudioTrack: false }, lastError: null },
    })
  })
})

describeCapture('chrome.desktopCapture', true, (ctx) => {
  const { outcomeCallback, openPage, inPage, setPicker, tabId } = ctx

  it('validates its arguments the way Chrome does', async () => {
    const page = await openPage()
    const signature =
      'desktopCapture.chooseDesktopMedia(array sources, optional tabs.Tab targetTab, optional object options, function callback)'
    expect(await inPage(page, "chooseThrows(['screen'])")).to.equal(
      `Error in invocation of ${signature}: No matching signature.`,
    )
    expect(await inPage(page, "chooseThrows(['nope'], () => {})")).to.equal(
      `Error in invocation of ${signature}: Error at parameter 'sources': Error at index 0: Value must be one of audio, screen, tab, window.`,
    )
    expect(await inPage(page, "chooseThrows(['screen'], { id: 1 }, () => {})")).to.equal(
      `Error in invocation of ${signature}: Error at parameter 'targetTab': Missing required property 'active'.`,
    )
  })

  it('needs a target tab from the worker, and a real one', async () => {
    expect(await outcomeCallback('desktopCapture.chooseDesktopMedia', ['screen'])).to.deep.equal({
      cbArgs: [null, null],
      lastError: 'A target tab is required when called from a service worker context.',
      returned: 1,
    })
    const tab = { id: 987654, active: true, highlighted: true, incognito: false, index: 0, pinned: false, selected: true, windowId: 1 }
    expect(
      await outcomeCallback('desktopCapture.chooseDesktopMedia', ['screen'], tab),
    ).to.deep.equal({ cbArgs: [null, null], lastError: 'Invalid tab specified.', returned: 2 })
    // Cancelling an unknown request is a no-op.
    expect(await ctx.outcome('desktopCapture.cancelChooseDesktopMedia', 12345)).to.deep.equal({
      value: '__undefined__',
    })
  })

  it('offers the embedder the sources asked for, and a tab picked there captures as desktop', async () => {
    let request: DesktopMediaRequest | undefined
    setPicker((incoming: DesktopMediaRequest) => {
      request = incoming
      return { sourceId: `tab:${tabId()}` }
    })
    const page = await openPage()
    // desktopCapturer takes seconds here (WGC enumerates every window): the long wait is for that.
    const result = await inPage(page, "choose(['screen', 'window', 'tab', 'audio'], { waitFor: 8000 })")
    expect(request, 'the embedder was asked').to.not.equal(undefined)
    expect(request!.extension.id).to.equal(ctx.browser.extension.id)
    expect(request!.requestId).to.equal(1)
    expect(request!.types).to.deep.equal(['screen', 'window', 'tab', 'audio'])
    expect(request!.targetTabId).to.equal(undefined)
    expect(request!.signal.aborted).to.equal(false)
    const tabSource = request!.sources.find((source) => source.id === `tab:${tabId()}`)
    expect(tabSource, JSON.stringify(request!.sources.map((s) => s.id))).to.deep.include({
      type: 'tab',
      tabId: tabId(),
      name: 'title',
    })
    for (const source of request!.sources) {
      if (source.type === 'tab') continue
      expect(source.id).to.match(/^(screen|window):/)
      expect(source.name).to.be.a('string')
    }

    expect(result.called.lastError).to.equal(null)
    expect(result.called.options).to.deep.equal({ canRequestAudioTrack: false })
    expect(result.called.streamId).to.match(STREAM_ID)

    const captured = await inPage(page, `captureDesktop(${JSON.stringify(result.called.streamId)})`)
    expect(captured.ok, JSON.stringify(captured)).to.equal(true)
    expect(captured.tracks[0].deviceId).to.match(/^web-contents-media-stream:\/\//)
    // A picker id is a desktop one: it is not good for a tab constraint.
    expect(await inPage(page, 'stopCapture()')).to.equal(true)
  })

  it('captures a screen the embedder picked, with audio when offered and taken', async function () {
    let offered: DesktopMediaRequest | undefined
    setPicker((request: DesktopMediaRequest) => {
      offered = request
      const screen = request.sources.find((source) => source.type === 'screen')
      return screen ? { sourceId: screen.id, audio: true } : undefined
    })
    const page = await openPage()
    const result = await inPage(page, "choose(['screen', 'audio'], { waitFor: 8000 })")
    if (!offered?.sources.some((source) => source.type === 'screen')) {
      // No screen to capture where this runs (a headless CI): the picker answered as dismissed.
      expect(result.called).to.deep.equal({
        streamId: '',
        options: { canRequestAudioTrack: false },
        lastError: null,
      })
      this.skip()
      return
    }
    expect(result.called.options).to.deep.equal({ canRequestAudioTrack: true })
    expect(result.called.streamId).to.match(STREAM_ID)
    const captured = await inPage(page, `captureDesktop(${JSON.stringify(result.called.streamId)})`)
    expect(captured.ok, JSON.stringify(captured)).to.equal(true)
    expect(captured.tracks[0].deviceId).to.match(/^screen:/)
    expect(await inPage(page, 'stopCapture()')).to.equal(true)
  })

  it('answers an empty id when the user dismisses the picker, and counts requests', async () => {
    setPicker(() => undefined)
    const page = await openPage()
    // Tabs only: no desktopCapturer round trip, so the dismissal is what is measured.
    const first = await inPage(page, "choose(['tab'])")
    expect(first).to.deep.equal({
      requestId: 1,
      called: { streamId: '', options: { canRequestAudioTrack: false }, lastError: null },
    })
    expect((await inPage(page, "choose(['tab'])")).requestId).to.equal(2)
  })

  it('cancel closes the picker and never calls back, even if the embedder answers later', async () => {
    let aborted = false
    let answer: (choice: DesktopMediaChoice) => void = () => {}
    setPicker(
      (request: DesktopMediaRequest) =>
        new Promise<DesktopMediaChoice>((resolve) => {
          answer = resolve
          request.signal.addEventListener('abort', () => {
            aborted = true
          })
        }),
    )
    const page = await openPage()
    // Tabs only, so the picker is open (not still enumerating screens) when the cancel arrives.
    const result = await inPage(page, "choose(['tab'], { cancelAfter: 100, waitFor: 600 })")
    expect(aborted, 'the picker was told to close').to.equal(true)
    expect(result.called).to.equal(null)
    answer({ sourceId: 'screen:0:0' })
    await settle()
    expect(await inPage(page, 'typeof chrome.runtime.lastError')).to.equal('undefined')
  })

  it('from the worker with a target tab, the picker is parented to its window', async () => {
    let request: DesktopMediaRequest | undefined
    setPicker((incoming: DesktopMediaRequest) => {
      request = incoming
      return undefined
    })
    const { value: tab } = await ctx.outcome('tabs.get', tabId())
    const result = await outcomeCallback('desktopCapture.chooseDesktopMedia', ['tab'], tab)
    expect(result.cbArgs, JSON.stringify(result)).to.deep.equal(['', { canRequestAudioTrack: false }])
    expect(request!.targetTabId).to.equal(tabId())
    expect(request!.window?.id).to.equal(ctx.browser.window.id)
  })
})
