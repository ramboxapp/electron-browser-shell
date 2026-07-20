import { ipcRenderer, contextBridge, webFrame } from 'electron'
import { addExtensionListener, removeExtensionListener, hasExtensionListeners } from './event'

export const injectExtensionAPIs = () => {
  interface ExtensionMessageOptions {
    noop?: boolean
    defaultResponse?: any
    serialize?: (...args: any[]) => any[]
  }

  const invokeExtension = async function (
    extensionId: string,
    fnName: string,
    options: ExtensionMessageOptions = {},
    ...args: any[]
  ) {
    const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined

    if (process.env.NODE_ENV === 'development') {
      console.log(fnName, args)
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
      // TODO: Set chrome.runtime.lastError?
      console.error(e)
      result = undefined
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(fnName, '(result)', result)
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
    disconnect: () => void,
    callback: ConnectNativeCallback,
  ) => {
    const connectionId = (contextBridge as any).executeInMainWorld({
      func: () => crypto.randomUUID(),
    })
    invokeExtension(extensionId, 'runtime.connectNative', {}, connectionId, application)
    const onMessage = (_event: Electron.IpcRendererEvent, message: any) => {
      receive(message)
    }
    ipcRenderer.on(`crx-native-msg-${connectionId}`, onMessage)
    ipcRenderer.once(`crx-native-msg-${connectionId}-disconnect`, () => {
      ipcRenderer.off(`crx-native-msg-${connectionId}`, onMessage)
      disconnect()
    })
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
    invokeExtension(extensionId, 'websocket.connect', {}, connectionId, url, protocols)
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

    const invokeExtension =
      (fnName: string, opts: ExtensionMessageOptions = {}) =>
      (...args: any[]) =>
        electron.invokeExtension(extensionId, fnName, opts, ...args)

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

    // chrome.types.ChromeSetting<any>
    class ChromeSetting {
      set() {}
      get() {}
      clear() {}
      onChange = {
        addListener: () => {},
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
    }

    class NativePort implements chrome.runtime.Port {
      private connectionId: string = ''
      private connected = false
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
        ;(this.onMessage as any)._emit(message)
      }

      _disconnect() {
        this.disconnect()
      }

      postMessage(message: any) {
        this._send(message)
      }
      disconnect() {
        if (this.connected) {
          electron.disconnectNative(extensionId, this.connectionId)
          ;(this.onDisconnect as any)._emit()
          this.connected = false
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

    const browserActionFactory = (base: DeepPartial<typeof globalThis.chrome.browserAction>) => {
      const api = {
        ...base,

        setTitle: invokeExtension('browserAction.setTitle'),
        getTitle: invokeExtension('browserAction.getTitle'),

        setIcon: invokeExtension('browserAction.setIcon', {
          serialize: (details: chrome.action.TabIconDetails) => {
            if (details.imageData) {
              if (manifest.manifest_version === 3) {
                // TODO(mv3): might need to use offscreen document to serialize
                console.warn(
                  'action.setIcon with imageData is not yet supported by electron-chrome-extensions',
                )
                details.imageData = undefined
              } else if (details.imageData instanceof ImageData) {
                details.imageData = imageData2base64(details.imageData) as any
              } else {
                details.imageData = Object.entries(details.imageData).reduce(
                  (obj: any, pair: any[]) => {
                    obj[pair[0]] = imageData2base64(pair[1])
                    return obj
                  },
                  {},
                )
              }
            }

            return [details]
          },
        }),

        setPopup: invokeExtension('browserAction.setPopup'),
        getPopup: invokeExtension('browserAction.getPopup'),

        setBadgeText: invokeExtension('browserAction.setBadgeText'),
        getBadgeText: invokeExtension('browserAction.getBadgeText'),

        setBadgeBackgroundColor: invokeExtension('browserAction.setBadgeBackgroundColor'),
        getBadgeBackgroundColor: invokeExtension('browserAction.getBadgeBackgroundColor'),

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
          return {
            ...base,
            isAllowedFileSchemeAccess: invokeExtension('extension.isAllowedFileSchemeAccess', {
              noop: true,
              defaultResponse: false,
            }),
            isAllowedIncognitoAccess: invokeExtension('extension.isAllowedIncognitoAccess', {
              noop: true,
              defaultResponse: false,
            }),
            // TODO: Add native implementation
            getViews: () => [],
          }
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
          return {
            ...base,
            getRedirectURL: (path?: string) => {
              const cleanPath = (path || '').replace(/^\//, '')
              return `https://${extensionId}.chromiumapp.org/${cleanPath}`
            },
            launchWebAuthFlow: invokeExtension('identity.launchWebAuthFlow'),
          }
        },
      },

      i18n: {
        shouldInject: () => manifest.manifest_version === 3,
        factory: (base) => {
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
          return {
            ...base,
            // Electron's native implementation of getAll never resolves.
            get: invokeExtension('management.get'),
            getAll: invokeExtension('management.getAll'),
            getSelf: invokeExtension('management.getSelf'),
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
              networkPredictionEnabled: new ChromeSetting(),
              webRTCIPHandlingPolicy: new ChromeSetting(),
            },
            services: {
              autofillAddressEnabled: new ChromeSetting(),
              autofillCreditCardEnabled: new ChromeSetting(),
              passwordSavingEnabled: new ChromeSetting(),
            },
            websites: {
              hyperlinkAuditingEnabled: new ChromeSetting(),
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

          return {
            ...base,
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
            openOptionsPage: invokeExtension('runtime.openOptionsPage'),
            sendNativeMessage: invokeExtension('runtime.sendNativeMessage'),
          }
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
          return {
            ...base,
            // TODO: provide a backend for browsers to opt-in to
            managed: local,
            sync: local,
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
            onCreated: new ExtensionEvent('tabs.onCreated'),
            onRemoved: new ExtensionEvent('tabs.onRemoved'),
            onUpdated: new ExtensionEvent('tabs.onUpdated'),
            onActivated: new ExtensionEvent('tabs.onActivated'),
            onReplaced: new ExtensionEvent('tabs.onReplaced'),
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
    Object.keys(apiDefinitions).forEach((key: any) => {
      const apiName: keyof typeof chrome = key
      const baseApi = chrome[apiName] as any
      const api = apiDefinitions[apiName]!

      // Allow APIs to opt-out of being available in this context.
      if (api.shouldInject && !api.shouldInject()) return

      Object.defineProperty(chrome, apiName, {
        value: api.factory(baseApi),
        enumerable: true,
        configurable: true,
      })
    })

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

    // Remove access to internals
    delete (globalThis as any).electron

    Object.freeze(chrome)

    void 0 // no return
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
