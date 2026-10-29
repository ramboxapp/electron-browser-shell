import { ipcRenderer, contextBridge, webFrame } from 'electron'
import { addExtensionListener, removeExtensionListener, hasExtensionListeners } from './event'
import { formatExtensionMessage, CrxI18nPayload, CrxI18nState } from '../shared/i18n-format'

export const injectExtensionAPIs = () => {
  interface ExtensionMessageOptions {
    noop?: boolean
    defaultResponse?: any
    serialize?: (...args: any[]) => any[]
  }

  /** Compact, never-throwing rendering of call arguments for the development call log. */
  const describeForLog = (value: any): string => {
    try {
      const text = JSON.stringify(value, (_key, inner) =>
        typeof inner === 'function' ? '[function]' : inner instanceof Error ? String(inner) : inner,
      )
      return text === undefined
        ? String(value)
        : text.length > 600
          ? text.slice(0, 600) + '...'
          : text
    } catch {
      return String(value)
    }
  }

  /*
    The message of an error the main process handler threw, in the words the handler used.

    ipcRenderer.invoke wraps a rejection as "Error invoking remote method 'crx-msg': Error: <message>",
    and that wrapper is what an extension would otherwise read in `runtime.lastError` — or match
    against, since extensions compare lastError messages to Chrome's own wording.
  */
  const invokeErrorMessage = (error: unknown): string => {
    const raw = error instanceof Error ? error.message : String(error)
    return raw.replace(/^Error invoking remote method '[^']*': /, '').replace(/^Error: /, '')
  }

  /*
    Rejects with the handler's error, and never calls a callback itself.

    This used to swallow every error of the main process (`console.error`, then resolve undefined),
    so an extension could not tell a failed call from one that answered nothing: the promise form
    resolved undefined where Chrome rejects, and the callback form ran with `runtime.lastError`
    unset where Chrome sets it. The callback — a function of the main world — is handled by the
    main-world wrapper (see `invokeExtension` in mainWorldScript), which is the only place that can
    set `runtime.lastError` for the duration of the call, as Chrome does. A trailing function is
    still popped here for the few internal callers that pass one.
  */
  const invokeExtension = async function (
    extensionId: string,
    fnName: string,
    options: ExtensionMessageOptions = {},
    ...args: any[]
  ) {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined

    if (process.env.NODE_ENV === 'development') {
      // JSON, not the raw array: a console line reaching the host app through Electron's
      // serviceWorkers 'console-message' event is already a string, so an object argument arrives as
      // "[object Object]" and the one thing worth knowing — WHAT the extension asked for — is lost.
      console.log(fnName, describeForLog(args))
    }

    if (options.noop) {
      console.warn(`${fnName} is not yet implemented.`)
      if (callback) callback(options.defaultResponse)
      return Promise.resolve(options.defaultResponse)
    }

    if (options.serialize) {
      args = options.serialize(...args)
    }

    let result

    try {
      result = await ipcRenderer.invoke('crx-msg', extensionId, fnName, ...args)
    } catch (e) {
      const message = invokeErrorMessage(e)
      if (process.env.NODE_ENV === 'development') {
        console.log(fnName, '(error)', message)
      }
      throw new Error(message)
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(fnName, '(result)', describeForLog(result))
    }

    if (callback) {
      callback(result)
    } else {
      return result
    }
  }

  type ConnectNativeCallback = (connectionId: string, send: (message: any) => void) => void
  const connectNative = (
    extensionId: string,
    application: string,
    receive: (message: any) => void,
    disconnect: (reason?: string) => void,
    callback: ConnectNativeCallback,
  ) => {
    const connectionId = (contextBridge as any).executeInMainWorld({
      func: () => crypto.randomUUID(),
    })
    const onMessage = (_event: Electron.IpcRendererEvent, message: any) => {
      receive(message)
    }
    ipcRenderer.on(`crx-native-msg-${connectionId}`, onMessage)
    // A reason, when the main process sends one, becomes the port's lastError (see NativePort).
    ipcRenderer.once(`crx-native-msg-${connectionId}-disconnect`, (_event, reason?: unknown) => {
      ipcRenderer.off(`crx-native-msg-${connectionId}`, onMessage)
      disconnect(typeof reason === 'string' ? reason : undefined)
    })
    // A connect the main process refuses (no nativeMessaging permission, say) ends the port the way
    // a host that could not start does: onDisconnect with the refusal as lastError.
    invokeExtension(extensionId, 'runtime.connectNative', {}, connectionId, application).catch(
      (error: unknown) => {
        ipcRenderer.off(`crx-native-msg-${connectionId}`, onMessage)
        disconnect(invokeErrorMessage(error))
      },
    )
    const send = (message: any) => {
      ipcRenderer.send(`crx-native-msg-${connectionId}`, message)
    }
    callback(connectionId, send)
  }

  const disconnectNative = (extensionId: string, connectionId: string) => {
    invokeExtension(extensionId, 'runtime.disconnectNative', {}, connectionId)
  }

  // WebSocket proxy bridge. Native WebSocket fails to connect from an MV3
  // service worker in this Electron version (see the WebSocketAPI docs); the
  // real socket is opened in the main process and its frames are relayed here.
  interface WebSocketCallbacks {
    onOpen: (payload: { protocol: string; extensions: string }) => void
    onMessage: (payload: { data: string | Uint8Array; binary: boolean }) => void
    onClose: (payload: { code: number; reason: string; wasClean: boolean }) => void
    onError: () => void
  }
  const connectWebSocket = (
    extensionId: string,
    connectionId: string,
    url: string,
    protocols: string[],
    callbacks: WebSocketCallbacks,
  ) => {
    const onOpen = (_e: Electron.IpcRendererEvent, payload: any) => callbacks.onOpen(payload)
    const onMessage = (_e: Electron.IpcRendererEvent, payload: any) => callbacks.onMessage(payload)
    const onClose = (_e: Electron.IpcRendererEvent, payload: any) => callbacks.onClose(payload)
    const onError = () => callbacks.onError()
    ipcRenderer.on(`crx-websocket-open-${connectionId}`, onOpen)
    ipcRenderer.on(`crx-websocket-message-${connectionId}`, onMessage)
    ipcRenderer.on(`crx-websocket-close-${connectionId}`, onClose)
    ipcRenderer.on(`crx-websocket-error-${connectionId}`, onError)
    // A connect the main process refuses fails the socket like a network error would.
    invokeExtension(extensionId, 'websocket.connect', {}, connectionId, url, protocols).catch(
      () => {
        callbacks.onError()
        callbacks.onClose({ code: 1006, reason: '', wasClean: false })
      },
    )
    // Disposer removes the per-connection listeners once the socket closes.
    return () => {
      ipcRenderer.off(`crx-websocket-open-${connectionId}`, onOpen)
      ipcRenderer.off(`crx-websocket-message-${connectionId}`, onMessage)
      ipcRenderer.off(`crx-websocket-close-${connectionId}`, onClose)
      ipcRenderer.off(`crx-websocket-error-${connectionId}`, onError)
    }
  }
  const sendWebSocketFrame = (connectionId: string, data: string | Uint8Array) => {
    ipcRenderer.send(`crx-websocket-send-${connectionId}`, data)
  }
  const closeWebSocket = (
    extensionId: string,
    connectionId: string,
    code?: number,
    reason?: string,
  ) => {
    invokeExtension(extensionId, 'websocket.close', {}, connectionId, code, reason)
  }

  /*
    The message bundle the locale patch left in the manifest, kept on this side of the bridge so
    `getMessage` — a synchronous API an extension calls hundreds of times — crosses it with a name
    and its substitutions, not with the whole bundle every call. Set once per context, from the
    main world, which is where the manifest is read.
  */
  let i18nState: CrxI18nState | undefined
  const i18nInit = (extensionId: string, payload: CrxI18nPayload) => {
    if (!payload || !payload.messages) return
    i18nState = { locale: payload.locale, messages: payload.messages, extensionId }
  }
  const i18nGetMessage = (name: unknown, substitutions?: unknown, options?: { escapeLt?: boolean }) =>
    i18nState ? formatExtensionMessage(i18nState, name, substitutions, options) : ''

  const electronContext = {
    invokeExtension,
    addExtensionListener,
    removeExtensionListener,
    hasExtensionListeners,
    connectNative,
    disconnectNative,
    connectWebSocket,
    sendWebSocketFrame,
    closeWebSocket,
    i18nInit,
    i18nGetMessage,
  }

  // Function body to run in the main world.
  // IMPORTANT: This must be self-contained, no closure variable will be included!
  function mainWorldScript() {
    // Use context bridge API or closure variable when context isolation is disabled.
    const electron = ((globalThis as any).electron as typeof electronContext) || electronContext

    const chrome = globalThis.chrome || {}
    const extensionId = chrome.runtime?.id

    // NOTE: This uses a synchronous IPC to get the extension manifest.
    // To avoid this, JS bindings for RendererExtensionRegistry would be
    // required.
    // OFFSCREEN_DOCUMENT contexts do not have this function defined.
    const manifest: chrome.runtime.Manifest =
      (extensionId && chrome.runtime.getManifest?.()) || ({} as any)

    /*
      What `chrome.runtime.lastError` reads while a callback this file runs itself is running.

      Chromium sets lastError on its own runtime object, for its own callbacks only. A callback the
      preload invokes — for an API the main process implements, or for a port implemented here in
      JavaScript (NativePort) — never goes through that path. The runtime namespace's `lastError`
      getter reads this first and Chromium's value otherwise. Declared before anything that calls
      into the main process, so every wrapper below can use it.
    */
    let injectedLastError: { message: string } | undefined
    const withLastError = (message: string, dispatch: () => void) => {
      const previous = injectedLastError
      injectedLastError = { message }
      try {
        dispatch()
      } finally {
        injectedLastError = previous
      }
    }
    // A `lastError` that reads through on every access, non-enumerable like Chrome's.
    const defineLastError = <T extends object>(target: T, read: () => unknown): T =>
      Object.defineProperty(target, 'lastError', {
        get: read,
        enumerable: false,
        configurable: true,
      })

    /*
      An API method backed by the main process, answering the way Chrome's do.

      With a callback: the callback runs with the result, or — when the main process failed the
      call — with no result and `chrome.runtime.lastError` set for its duration, and the method
      returns nothing. Without one: a promise that resolves with the result or rejects with the
      error. Errors used to vanish in the isolated world (every failed call read as a success that
      answered undefined); an extension that asks `windows.create` for a URL it may not open, or
      `offscreen.createDocument` twice, now learns it the way it does in Chrome.
    */
    const invokeExtension =
      (fnName: string, opts: ExtensionMessageOptions = {}) =>
      (...args: any[]) => {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
        const promise: Promise<any> = electron.invokeExtension(extensionId, fnName, opts, ...args)
        if (!callback) return promise
        promise.then(
          (result) => callback(result),
          (error) => withLastError(errorMessage(error), () => callback()),
        )
      }
    const errorMessage = (error: unknown): string =>
      error instanceof Error ? error.message : String(error)

    function imageData2base64(imageData: ImageData) {
      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d')
      if (!ctx) return null

      canvas.width = imageData.width
      canvas.height = imageData.height
      ctx.putImageData(imageData, 0, 0)

      return canvas.toDataURL()
    }

    /**
     * Renderer-only method which resolves with a static result. Used to stub
     * APIs that have no browser-side implementation, while still supporting
     * both callback and Promise call styles.
     */
    const localStub =
      (result?: any) =>
      (...args: any[]) => {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
        if (callback) {
          queueMicrotask(() => callback(result))
        }
        return Promise.resolve(result)
      }

    class ExtensionEvent<T extends Function> implements chrome.events.Event<T> {
      constructor(private name: string) {}

      addListener(callback: T) {
        electron.addExtensionListener(extensionId, this.name, callback)
      }
      removeListener(callback: T) {
        electron.removeExtensionListener(extensionId, this.name, callback)
      }

      // Declarative event rules aren't implemented (no extension in the
      // fleet needs them). Chrome never throws for these even when a given
      // event doesn't support rules — it just reports none — so match that
      // instead of throwing: 1Password's background threw an uncaught
      // "Method not implemented." from one of these on every page load
      // (2026-07-09), silently aborting whatever async flow it was guarding,
      // including its first-run notification toast.
      getRules(callback: (rules: chrome.events.Rule[]) => void): void
      getRules(ruleIdentifiers: string[], callback: (rules: chrome.events.Rule[]) => void): void
      getRules(ruleIdentifiers: any, callback?: any) {
        const cb = typeof ruleIdentifiers === 'function' ? ruleIdentifiers : callback
        if (cb) cb([])
      }
      // Approximates whether *any* listener is registered for this event —
      // not specifically `callback`, since callback identity isn't tracked
      // across the IPC boundary (see hasExtensionListeners in event.ts).
      // Good enough for the common "have I already registered?" guard, and
      // — unlike throwing — doesn't crash the caller that relies on it.
      hasListener(callback: T): boolean {
        return electron.hasExtensionListeners(this.name)
      }
      removeRules(ruleIdentifiers?: string[] | undefined, callback?: (() => void) | undefined): void
      removeRules(callback?: (() => void) | undefined): void
      removeRules(ruleIdentifiers?: any, callback?: any) {
        const cb = typeof ruleIdentifiers === 'function' ? ruleIdentifiers : callback
        if (cb) cb()
      }
      addRules(
        rules: chrome.events.Rule[],
        callback?: ((rules: chrome.events.Rule[]) => void) | undefined,
      ): void {
        if (callback) callback([])
      }
      hasListeners(): boolean {
        return electron.hasExtensionListeners(this.name)
      }
    }

    /*
      `chrome.types.ChromeSetting<any>`, answering the way Chrome's does: a promise when no callback
      is given, the callback when there is one.

      The three methods used to return `undefined`, which is worse than it looks. An extension that
      writes `chrome.privacy.services.passwordSavingEnabled.get({}).then(…)` gets a TypeError for
      reading 'then' of undefined — and when that call sits in a comma-sequenced run of start-up
      calls, as it does in NordPass 7.11.9, the throw takes the whole background init with it: the
      rest of its boot never runs, its state machine stays at LOADING, and the extension shows its
      loading spinner forever with nothing in the console. Measured against a stock Chromium, where
      the same call answers `{ value: false, levelOfControl: 'not_controllable' }` and the extension
      boots.

      `not_controllable` is the honest answer rather than a convenient one: these are Chrome profile
      preferences, Electron exposes no way to read or write them, and nothing here pretends a `set`
      took effect. An extension that checks the level before writing — again, as NordPass does —
      then correctly leaves the setting alone instead of fighting a write that goes nowhere.
    */
    class ChromeSetting {
      // The value Chrome reports for a setting no extension controls. Per setting, because
      // `webRTCIPHandlingPolicy` is a string and the rest are booleans. Kept in a closure rather
      // than on the instance so `Object.keys(setting)` shows what Chrome's shows and nothing more.
      private readonly defaultValue!: () => unknown
      constructor(defaultValue: unknown = false) {
        Object.defineProperty(this, 'defaultValue', {
          value: () => defaultValue,
          enumerable: false,
        })
      }

      private answer<T>(callback: unknown, value: T) {
        if (typeof callback === 'function') {
          ;(callback as (result: T) => void)(value)
          return undefined
        }
        return Promise.resolve(value)
      }

      get(_details?: unknown, callback?: unknown) {
        return this.answer(callback, {
          value: this.defaultValue(),
          levelOfControl: 'not_controllable',
        })
      }
      set(_details?: unknown, callback?: unknown) {
        return this.answer(callback, undefined)
      }
      clear(_details?: unknown, callback?: unknown) {
        return this.answer(callback, undefined)
      }
      // Nothing ever changes these, so the event never fires; it still needs the full shape, since
      // an extension that adds a listener on start-up usually removes it on teardown.
      onChange = {
        addListener: () => {},
        removeListener: () => {},
        hasListener: () => false,
        hasListeners: () => false,
      }
    }

    class Event<T extends Function> implements Partial<chrome.events.Event<T>> {
      private listeners: T[] = []

      _emit(...args: any[]) {
        this.listeners.forEach((listener) => {
          listener(...args)
        })
      }

      addListener(callback: T): void {
        this.listeners.push(callback)
      }
      removeListener(callback: T): void {
        const index = this.listeners.indexOf(callback)
        if (index > -1) {
          this.listeners.splice(index, 1)
        }
      }
      // Chrome's events answer these two; an extension that guards its registration with
      // hasListener() got a TypeError here.
      hasListener(callback: T): boolean {
        return this.listeners.includes(callback)
      }
      hasListeners(): boolean {
        return this.listeners.length > 0
      }
    }

    class NativePort implements chrome.runtime.Port {
      private connectionId: string = ''
      private connected = false
      private received = false
      private pending: any[] = []

      name: string = ''

      _init = (connectionId: string, send: (message: any) => void) => {
        this.connected = true
        this.connectionId = connectionId
        this._send = send

        this.pending.forEach((msg) => this.postMessage(msg))
        this.pending = []

        Object.defineProperty(this, '_init', { value: undefined })
      }

      _send(message: any) {
        this.pending.push(message)
      }

      _receive(message: any) {
        this.received = true
        ;(this.onMessage as any)._emit(message)
      }

      /*
        The host side went away. Chrome — measured in Edge 156 against a host that is not installed —
        calls onDisconnect with the port and lastError "Specified native messaging host not found.",
        and "Native host has exited." once a host that ran is gone. This used to call the listeners
        with no arguments and no lastError, so an extension could not tell a missing desktop app from
        a clean close. The main process says why (NativeMessagingHost: not found, forbidden, failed
        to start, exited); the guess below is only for a disconnect that arrives without a reason.
      */
      _disconnect(reason?: string) {
        if (!this.connected) return
        this.connected = false
        electron.disconnectNative(extensionId, this.connectionId)
        const message =
          reason ||
          (this.received ? 'Native host has exited.' : 'Specified native messaging host not found.')
        withLastError(message, () => (this.onDisconnect as any)._emit(this))
      }

      postMessage(message: any) {
        this._send(message)
      }
      // Chrome does not fire onDisconnect on the port that called disconnect() (measured in Edge 156).
      disconnect() {
        if (this.connected) {
          this.connected = false
          electron.disconnectNative(extensionId, this.connectionId)
        }
      }
      onMessage: chrome.runtime.PortMessageEvent = new Event() as any
      onDisconnect: chrome.runtime.PortDisconnectEvent = new Event() as any
    }

    // The DOM `Event` constructor, reached explicitly because mainWorldScript
    // defines a local `Event` class (the chrome.events shim) that shadows it.
    const NativeEvent = (globalThis as any).Event

    /**
     * Drop-in replacement for the global `WebSocket`, installed only in service
     * workers (native WebSocket fails to connect there in this Electron — see
     * WebSocketAPI). Implements the WHATWG interface but relays frames through
     * the `electron` bridge to a real socket in the main process.
     */
    class ProxyWebSocket extends EventTarget {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly CLOSING = 2
      static readonly CLOSED = 3
      readonly CONNECTING = 0
      readonly OPEN = 1
      readonly CLOSING = 2
      readonly CLOSED = 3

      url: string
      readyState = 0
      bufferedAmount = 0
      extensions = ''
      protocol = ''
      binaryType: 'blob' | 'arraybuffer' = 'blob'

      onopen: ((ev: any) => any) | null = null
      onmessage: ((ev: MessageEvent) => any) | null = null
      onerror: ((ev: any) => any) | null = null
      onclose: ((ev: CloseEvent) => any) | null = null

      private _id: string
      private _dispose?: () => void

      constructor(url: string, protocols?: string | string[]) {
        super()

        // WHATWG requires a synchronous throw on an invalid URL/scheme.
        const resolved = new URL(url, (self as any).location?.href)
        if (resolved.protocol !== 'ws:' && resolved.protocol !== 'wss:') {
          throw new SyntaxError(
            `Failed to construct 'WebSocket': The URL's scheme must be either 'ws' or 'wss'. '${resolved.protocol}' is not allowed.`,
          )
        }

        this.url = resolved.href
        this._id = (crypto as any).randomUUID()
        const protocolList = typeof protocols === 'string' ? [protocols] : protocols || []

        this._dispose = electron.connectWebSocket(extensionId, this._id, this.url, protocolList, {
          onOpen: (payload) => {
            this.readyState = 1
            this.protocol = payload.protocol || ''
            this.extensions = payload.extensions || ''
            this._fire('open', new NativeEvent('open'))
          },
          onMessage: (payload) => {
            let data: any
            if (payload.binary) {
              const bytes = payload.data as Uint8Array
              const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
              data = this.binaryType === 'arraybuffer' ? ab : new Blob([ab])
            } else {
              data = payload.data
            }
            this._fire('message', new MessageEvent('message', { data }))
          },
          onClose: (payload) => {
            this.readyState = 3
            this._teardown()
            this._fire(
              'close',
              new CloseEvent('close', {
                code: payload.code,
                reason: payload.reason,
                wasClean: payload.wasClean,
              }),
            )
          },
          onError: () => {
            this._fire('error', new NativeEvent('error'))
          },
        })
      }

      send(data: string | ArrayBufferLike | ArrayBufferView | Blob) {
        if (this.readyState === 0) {
          throw new DOMException(
            "Failed to execute 'send' on 'WebSocket': Still in CONNECTING state.",
            'InvalidStateError',
          )
        }
        if (this.readyState !== 1) return

        if (typeof data === 'string') {
          electron.sendWebSocketFrame(this._id, data)
        } else if (data instanceof Blob) {
          // Blob has no sync bytes; send once resolved (ordering caveat, but
          // extensions overwhelmingly send strings or typed arrays).
          data.arrayBuffer().then((ab) => {
            if (this.readyState === 1) electron.sendWebSocketFrame(this._id, new Uint8Array(ab))
          })
        } else if (data instanceof ArrayBuffer) {
          electron.sendWebSocketFrame(this._id, new Uint8Array(data))
        } else if (ArrayBuffer.isView(data)) {
          electron.sendWebSocketFrame(
            this._id,
            new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          )
        } else {
          electron.sendWebSocketFrame(this._id, String(data))
        }
      }

      close(code?: number, reason?: string) {
        if (this.readyState === 2 || this.readyState === 3) return
        this.readyState = 2
        electron.closeWebSocket(extensionId, this._id, code, reason)
      }

      private _teardown() {
        if (this._dispose) {
          this._dispose()
          this._dispose = undefined
        }
      }

      private _fire(type: string, event: any) {
        const handler = (this as any)['on' + type]
        if (typeof handler === 'function') {
          try {
            handler.call(this, event)
          } catch (error) {
            console.error(error)
          }
        }
        this.dispatchEvent(event)
      }
    }

    type DeepPartial<T> = {
      [P in keyof T]?: DeepPartial<T[P]>
    }

    type APIFactoryMap = {
      [apiName in keyof typeof chrome]: {
        shouldInject?: () => boolean
        factory: (
          base: DeepPartial<(typeof chrome)[apiName]>,
        ) => DeepPartial<(typeof chrome)[apiName]>
      }
    }

    /**
     * Synchronous cache of active tab ids across windows. Needed to patch
     * MessageSender.tab.active at event dispatch time — an async lookup is
     * not possible there because onMessage listeners must run synchronously
     * to preserve their `return true` (async response) contract.
     */
    const activeTabCache = {
      // Flat set of every active tab id, for O(1) lookups in patchSenderTab.
      ids: new Set<number>(),
      // windowId -> tabId, so activation in one window doesn't clear another's.
      byWindow: new Map<number, number>(),
      initialized: false,
      // Lazily initialized on first onMessage/onConnect subscription to avoid
      // registering tab listeners for extensions that never receive messages.
      init() {
        if (this.initialized) return
        this.initialized = true
        // Replaces the previously-active tab for a window with the new one,
        // keeping both `ids` and `byWindow` in sync.
        const setActive = (windowId: number, tabId: number) => {
          const previous = this.byWindow.get(windowId)
          if (typeof previous === 'number') this.ids.delete(previous)
          this.byWindow.set(windowId, tabId)
          this.ids.add(tabId)
        }
        try {
          // Keep the cache current as the user switches tabs.
          electron.addExtensionListener(
            extensionId,
            'tabs.onActivated',
            (info: chrome.tabs.TabActiveInfo) => {
              setActive(info.windowId, info.tabId)
            },
          )
          // Seed with the currently active tabs (one per window) so messages
          // that arrive before any onActivated event still resolve correctly.
          electron.invokeExtension(extensionId, 'tabs.query', {}, { active: true }).then(
            (tabs: chrome.tabs.Tab[]) => {
              tabs?.forEach((tab) => {
                if (typeof tab.id === 'number') setActive(tab.windowId, tab.id)
              })
            },
            () => {},
          )
        } catch {
          // Ignore setup failures; sender.tab will just keep native values.
        }
      },
    }

    /*
      An ImageData as a PNG data URL, in a context with no `document`: a service worker. Chrome
      accepts ImageData from a worker, and an extension that draws its own icon state (a blocker
      counting what it blocked, a dark-mode toggle) does exactly that. `OffscreenCanvas` encodes it;
      the result is what the main process already knows how to serve.
    */
    const imageDataToPngUrl = async (imageData: ImageData): Promise<string> => {
      // `any`: the DOM lib this package compiles against predates OffscreenCanvas' 2d context typings.
      const canvas: any = new (globalThis as any).OffscreenCanvas(imageData.width, imageData.height)
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('No 2d context for the icon')
      ctx.putImageData(imageData, 0, 0)
      const blob: Blob = await canvas.convertToBlob({ type: 'image/png' })
      const bytes = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)))
      }
      return `data:image/png;base64,${btoa(binary)}`
    }

    /*
      setIcon's `imageData`, in a shape the main process can serve: a data URL, or a size map of
      them. In a page the canvas is synchronous; in a worker it is OffscreenCanvas and asynchronous,
      which is why this returns a promise either way. Used to drop the image in MV3 with a warning,
      so every extension that paints its icon from a worker kept the manifest's static one.
    */
    const serializeIconDetails = async (
      details: chrome.action.TabIconDetails,
    ): Promise<chrome.action.TabIconDetails> => {
      const image = details?.imageData
      if (!image) return details
      const encode = (data: ImageData): Promise<string | null> =>
        typeof document !== 'undefined'
          ? Promise.resolve(imageData2base64(data))
          : imageDataToPngUrl(data)
      const isImageData = (value: unknown): value is ImageData =>
        typeof ImageData !== 'undefined' && value instanceof ImageData
      let imageData: any
      if (isImageData(image)) {
        imageData = await encode(image)
      } else if (typeof image === 'object') {
        imageData = {}
        for (const [size, data] of Object.entries(image as Record<string, ImageData>)) {
          if (isImageData(data)) imageData[size] = await encode(data)
        }
      }
      return { ...details, imageData }
    }

    const browserActionFactory = (base: DeepPartial<typeof globalThis.chrome.browserAction>) => {
      const setIconInvoke = invokeExtension('browserAction.setIcon')
      const api = {
        ...base,

        setTitle: invokeExtension('browserAction.setTitle'),
        getTitle: invokeExtension('browserAction.getTitle'),

        setIcon: (details: chrome.action.TabIconDetails, callback?: () => void) => {
          const promise = serializeIconDetails(details).then((serialized) =>
            setIconInvoke(serialized),
          )
          if (typeof callback !== 'function') return promise
          const done = callback
          promise.then(
            () => done(),
            (error) => withLastError(errorMessage(error), () => done()),
          )
        },

        setPopup: invokeExtension('browserAction.setPopup'),
        getPopup: invokeExtension('browserAction.getPopup'),

        setBadgeText: invokeExtension('browserAction.setBadgeText'),
        getBadgeText: invokeExtension('browserAction.getBadgeText'),

        setBadgeBackgroundColor: invokeExtension('browserAction.setBadgeBackgroundColor'),
        getBadgeBackgroundColor: invokeExtension('browserAction.getBadgeBackgroundColor'),

        setBadgeTextColor: invokeExtension('browserAction.setBadgeTextColor'),
        getBadgeTextColor: invokeExtension('browserAction.getBadgeTextColor'),

        getUserSettings: invokeExtension('browserAction.getUserSettings'),

        enable: invokeExtension('browserAction.enable', { noop: true }),
        disable: invokeExtension('browserAction.disable', { noop: true }),

        openPopup: invokeExtension('browserAction.openPopup'),

        onClicked: new ExtensionEvent('browserAction.onClicked'),
      }

      return api
    }

    /**
     * Factories for each additional chrome.* API.
     */
    const apiDefinitions: Partial<APIFactoryMap> = {
      action: {
        shouldInject: () => manifest.manifest_version === 3 && !!manifest.action,
        factory: browserActionFactory,
      },

      alarms: {
        factory: (base) => {
          return {
            ...base,
            create: invokeExtension('alarms.create'),
            get: invokeExtension('alarms.get'),
            getAll: invokeExtension('alarms.getAll'),
            clear: invokeExtension('alarms.clear'),
            clearAll: invokeExtension('alarms.clearAll'),
            onAlarm: new ExtensionEvent('alarms.onAlarm'),
          }
        },
      },

      browserAction: {
        shouldInject: () => manifest.manifest_version === 2 && !!manifest.browser_action,
        factory: browserActionFactory,
      },

      commands: {
        factory: (base) => {
          return {
            ...base,
            getAll: invokeExtension('commands.getAll'),
            onCommand: new ExtensionEvent('commands.onCommand'),
          }
        },
      },

      contextMenus: {
        factory: (base) => {
          let menuCounter = 0
          const menuCallbacks: {
            [key: string]: chrome.contextMenus.CreateProperties['onclick']
          } = {}
          const menuCreate = invokeExtension('contextMenus.create')

          let hasInternalListener = false
          const addInternalListener = () => {
            api.onClicked.addListener((info, tab) => {
              const callback = menuCallbacks[info.menuItemId]
              if (callback && tab) callback(info, tab)
            })
            hasInternalListener = true
          }

          const menuUpdate = invokeExtension('contextMenus.update')

          const api = {
            ...base,
            create: function (
              createProperties: chrome.contextMenus.CreateProperties,
              callback?: Function,
            ) {
              if (typeof createProperties.id === 'undefined') {
                createProperties.id = `${++menuCounter}`
              }
              if (createProperties.onclick) {
                if (!hasInternalListener) addInternalListener()
                menuCallbacks[createProperties.id] = createProperties.onclick
                delete createProperties.onclick
              }
              menuCreate(createProperties, callback)
              return createProperties.id
            },
            update: function (
              id: string | number,
              updateProperties: chrome.contextMenus.CreateProperties,
              callback?: Function,
            ) {
              // Like create(), onclick handlers can't cross the IPC boundary
              // so they're kept in the renderer and dispatched via onClicked.
              if (updateProperties.onclick) {
                if (!hasInternalListener) addInternalListener()
                menuCallbacks[id] = updateProperties.onclick
                delete updateProperties.onclick
              }
              return menuUpdate(id, updateProperties, callback)
            },
            remove: invokeExtension('contextMenus.remove'),
            removeAll: invokeExtension('contextMenus.removeAll'),
            onClicked: new ExtensionEvent<
              (info: chrome.contextMenus.OnClickData, tab: chrome.tabs.Tab) => void
            >('contextMenus.onClicked'),
          }

          return api
        },
      },

      cookies: {
        factory: (base) => {
          return {
            ...base,
            get: invokeExtension('cookies.get'),
            getAll: invokeExtension('cookies.getAll'),
            set: invokeExtension('cookies.set'),
            remove: invokeExtension('cookies.remove'),
            getAllCookieStores: invokeExtension('cookies.getAllCookieStores'),
            onChanged: new ExtensionEvent('cookies.onChanged'),
          }
        },
      },

      downloads: {
        factory: (base) => {
          return {
            ...base,
            acceptDanger: invokeExtension('downloads.acceptDanger', { noop: true }),
            cancel: invokeExtension('downloads.cancel'),
            download: invokeExtension('downloads.download'),
            erase: invokeExtension('downloads.erase'),
            getFileIcon: invokeExtension('downloads.getFileIcon', { noop: true }),
            open: invokeExtension('downloads.open'),
            pause: invokeExtension('downloads.pause'),
            removeFile: invokeExtension('downloads.removeFile', { noop: true }),
            resume: invokeExtension('downloads.resume'),
            search: invokeExtension('downloads.search'),
            setUiOptions: invokeExtension('downloads.setUiOptions', { noop: true }),
            show: invokeExtension('downloads.show'),
            showDefaultFolder: invokeExtension('downloads.showDefaultFolder'),
            onChanged: new ExtensionEvent('downloads.onChanged'),
            onCreated: new ExtensionEvent('downloads.onCreated'),
            onDeterminingFilename: new ExtensionEvent('downloads.onDeterminingFilename'),
            onErased: new ExtensionEvent('downloads.onErased'),
          }
        },
      },

      extension: {
        factory: (base) => {
          const inServiceWorker =
            typeof (globalThis as any).ServiceWorkerGlobalScope !== 'undefined' &&
            globalThis instanceof (globalThis as any).ServiceWorkerGlobalScope

          /*
            `getViews` was `() => []` everywhere. Chrome has no `getViews` in a service worker at all,
            and in a page it lists the extension's views in the same process — the calling page
            always among them. Other views live in other renderer processes here and a Window
            cannot cross that boundary, so the honest part this can give is the caller itself, and
            only when the filter could match it: a `type`, `tabId` or `windowId` filter asks
            for something this context cannot vouch for, and answers [] as before.
          */
          const getViews = (fetchProperties?: chrome.extension.FetchProperties) => {
            if (typeof (base as any)?.getViews === 'function') {
              const native = (base as any).getViews(fetchProperties)
              if (Array.isArray(native) && native.length > 0) return native
            }
            const filter: any = fetchProperties || {}
            const narrowed =
              filter.type !== undefined ||
              filter.tabId !== undefined ||
              (filter.windowId !== undefined && filter.windowId !== -2)
            return narrowed ? [] : [globalThis]
          }

          // The MV2 alias of runtime.lastError; read through for the same reason (see runtime below).
          const api: any = defineLastError(
            {
              ...base,
              isAllowedFileSchemeAccess: invokeExtension('extension.isAllowedFileSchemeAccess', {
                noop: true,
                defaultResponse: false,
              }),
              isAllowedIncognitoAccess: invokeExtension('extension.isAllowedIncognitoAccess', {
                noop: true,
                defaultResponse: false,
              }),
              ...(inServiceWorker ? {} : { getViews }),
            },
            () => base?.lastError,
          )
          if (inServiceWorker) delete api.getViews
          return api
        },
      },

      // Font settings aren't configurable in Electron, so this is a local
      // stub which reports Chrome's default values as 'not_controllable'.
      fontSettings: {
        factory: (base) => {
          const genericFontList = [
            { fontId: 'sans-serif', displayName: 'Sans-Serif' },
            { fontId: 'serif', displayName: 'Serif' },
            { fontId: 'monospace', displayName: 'Monospace' },
          ]
          return {
            ...base,
            clearDefaultFixedFontSize: localStub(),
            clearDefaultFontSize: localStub(),
            clearFont: localStub(),
            clearMinimumFontSize: localStub(),
            getDefaultFixedFontSize: localStub({
              pixelSize: 13,
              levelOfControl: 'not_controllable',
            }),
            getDefaultFontSize: localStub({ pixelSize: 16, levelOfControl: 'not_controllable' }),
            getFont: localStub({ fontId: '', levelOfControl: 'not_controllable' }),
            getFontList: localStub(genericFontList),
            getMinimumFontSize: localStub({ pixelSize: 0, levelOfControl: 'not_controllable' }),
            setDefaultFixedFontSize: localStub(),
            setDefaultFontSize: localStub(),
            setFont: localStub(),
            setMinimumFontSize: localStub(),
            onDefaultFixedFontSizeChanged: new Event(),
            onDefaultFontSizeChanged: new Event(),
            onFontChanged: new Event(),
            onMinimumFontSizeChanged: new Event(),
          }
        },
      },

      identity: {
        shouldInject: () => !!(manifest.permissions as string[] | undefined)?.includes('identity'),
        factory: (base) => {
          /*
            The account half of chrome.identity, answered as Chrome answers them in a browser with no
            Google account signed in: `getProfileUserInfo` gives empty strings, `getAuthToken` fails
            with "The user is not signed in." (the message Chrome's own binding uses), the cache
            calls succeed with nothing to clear, and `getAccounts` lists none. There is no account
            to sign in here, so these are the honest answers — and far better than the methods not
            existing, which made an enterprise agent die on `getAuthToken is not a function` at
            worker start instead of taking its no-account path.
          */
          const notSignedIn = () => new Error('The user is not signed in.')
          const fail =
            (error: () => Error) =>
            (...args: any[]) => {
              const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
              if (callback) {
                queueMicrotask(() => withLastError(error().message, () => callback()))
                return
              }
              return Promise.reject(error())
            }
          return {
            ...base,
            getRedirectURL: (path?: string) => {
              const cleanPath = (path || '').replace(/^\//, '')
              return `https://${extensionId}.chromiumapp.org/${cleanPath}`
            },
            launchWebAuthFlow: invokeExtension('identity.launchWebAuthFlow'),
            getProfileUserInfo: localStub({ email: '', id: '' }),
            getAuthToken: fail(notSignedIn),
            removeCachedAuthToken: localStub(),
            clearAllCachedAuthTokens: localStub(),
            getAccounts: localStub([]),
            onSignInChanged: new Event(),
            // The enum getProfileUserInfo's details use; Endpoint Verification reads it at start.
            AccountStatus: { ANY: 'ANY', SYNC: 'SYNC' } as any,
          }
        },
      },

      /*
        chrome.gcm: the push channel of Google Cloud Messaging, which only Chrome's own GCM client
        can provide. There is none here, so nothing can ever arrive and a registration cannot be
        made — answered as Chrome answers a failed one (lastError / rejection, the error strings
        are gcm's own). What matters is that the namespace exists: Endpoint Verification registers
        `gcm.onMessage` at the top of its worker and died there, worker and all, on `undefined`.
      */
      gcm: {
        shouldInject: () => !!(manifest.permissions as string[] | undefined)?.includes('gcm'),
        factory: (base) => {
          const unavailable =
            (...args: any[]) => {
              const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
              const error = new Error('UNKNOWN_ERROR')
              if (callback) {
                queueMicrotask(() => withLastError(error.message, () => callback()))
                return
              }
              return Promise.reject(error)
            }
          return {
            ...base,
            MAX_MESSAGE_SIZE: 4096,
            register: unavailable,
            unregister: localStub(),
            send: unavailable,
            onMessage: new Event(),
            onMessagesDeleted: new Event(),
            onSendError: new Event(),
          }
        },
      },

      /*
        chrome.proxy: Electron defines the namespace natively but registers none of its functions,
        so every call ended in "Access to extension API denied." — NordVPN hits that three times per
        boot and once per popup. The embedder owns the session's proxy (Rambox configures it per
        profile), so the honest answer is a setting no extension controls: `get` reports the system
        proxy as not controllable, `set` and `clear` take effect nowhere, and the extension's own
        check of levelOfControl tells it so, instead of a denial it cannot interpret.
      */
      proxy: {
        factory: (base) => {
          const b: any = base || {}
          return {
            ...base,
            settings: new ChromeSetting({ mode: 'system' }),
            onProxyError: b.onProxyError || new Event(),
            Mode: {
              DIRECT: 'direct',
              AUTO_DETECT: 'auto_detect',
              PAC_SCRIPT: 'pac_script',
              FIXED_SERVERS: 'fixed_servers',
              SYSTEM: 'system',
            },
            Scheme: { HTTP: 'http', HTTPS: 'https', QUIC: 'quic', SOCKS4: 'socks4', SOCKS5: 'socks5' },
          }
        },
      },

      i18n: {
        factory: (base) => {
          /*
            The host application's language, when the locale patch resolved a bundle for it (see
            browser/patch/locale-patch.ts: Electron's own getMessage only ever answers in the
            extension's default locale). The bundle rides in the manifest under `crx_i18n` because
            getManifest() is synchronous in every context, getMessage is a synchronous API, and a
            worker calls it from its first lines. Only the locale-dependent methods are replaced;
            `detectLanguage` and whatever else Electron provides stay native.
          */
          const payload: CrxI18nPayload | undefined = (manifest as any)?.crx_i18n
          if (payload && payload.messages && extensionId) {
            electron.i18nInit(extensionId, payload)
            const languages = payload.locale === 'en-US' ? ['en-US'] : [payload.locale, 'en-US']
            return {
              ...base,
              getMessage: (name: string, substitutions?: any, options?: any) =>
                electron.i18nGetMessage(name, substitutions, options),
              getUILanguage: () => payload.locale,
              getAcceptLanguages: (callback?: any) => {
                const results = languages.slice()
                if (typeof callback === 'function') {
                  queueMicrotask(() => callback(results))
                  return
                }
                return Promise.resolve(results)
              },
            }
          }

          // Electron configuration prevented this API from being available.
          // https://github.com/electron/electron/pull/45031
          if (base.getMessage) {
            return base
          }

          return {
            ...base,
            getUILanguage: () => 'en-US',
            getAcceptLanguages: (callback: any) => {
              const results = ['en-US']
              if (callback) {
                queueMicrotask(() => callback(results))
              }
              return Promise.resolve(results)
            },
            getMessage: (messageName: string) => messageName,
          }
        },
      },

      idle: {
        factory: (base) => {
          return {
            ...base,
            queryState: invokeExtension('idle.queryState'),
            setDetectionInterval: invokeExtension('idle.setDetectionInterval'),
            getAutoLockDelay: invokeExtension('idle.getAutoLockDelay'),
            onStateChanged: new ExtensionEvent('idle.onStateChanged'),
          }
        },
      },

      management: {
        factory: (base) => {
          const b: any = base || {}
          return {
            ...base,
            // Electron's native implementation of getAll never resolves.
            get: invokeExtension('management.get'),
            getAll: invokeExtension('management.getAll'),
            getSelf: invokeExtension('management.getSelf'),
            getPermissionWarningsById: invokeExtension('management.getPermissionWarningsById'),
            getPermissionWarningsByManifest: invokeExtension(
              'management.getPermissionWarningsByManifest',
            ),
            setEnabled: invokeExtension('management.setEnabled'),
            uninstallSelf: invokeExtension('management.uninstallSelf'),
            // Electron's binding carries onEnabled/onDisabled; the other two come from the library's
            // own load and unload events. Nothing is ever disabled here, so those two never fire.
            onInstalled: new ExtensionEvent('management.onInstalled'),
            onUninstalled: new ExtensionEvent('management.onUninstalled'),
            onEnabled: b.onEnabled || new ExtensionEvent('management.onEnabled'),
            onDisabled: b.onDisabled || new ExtensionEvent('management.onDisabled'),
          }
        },
      },

      notifications: {
        factory: (base) => {
          return {
            ...base,
            clear: invokeExtension('notifications.clear'),
            create: invokeExtension('notifications.create'),
            getAll: invokeExtension('notifications.getAll'),
            getPermissionLevel: invokeExtension('notifications.getPermissionLevel'),
            update: invokeExtension('notifications.update'),
            onClicked: new ExtensionEvent('notifications.onClicked'),
            onButtonClicked: new ExtensionEvent('notifications.onButtonClicked'),
            onClosed: new ExtensionEvent('notifications.onClosed'),
          }
        },
      },

      offscreen: {
        shouldInject: () => manifest.manifest_version === 3,
        factory: (base) => {
          return {
            ...base,
            createDocument: invokeExtension('offscreen.createDocument'),
            closeDocument: invokeExtension('offscreen.closeDocument'),
            hasDocument: invokeExtension('offscreen.hasDocument'),
            // Enum normally provided by Chrome; extensions reference it when
            // building createDocument() parameters.
            Reason: {
              TESTING: 'TESTING',
              AUDIO_PLAYBACK: 'AUDIO_PLAYBACK',
              IFRAME_SCRIPTING: 'IFRAME_SCRIPTING',
              DOM_SCRAPING: 'DOM_SCRAPING',
              BLOBS: 'BLOBS',
              DOM_PARSER: 'DOM_PARSER',
              USER_MEDIA: 'USER_MEDIA',
              DISPLAY_MEDIA: 'DISPLAY_MEDIA',
              WEB_RTC: 'WEB_RTC',
              CLIPBOARD: 'CLIPBOARD',
              LOCAL_STORAGE: 'LOCAL_STORAGE',
              WORKERS: 'WORKERS',
              BATTERY_STATUS: 'BATTERY_STATUS',
              MATCH_MEDIA: 'MATCH_MEDIA',
              GEOLOCATION: 'GEOLOCATION',
            } as any,
          }
        },
      },

      permissions: {
        factory: (base) => {
          return {
            ...base,
            contains: invokeExtension('permissions.contains'),
            getAll: invokeExtension('permissions.getAll'),
            remove: invokeExtension('permissions.remove'),
            request: invokeExtension('permissions.request'),
            onAdded: new ExtensionEvent('permissions.onAdded'),
            onRemoved: new ExtensionEvent('permissions.onRemoved'),
          }
        },
      },

      privacy: {
        factory: (base) => {
          return {
            ...base,
            network: {
              networkPredictionEnabled: new ChromeSetting(false),
              // The one string setting of the group; 'default' is Chrome's own default policy.
              webRTCIPHandlingPolicy: new ChromeSetting('default'),
            },
            services: {
              autofillAddressEnabled: new ChromeSetting(false),
              autofillCreditCardEnabled: new ChromeSetting(false),
              passwordSavingEnabled: new ChromeSetting(false),
            },
            websites: {
              hyperlinkAuditingEnabled: new ChromeSetting(false),
            },
          }
        },
      },

      runtime: {
        factory: (base) => {
          // Electron natively fills MessageSender.tab with hardcoded
          // active/highlighted=false since it has no tab model. Extensions
          // (e.g. password managers) rely on sender.tab.active to decide
          // whether to analyze/autofill a page, so we patch those fields
          // using the library's tab state. See activeTabCache below.
          const patchSenderTab = (sender?: chrome.runtime.MessageSender) => {
            const tab = sender?.tab
            // Only override when we positively know this tab is active; leave
            // the native (false) values untouched otherwise.
            if (tab && typeof tab.id === 'number' && activeTabCache.ids.has(tab.id)) {
              tab.active = true
              tab.highlighted = true
            }
            return sender
          }

          // Wraps a native event so listener args can be transformed before
          // dispatch. A WeakMap preserves removeListener identity semantics.
          const wrapSenderEvent = <T extends Function>(
            event: chrome.events.Event<T> | undefined,
            transform: (args: any[]) => void,
          ) => {
            // Nothing to wrap (e.g. API missing in this context) — pass through.
            if (!event?.addListener) return event
            // Maps the caller's original callback to our wrapper, so
            // removeListener/hasListener can resolve back to the wrapper.
            const wrappers = new WeakMap<Function, Function>()
            const originalAdd = event.addListener.bind(event)
            const originalRemove = event.removeListener.bind(event)
            // Inherit from the native event so any untouched members (getRules,
            // etc.) keep working via the prototype chain.
            return Object.assign(Object.create(event), {
              addListener: (callback: Function, ...rest: any[]) => {
                // First subscription is the trigger to start tracking tabs.
                activeTabCache.init()
                const wrapped = (...args: any[]) => {
                  transform(args)
                  // Preserve the return value; returning true keeps the
                  // sendResponse port open for async replies.
                  return callback(...args)
                }
                wrappers.set(callback, wrapped)
                return (originalAdd as any)(wrapped, ...rest)
              },
              removeListener: (callback: Function) => {
                // Fall back to the raw callback in case it was never wrapped.
                originalRemove((wrappers.get(callback) as any) ?? callback)
                wrappers.delete(callback)
              },
              hasListener: (callback: Function) =>
                (event.hasListener as any)?.((wrappers.get(callback) as any) ?? callback),
            })
          }

          /*
            `runtime.onInstalled`, fired from the library's record because Electron never fires it
            (see RuntimeAPI in the browser side). Only a background — the MV3 worker, or an MV2
            background page — receives it, as in Chrome, where it is dispatched to the background.

            The first `addListener` asks the main process for the pending details, once; every listener
            registered before the answer arrives gets them, which covers the ones an extension adds
            while its worker script evaluates. Anything subscribed later misses it, as in Chrome.
          */
          const isBackgroundContext = (() => {
            if (typeof (globalThis as any).ServiceWorkerGlobalScope !== 'undefined') {
              return globalThis instanceof (globalThis as any).ServiceWorkerGlobalScope
            }
            const background = (manifest as any).background
            if (manifest.manifest_version !== 2 || !background) return false
            const page = background.page || '_generated_background_page.html'
            try {
              return location.href.split('#')[0] === (base as any).getURL(page)
            } catch {
              return false
            }
          })()

          const createOnInstalled = () => {
            const listeners = new Set<Function>()
            let asked = false
            const ask = () => {
              if (asked) return
              asked = true
              // Promise form: no callback is passed, so the wrapper returns one.
              ;(invokeExtension('runtime.takeInstalledDetails')() as Promise<any>).then(
                (details: any) => {
                  if (!details) return
                  for (const listener of Array.from(listeners)) {
                    try {
                      listener(details)
                    } catch (error) {
                      // An extension's own listener throwing must not stop the next one, as in Chrome.
                      console.error(error)
                    }
                  }
                },
                // No record to read (a context the router cannot attribute): no event, not a rejection
                // nobody handles.
                () => undefined,
              )
            }
            return {
              addListener: (callback: Function) => {
                listeners.add(callback)
                ask()
              },
              removeListener: (callback: Function) => {
                listeners.delete(callback)
              },
              hasListener: (callback: Function) => listeners.has(callback),
              hasListeners: () => listeners.size > 0,
            }
          }

          /*
            `lastError` reads through to Chromium on every access. The spread below cannot carry it: Chromium
            defines `lastError` on ITS runtime object only while one of its callbacks runs, and
            deletes it after (Edge 156: no own property outside a callback). So on this replacement
            object `chrome.runtime.lastError` was always undefined — every callback-style call
            looked like a success to the extension — and, because the extension's read never
            reached Chromium's getter, Chromium also logged "Unchecked runtime.lastError" for
            callers that DID check. That is where RoboForm's 11 to 18 "Could not establish
            connection. Receiving end does not exist." per boot came from: its broadcasts to
            popups that are not open, which read lastError on purpose.
          */
          return defineLastError(
            {
              ...base,
              ...(isBackgroundContext ? { onInstalled: createOnInstalled() } : {}),
              // onMessage signature is (message, sender, sendResponse) — patch arg[1].
              onMessage: wrapSenderEvent(base.onMessage as any, (args) => {
                patchSenderTab(args[1])
              }),
              // onConnect signature is (port) — the sender lives on the port.
              onConnect: wrapSenderEvent(base.onConnect as any, (args) => {
                patchSenderTab(args[0]?.sender)
              }),
              connectNative: (application: string) => {
                const port = new NativePort()
                const receive = port._receive.bind(port)
                const disconnect = port._disconnect.bind(port)
                const callback: ConnectNativeCallback = (connectionId, send) => {
                  port._init(connectionId, send)
                }
                electron.connectNative(extensionId, application, receive, disconnect, callback)
                return port
              },
              /*
                Electron's binding knows only the BACKGROUND context. Chromium also lists the
                extension's offscreen document, popup and tabs, which the main process knows
                (runtime.getDocumentContexts); both lists are joined here and filtered as Chromium
                filters (every given key must match, any value within a key).
              */
              getContexts: (filter?: any, callback?: (contexts: any[]) => void) => {
                if (typeof filter === 'function') {
                  callback = filter
                  filter = {}
                }
                filter = filter || {}
                const native = (): Promise<any[]> =>
                  new Promise((resolve) => {
                    const nativeGetContexts = (base as any).getContexts
                    if (typeof nativeGetContexts !== 'function') return resolve([])
                    try {
                      nativeGetContexts.call(
                        base,
                        { contextTypes: ['BACKGROUND'] },
                        (list: any[]) => resolve(Array.isArray(list) ? list : []),
                      )
                    } catch {
                      resolve([])
                    }
                  })
                const keys: Array<[string, string]> = [
                  ['contextTypes', 'contextType'],
                  ['contextIds', 'contextId'],
                  ['tabIds', 'tabId'],
                  ['windowIds', 'windowId'],
                  ['frameIds', 'frameId'],
                  ['documentIds', 'documentId'],
                  ['documentUrls', 'documentUrl'],
                  ['documentOrigins', 'documentOrigin'],
                ]
                const matches = (context: any) =>
                  keys.every(
                    ([filterKey, field]) =>
                      !Array.isArray(filter[filterKey]) ||
                      filter[filterKey].includes(context[field]),
                  ) &&
                  (typeof filter.incognito !== 'boolean' || context.incognito === filter.incognito)
                const promise = Promise.all([
                  native(),
                  invokeExtension('runtime.getDocumentContexts')() as Promise<any[]>,
                ]).then(([background, documents]) =>
                  [...background, ...(Array.isArray(documents) ? documents : [])].filter(matches),
                )
                if (typeof callback === 'function') {
                  promise.then(callback)
                  return
                }
                return promise
              },
              openOptionsPage: invokeExtension('runtime.openOptionsPage'),
              sendNativeMessage: invokeExtension('runtime.sendNativeMessage'),
              /*
              Electron's own requestUpdateCheck sets lastError "Autoupdate is not enabled." and hands
              the callback nothing — and without a callback the promise REJECTS. Chrome never fails
              here: it answers a status (measured in Edge 156: callback ('throttled', { version: '' }),
              promise { status: 'throttled', version: '' }). Grammarly 14.1342.0 calls it on every
              worker start, without reading lastError, so each boot logged an unchecked lastError; a
              caller that awaits it would get an unhandled rejection instead.

              There is no updater in an Electron embedder — the host ships extension updates itself —
              so the true answer is that there is no update, in the shape Chrome gives.
            */
              requestUpdateCheck: (
                callback?: (status: string, details: { version: string }) => void,
              ) => {
                const status = 'no_update'
                const details = { version: '' }
                if (typeof callback === 'function') {
                  queueMicrotask(() => callback(status, details))
                  return
                }
                return Promise.resolve({ status, ...details })
              },
            },
            () => injectedLastError ?? base?.lastError,
          )
        },
      },

      // There's no side panel UI in Electron; stubbed so MV3 extensions that
      // probe for the API don't crash.
      sidePanel: {
        shouldInject: () => manifest.manifest_version === 3,
        factory: (base) => {
          return {
            ...base,
            getOptions: localStub({ enabled: false }),
            setOptions: localStub(),
            getPanelBehavior: localStub({ openPanelOnActionClick: false }),
            setPanelBehavior: localStub(),
            open: localStub(),
          }
        },
      },

      storage: {
        factory: (base) => {
          const local = base && base.local

          /*
            `managed` is the administrator's policy store. It is read-only, and on a machine with no
            enterprise policy installed Chrome answers every read with an empty result. Electron has no
            policy backend, so empty is not a fallback here: it is the same answer Chrome gives, and the
            only honest one.

            It used to alias `local`, which was wrong in two ways.

            It handed an extension its OWN data back as administrator policy. `managed.get(null)`
            returned the whole local store, and a password manager reads that area for vault policy —
            measured in Rambox, Grammarly's `managed.get(null)` came back holding its alarms, its
            cached config and the active tab's URL.

            And every read took a round trip to the main process, which a caller can lose. Real
            extensions race a policy read against a timeout — Grammarly gives it 3s — and measured
            with the worker's event loop blocked past such a deadline, the IPC answer never arrives
            and the timer wins, while an answer resolved in a microtask lands the instant the loop
            frees up. There is nothing to fetch here, so this area never leaves the renderer.

            (That measurement is NOT a diagnosis of Grammarly's own "Manage storage timeout" errors:
            its `get`, copied verbatim into its own worker, resolves in 0 ms across the exact window
            where its calls expire. This change does not stop them. See
            docs/EXTENSION_CATALOG_HEALTH.md in the Rambox monorepo.)

            `sync` still aliases `local`: it is a real read/write store, and backing it with local data
            is what an extension expects to find in it.
          */
          const EMPTY_RESULT = () => ({}) as Record<string, unknown>

          const managedGet = (...args: any[]) => {
            const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
            const keys = args[0]
            // Chrome returns the defaults an extension passes and overrides none of them, because
            // there is no policy to override them with. Arrays and plain keys simply find nothing.
            const result =
              keys && typeof keys === 'object' && !Array.isArray(keys)
                ? { ...(keys as Record<string, unknown>) }
                : EMPTY_RESULT()
            if (callback) {
              queueMicrotask(() => callback(result))
              return
            }
            return Promise.resolve(result)
          }

          /*
            Chrome exposes the write methods on the managed area and fails the call; it reports that
            through `runtime.lastError` for a callback, which a preload cannot set, so the callback
            form here comes back without one. The promise form — what MV3 code uses — rejects with
            Chrome's own message.
          */
          const readOnly =
            () =>
            (...args: any[]) => {
              const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
              if (callback) {
                queueMicrotask(() => callback())
                return
              }
              return Promise.reject(new Error('This is a read-only store.'))
            }

          // Policy never changes while the app runs, so this event has nothing to report. Taking
          // local's would deliver the extension's own writes as policy changes, which is the leak
          // above in event form.
          const inertOnChanged = {
            addListener: () => {},
            removeListener: () => {},
            hasListener: () => false,
            hasListeners: () => false,
          }

          const managed = {
            get: managedGet,
            getKeys: localStub([]),
            getBytesInUse: localStub(0),
            set: readOnly(),
            remove: readOnly(),
            clear: readOnly(),
            onChanged: inertOnChanged,
          }

          /*
            `sync` aliases `local`, with the constants Chrome puts on the sync area. The alias used
            to be the local object itself, whose constants are local's (QUOTA_BYTES alone), so
            `sync.MAX_ITEMS` and `sync.QUOTA_BYTES_PER_ITEM` read undefined: LanguageTool 11.5.0
            splits its dictionary into chunks sized by them, and a NaN chunk size keeps one chunk.
            Methods stay bound to local, which is where the data lives.
          */
          const sync: any = {}
          if (local) {
            for (const key of Object.keys(local)) {
              const member = (local as any)[key]
              sync[key] = typeof member === 'function' ? member.bind(local) : member
            }
            // Members that live on the prototype of the native area, which Object.keys does not list.
            for (const name of ['get', 'getBytesInUse', 'getKeys', 'set', 'remove', 'clear', 'setAccessLevel']) {
              const member = (local as any)[name]
              if (typeof member === 'function' && !sync[name]) sync[name] = member.bind(local)
            }
            if (!sync.onChanged && (local as any).onChanged) sync.onChanged = (local as any).onChanged
          }
          Object.assign(sync, {
            QUOTA_BYTES: 102400,
            QUOTA_BYTES_PER_ITEM: 8192,
            MAX_ITEMS: 512,
            MAX_WRITE_OPERATIONS_PER_HOUR: 1800,
            MAX_WRITE_OPERATIONS_PER_MINUTE: 120,
            MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000,
          })

          return {
            ...base,
            managed,
            sync,
          }
        },
      },

      tabs: {
        factory: (base) => {
          const api = {
            ...base,
            create: invokeExtension('tabs.create'),
            executeScript: async function (
              arg1: unknown,
              arg2: unknown,
              arg3: unknown,
            ): Promise<any> {
              // Electron's implementation of chrome.tabs.executeScript is in
              // C++, but it doesn't support implicit execution in the active
              // tab. To handle this, we need to get the active tab ID and
              // pass it into the C++ implementation ourselves.
              if (typeof arg1 === 'object') {
                const [activeTab] = await api.query({
                  active: true,
                  windowId: chrome.windows.WINDOW_ID_CURRENT,
                })
                return api.executeScript(activeTab.id, arg1, arg2)
              } else {
                return (base.executeScript as typeof chrome.tabs.executeScript)(
                  arg1 as number,
                  arg2 as chrome.tabs.InjectDetails,
                  arg3 as () => {},
                )
              }
            },
            captureVisibleTab: invokeExtension('tabs.captureVisibleTab'),
            // Electron has no detectLanguage of its own, so without this the method is simply
            // absent and a call throws. Two extensions in Rambox's catalog make one.
            detectLanguage: invokeExtension('tabs.detectLanguage'),
            get: invokeExtension('tabs.get'),
            getCurrent: invokeExtension('tabs.getCurrent'),
            getAllInWindow: invokeExtension('tabs.getAllInWindow'),
            insertCSS: invokeExtension('tabs.insertCSS'),
            query: invokeExtension('tabs.query'),
            reload: invokeExtension('tabs.reload'),
            update: invokeExtension('tabs.update'),
            remove: invokeExtension('tabs.remove'),
            goBack: invokeExtension('tabs.goBack'),
            goForward: invokeExtension('tabs.goForward'),
            duplicate: invokeExtension('tabs.duplicate'),
            highlight: invokeExtension('tabs.highlight'),
            onCreated: new ExtensionEvent('tabs.onCreated'),
            onRemoved: new ExtensionEvent('tabs.onRemoved'),
            onUpdated: new ExtensionEvent('tabs.onUpdated'),
            onActivated: new ExtensionEvent('tabs.onActivated'),
            onReplaced: new ExtensionEvent('tabs.onReplaced'),
            /*
              The rest of chrome.tabs' events. An extension registers these at the top of its worker
              as a matter of course (a tab manager listens to all of them), and a namespace missing
              one threw there and took the worker's registration with it. onHighlighted follows every
              activation and onZoomChange the user's zoom; the other three describe a tab moving
              between positions or windows, which the embedder's tabs never do, so they never fire —
              which is the truth of the model, not a stub.
            */
            onHighlighted: new ExtensionEvent('tabs.onHighlighted'),
            onZoomChange: new ExtensionEvent('tabs.onZoomChange'),
            onMoved: new ExtensionEvent('tabs.onMoved'),
            onDetached: new ExtensionEvent('tabs.onDetached'),
            onAttached: new ExtensionEvent('tabs.onAttached'),
          }
          return api
        },
      },

      topSites: {
        factory: () => {
          return {
            get: invokeExtension('topSites.get', { noop: true, defaultResponse: [] }),
          }
        },
      },

      webNavigation: {
        factory: (base) => {
          return {
            ...base,
            getFrame: invokeExtension('webNavigation.getFrame'),
            getAllFrames: invokeExtension('webNavigation.getAllFrames'),
            onBeforeNavigate: new ExtensionEvent('webNavigation.onBeforeNavigate'),
            onCommitted: new ExtensionEvent('webNavigation.onCommitted'),
            onCompleted: new ExtensionEvent('webNavigation.onCompleted'),
            onCreatedNavigationTarget: new ExtensionEvent(
              'webNavigation.onCreatedNavigationTarget',
            ),
            onDOMContentLoaded: new ExtensionEvent('webNavigation.onDOMContentLoaded'),
            onErrorOccurred: new ExtensionEvent('webNavigation.onErrorOccurred'),
            onHistoryStateUpdated: new ExtensionEvent('webNavigation.onHistoryStateUpdated'),
            onReferenceFragmentUpdated: new ExtensionEvent(
              'webNavigation.onReferenceFragmentUpdated',
            ),
            onTabReplaced: new ExtensionEvent('webNavigation.onTabReplaced'),
          }
        },
      },

      windows: {
        factory: (base) => {
          return {
            ...base,
            WINDOW_ID_NONE: -1,
            WINDOW_ID_CURRENT: -2,
            get: invokeExtension('windows.get'),
            getCurrent: invokeExtension('windows.getCurrent'),
            getLastFocused: invokeExtension('windows.getLastFocused'),
            getAll: invokeExtension('windows.getAll'),
            create: invokeExtension('windows.create'),
            update: invokeExtension('windows.update'),
            remove: invokeExtension('windows.remove'),
            onCreated: new ExtensionEvent('windows.onCreated'),
            onRemoved: new ExtensionEvent('windows.onRemoved'),
            onFocusChanged: new ExtensionEvent('windows.onFocusChanged'),
            onBoundsChanged: new ExtensionEvent('windows.onBoundsChanged'),
          }
        },
      },
    }

    // Initialize APIs
    //
    // Each namespace is injected on its own, because a single failure used to take out every
    // namespace after it in iteration order and leave no trace of why. `windows` is last, so an
    // exception anywhere earlier made `chrome.windows` undefined — and an extension that registers
    // `chrome.windows.onFocusChanged` at service-worker top level (LastPass does) then died with
    // "Cannot read properties of undefined", its worker never registered and the whole extension
    // did nothing at all. Reading `chrome[apiName]` can throw too (Chromium's namespaces are lazy
    // getters that load a binding module, and a module can fail to load: "No source for
    // require(webRequest)" on Electron 43), so the read is inside the try as well.
    Object.keys(apiDefinitions).forEach((key: any) => {
      const apiName: keyof typeof chrome = key
      try {
        const api = apiDefinitions[apiName]!

        // Allow APIs to opt-out of being available in this context.
        if (api.shouldInject && !api.shouldInject()) return

        const baseApi = chrome[apiName] as any
        Object.defineProperty(chrome, apiName, {
          value: api.factory(baseApi),
          enumerable: true,
          configurable: true,
        })
      } catch (error) {
        // Loud on purpose: a missing namespace is otherwise indistinguishable from an extension bug.
        console.error(`electron-chrome-extensions: failed to inject chrome.${apiName}`, error)
      }
    })

    /*
      Namespaces this file replaced on `chrome`, which have to be mirrored onto the `browser` global
      once every repair below has run too. See mirrorOntoBrowserGlobal at the end of this function.
    */
    const replacedNamespaces = new Set(
      Object.keys(apiDefinitions).filter((apiName) => !!(chrome as any)[apiName]),
    )

    // Seed the active tab cache eagerly in extension contexts so early
    // incoming messages (e.g. content scripts connecting on page load) get a
    // correct sender.tab.active value.
    if (extensionId) activeTabCache.init()

    // Replace the broken native WebSocket in service-worker contexts only.
    // Pages keep the working native implementation. ProxyWebSocket closes over
    // `electron`, so it keeps working after the global reference is removed
    // below.
    const isServiceWorker =
      typeof (self as any).ServiceWorkerGlobalScope !== 'undefined' &&
      (self as any) instanceof (self as any).ServiceWorkerGlobalScope
    if (isServiceWorker && extensionId) {
      try {
        ;(globalThis as any).WebSocket = ProxyWebSocket
      } catch (error) {
        console.error('Failed to install WebSocket proxy', error)
      }
    }

    // Repair chrome.webRequest's event objects on Electron 43.
    // Upstream Electron 43.0.0 regression (reproduced with a minimal repro —
    // bare loadExtension of an MV3 extension declaring the webRequest
    // permission — on BOTH stock 43.0.0 and castlabs 43.0.0+wvcus; absent on
    // stock 42.5.2): the chrome.webRequest namespace exists and Object.keys
    // lists all its event names, but every event object (onBeforeRequest,
    // onAuthRequired, ...) evaluates to undefined because Chromium's binding
    // module fails to load ("No source for require(webRequestEvent)" logged
    // by the extensions context). Real extensions register webRequest
    // listeners at service-worker top level (observed live: Keeper's BG.js in
    // Rambox), so the resulting `Cannot read properties of undefined
    // (reading 'addListener')` kills their whole init — the popup's startup
    // message never gets answered and the login UI never appears.
    //
    // Fill ONLY the missing events with inert Chrome-shaped stubs: listeners
    // registered on a stub never fire (the native observation layer is what's
    // broken — there is nothing to receive events from), but the extension
    // survives startup with webRequest-dependent features degraded instead of
    // dying outright. On Electron versions where the native API is intact
    // this is a complete no-op, so nothing needs to detect versions.
    const nativeWebRequest = (chrome as any).webRequest
    if (nativeWebRequest) {
      const webRequestEventNames = [
        'onBeforeRequest',
        'onBeforeSendHeaders',
        'onSendHeaders',
        'onHeadersReceived',
        'onAuthRequired',
        'onResponseStarted',
        'onBeforeRedirect',
        'onCompleted',
        'onErrorOccurred',
        'onActionIgnored',
      ]
      const missing = webRequestEventNames.filter((name) => nativeWebRequest[name] === undefined)
      if (missing.length > 0) {
        // Match Chrome's event-object surface so feature-detection and
        // defensive calls behave (hasListener -> false, getRules -> empty).
        const makeInertEvent = () => ({
          addListener: () => {},
          removeListener: () => {},
          hasListener: () => false,
          hasListeners: () => false,
          getRules: (...args: any[]) => {
            const cb = args[args.length - 1]
            if (typeof cb === 'function') cb([])
          },
          addRules: () => {},
          removeRules: (...args: any[]) => {
            const cb = args[args.length - 1]
            if (typeof cb === 'function') cb()
          },
        })

        // The broken properties may be lazy accessors on the native object,
        // so don't assign into it — rebuild a plain wrapper (spread copies
        // the working members: handlerBehaviorChanged, constants, and any
        // event that DID resolve) and replace chrome.webRequest wholesale,
        // the same way the injected API factories above are installed.
        try {
          const repaired: any = { ...nativeWebRequest }
          for (const name of missing) repaired[name] = makeInertEvent()
          Object.defineProperty(chrome, 'webRequest', {
            value: repaired,
            enumerable: true,
            configurable: true,
          })
          replacedNamespaces.add('webRequest')
        } catch (error) {
          console.error('Failed to repair chrome.webRequest events', error)
        }
      }
    }

    // Enable manifest-declared static declarativeNetRequest rulesets. Electron
    // 42's native DNR engine parses and enforces static rulesets but does NOT
    // honor their manifest `"enabled": true` flag at load — leaving them
    // disabled (getEnabledRulesets() returns []). Calling updateEnabledRulesets
    // once at service-worker startup activates them, matching Chrome's default.
    // Dynamic and session rules already work natively and need no help here.
    /*
      Known cost on Electron 44 (44.5.1, 44.9.3 and 44.10.0 stock, measured 29/10/2026 with uBlock in
      Rambox's bench; 43 is fine): once ANY `updateEnabledRulesets` has run for an extension — this
      one, or the extension's own, which uBlock issues at boot — its dynamic ruleset is gone for the
      session: persisted dynamic rules do not load and every `updateDynamicRules` fails with
      "Internal error while updating dynamic rules.". And without an enable on a launch after the
      first, Electron 44 does not restore the enabled static rulesets either (`getEnabledRulesets()`
      stays `[]`). So on 44 it is static blocking or dynamic rules, not both, and this keeps the
      static rulesets — the blocking an extension ships with. Skipping the call on later launches
      (prefs say the rulesets are remembered) and deferring it were both tried and change nothing:
      the extension's own enable breaks the dynamic ruleset the same way. The fix is Electron's.
      See docs/EXTENSION_CATALOG_HEALTH.md in the Rambox monorepo for the measurements.
    */
    if (isServiceWorker && extensionId) {
      const dnr = (chrome as any).declarativeNetRequest
      const rulesets: any[] = (manifest as any).declarative_net_request?.rule_resources || []
      const enabledIds = rulesets
        .filter((r) => r && r.enabled !== false && typeof r.id === 'string')
        .map((r) => r.id)
      if (dnr?.updateEnabledRulesets && enabledIds.length > 0) {
        try {
          // Fire-and-forget: startup enablement, errors are non-fatal.
          Promise.resolve(dnr.updateEnabledRulesets({ enableRulesetIds: enabledIds })).catch(
            (error: unknown) => console.error('Failed to enable static DNR rulesets', error),
          )
        } catch (error) {
          console.error('Failed to enable static DNR rulesets', error)
        }
      }
    }

    /*
      Mirror everything replaced above onto the `browser` global.

      Chrome has no `browser` global at all — that is why webextension-polyfill exists — but Electron
      defines one in extension contexts holding ONLY the natively implemented namespaces (action,
      alarms, extension, i18n, idle, management, offscreen, runtime, scripting, storage, tabs,
      webRequest, declarativeNetRequest). Everything injected above — windows, webNavigation,
      cookies, contextMenus, permissions, notifications, privacy, downloads, commands, sidePanel… —
      was missing from it, and its `webRequest` carried the same broken events the repair above fixes
      on `chrome`.

      Cross-browser extensions pick `globalThis.browser` over `chrome` precisely because its presence
      is supposed to mean "this browser has the WebExtension API", so they got the half-empty object.
      Measured against the catalog: LastPass 4.154.2 and NordPass 7.8.15 both died at service-worker
      top level on it ("Cannot read properties of undefined", worker registration then failing with
      status 15) and did nothing at all afterwards — no popup, no autofill — with no error anywhere a
      user or the host app could see.

      Runs last so the repairs above are included. The injected members take callbacks AND return
      promises, so they satisfy both calling conventions a `browser`-flavoured extension may use.
    */
    const browserGlobal = (globalThis as any).browser
    if (browserGlobal && typeof browserGlobal === 'object' && browserGlobal !== chrome) {
      for (const apiName of replacedNamespaces) {
        const injected = (chrome as any)[apiName]
        if (!injected) continue
        try {
          Object.defineProperty(browserGlobal, apiName, {
            value: injected,
            enumerable: true,
            configurable: true,
          })
        } catch (error) {
          console.error(`electron-chrome-extensions: failed to mirror browser.${apiName}`, error)
        }
      }
    }

    // Remove access to internals
    delete (globalThis as any).electron

    Object.freeze(chrome)

    void 0 // no return
  }

  /*
    Tell the main process this page's own size as soon as the document is interactive: before its
    deferred scripts run, so before an extension can read its viewport. Electron's preferred-size
    mode only starts after the load, and a popup that sizes itself from its viewport (Proton Pass)
    otherwise adopts whatever the window happened to measure then. Main ignores it for every page
    but the open browser-action popup. Isolated world, so the page cannot see or fake it.
  */
  if (
    process.type === 'renderer' &&
    location.protocol === 'chrome-extension:' &&
    window.top === window
  ) {
    const reportContentSize = () => {
      const root = document.documentElement
      if (!root) return
      const size = { width: root.scrollWidth, height: root.scrollHeight }
      ipcRenderer
        .invoke('crx-msg', location.hostname, 'browserAction.popupContentSize', size)
        .catch(() => {})
    }
    if (document.readyState === 'loading') {
      document.addEventListener(
        'readystatechange',
        () => {
          if (document.readyState === 'interactive') reportContentSize()
        },
        { once: true },
      )
    } else {
      reportContentSize()
    }
  }

  if (!process.contextIsolated) {
    console.warn(`injectExtensionAPIs: context isolation disabled in ${location.href}`)
    mainWorldScript()
    return
  }

  try {
    // Expose extension IPC to main world
    contextBridge.exposeInMainWorld('electron', electronContext)

    // Mutate global 'chrome' object with additional APIs in the main world.
    if ('executeInMainWorld' in contextBridge) {
      ;(contextBridge as any).executeInMainWorld({
        func: mainWorldScript,
      })
    } else {
      // TODO(mv3): remove webFrame usage
      webFrame.executeJavaScript(`(${mainWorldScript}());`)
    }
  } catch (error) {
    console.error(`injectExtensionAPIs error (${location.href})`)
    console.error(error)
  }
}
