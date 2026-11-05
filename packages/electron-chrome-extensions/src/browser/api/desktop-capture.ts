import { desktopCapturer } from 'electron'
import { randomBytes } from 'node:crypto'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { TabContents } from './common'
import debug from 'debug'

const d = debug('electron-chrome-extensions:desktopCapture')

export type DesktopMediaSourceType = 'screen' | 'window' | 'tab' | 'audio'

/** One thing the user can pick in the embedder's picker. */
export interface DesktopMediaSource {
  /** What a choice hands back: a desktopCapturer id (`screen:0:0`, `window:123:0`) or `tab:<tabId>`. */
  id: string
  type: 'screen' | 'window' | 'tab'
  name: string
  /** desktopCapturer's thumbnail, for screens and windows. */
  thumbnail?: Electron.NativeImage
  /** The window's application icon, when desktopCapturer has one. */
  appIcon?: Electron.NativeImage | null
  displayId?: string
  /** For a tab: its id in the extensions store, and its favicon when one is known. */
  tabId?: number
  favIconUrl?: string
}

/** `chooseDesktopMedia`'s third argument, as Chrome's `ChooseDesktopMediaOptions`. */
export interface DesktopMediaOptions {
  systemAudio?: 'include' | 'exclude'
  selfBrowserSurface?: 'include' | 'exclude'
  suppressLocalAudioPlaybackIntended?: boolean
  windowAudio?: 'system' | 'window' | 'exclude'
}

/** What `chooseDesktopMedia` asks the embedder: show a picker for these sources, answer the choice. */
export interface DesktopMediaRequest {
  extension: Electron.Extension
  /** The id the extension can cancel with; unique per extension context, as Chrome's. */
  requestId: number
  /** The source types the extension asked for, `audio` included when it wants an audio track offered. */
  types: DesktopMediaSourceType[]
  sources: DesktopMediaSource[]
  /** The tab the stream is for, when the extension gave one (`targetTab`). */
  targetTabId?: number
  /** The window to parent the picker to: the target tab's, else the current one. */
  window?: Electron.BaseWindow
  options?: DesktopMediaOptions
  /** Aborted by `cancelChooseDesktopMedia`, or when the extension unloads: close the picker. */
  signal: AbortSignal
}

/** The user's choice: one of the request's sources, and whether audio may be captured with it. */
export interface DesktopMediaChoice {
  sourceId: string
  /** Whether the user agreed to share audio with it; `canRequestAudioTrack` in the extension's answer. */
  audio?: boolean
}

/** What `chrome.tabCapture.getCapturedTabs` lists and `onStatusChanged` reports. */
interface CaptureInfo {
  tabId: number
  status: 'pending' | 'active' | 'stopped' | 'error'
  fullscreen: boolean
}

/** A stream id handed to an extension, and what it stands for until it is used or expires. */
interface ApprovedStream {
  extensionId: string
  /**
   * Which `chromeMediaSource` the id is good for, as Chromium's registry keeps two kinds: a
   * `tabCapture` id works with `'tab'` only, a picker's with `'desktop'` only — a tab picked in the
   * desktop picker included (measured: a tabCapture id under `'desktop'` is "Error starting tab capture").
   */
  registry: 'tab' | 'desktop'
  source: { kind: 'tab'; tab: Electron.WebContents } | { kind: 'desktop'; sourceId: string }
  /** Which document may use it: one tab's WebContents, or any page of the extension. */
  consumer: { webContentsId: number } | { origin: string }
  expiresAt: number
}

/** What the preload swaps into getUserMedia for a stream id of ours. */
interface ResolvedStream {
  chromeMediaSource: 'tab' | 'desktop'
  chromeMediaSourceId: string
}

const NOT_INVOKED_ERROR =
  'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.'
const INVALID_TAB_ERROR = 'Invalid tab specified.'
const WORKER_NEEDS_TAB_ERROR = 'A target tab is required when called from a service worker context.'

/** How long a stream id stays valid: Chromium's DesktopStreamsRegistry keeps an approved stream 10 s. */
const STREAM_LIFETIME_MS = 10_000

const SOURCE_TYPES: DesktopMediaSourceType[] = ['screen', 'window', 'tab', 'audio']

/* By hand: Node's URL answers "null" as the origin of a chrome-extension:// URL. */
const originOf = (url: string) => {
  try {
    const { protocol, host } = new URL(url)
    return `${protocol}//${host}`
  } catch {
    return ''
  }
}

/**
 * chrome.desktopCapture and chrome.tabCapture, on Electron's two capture primitives.
 *
 * Both APIs answer a *stream id*: an opaque string the extension then passes to getUserMedia as
 * `chromeMediaSourceId`. Electron has the same registry Chrome has, reached through
 * `webContents.getMediaSourceId(requester)`, but with a rule the preload has to work around: the id
 * it mints is tied to the exact WebContents that will call getUserMedia (measured on 44.10.1: a
 * sibling page of the same extension, same renderer process, gets "Error starting tab capture"),
 * so it cannot be minted when the extension asks — the asking context is a service worker, or a page
 * other than the one that will capture. And a tab needs `chromeMediaSource: 'tab'` while a screen or
 * window needs `'desktop'`, where Chrome's desktop picker answers one id for either.
 *
 * So the ids handed out here are Chrome-shaped (16 random bytes, base64: what Chromium's registry
 * generates) and ours. The preload wraps `navigator.mediaDevices.getUserMedia` in the extension's
 * pages and, on a constraint carrying one of them, asks `resolveStream` with the calling page as
 * sender: that is when the tab's Electron id is minted for that page, or the desktopCapturer id
 * handed over, and the constraint rewritten to what Electron accepts. One use and ten seconds, as
 * in Chromium; an id that is not ours passes through untouched, so a raw desktopCapturer id keeps
 * working and an expired or foreign id fails with Chromium's own error.
 *
 * The picker is the embedder's (`ChromeExtensionImpl.chooseDesktopMedia`): the library enumerates
 * the sources and waits for a choice. Without the hook the answer is Chrome's for a picker the user
 * dismissed: an empty stream id.
 *
 * Measured against Edge 156 and Chromium 147 (05/11/2026, probe extension, both agree):
 * - `getMediaStreamId` needs the extension to have been invoked on the target tab (action click,
 *   context menu, command: what grants `activeTab`); `<all_urls>` and `tabCapture` alone do not do
 *   it. Without it, or with no target and no active tab: the long "has not been invoked" error. An
 *   unknown tab: "Invalid tab specified.". The id is 24 characters of base64, good for 10 seconds
 *   and one getUserMedia (a second use: "Error starting tab capture"), on both the audio and the
 *   video constraint of that one call.
 * - `getCapturedTabs()` answers `[]` until getUserMedia runs with the id: then the tab appears as
 *   `pending`, `active` once the stream is up, and stays listed as `stopped` after its tracks end,
 *   with `onStatusChanged` for each of the three.
 * - `tabCapture.capture` exists in the extension's pages and not in its worker; it takes
 *   `(options, callback)` and nothing else ("No matching signature"), and answers `null` with
 *   lastError when not invoked.
 * - `chooseDesktopMedia` takes `(sources, targetTab?, options?, callback)`: no callback is a
 *   signature error, an unknown source type a schema error, and an object in second position is
 *   always validated as a `tabs.Tab`. From a worker it needs `targetTab`; an unknown one answers
 *   "Invalid tab specified." through the callback, `(null, null)` with lastError. The request id
 *   counts from 1. `cancelChooseDesktopMedia` closes the picker and never calls the callback;
 *   cancelling an unknown id is a no-op.
 */
export class DesktopCaptureAPI {
  /** Stream ids handed out and not yet used. */
  private streams = new Map<string, ApprovedStream>()
  /** The captures the extension can list, by the stream id that started them. */
  private captures = new Map<string, CaptureInfo & { extensionId: string }>()
  /** Open pickers, by `<extensionId>:<requestId>`. */
  private pickers = new Map<string, AbortController>()
  /** The tabs each extension was invoked on, with the origin that invocation was for. */
  private invocations = new Map<string, Map<number, string>>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    const desktopCapture = { permission: 'desktopCapture' as chrome.runtime.ManifestPermissions }
    const tabCapture = { permission: 'tabCapture' as chrome.runtime.ManifestPermissions }
    handle('desktopCapture.chooseDesktopMedia', this.chooseDesktopMedia, desktopCapture)
    handle('desktopCapture.cancelChooseDesktopMedia', this.cancelChooseDesktopMedia, desktopCapture)
    handle('tabCapture.getMediaStreamId', this.getMediaStreamId, tabCapture)
    handle('tabCapture.getCapturedTabs', this.getCapturedTabs, tabCapture)
    // The preload's half: the swap at getUserMedia time, and what became of the stream.
    handle('desktopCapture.resolveStream', this.resolveStream)
    handle('tabCapture.reportStream', this.reportStream)

    this.ctx.store.on('invoked', (extensionId: string, tab: Electron.WebContents) =>
      this.noteInvocation(extensionId, tab),
    )
    this.ctx.store.on('tab-removed', (tabId: number) => this.onTabRemoved(tabId))

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.forgetExtension(extension.id)
    })
  }

  // --- activeTab --------------------------------------------------------------------------------

  /**
   * Chrome grants `activeTab` for the tab a user action targeted, and keeps it until the tab
   * navigates to another origin or closes. The origin is remembered and compared at use.
   */
  private noteInvocation(extensionId: string, tab: Electron.WebContents) {
    if (tab.isDestroyed()) return
    let tabs = this.invocations.get(extensionId)
    if (!tabs) this.invocations.set(extensionId, (tabs = new Map()))
    tabs.set(tab.id, originOf(tab.getURL()))
  }

  private isInvokedOn(extensionId: string, tab: Electron.WebContents) {
    const origin = this.invocations.get(extensionId)?.get(tab.id)
    return origin !== undefined && origin === originOf(tab.getURL())
  }

  private onTabRemoved(tabId: number) {
    for (const tabs of this.invocations.values()) tabs.delete(tabId)
    for (const [streamId, capture] of Array.from(this.captures)) {
      if (capture.tabId === tabId) this.setCaptureStatus(streamId, 'stopped')
    }
  }

  private forgetExtension(extensionId: string) {
    this.invocations.delete(extensionId)
    for (const [key, controller] of Array.from(this.pickers)) {
      if (key.startsWith(`${extensionId}:`)) {
        controller.abort()
        this.pickers.delete(key)
      }
    }
    for (const [id, stream] of Array.from(this.streams)) {
      if (stream.extensionId === extensionId) this.streams.delete(id)
    }
    for (const [id, capture] of Array.from(this.captures)) {
      if (capture.extensionId === extensionId) this.captures.delete(id)
    }
  }

  // --- the stream registry ----------------------------------------------------------------------

  /** A stream id the way Chromium's DesktopStreamsRegistry makes one: 16 random bytes in base64. */
  private approve(stream: Omit<ApprovedStream, 'expiresAt'>): string {
    const id = randomBytes(16).toString('base64')
    this.streams.set(id, { ...stream, expiresAt: Date.now() + STREAM_LIFETIME_MS })
    setTimeout(() => this.streams.delete(id), STREAM_LIFETIME_MS).unref?.()
    return id
  }

  private senderOrigin(sender: Electron.WebContents) {
    return sender.isDestroyed() ? '' : originOf(sender.getURL())
  }

  /**
   * The preload asks this from the page about to call getUserMedia with one of our ids. Nothing for
   * an id that is not ours, is not for this page, was used, or expired: the constraint then goes to
   * Chromium as it is, which fails it the way Chrome fails a bad id.
   */
  private resolveStream = (
    event: ExtensionEvent,
    streamId: unknown,
    requestedSource: unknown,
  ): ResolvedStream | null => {
    if (event.type !== 'frame' || typeof streamId !== 'string') return null
    const stream = this.streams.get(streamId)
    if (!stream || stream.extensionId !== event.extension.id) return null
    if (requestedSource !== stream.registry) {
      d('resolveStream: %s is a %s id, asked as %s', streamId, stream.registry, requestedSource)
      return null
    }
    const sender = event.sender
    const allowed =
      'webContentsId' in stream.consumer
        ? stream.consumer.webContentsId === sender.id
        : stream.consumer.origin === this.senderOrigin(sender)
    if (!allowed) {
      d('resolveStream: %s is not for %s', streamId, sender.getURL())
      return null
    }
    // One use, as in Chromium's registry: the preload resolves an id once per getUserMedia call,
    // even when it sits on both the audio and the video constraint.
    this.streams.delete(streamId)
    if (Date.now() > stream.expiresAt) return null

    if (stream.source.kind === 'desktop') {
      return { chromeMediaSource: 'desktop', chromeMediaSourceId: stream.source.sourceId }
    }
    const { tab } = stream.source
    if (tab.isDestroyed()) return null
    if (stream.registry === 'tab') this.startCapture(streamId, stream.extensionId, tab.id)
    return { chromeMediaSource: 'tab', chromeMediaSourceId: tab.getMediaSourceId(sender) }
  }

  /**
   * A tabCapture stream is listed from the moment getUserMedia runs with it (not from the id), as
   * Chrome lists it: one entry per tab, the latest capture replacing the one before.
   */
  private startCapture(streamId: string, extensionId: string, tabId: number) {
    for (const [id, capture] of Array.from(this.captures)) {
      if (capture.extensionId === extensionId && capture.tabId === tabId) this.captures.delete(id)
    }
    this.captures.set(streamId, { extensionId, tabId, status: 'pending', fullscreen: false })
    this.ctx.router.sendEvent(extensionId, 'tabCapture.onStatusChanged', {
      tabId,
      status: 'pending',
      fullscreen: false,
    })
  }

  /** The page reports how the capture went: it is the only one that sees the MediaStream. */
  private reportStream = (event: ExtensionEvent, streamId: unknown, status: unknown) => {
    if (typeof streamId !== 'string') return
    const capture = this.captures.get(streamId)
    if (!capture || capture.extensionId !== event.extension.id) return
    if (status === 'active' || status === 'stopped' || status === 'error') {
      this.setCaptureStatus(streamId, status)
    }
  }

  private setCaptureStatus(streamId: string, status: CaptureInfo['status']) {
    const capture = this.captures.get(streamId)
    if (!capture || capture.status === status) return
    capture.status = status
    const { extensionId, ...info } = capture
    this.ctx.router.sendEvent(extensionId, 'tabCapture.onStatusChanged', info)
  }

  // --- chrome.tabCapture ------------------------------------------------------------------------

  private getMediaStreamId = (
    event: ExtensionEvent,
    options: chrome.tabCapture.GetMediaStreamOptions = {},
  ): string => {
    const { extension } = event
    const { store } = this.ctx

    let target: Electron.WebContents | undefined
    if (typeof options?.targetTabId === 'number') {
      target = store.getTabById(options.targetTabId)
      if (!target) throw new Error(INVALID_TAB_ERROR)
    } else {
      target = store.getActiveTabOfCurrentWindow()
    }
    if (!target || !this.isInvokedOn(extension.id, target)) throw new Error(NOT_INVOKED_ERROR)

    let consumer: Electron.WebContents | undefined
    if (typeof options?.consumerTabId === 'number') {
      consumer = store.getTabById(options.consumerTabId)
      if (!consumer) throw new Error(INVALID_TAB_ERROR)
    }

    /*
      A consumer tab that is not a page of the extension has no preload to swap the id in, but
      needs none: Electron's own id, minted for that tab now, is what its getUserMedia with
      `chromeMediaSource: 'tab'` takes. What is lost there is the capture's status: nothing reports
      it back, so it is not listed.
    */
    if (consumer && this.senderOrigin(consumer) !== `chrome-extension://${extension.id}`) {
      return target.getMediaSourceId(consumer)
    }

    const streamId = this.approve({
      extensionId: extension.id,
      registry: 'tab',
      source: { kind: 'tab', tab: target },
      consumer: consumer
        ? { webContentsId: consumer.id }
        : { origin: `chrome-extension://${extension.id}` },
    })
    d('getMediaStreamId: %s for tab %d', streamId, target.id)
    return streamId
  }

  private getCapturedTabs = (event: ExtensionEvent): CaptureInfo[] => {
    const result: CaptureInfo[] = []
    for (const capture of this.captures.values()) {
      if (capture.extensionId !== event.extension.id) continue
      const { extensionId, ...info } = capture
      result.push(info)
    }
    return result
  }

  // --- chrome.desktopCapture --------------------------------------------------------------------

  private async enumerateSources(types: DesktopMediaSourceType[]): Promise<DesktopMediaSource[]> {
    const sources: DesktopMediaSource[] = []
    const nativeTypes = types.filter((type): type is 'screen' | 'window' =>
      type === 'screen' || type === 'window',
    )
    if (nativeTypes.length) {
      const native = await desktopCapturer.getSources({
        types: nativeTypes,
        thumbnailSize: { width: 320, height: 180 },
        fetchWindowIcons: true,
      })
      for (const source of native) {
        sources.push({
          id: source.id,
          type: source.id.startsWith('screen:') ? 'screen' : 'window',
          name: source.name,
          thumbnail: source.thumbnail,
          appIcon: source.appIcon,
          displayId: source.display_id,
        })
      }
    }
    if (types.includes('tab')) {
      for (const tab of this.ctx.store.tabs) {
        if (tab.isDestroyed()) continue
        sources.push({
          id: `tab:${tab.id}`,
          type: 'tab',
          name: tab.getTitle(),
          tabId: tab.id,
          favIconUrl: (tab as TabContents).favicon,
        })
      }
    }
    return sources
  }

  private chooseDesktopMedia = async (
    event: ExtensionEvent,
    requestId: number,
    sources: unknown,
    targetTab?: { id?: number },
    options?: DesktopMediaOptions,
  ): Promise<{ streamId: string; canRequestAudioTrack: boolean }> => {
    const { extension } = event
    const cancelled = { streamId: '', canRequestAudioTrack: false }
    const types = (Array.isArray(sources) ? sources : []).filter(
      (type): type is DesktopMediaSourceType => SOURCE_TYPES.includes(type),
    )

    let target: Electron.WebContents | undefined
    if (targetTab && typeof targetTab === 'object') {
      target = typeof targetTab.id === 'number' ? this.ctx.store.getTabById(targetTab.id) : undefined
      if (!target) throw new Error(INVALID_TAB_ERROR)
    } else if (event.type === 'service-worker') {
      throw new Error(WORKER_NEEDS_TAB_ERROR)
    }

    const pick = this.ctx.store.impl.chooseDesktopMedia
    if (!pick) {
      d('chooseDesktopMedia: no picker in the embedder, answering as dismissed')
      return cancelled
    }

    const key = `${extension.id}:${requestId}`
    const controller = new AbortController()
    this.pickers.set(key, controller)
    try {
      const list = await this.enumerateSources(types)
      if (controller.signal.aborted) return cancelled
      const window = target
        ? this.ctx.store.tabToWindow.get(target)
        : this.ctx.store.getCurrentWindow() || undefined
      const choice = await pick({
        extension,
        requestId,
        types,
        sources: list,
        targetTabId: target?.id,
        window: window && !window.isDestroyed() ? window : undefined,
        options,
        signal: controller.signal,
      })
      if (controller.signal.aborted || !choice) return cancelled
      const chosen = list.find((source) => source.id === choice.sourceId)
      if (!chosen) {
        d('chooseDesktopMedia: the embedder chose %s, which was not offered', choice.sourceId)
        return cancelled
      }

      const consumer = target
        ? { webContentsId: target.id }
        : { origin: `chrome-extension://${extension.id}` }
      let streamId: string
      if (chosen.type === 'tab') {
        const tab = this.ctx.store.getTabById(chosen.tabId!)
        if (!tab) return cancelled
        streamId = this.approve({
          extensionId: extension.id,
          registry: 'desktop',
          source: { kind: 'tab', tab },
          consumer,
        })
      } else if (target && this.senderOrigin(target) !== `chrome-extension://${extension.id}`) {
        // A page outside the extension has no preload to resolve our id: the raw desktopCapturer id
        // is what Electron accepts from any page with `chromeMediaSource: 'desktop'`.
        streamId = chosen.id
      } else {
        streamId = this.approve({
          extensionId: extension.id,
          registry: 'desktop',
          source: { kind: 'desktop', sourceId: chosen.id },
          consumer,
        })
      }
      return { streamId, canRequestAudioTrack: types.includes('audio') && choice.audio === true }
    } finally {
      this.pickers.delete(key)
    }
  }

  private cancelChooseDesktopMedia = (event: ExtensionEvent, requestId: unknown) => {
    const controller = this.pickers.get(`${event.extension.id}:${requestId}`)
    if (!controller) return
    d('cancelChooseDesktopMedia: %s %s', event.extension.id, requestId)
    controller.abort()
  }
}
