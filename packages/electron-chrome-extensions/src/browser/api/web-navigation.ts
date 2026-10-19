import * as electron from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import debug from 'debug'

const d = debug('electron-chrome-extensions:webNavigation')

type DocumentLifecycle = 'prerender' | 'active' | 'cached' | 'pending_deletion'

const getFrame = (frameProcessId: number, frameRoutingId: number) =>
  electron.webFrameMain.fromId(frameProcessId, frameRoutingId)

// Any property access on a disposed WebFrameMain throws ("Render frame was
// disposed before WebFrameMain could be accessed"). Fast redirect chains
// (e.g. OAuth consent flows) can dispose a frame between the navigation
// event that references it and our handlers running, so every entry point
// must check liveness before touching the frame.
const isLiveFrame = (
  frame: Electron.WebFrameMain | null | undefined,
): frame is Electron.WebFrameMain => Boolean(frame && !frame.isDestroyed())

const getFrameId = (frame: Electron.WebFrameMain) =>
  frame === frame.top ? 0 : frame.frameTreeNodeId

const getParentFrameId = (frame: Electron.WebFrameMain) => {
  const parentFrame = frame?.parent
  return parentFrame ? getFrameId(parentFrame) : -1
}

// TODO(mv3): fenced_frame getter API needed
const getFrameType = (frame: Electron.WebFrameMain) =>
  !frame.parent ? 'outermost_frame' : 'sub_frame'

// TODO(mv3): add WebFrameMain API to retrieve this
const getDocumentLifecycle = (frame: Electron.WebFrameMain): DocumentLifecycle => 'active' as const

/*
  `documentId` is left OUT rather than filled with a placeholder.

  It used to be the string 'not-implemented', which is worse than absent: `tabs.sendMessage` is
  Chromium's own, so `{ documentId: 'not-implemented' }` addresses a document that cannot exist and
  the message is delivered nowhere, silently. Real extensions choose between the two addressing
  modes exactly the way the API invites — Keeper 18.2.0 does
  `sendMessage(tabId, msg, documentId !== undefined ? { documentId } : { frameId })` — so a defined
  placeholder sends every one of those messages into the void, while an undefined one makes them
  fall back to `frameId`, which works here.

  Measured against a stock Chromium with the same extension: there the in-field prompt opens and
  stays, and the sequence continues past `restoreLocks` with the `setVisibility` that shows it. In
  Rambox the sequence stopped at `restoreLocks`.

  Implementing real document ids means minting one per document and resolving it back in the
  messaging path, which is Electron's to expose; until then, absent is the honest answer.
*/
const getFrameDetails = (
  frame: Electron.WebFrameMain,
): chrome.webNavigation.GetFrameResultDetails => ({
  // TODO(mv3): implement new properties
  url: frame.url,
  // The type insists on it; undefined is the value, and it does not survive the trip to the
  // extension at all, which is the point.
  documentId: undefined as unknown as string,
  documentLifecycle: getDocumentLifecycle(frame),
  errorOccurred: false,
  frameType: getFrameType(frame),
  // FIXME: frameId is missing from @types/chrome
  ...{
    frameId: getFrameId(frame),
  },
  parentDocumentId: undefined,
  parentFrameId: getParentFrameId(frame),
})

export class WebNavigationAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('webNavigation.getFrame', this.getFrame.bind(this))
    handle('webNavigation.getAllFrames', this.getAllFrames.bind(this))

    this.ctx.store.on('tab-added', this.observeTab.bind(this))
  }

  private observeTab(tab: Electron.WebContents) {
    tab.once('will-navigate', this.onCreatedNavigationTarget.bind(this, tab))
    tab.on('did-start-navigation', this.onBeforeNavigate.bind(this, tab))
    tab.on('did-frame-finish-load', this.onFinishLoad.bind(this, tab))
    tab.on('did-frame-navigate', this.onCommitted.bind(this, tab))
    tab.on('did-navigate-in-page', this.onHistoryStateUpdated.bind(this, tab))

    tab.on('frame-created', (_e, { frame }) => {
      if (!frame || frame.top === frame) return

      frame.on('dom-ready', () => {
        this.onDOMContentLoaded(tab, frame)
      })
    })

    // Main frame dom-ready event
    tab.on('dom-ready', () => {
      if ('mainFrame' in tab) {
        this.onDOMContentLoaded(tab, tab.mainFrame)
      }
    })
  }

  private getFrame(
    event: ExtensionEvent,
    details: chrome.webNavigation.GetFrameDetails,
  ): chrome.webNavigation.GetFrameResultDetails | null {
    const tab = this.ctx.store.getTabById(details.tabId)
    if (!tab) return null

    let targetFrame: Electron.WebFrameMain | undefined

    if (typeof details.frameId === 'number') {
      const mainFrame = tab.mainFrame
      targetFrame = mainFrame.framesInSubtree.filter(isLiveFrame).find((frame: any) => {
        const isMainFrame = frame === frame.top
        return isMainFrame ? details.frameId === 0 : details.frameId === frame.frameTreeNodeId
      })
    }

    return targetFrame ? getFrameDetails(targetFrame) : null
  }

  private getAllFrames(
    event: ExtensionEvent,
    details: chrome.webNavigation.GetFrameDetails,
  ): chrome.webNavigation.GetAllFrameResultDetails[] | null {
    const tab = this.ctx.store.getTabById(details.tabId)
    if (!tab || !('mainFrame' in tab)) return []
    return (tab as any).mainFrame.framesInSubtree.filter(isLiveFrame).map(getFrameDetails)
  }

  private sendNavigationEvent = (eventName: string, details: { url: string }) => {
    d(`${eventName} [url: ${details.url}]`)
    this.ctx.router.broadcastEvent(`webNavigation.${eventName}`, details)
  }

  private onCreatedNavigationTarget = (
    tab: Electron.WebContents,
    { url, frame }: Electron.Event<Electron.WebContentsWillNavigateEventParams>,
  ) => {
    if (!isLiveFrame(frame)) return

    const details: chrome.webNavigation.WebNavigationSourceCallbackDetails = {
      sourceTabId: tab.id,
      sourceProcessId: frame ? frame.processId : -1,
      sourceFrameId: getFrameId(frame),
      url,
      tabId: tab.id,
      timeStamp: Date.now(),
    }
    this.sendNavigationEvent('onCreatedNavigationTarget', details)
  }

  private onBeforeNavigate = (
    tab: Electron.WebContents,
    {
      url,
      isSameDocument,
      frame,
    }: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>,
  ) => {
    if (isSameDocument) return
    if (!isLiveFrame(frame)) return

    const details: chrome.webNavigation.WebNavigationParentedCallbackDetails = {
      frameId: getFrameId(frame),
      frameType: getFrameType(frame),
      documentLifecycle: getDocumentLifecycle(frame),
      parentFrameId: getParentFrameId(frame),
      processId: frame ? frame.processId : -1,
      tabId: tab.id,
      timeStamp: Date.now(),
      url,
    }

    this.sendNavigationEvent('onBeforeNavigate', details)
  }

  private onCommitted = (
    tab: Electron.WebContents,
    _event: Electron.Event,
    url: string,
    _httpResponseCode: number,
    _httpStatusText: string,
    _isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number,
  ) => {
    const frame = getFrame(frameProcessId, frameRoutingId)
    if (!isLiveFrame(frame)) return

    const details: chrome.webNavigation.WebNavigationTransitionCallbackDetails = {
      frameId: getFrameId(frame),
      // NOTE: workaround for property missing in type
      ...{
        parentFrameId: getParentFrameId(frame),
      },
      frameType: getFrameType(frame),
      transitionType: '', // TODO(mv3)
      transitionQualifiers: [], // TODO(mv3)
      documentLifecycle: getDocumentLifecycle(frame),
      processId: frameProcessId,
      tabId: tab.id,
      timeStamp: Date.now(),
      url,
    }
    this.sendNavigationEvent('onCommitted', details)
  }

  private onHistoryStateUpdated = (
    tab: Electron.WebContents,
    event: Electron.Event,
    url: string,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number,
  ) => {
    const frame = getFrame(frameProcessId, frameRoutingId)
    if (!isLiveFrame(frame)) return

    const details: chrome.webNavigation.WebNavigationTransitionCallbackDetails & {
      parentFrameId: number
    } = {
      transitionType: '', // TODO
      transitionQualifiers: [], // TODO
      frameId: getFrameId(frame),
      parentFrameId: getParentFrameId(frame),
      frameType: getFrameType(frame),
      documentLifecycle: getDocumentLifecycle(frame),
      processId: frameProcessId,
      tabId: tab.id,
      timeStamp: Date.now(),
      url,
    }
    this.sendNavigationEvent('onHistoryStateUpdated', details)
  }

  private onDOMContentLoaded = (tab: Electron.WebContents, frame: Electron.WebFrameMain) => {
    if (!isLiveFrame(frame)) return

    const details: chrome.webNavigation.WebNavigationParentedCallbackDetails = {
      frameId: getFrameId(frame),
      parentFrameId: getParentFrameId(frame),
      frameType: getFrameType(frame),
      documentLifecycle: getDocumentLifecycle(frame),
      processId: frame.processId,
      tabId: tab.id,
      timeStamp: Date.now(),
      url: frame.url,
    }
    this.sendNavigationEvent('onDOMContentLoaded', details)

    if (!tab.isLoadingMainFrame()) {
      this.sendNavigationEvent('onCompleted', details)
    }
  }

  private onFinishLoad = (
    tab: Electron.WebContents,
    event: Electron.Event,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number,
  ) => {
    const frame = getFrame(frameProcessId, frameRoutingId)
    if (!isLiveFrame(frame)) return

    const url = tab.getURL()
    const details: chrome.webNavigation.WebNavigationParentedCallbackDetails = {
      frameId: getFrameId(frame),
      parentFrameId: getParentFrameId(frame),
      frameType: getFrameType(frame),
      documentLifecycle: getDocumentLifecycle(frame),
      processId: frameProcessId,
      tabId: tab.id,
      timeStamp: Date.now(),
      url,
    }
    this.sendNavigationEvent('onCompleted', details)
  }
}
