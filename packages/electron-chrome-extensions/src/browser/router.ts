import { app, ipcMain, Session } from 'electron'
import debug from 'debug'

import { resolvePartition } from './partition'

// Shorten base64 encoded icons
const shortenValues = (k: string, v: any) =>
  typeof v === 'string' && v.length > 128 ? v.substr(0, 128) + '...' : v

debug.formatters.r = (value: any) => {
  return value ? JSON.stringify(value, shortenValues, '  ') : value
}

export type IpcEvent = Electron.IpcMainEvent | Electron.IpcMainServiceWorkerEvent
export type IpcInvokeEvent = Electron.IpcMainInvokeEvent | Electron.IpcMainServiceWorkerInvokeEvent
export type IpcAnyEvent = IpcEvent | IpcInvokeEvent

const getSessionFromEvent = (event: IpcAnyEvent): Electron.Session => {
  if (event.type === 'service-worker') {
    return event.session
  } else {
    return event.sender.session
  }
}

const getHostFromEvent = (event: IpcAnyEvent) => {
  if (event.type === 'service-worker') {
    return event.serviceWorker
  } else {
    return event.sender
  }
}

const d = debug('electron-chrome-extensions:router')

const EXTENSION_URL = /^chrome-extension:\/\/([^/?#]+)/

/** The extension id of a `chrome-extension://<id>/...` URL or origin, or undefined. */
export const extensionIdFromUrl = (url: string | undefined | null): string | undefined => {
  const match = typeof url === 'string' ? EXTENSION_URL.exec(url) : null
  return match ? match[1] : undefined
}

/**
 * The extension an IPC really comes from, read from the sender and never from the message: a
 * frame's origin (its URL when the origin is opaque, as in an extension's sandboxed page) or a
 * service worker's scope. Undefined when the sender is not an extension context.
 *
 * An about:blank or srcdoc frame inherits its creator's origin, so one an extension page creates
 * reads as that extension, and one a web page creates (a password manager's inline menu host) as
 * the web page. The library's preload never enters those frames (it only injects where `location`
 * is a chrome-extension:// URL), so nothing legitimate arrives from them anyway.
 */
export const getSenderExtensionId = (event: IpcAnyEvent): string | undefined => {
  if (event.type === 'service-worker') {
    return extensionIdFromUrl((event as any).serviceWorker?.scope)
  }
  let frame: Electron.WebFrameMain | null | undefined
  try {
    frame = (event as any).senderFrame
  } catch {
    // Electron throws reading senderFrame of a frame that navigated or went away.
    frame = undefined
  }
  if (!frame) return undefined
  return extensionIdFromUrl(frame.origin) || extensionIdFromUrl(frame.url)
}

/**
 * Whether the id an IPC claims belongs to its sender. An extension context can only speak for
 * itself: otherwise extension A, or a compromised renderer of A, calls `cookies.getAll` with the
 * permissions of B. A claim of no extension at all is checked by the handler (`extensionContext`).
 */
const checkSenderClaim = (event: IpcAnyEvent, extensionId: string | undefined) => {
  const senderId = getSenderExtensionId(event)
  return { ok: !extensionId || senderId === extensionId, senderId }
}

const describeSender = (senderId: string | undefined) =>
  senderId ? `extension ${senderId}` : 'a context that is not an extension'

const DEFAULT_SESSION = '_self'

interface RoutingDelegateObserver {
  session: Electron.Session
  onExtensionMessage(
    event: Electron.IpcMainInvokeEvent,
    extensionId: string | undefined,
    handlerName: string,
    ...args: any[]
  ): Promise<void>
  addListener(listener: EventListener, extensionId: string, eventName: string): void
  removeListener(listener: EventListener, extensionId: string, eventName: string): void
}

let gRoutingDelegate: RoutingDelegate

/**
 * Handles event routing IPCs and delivers them to the observer with the
 * associated session.
 */
class RoutingDelegate {
  static get() {
    return gRoutingDelegate || (gRoutingDelegate = new RoutingDelegate())
  }

  private sessionMap: WeakMap<Session, RoutingDelegateObserver> = new WeakMap()
  private workers: WeakSet<any> = new WeakSet()

  private constructor() {
    ipcMain.handle('crx-msg', this.onRouterMessage)
    ipcMain.handle('crx-msg-remote', this.onRemoteMessage)
    ipcMain.on('crx-add-listener', this.onAddListener)
    ipcMain.on('crx-remove-listener', this.onRemoveListener)
  }

  addObserver(observer: RoutingDelegateObserver) {
    this.sessionMap.set(observer.session, observer)

    const maybeListenForWorkerEvents = ({
      runningStatus,
      versionId,
    }: Electron.Event<Electron.ServiceWorkersRunningStatusChangedEventParams>) => {
      if (runningStatus !== 'starting') return

      const serviceWorker = (observer.session as any).serviceWorkers.getWorkerFromVersionID(
        versionId,
      )
      if (
        serviceWorker?.scope?.startsWith('chrome-extension://') &&
        !this.workers.has(serviceWorker)
      ) {
        d(`listening to service worker [versionId:${versionId}, scope:${serviceWorker.scope}]`)
        this.workers.add(serviceWorker)
        serviceWorker.ipc.handle('crx-msg', this.onRouterMessage)
        serviceWorker.ipc.handle('crx-msg-remote', this.onRemoteMessage)
        serviceWorker.ipc.on('crx-add-listener', this.onAddListener)
        serviceWorker.ipc.on('crx-remove-listener', this.onRemoveListener)
      }
    }
    observer.session.serviceWorkers.on('running-status-changed', maybeListenForWorkerEvents)
  }

  private onRouterMessage = async (
    event: Electron.IpcMainInvokeEvent,
    extensionId: string,
    handlerName: string,
    ...args: any[]
  ) => {
    d(`received '${handlerName}'`, args)

    const { ok, senderId } = checkSenderClaim(event, extensionId)
    if (!ok) {
      throw new Error(
        `${handlerName} was sent for extension ${extensionId} from ${describeSender(senderId)}`,
      )
    }

    const observer = this.sessionMap.get(getSessionFromEvent(event))

    // The sender's own id, also when it claimed none: an extension never acts as "no extension".
    return observer?.onExtensionMessage(event, senderId ?? extensionId, handlerName, ...args)
  }

  private onRemoteMessage = async (
    event: Electron.IpcMainInvokeEvent,
    sessionPartition: string,
    handlerName: string,
    ...args: any[]
  ) => {
    d(`received remote '${handlerName}' for '${sessionPartition}'`, args)

    const ses =
      sessionPartition === DEFAULT_SESSION
        ? getSessionFromEvent(event)
        : resolvePartition(sessionPartition)

    const observer = this.sessionMap.get(ses)

    return observer?.onExtensionMessage(event, undefined, handlerName, ...args)
  }

  private onAddListener = (event: IpcAnyEvent, extensionId: string, eventName: string) => {
    // An ipcMain.on handler: nothing catches a throw here, so a claim that is not the sender's own
    // is dropped instead of thrown.
    const { ok, senderId } = checkSenderClaim(event, extensionId)
    if (!ok || !senderId) {
      d(`ignoring '${eventName}' listener for ${extensionId} from ${describeSender(senderId)}`)
      return
    }
    const observer = this.sessionMap.get(getSessionFromEvent(event))
    const listener: EventListener =
      event.type === 'frame'
        ? {
            type: event.type,
            extensionId,
            host: event.sender,
          }
        : {
            type: event.type,
            extensionId,
          }
    return observer?.addListener(listener, extensionId, eventName)
  }

  private onRemoveListener = (
    event: Electron.IpcMainInvokeEvent,
    extensionId: string,
    eventName: string,
  ) => {
    const { ok, senderId } = checkSenderClaim(event, extensionId)
    if (!ok || !senderId) {
      d(
        `ignoring '${eventName}' listener removal for ${extensionId} from ${describeSender(senderId)}`,
      )
      return
    }
    const observer = this.sessionMap.get(getSessionFromEvent(event))
    const listener: EventListener =
      event.type === 'frame'
        ? {
            type: event.type,
            extensionId,
            host: event.sender,
          }
        : {
            type: event.type,
            extensionId,
          }
    return observer?.removeListener(listener, extensionId, eventName)
  }
}

export type ExtensionSender = Electron.WebContents | Electron.ServiceWorkerMain
// export interface ExtensionSender {
//   id?: number
//   ipc: Electron.IpcMain | Electron.IpcMainServiceWorker
//   send: Electron.WebFrameMain['send']
// }

type ExtendedExtension = Omit<Electron.Extension, 'manifest'> & {
  manifest: chrome.runtime.Manifest
}

export type ExtensionEvent =
  | { type: 'frame'; sender: Electron.WebContents; extension: ExtendedExtension }
  | { type: 'service-worker'; sender: Electron.ServiceWorkerMain; extension: ExtendedExtension }

export type HandlerCallback = (event: ExtensionEvent, ...args: any[]) => any

export interface HandlerOptions {
  /** Whether the handler can be invoked on behalf of a different session. */
  allowRemote?: boolean
  /** Whether an extension context is required to invoke the handler. */
  extensionContext: boolean
  /** Required extension permission to run the handler. */
  permission?: chrome.runtime.ManifestPermissions
  /**
   * Only the embedder's own pages may call it (the browser-action preload of its window): refused
   * from any extension context. `extensionContext: false` only means one is not required.
   */
  embedderOnly?: boolean
}

interface Handler extends HandlerOptions {
  callback: HandlerCallback
}

/** e.g. 'tabs.query' */
type EventName = string

type HandlerMap = Map<EventName, Handler>

type FrameEventListener = { type: 'frame'; host: Electron.WebContents; extensionId: string }
type SWEventListener = { type: 'service-worker'; extensionId: string }
type EventListener = FrameEventListener | SWEventListener

const getHostId = (host: FrameEventListener['host']) => host.id
const getHostUrl = (host: FrameEventListener['host']) => host.getURL?.()

const eventListenerEquals = (a: EventListener) => (b: EventListener) => {
  if (a === b) return true
  if (a.extensionId !== b.extensionId) return false
  if (a.type !== b.type) return false
  if (a.type === 'frame' && b.type === 'frame') {
    return a.host === b.host
  }
  return true
}

export class ExtensionRouter {
  private handlers: HandlerMap = new Map()
  private listeners: Map<EventName, EventListener[]> = new Map()

  /**
   * Collection of all extension hosts in the session.
   *
   * Currently the router has no ability to wake up non-persistent background
   * scripts to deliver events. For now we just hold a reference to them to
   * prevent them from being terminated.
   */
  private extensionHosts: Set<Electron.WebContents> = new Set()

  /**
   * Hosts already watched for 'destroyed'. Without it every listener a page registers hung one more
   * 'destroyed' handler on its WebContents (one per event name, and again after every
   * remove/add), each filtering the whole listener map when the page closed.
   */
  private observedHosts: WeakSet<Electron.WebContents> = new WeakSet()

  constructor(
    public session: Electron.Session,
    private delegate: RoutingDelegate = RoutingDelegate.get(),
  ) {
    this.delegate.addObserver(this)

    const sessionExtensions = session.extensions || session
    sessionExtensions.on('extension-unloaded', (event, extension) => {
      this.filterListeners((listener) => listener.extensionId !== extension.id)
    })

    app.on('web-contents-created', (event, webContents) => {
      if (webContents.session === this.session && webContents.getType() === 'backgroundPage') {
        d(`storing reference to background host [url:'${webContents.getURL()}']`)
        this.extensionHosts.add(webContents)
        // A reload or an unload destroys the host: keeping it would hold a dead WebContents for
        // the life of the session.
        webContents.once('destroyed', () => this.extensionHosts.delete(webContents))
      }
    })

    // There used to be a set of every extension service worker that ever started, "to prevent
    // them from being terminated". A ServiceWorkerMain reference keeps nothing alive (Chromium
    // stops an idle worker regardless), so it only grew: removed 11/11/2026.
  }

  private filterListeners(predicate: (listener: EventListener) => boolean) {
    for (const [eventName, listeners] of this.listeners) {
      const filteredListeners = listeners.filter(predicate)
      const delta = listeners.length - filteredListeners.length

      if (filteredListeners.length > 0) {
        this.listeners.set(eventName, filteredListeners)
      } else {
        this.listeners.delete(eventName)
      }

      if (delta > 0) {
        d(`removed ${delta} listener(s) for '${eventName}'`)
      }
    }
  }

  private observeListenerHost(host: FrameEventListener['host']) {
    if (this.observedHosts.has(host)) return
    this.observedHosts.add(host)
    const hostId = getHostId(host)
    d(`observing listener [id:${hostId}, url:'${getHostUrl(host)}']`)
    host.once('destroyed', () => {
      d(`extension host destroyed [id:${hostId}]`)
      this.filterListeners((listener) => listener.type !== 'frame' || listener.host !== host)
    })
  }

  addListener(listener: EventListener, extensionId: string, eventName: string) {
    const { listeners, session } = this

    const sessionExtensions = session.extensions || session
    const extension = sessionExtensions.getExtension(extensionId)
    if (!extension) {
      // Not an error: this arrives over IPC from a worker that is still starting while its extension
      // is being unloaded, and throwing here is an uncaught exception in the embedder's main process.
      d(`ignoring '${eventName}' listener for unloaded extension ${extensionId}`)
      return
    }

    if (!listeners.has(eventName)) {
      listeners.set(eventName, [])
    }

    const eventListeners = listeners.get(eventName)!
    const existingEventListener = eventListeners.find(eventListenerEquals(listener))

    if (existingEventListener) {
      d(`ignoring existing '${eventName}' event listener for ${extensionId}`)
    } else {
      d(`adding '${eventName}' event listener for ${extensionId}`)
      eventListeners.push(listener)
      if (listener.type === 'frame' && listener.host) {
        this.observeListenerHost(listener.host)
      }
    }
  }

  removeListener(listener: EventListener, extensionId: string, eventName: string) {
    const { listeners } = this

    const eventListeners = listeners.get(eventName)
    if (!eventListeners) {
      // Routine, not an error: a page removing a listener after its extension was unloaded, or
      // after a removal for its whole host already ran.
      d(`event listener not registered for '${eventName}'`)
      return
    }

    const index = eventListeners.findIndex(eventListenerEquals(listener))

    if (index >= 0) {
      d(`removing '${eventName}' event listener for ${extensionId}`)
      eventListeners.splice(index, 1)
    }

    if (eventListeners.length === 0) {
      listeners.delete(eventName)
    }
  }

  /** The ids of the extensions with at least one listener for the event, in registration order. */
  listeningExtensions(eventName: EventName): string[] {
    const seen: string[] = []
    for (const listener of this.listeners.get(eventName) || []) {
      if (!seen.includes(listener.extensionId)) seen.push(listener.extensionId)
    }
    return seen
  }

  private getHandler(handlerName: string) {
    const handler = this.handlers.get(handlerName)
    if (!handler) {
      throw new Error(`${handlerName} is not a registered handler`)
    }

    return handler
  }

  async onExtensionMessage(
    event: IpcInvokeEvent,
    extensionId: string | undefined,
    handlerName: string,
    ...args: any[]
  ) {
    const { session } = this
    const eventSession = getSessionFromEvent(event)
    const eventSessionExtensions = eventSession.extensions || eventSession
    const handler = this.getHandler(handlerName)

    if (eventSession !== session && !handler.allowRemote) {
      throw new Error(`${handlerName} does not support calling from a remote session`)
    }

    if (handler.embedderOnly && getSenderExtensionId(event)) {
      throw new Error(`${handlerName} cannot be called from an extension`)
    }

    const extension = extensionId ? eventSessionExtensions.getExtension(extensionId) : undefined
    if (!extension && handler.extensionContext) {
      throw new Error(`${handlerName} was sent from an unknown extension context`)
    }

    if (handler.permission) {
      const manifest: chrome.runtime.Manifest = extension?.manifest
      if (!extension || !manifest.permissions?.includes(handler.permission)) {
        throw new Error(
          `${handlerName} requires an extension with ${handler.permission} permissions`,
        )
      }
    }

    const extEvent: ExtensionEvent =
      event.type === 'frame'
        ? { type: event.type, sender: event.sender, extension: extension! }
        : { type: event.type, sender: event.serviceWorker, extension: extension! }

    const result = await handler.callback(extEvent, ...args)

    d(`${handlerName} result: %r`, result)

    return result
  }

  private handle(name: string, callback: HandlerCallback, opts?: Partial<HandlerOptions>): void {
    this.handlers.set(name, {
      callback,
      extensionContext: typeof opts?.extensionContext === 'boolean' ? opts.extensionContext : true,
      allowRemote: typeof opts?.allowRemote === 'boolean' ? opts.allowRemote : false,
      permission: typeof opts?.permission === 'string' ? opts.permission : undefined,
      embedderOnly: opts?.embedderOnly === true,
    })
  }

  /** Returns a callback to register API handlers for the given context. */
  apiHandler() {
    return (name: string, callback: HandlerCallback, opts?: Partial<HandlerOptions>) => {
      this.handle(name, callback, opts)
    }
  }

  /**
   * Sends extension event to the host for the given extension ID if it
   * registered a listener for it.
   */
  sendEvent(targetExtensionId: string | undefined, eventName: string, ...args: any[]) {
    const { listeners } = this
    let eventListeners = listeners.get(eventName)
    const ipcName = `crx-${eventName}`

    if (!eventListeners || eventListeners.length === 0) {
      // Ignore events with no listeners
      return
    }

    let sentCount = 0
    for (const listener of eventListeners) {
      const { type, extensionId } = listener

      if (targetExtensionId && targetExtensionId !== extensionId) {
        continue
      }

      if (type === 'service-worker') {
        const scope = `chrome-extension://${extensionId}/`
        this.session.serviceWorkers
          .startWorkerForScope(scope)
          .then((serviceWorker) => {
            serviceWorker.send(ipcName, ...args)
          })
          .catch((error) => {
            d('failed to send %s to %s', eventName, extensionId)
            console.error(error)
          })
      } else {
        if (listener.host.isDestroyed()) {
          // One closed page must not cost the event to every listener after it in the list.
          d(`unable to send '${eventName}' to destroyed extension host for ${extensionId}`)
          continue
        }
        listener.host.send(ipcName, ...args)
      }

      sentCount++
    }

    d(`sent '${eventName}' event to ${sentCount} listeners`)
  }

  /** Broadcasts extension event to all extension hosts listening for it. */
  broadcastEvent(eventName: string, ...args: any[]) {
    this.sendEvent(undefined, eventName, ...args)
  }
}
