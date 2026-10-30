import { ipcRenderer, contextBridge, webFrame } from 'electron'
import { addExtensionListener, removeExtensionListener, hasExtensionListeners } from './event'
import { formatExtensionMessage, CrxI18nPayload, CrxI18nState } from '../shared/i18n-format'
import {
  fontSettingsSchemaError,
  GENERIC_FAMILIES,
  SCRIPT_CODES,
} from '../shared/font-settings-schema'

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
  const i18nGetMessage = (
    name: unknown,
    substitutions?: unknown,
    options?: { escapeLt?: boolean },
  ) => (i18nState ? formatExtensionMessage(i18nState, name, substitutions, options) : '')

  /*
    Whether this Electron delivers `storage.onChanged` to an extension's service worker on its own.

    Measured 30/10/2026 with a bare main process (no library), a worker listening to
    `storage.onChanged`, `storage.local.onChanged` and `storage.session.onChanged`, and a page and the
    worker writing: 43.0.0 and 44.9.3+wvcus deliver 0 of 5 changes to the worker (the page gets 5 of
    5); 44.10.0 and 45.1.0 stock deliver 5 of 5. The fix is electron/electron#55146 (the native
    event router was bound to frames only), backported to 44 in 44.10.0. Below that, the library
    relays the changes itself (see the `storage` definition in mainWorldScript and
    src/browser/api/storage.ts). `chrome-storage-onChanged-spec.ts` measures the binary it runs on
    against this answer, so a binary that disagrees fails the suite instead of duplicating or
    dropping events. ELECTRON_CHROME_EXTENSIONS_STORAGE_RELAY=0|1 overrides it.
  */
  const workerStorageEventsAreNative = (): boolean => {
    const override = process.env.ELECTRON_CHROME_EXTENSIONS_STORAGE_RELAY
    if (override === '0') return true
    if (override === '1') return false
    const [major, minor] = String(process.versions.electron || '')
      .split('.')
      .map((part) => parseInt(part, 10))
    if (!Number.isFinite(major)) return false
    if (major >= 46) return true
    if (major === 45) return minor >= 1
    if (major === 44) return minor >= 10
    return false
  }

  /*
    A storage write this context made, for the main process to deliver to the extension's worker.
    Not through invokeExtension on purpose: that one logs every call with its arguments in
    development, and these arguments are the stored values — a password manager's vault state.
  */
  const reportStorageChanges = (extensionId: string, areaName: string, changes: object) => {
    ipcRenderer
      .invoke('crx-msg', extensionId, 'storage.reportChanges', areaName, changes)
      .catch(() => {})
  }

  const electronContext = {
    storageChangeRelay: !workerStorageEventsAreNative(),
    reportStorageChanges,
    invokeExtension,
    addExtensionListener,
    removeExtensionListener,
    hasExtensionListeners,
    connectNative,
    disconnectNative,
    i18nInit,
    i18nGetMessage,
    // chrome.fontSettings' schema, which the main world cannot import (see mainWorldScript).
    fontSettingsSchemaError,
    fontSettingsEnums: () => ({ genericFamilies: GENERIC_FAMILIES, scriptCodes: SCRIPT_CODES }),
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

    // Shared by chrome.windows and chrome.tabs, as Chrome's are (values read from Edge 156).
    const WINDOW_TYPE = {
      NORMAL: 'normal',
      POPUP: 'popup',
      PANEL: 'panel',
      APP: 'app',
      DEVTOOLS: 'devtools',
      CUSTOM_TAB: 'custom-tab',
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
            // Chrome's constant and enums; an extension sizes its toolbar menu by the first.
            ACTION_MENU_TOP_LEVEL_LIMIT: 6,
            ContextType: {
              ALL: 'all',
              PAGE: 'page',
              FRAME: 'frame',
              SELECTION: 'selection',
              LINK: 'link',
              EDITABLE: 'editable',
              IMAGE: 'image',
              VIDEO: 'video',
              AUDIO: 'audio',
              LAUNCHER: 'launcher',
              BROWSER_ACTION: 'browser_action',
              PAGE_ACTION: 'page_action',
              ACTION: 'action',
              TAB: 'tab',
            },
            ItemType: {
              NORMAL: 'normal',
              CHECKBOX: 'checkbox',
              RADIO: 'radio',
              SEPARATOR: 'separator',
            },
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

      /*
        chrome.fontSettings. The font list and each family's font come from the main process, which
        reads what this Electron really has (see browser/api/font-settings.ts). Everything is
        `not_controllable`: Electron takes the default fonts and sizes from a WebContents'
        webPreferences when it is created and cannot change them for a running page, so a setter
        resolves and changes nothing, and no on*Changed fires — what Chrome answers when a policy holds
        the pref (measured in Chromium 147 on 30/10/2026: a set there would store the value per
        extension, report `controlled_by_this_extension` and fire the event, none of which would be
        true here). The sizes are Electron's defaults, which are Chrome's: 16, 13 and 0. Schema errors
        reject (or set lastError) with Chrome's own text instead of throwing.

        This was a local stub whose font list held three generic names that are not fonts
        ("sans-serif", "serif", "monospace"), which is all Dark Reader's font picker showed.
      */
      fontSettings: {
        factory: (base) => {
          const notControllable = 'not_controllable'
          const local =
            (
              method: string,
              required: Parameters<typeof electron.fontSettingsSchemaError>[2],
              answer: () => any,
            ) =>
            (...args: any[]) => {
              const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
              const error = electron.fontSettingsSchemaError(method, args[0], required)
              const result = error ? undefined : answer()
              if (callback) {
                queueMicrotask(() =>
                  error ? withLastError(error, () => callback()) : callback(result),
                )
                return
              }
              return error ? Promise.reject(new Error(error)) : Promise.resolve(result)
            }
          const size = (pixelSize: number) => () => ({
            levelOfControl: notControllable,
            pixelSize,
          })
          const enumOf = (values: string[]) =>
            Object.fromEntries(values.map((value) => [value.toUpperCase(), value]))
          const { genericFamilies, scriptCodes } = electron.fontSettingsEnums()
          return {
            ...base,
            GenericFamily: enumOf(genericFamilies),
            LevelOfControl: enumOf([
              'controllable_by_this_extension',
              'controlled_by_other_extensions',
              'controlled_by_this_extension',
              'not_controllable',
            ]),
            ScriptCode: enumOf(scriptCodes),
            getFontList: invokeExtension('fontSettings.getFontList'),
            getFont: invokeExtension('fontSettings.getFont'),
            getDefaultFontSize: local('getDefaultFontSize', {}, size(16)),
            getDefaultFixedFontSize: local('getDefaultFixedFontSize', {}, size(13)),
            getMinimumFontSize: local('getMinimumFontSize', {}, size(0)),
            setFont: local('setFont', { genericFamily: true, fontId: true }, () => undefined),
            setDefaultFontSize: local('setDefaultFontSize', { pixelSize: true }, () => undefined),
            setDefaultFixedFontSize: local(
              'setDefaultFixedFontSize',
              { pixelSize: true },
              () => undefined,
            ),
            setMinimumFontSize: local('setMinimumFontSize', { pixelSize: true }, () => undefined),
            clearFont: local('clearFont', { genericFamily: true }, () => undefined),
            clearDefaultFontSize: local('clearDefaultFontSize', {}, () => undefined),
            clearDefaultFixedFontSize: local('clearDefaultFixedFontSize', {}, () => undefined),
            clearMinimumFontSize: local('clearMinimumFontSize', {}, () => undefined),
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
          const unavailable = (...args: any[]) => {
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
            Scheme: {
              HTTP: 'http',
              HTTPS: 'https',
              QUIC: 'quic',
              SOCKS4: 'socks4',
              SOCKS5: 'socks5',
            },
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
            // Chrome's methods for other extensions and for apps. There are no apps here, so the
            // app ones fail as Chrome fails them for an extension (see ManagementAPI).
            uninstall: invokeExtension('management.uninstall'),
            launchApp: invokeExtension('management.launchApp'),
            setLaunchType: invokeExtension('management.setLaunchType'),
            createAppShortcut: invokeExtension('management.createAppShortcut'),
            generateAppForLink: invokeExtension('management.generateAppForLink'),
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
            // The permission is granted for as long as the extension is loaded, and there is no
            // notification settings page to show, so these two never fire.
            onPermissionLevelChanged: new ExtensionEvent('notifications.onPermissionLevelChanged'),
            onShowSettings: new ExtensionEvent('notifications.onShowSettings'),
            // Chrome's enums (Chromium 147), read at the top of a worker to build create() options.
            PermissionLevel: { GRANTED: 'granted', DENIED: 'denied' } as any,
            TemplateType: {
              BASIC: 'basic',
              IMAGE: 'image',
              LIST: 'list',
              PROGRESS: 'progress',
            } as any,
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
            /*
              Every setting Chrome 156 lists (read from Edge), not only the ones an extension was seen
              to read. A `.get` on a setting this object lacked threw "Cannot read properties of
              undefined" — the failure that kept NordPass from booting, one level down. Rambox's API
              probe found ten of them missing on 2026-10-29. Values describe Electron, not Chrome's defaults: no
              autofill, no password manager, no Safe Browsing, no omnibox suggestions or translation
              service; third-party cookies and referrers on; protected content on, since the app
              ships Widevine; Topics, FLEDGE and ad measurement off.
            */
            services: {
              alternateErrorPagesEnabled: new ChromeSetting(false),
              autofillAddressEnabled: new ChromeSetting(false),
              autofillCreditCardEnabled: new ChromeSetting(false),
              autofillEnabled: new ChromeSetting(false),
              autofillSettings: new ChromeSetting([]),
              passwordSavingEnabled: new ChromeSetting(false),
              safeBrowsingEnabled: new ChromeSetting(false),
              safeBrowsingExtendedReportingEnabled: new ChromeSetting(false),
              searchSuggestEnabled: new ChromeSetting(false),
              spellingServiceEnabled: new ChromeSetting(false),
              translationServiceEnabled: new ChromeSetting(false),
            },
            websites: {
              adMeasurementEnabled: new ChromeSetting(false),
              doNotTrackEnabled: new ChromeSetting(false),
              fledgeEnabled: new ChromeSetting(false),
              hyperlinkAuditingEnabled: new ChromeSetting(false),
              protectedContentEnabled: new ChromeSetting(true),
              referrersEnabled: new ChromeSetting(true),
              thirdPartyCookiesAllowed: new ChromeSetting(true),
              topicsEnabled: new ChromeSetting(false),
            },
            ...({
              IPHandlingPolicy: {
                DEFAULT: 'default',
                DEFAULT_PUBLIC_AND_PRIVATE_INTERFACES: 'default_public_and_private_interfaces',
                DEFAULT_PUBLIC_INTERFACE_ONLY: 'default_public_interface_only',
                DISABLE_NON_PROXIED_UDP: 'disable_non_proxied_udp',
              },
              AutofillBlockedType: {
                ALL: 'all',
                CONTACT_INFO: 'contact_info',
                IDENTITY_DOCS: 'identity_docs',
                PAYMENTS: 'payments',
                TRAVEL: 'travel',
              },
            } as any),
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
                Electron's answer has `arch` and `os` and not `nacl_arch` (measured on 44.9.3: two
                fields, Chromium 147 and Edge 156 three). Chrome still reports it — the architecture
                Native Client would use, which has no arm64 (PlatformNaclArch stops at 'arm') — so
                the native answer gets it here and keeps everything else.
              */
              ...(typeof (base as any)?.getPlatformInfo === 'function'
                ? {
                    getPlatformInfo: (callback?: (info: any) => void) => {
                      const withNaclArch = (info: any) =>
                        info && typeof info === 'object' && !info.nacl_arch
                          ? { ...info, nacl_arch: info.arch === 'arm64' ? 'arm' : info.arch }
                          : info
                      const promise = Promise.resolve(
                        (base as any).getPlatformInfo.call(base),
                      ).then(withNaclArch)
                      if (typeof callback !== 'function') return promise
                      promise.then(
                        (info) => callback(info),
                        (error) => withLastError(errorMessage(error), () => (callback as any)()),
                      )
                    },
                  }
                : {}),
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

      /*
        The side panel's state, open/close and events live in the main process (api/side-panel.ts);
        the embedder shows the panel. Every method answers in both shapes, a promise and a callback
        with lastError, as Chrome's do.
      */
      sidePanel: {
        shouldInject: () => manifest.manifest_version === 3,
        factory: (base) => {
          return {
            ...base,
            Side: { LEFT: 'left', RIGHT: 'right' },
            getOptions: invokeExtension('sidePanel.getOptions'),
            setOptions: invokeExtension('sidePanel.setOptions'),
            getPanelBehavior: invokeExtension('sidePanel.getPanelBehavior'),
            setPanelBehavior: invokeExtension('sidePanel.setPanelBehavior'),
            getLayout: invokeExtension('sidePanel.getLayout'),
            open: invokeExtension('sidePanel.open'),
            close: invokeExtension('sidePanel.close'),
            onOpened: new ExtensionEvent('sidePanel.onOpened'),
            onClosed: new ExtensionEvent('sidePanel.onClosed'),
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
          /*
            `storage.onChanged` for the service worker, on an Electron that does not deliver it there
            (43 and 44 below 44.10, measured; see workerStorageEventsAreNative in the isolated world).

            Chrome tells every context of an extension about every change to its storage, the
            worker included, and extensions rely on that to keep the worker in step with what the
            popup or the options page changed: Google Translate's worker keeps the target language
            in memory and only learns a new one from this event; SafeInCloud's worker keeps a cache
            of the whole local area fed by it, and clears the current account when the popup logs
            out; RoboForm re-reads its options, HubSpot reinitialises on a portal change. Without
            it, a setting changed in the popup does not reach the worker until the worker restarts.

            So every extension context that can write (pages, popups, offscreen documents and the
            worker itself; not content scripts, whose world the preload cannot reach) reports each
            write it made to the main process, as Chrome would report it: the keys whose value
            actually changed, with `oldValue` and `newValue` read before and after the write. The
            main process re-emits it to the worker only (src/browser/api/storage.ts). Pages are left
            alone: they already get the native event.

            A patch with an end date. It turns itself off on a binary that delivers natively (the
            gate), and in the worker the first native delivery switches the relay off for the rest
            of the worker's life, so a binary the gate misjudges duplicates one change at most.
          */
          // Only with a native area to wrap: a context without the `storage` permission has none, and
          // reading `.onChanged` off it would fail the whole namespace.
          const relayEnabled =
            !!local &&
            !!electron.storageChangeRelay &&
            !!extensionId &&
            manifest.manifest_version === 3 &&
            !!(manifest as any).background?.service_worker
          const inWorker =
            typeof (globalThis as any).ServiceWorkerGlobalScope !== 'undefined' &&
            globalThis instanceof (globalThis as any).ServiceWorkerGlobalScope

          const AREA_METHODS = [
            'get',
            'getBytesInUse',
            'getKeys',
            'set',
            'remove',
            'clear',
            'setAccessLevel',
          ]
          const AREA_CONSTANTS = [
            'QUOTA_BYTES',
            'QUOTA_BYTES_PER_ITEM',
            'MAX_ITEMS',
            'MAX_WRITE_OPERATIONS_PER_HOUR',
            'MAX_WRITE_OPERATIONS_PER_MINUTE',
            'MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE',
          ]
          // A plain copy of a native area: own members, plus the methods and constants that live on
          // its prototype (Object.keys does not list them), bound to the native area.
          const copyArea = (area: any) => {
            const copy: any = {}
            for (const key of Object.keys(area)) {
              const member = area[key]
              copy[key] = typeof member === 'function' ? member.bind(area) : member
            }
            for (const name of AREA_METHODS) {
              const member = area[name]
              if (typeof member === 'function' && !copy[name]) copy[name] = member.bind(area)
            }
            for (const name of AREA_CONSTANTS) {
              if (copy[name] === undefined && area[name] !== undefined) copy[name] = area[name]
            }
            if (!copy.onChanged && area.onChanged) copy.onChanged = area.onChanged
            return copy
          }

          // Chrome compares stored values, not identities: a set that writes what is already there
          // reports nothing. Key order does not make two objects different.
          const stableJson = (value: unknown): string =>
            JSON.stringify(value, (_key, inner) =>
              inner && typeof inner === 'object' && !Array.isArray(inner)
                ? Object.keys(inner)
                    .sort()
                    .reduce((sorted: any, key) => ((sorted[key] = inner[key]), sorted), {})
                : inner,
            )
          const diff = (keys: string[], before: any, after: any) => {
            const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {}
            for (const key of keys) {
              const had = Object.prototype.hasOwnProperty.call(before, key)
              const has = Object.prototype.hasOwnProperty.call(after, key)
              if (!had && !has) continue
              if (had && has && stableJson(before[key]) === stableJson(after[key])) continue
              const change: { oldValue?: unknown; newValue?: unknown } = {}
              if (had) change.oldValue = before[key]
              if (has) change.newValue = after[key]
              changes[key] = change
            }
            return changes
          }

          // One write at a time per context, so the value read before a write is the one the
          // previous write left, not one it is about to replace.
          let writeQueue: Promise<unknown> = Promise.resolve()
          const reportingArea = (native: any, areaName: 'local' | 'session') => {
            const area = copyArea(native)
            const write =
              (method: 'set' | 'remove' | 'clear', keysOf: (args: any[]) => string[] | null) =>
              (...args: any[]) => {
                const callback =
                  typeof args[args.length - 1] === 'function' ? args.pop() : undefined
                // A call the schema refuses goes straight to the native method, which throws it
                // synchronously with Chrome's message, as it did before this wrapper.
                const malformed =
                  (method === 'set' &&
                    (!args[0] || typeof args[0] !== 'object' || Array.isArray(args[0]))) ||
                  (method === 'remove' && typeof args[0] !== 'string' && !Array.isArray(args[0]))
                if (malformed) return native[method](...args, ...(callback ? [callback] : []))
                const run = async () => {
                  const keys = keysOf(args)
                  const before = await native.get(keys)
                  await native[method](...args)
                  const after = method === 'clear' ? {} : await native.get(keys)
                  const changes = diff(keys ?? Object.keys(before || {}), before || {}, after || {})
                  if (Object.keys(changes).length > 0) {
                    electron.reportStorageChanges(extensionId, areaName, changes)
                  }
                }
                const promise = writeQueue.then(run, run)
                writeQueue = promise.catch(() => {})
                if (!callback) return promise
                promise.then(
                  () => callback(),
                  (error) => withLastError(errorMessage(error), () => callback()),
                )
              }
            area.set = write('set', (args) =>
              args[0] && typeof args[0] === 'object' ? Object.keys(args[0]) : [],
            )
            area.remove = write('remove', (args) =>
              Array.isArray(args[0]) ? args[0].map(String) : [String(args[0])],
            )
            area.clear = write('clear', () => null)
            return area
          }

          /*
            The worker's events: one listener set per event, fed by the native event (if it ever
            fires) and by the relay. The relay listener is registered with the main process on the
            first addListener, as Chrome only wakes a worker for an event it listens to.
          */
          const workerEvents = (() => {
            if (!relayEnabled || !inWorker) return undefined
            let nativeDelivers = false
            let relayRegistered = false
            const sets = {
              any: new Set<Function>(),
              local: new Set<Function>(),
              session: new Set<Function>(),
            }
            const clone = (value: unknown) => JSON.parse(JSON.stringify(value))
            const dispatch = (changes: object, areaName: string) => {
              for (const listener of Array.from(sets.any)) {
                try {
                  listener(clone(changes), areaName)
                } catch (error) {
                  console.error(error)
                }
              }
              const perArea = (sets as any)[areaName] as Set<Function> | undefined
              for (const listener of Array.from(perArea || [])) {
                try {
                  listener(clone(changes))
                } catch (error) {
                  console.error(error)
                }
              }
            }
            const onRelayed = (changes: object, areaName: string) => {
              if (nativeDelivers) return
              dispatch(changes, areaName)
            }
            const makeEvent = (which: 'any' | 'local' | 'session', nativeEvent: any) => {
              let nativeHooked = false
              return {
                addListener(listener: Function) {
                  if (typeof listener !== 'function') return
                  sets[which].add(listener)
                  if (!nativeHooked && nativeEvent?.addListener) {
                    nativeHooked = true
                    // A binary that does deliver here: from now on it is the only source.
                    nativeEvent.addListener((...args: any[]) => {
                      nativeDelivers = true
                      for (const own of Array.from(sets[which])) {
                        try {
                          own(...args)
                        } catch (error) {
                          console.error(error)
                        }
                      }
                    })
                  }
                  if (!relayRegistered) {
                    relayRegistered = true
                    electron.addExtensionListener(extensionId, 'storage.onChanged', onRelayed)
                  }
                },
                removeListener(listener: Function) {
                  sets[which].delete(listener)
                },
                hasListener(listener: Function) {
                  return sets[which].has(listener)
                },
                hasListeners() {
                  return sets[which].size > 0
                },
              }
            }
            return { makeEvent }
          })()

          const localArea = local && relayEnabled ? reportingArea(local, 'local') : local
          const sessionArea =
            base && base.session && relayEnabled
              ? reportingArea(base.session, 'session')
              : base && base.session
          if (workerEvents) {
            if (localArea)
              localArea.onChanged = workerEvents.makeEvent('local', (local as any).onChanged)
            if (sessionArea)
              sessionArea.onChanged = workerEvents.makeEvent(
                'session',
                (base as any).session.onChanged,
              )
          }

          const sync: any = {}
          if (localArea) {
            for (const key of Object.keys(localArea)) {
              const member = (localArea as any)[key]
              sync[key] = typeof member === 'function' ? member.bind(localArea) : member
            }
            // Members that live on the prototype of the native area, which Object.keys does not list.
            for (const name of AREA_METHODS) {
              const member = (localArea as any)[name]
              if (typeof member === 'function' && !sync[name]) sync[name] = member.bind(localArea)
            }
            if (!sync.onChanged && (localArea as any).onChanged)
              sync.onChanged = (localArea as any).onChanged
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
            ...(localArea ? { local: localArea } : {}),
            ...(sessionArea ? { session: sessionArea } : {}),
            ...(workerEvents
              ? { onChanged: workerEvents.makeEvent('any', (base as any).onChanged) }
              : {}),
            managed,
            sync,
          }
        },
      },

      tabs: {
        factory: (base) => {
          /*
            Zoom. Electron implements the four methods natively, and they mostly answer as Chrome's
            do (measured on 44.9.3 against Chromium 147: the factor, the settings, the manual-mode
            refusal). What they get wrong is wrapped here, and nothing else:
            - with no tab id they fail ("No such tab") where Chrome uses the active tab;
            - an unknown tab reads "No such tab", not Chrome's "No tab with id: N.";
            - `setZoom(tab, 0)` set the factor to 0.25 — Chrome resets to the default;
            - `setZoom` succeeded in "disabled" mode, which Chrome refuses;
            - tabs.onZoomChange never fired, where Chrome fires it after every successful setZoom
              and setZoomSettings. The main process does that now (tabs.reportZoomChange), reading
              the new factor from the tab itself.
            Without the native methods (another Electron), the main process answers getZoom and
            setZoom on its own, and the settings stay Chrome's defaults.
          */
          const nativeMethod = (name: string) => {
            const fn = (base as any)?.[name]
            return typeof fn === 'function'
              ? (...args: any[]): Promise<any> => fn.apply(base, args)
              : undefined
          }
          const nativeGetZoom = nativeMethod('getZoom')
          const nativeSetZoom = nativeMethod('setZoom')
          const nativeGetZoomSettings = nativeMethod('getZoomSettings')
          const nativeSetZoomSettings = nativeMethod('setZoomSettings')
          const DEFAULT_ZOOM_SETTINGS = {
            defaultZoomFactor: 1,
            mode: 'automatic',
            scope: 'per-origin',
          }
          const answerAsync =
            (run: (...args: any[]) => Promise<any>) =>
            (...args: any[]) => {
              const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
              const promise = run(...args)
              if (!callback) return promise
              promise.then(
                (value) => callback(value),
                (error) => withLastError(errorMessage(error), () => callback()),
              )
            }
          const tabIdOrActive = async (tabId: unknown): Promise<number | undefined> => {
            if (typeof tabId === 'number') return tabId
            const [tab] = await (invokeExtension('tabs.query')({
              active: true,
              currentWindow: true,
            }) as Promise<any[]>)
            return tab?.id
          }
          const inChromeWords = (tabId: unknown) => (error: unknown) => {
            const message = errorMessage(error)
            throw new Error(message === 'No such tab' ? `No tab with id: ${tabId}.` : message)
          }
          const zoomSettingsOf = async (tabId: number | undefined) => {
            if (!nativeGetZoomSettings) {
              await invokeExtension('tabs.getZoom')(tabId)
              return { ...DEFAULT_ZOOM_SETTINGS }
            }
            return nativeGetZoomSettings(tabId).catch(inChromeWords(tabId))
          }
          // The optional leading tab id, as Chrome's signatures put it: (tabId?, value).
          const leadingTabId = (args: any[]) => (args.length >= 2 ? args : [undefined, args[0]])
          const zoom = {
            getZoom: answerAsync(async (tabId?: number) => {
              const id = await tabIdOrActive(tabId)
              if (!nativeGetZoom) return invokeExtension('tabs.getZoom')(id)
              return nativeGetZoom(id).catch(inChromeWords(id))
            }),
            setZoom: answerAsync(async (...args: any[]) => {
              const [tabId, zoomFactor] = leadingTabId(args)
              const id = await tabIdOrActive(tabId)
              if (!nativeSetZoom) return invokeExtension('tabs.setZoom')(id, zoomFactor)
              const settings = await zoomSettingsOf(id)
              if (settings.mode === 'disabled') {
                throw new Error('Cannot zoom a tab in disabled mode.')
              }
              const factor = zoomFactor === 0 ? settings.defaultZoomFactor || 1 : zoomFactor
              await nativeSetZoom(id, factor).catch(inChromeWords(id))
              await invokeExtension('tabs.reportZoomChange')(
                id,
                { mode: settings.mode, scope: settings.scope },
                factor,
              )
            }),
            getZoomSettings: answerAsync(async (tabId?: number) =>
              zoomSettingsOf(await tabIdOrActive(tabId)),
            ),
            setZoomSettings: answerAsync(async (...args: any[]) => {
              const [tabId, zoomSettings] = leadingTabId(args)
              const id = await tabIdOrActive(tabId)
              if (!nativeSetZoomSettings) {
                const asked = zoomSettings || {}
                if (
                  (asked.mode && asked.mode !== 'automatic') ||
                  (asked.scope && asked.scope !== 'per-origin')
                ) {
                  throw new Error('Zoom settings cannot be changed here.')
                }
                return
              }
              await nativeSetZoomSettings(id, zoomSettings).catch(inChromeWords(id))
              const now = await zoomSettingsOf(id)
              await invokeExtension('tabs.reportZoomChange')(id, {
                mode: now.mode,
                scope: now.scope,
              })
            }),
          }

          const api = {
            ...base,
            ...zoom,
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
            // A new position in the tab's own window, with onMoved (see TabsAPI.move).
            move: invokeExtension('tabs.move'),
            // Through the embedder's discardTab hook, or failing as Chrome does without one.
            discard: invokeExtension('tabs.discard'),
            // No tab groups here: group fails as Chrome does in a window that cannot group, and
            // ungroup resolves, as it does for a tab that is in no group.
            group: invokeExtension('tabs.group'),
            ungroup: invokeExtension('tabs.ungroup'),
            onCreated: new ExtensionEvent('tabs.onCreated'),
            onRemoved: new ExtensionEvent('tabs.onRemoved'),
            onUpdated: new ExtensionEvent('tabs.onUpdated'),
            onActivated: new ExtensionEvent('tabs.onActivated'),
            onReplaced: new ExtensionEvent('tabs.onReplaced'),
            /*
              The rest of chrome.tabs' events. An extension registers these at the top of its worker
              as a matter of course (a tab manager listens to all of them), and a namespace missing
              one threw there and took the worker's registration with it. onHighlighted follows every
              activation, onZoomChange the user's zoom and every setZoom/setZoomSettings, onMoved
              every tabs.move that changes an index. onDetached and onAttached describe a tab
              changing windows, which the embedder's tabs never do, so they never fire — which is
              the truth of the model, not a stub.
            */
            onHighlighted: new ExtensionEvent('tabs.onHighlighted'),
            onZoomChange: new ExtensionEvent('tabs.onZoomChange'),
            onMoved: new ExtensionEvent('tabs.onMoved'),
            onDetached: new ExtensionEvent('tabs.onDetached'),
            onAttached: new ExtensionEvent('tabs.onAttached'),
            /*
              Constants Chrome defines and Electron's native namespace does not (measured on 44.9.3
              with no library loaded: `TAB_ID_NONE` and friends read undefined). They are read at the
              top of a worker, where `undefined` turns a comparison into a silent wrong branch — or
              a crash, when it is used as a key. Native enums win when Electron has them.
            */
            ...({
              TAB_ID_NONE: -1,
              TAB_INDEX_NONE: -1,
              SPLIT_VIEW_ID_NONE: -1,
              MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND: 2,
              MutedInfoReason: (base as any)?.MutedInfoReason ?? {
                USER: 'user',
                CAPTURE: 'capture',
                EXTENSION: 'extension',
              },
              TabStatus: (base as any)?.TabStatus ?? {
                UNLOADED: 'unloaded',
                LOADING: 'loading',
                COMPLETE: 'complete',
              },
              WindowType: (base as any)?.WindowType ?? WINDOW_TYPE,
              ZoomSettingsMode: (base as any)?.ZoomSettingsMode ?? {
                AUTOMATIC: 'automatic',
                MANUAL: 'manual',
                DISABLED: 'disabled',
              },
              ZoomSettingsScope: (base as any)?.ZoomSettingsScope ?? {
                PER_ORIGIN: 'per-origin',
                PER_TAB: 'per-tab',
              },
            } as any),
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
            // Chrome's enums, which this namespace did not carry (Electron has no chrome.windows):
            // `chrome.windows.CreateType.POPUP` read at worker top level threw on undefined.
            WindowType: WINDOW_TYPE,
            WindowState: {
              NORMAL: 'normal',
              MINIMIZED: 'minimized',
              MAXIMIZED: 'maximized',
              FULLSCREEN: 'fullscreen',
              LOCKED_FULLSCREEN: 'locked-fullscreen',
            },
            CreateType: { NORMAL: 'normal', POPUP: 'popup', PANEL: 'panel' },
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

    /*
      The anti-crash floor: every public namespace of desktop Chrome that Electron does not provide
      exists here, when — and only when — the manifest asks for it, as in Chrome.

      The failure this prevents was measured three times in Rambox's catalog (NordPass on
      `chrome.privacy`, Endpoint Verification on `chrome.gcm`, LastPass on `chrome.windows`): an
      access at service-worker top level to something undefined kills the extension whole, with
      nothing in any console. A namespace that answers "nothing" — or fails a call the way Chrome
      fails one, with lastError or a rejection — is always better than its absence.

      Most of these are honest stubs because the host has no such thing (no bookmarks, history,
      sessions, tab groups, reading list, omnibox, voices or debugger). The rest are real and
      backed by the main process: browsingData, system.storage, system.display, pageCapture and the
      local half of instanceID. Surfaces and error strings were read from Edge 156.

      Measured and left alone, because Electron 44.9.3 provides them natively and they answer:
      `power`, `system.cpu`, `system.memory`, `printerProvider`. Left absent on purpose:
      `userScripts` (Chrome hides it too until the user allows it), `dom`, `processes`, `dns`
      and `enterprise.*`.
    */
    const declaredPermissions = new Set<string>(
      ((manifest.permissions as string[] | undefined) ?? []).map(String),
    )
    const declares = (...permissions: string[]) =>
      permissions.some((permission) => declaredPermissions.has(permission))

    /**
     * A method that answers the way Chrome's do: the callback with the value, or a promise of it;
     * when `compute` throws, `chrome.runtime.lastError` for the callback, a rejection otherwise.
     */
    const answering =
      (compute: (...args: any[]) => unknown) =>
      (...args: any[]) => {
        const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
        let value: unknown
        try {
          value = compute(...args)
        } catch (error) {
          const text = errorMessage(error)
          if (callback) {
            queueMicrotask(() => withLastError(text, () => callback()))
            return
          }
          return Promise.reject(new Error(text))
        }
        if (callback) {
          queueMicrotask(() => callback(value))
          return
        }
        return Promise.resolve(value)
      }
    const failWith = (message: string | ((...args: any[]) => string)) =>
      answering((...args: any[]) => {
        throw new Error(typeof message === 'function' ? message(...args) : message)
      })
    /** Methods Chrome declares as returning nothing, synchronously. */
    const noop = () => undefined
    /** Events nothing in this host raises: the whole shape, never called. */
    const inert = () => new Event()
    const enumOf = (...values: string[]) =>
      Object.fromEntries(
        values.map((value) => [value.toUpperCase().replace(/[-.]/g, '_'), value]),
      ) as Record<string, string>
    const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))

    /** `chrome.contentSettings.<x>`: reads Chrome's default, refuses to change what it cannot. */
    class ContentSetting {
      private readonly setting!: () => string
      constructor(setting: string) {
        Object.defineProperty(this, 'setting', { value: () => setting, enumerable: false })
      }
      get = answering(() => ({ setting: this.setting() }))
      // The host owns these permissions (Rambox asks the user per service), so a write that would
      // change nothing fails instead of reporting success.
      set = failWith('Content settings are controlled by the application.')
      clear = failWith('Content settings are controlled by the application.')
      getResourceIdentifiers = answering(() => undefined)
    }

    const floorDefinitions: Record<
      string,
      { shouldInject?: () => boolean; factory: (base: any) => any }
    > = {
      declarativeContent: {
        shouldInject: () => declares('declarativeContent'),
        factory: () => {
          // Rule constructors. `new PageStateMatcher(opts)` serialises to opts plus `instanceType`,
          // as Chrome's do; a call without `new` throws, as Chrome's does.
          const declarative = (instanceType: string) => {
            const Ctor: any = function (this: any, options?: Record<string, unknown>) {
              if (!(this instanceof Ctor)) {
                throw new TypeError(`${instanceType} must be called with new`)
              }
              Object.assign(this, options)
              this.instanceType = instanceType
            }
            // Named as Chrome's are: `PageStateMatcher.name === 'PageStateMatcher'`.
            Object.defineProperty(Ctor, 'name', { value: instanceType.split('.')[1] })
            return Ctor
          }
          /*
            The rules are kept and answered back, not evaluated: no extension in the catalog was seen
            to depend on a page action appearing (Everhour declares the permission). Kept per
            context — a rule added by the worker is the worker's — which is enough for the
            add-then-read pattern; evaluating them on navigation is stage 2 if someone needs it.
          */
          let rules: any[] = []
          let nextRuleId = 0
          const ruleCallback = (args: any[]) =>
            typeof args[args.length - 1] === 'function' ? args.pop() : undefined
          const onPageChanged: any = inert()
          onPageChanged.addRules = (...args: any[]) => {
            const callback = ruleCallback(args)
            const added = clone(args[0] || []).map((rule: any) => ({
              ...rule,
              id: rule.id ?? `_${nextRuleId++}_`,
              priority: rule.priority ?? 100,
            }))
            const duplicate = added.find((rule: any) => rules.some((r) => r.id === rule.id))
            if (duplicate) {
              if (callback) {
                queueMicrotask(() =>
                  withLastError(`Duplicate rule ID: ${duplicate.id}`, () => callback()),
                )
              }
              return
            }
            rules = rules.concat(added)
            if (callback) queueMicrotask(() => callback(clone(added)))
          }
          onPageChanged.getRules = (...args: any[]) => {
            const callback = ruleCallback(args)
            const ids: string[] | undefined = args[0]
            const found = ids ? rules.filter((rule) => ids.includes(rule.id)) : rules
            if (callback) queueMicrotask(() => callback(clone(found)))
          }
          onPageChanged.removeRules = (...args: any[]) => {
            const callback = ruleCallback(args)
            const ids: string[] | undefined = args[0]
            rules = ids ? rules.filter((rule) => !ids.includes(rule.id)) : []
            if (callback) queueMicrotask(() => callback())
          }
          const types = {
            PageStateMatcher: 'declarativeContent.PageStateMatcher',
            ShowAction: 'declarativeContent.ShowAction',
            ShowPageAction: 'declarativeContent.ShowPageAction',
            SetIcon: 'declarativeContent.SetIcon',
            RequestContentScript: 'declarativeContent.RequestContentScript',
          }
          const api: Record<string, unknown> = { onPageChanged }
          for (const [name, instanceType] of Object.entries(types)) {
            api[name] = declarative(instanceType)
            // 'declarativeContent.PageStateMatcher' → 'DECLARATIVE_CONTENT.PAGE_STATE_MATCHER'
            const enumKey = instanceType.replace(/([a-z])([A-Z])/g, '$1_$2').toUpperCase()
            api[`${name}InstanceType`] = { [enumKey]: instanceType }
          }
          return api
        },
      },

      browsingData: {
        shouldInject: () => declares('browsingData'),
        factory: () => {
          const DATA_TYPES = [
            'appcache',
            'cache',
            'cacheStorage',
            'cookies',
            'downloads',
            'fileSystems',
            'formData',
            'history',
            'indexedDB',
            'localStorage',
            'passwords',
            'pluginData',
            'serviceWorkers',
            'webSQL',
          ]
          const remove = invokeExtension('browsingData.remove')
          // removeCookies(options, callback?) is remove(options, { cookies: true }, callback?).
          const removeOne =
            (type: string) =>
            (...args: any[]) => {
              const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
              const forward = [args[0] || {}, { [type]: true }]
              return callback ? remove(...forward, callback) : remove(...forward)
            }
          const capitalised = (type: string) => type[0].toUpperCase() + type.slice(1)
          const api: Record<string, unknown> = {
            remove: (...args: any[]) => {
              const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
              const forward = [args[0] || {}, args[1] || {}]
              return callback ? remove(...forward, callback) : remove(...forward)
            },
            settings: answering(() => ({
              options: {
                since: 0,
                originTypes: { unprotectedWeb: true, protectedWeb: false, extension: false },
              },
              dataToRemove: Object.fromEntries(DATA_TYPES.map((type) => [type, false])),
              dataRemovalPermitted: Object.fromEntries(DATA_TYPES.map((type) => [type, true])),
            })),
          }
          for (const type of DATA_TYPES) {
            api[`remove${type === 'webSQL' ? 'WebSQL' : capitalised(type)}`] = removeOne(type)
          }
          return api
        },
      },

      system: {
        shouldInject: () =>
          declares('system.cpu', 'system.memory', 'system.storage', 'system.display'),
        factory: (base) => {
          const api: Record<string, unknown> = {}
          // cpu and memory are Electron's own and answer like Chrome's; kept as they are.
          for (const name of ['cpu', 'memory']) {
            try {
              if (declares(`system.${name}`) && base?.[name]) api[name] = base[name]
            } catch {
              // a lazy binding that fails to load leaves the member out, nothing more
            }
          }
          /*
            storage: Electron's native `getInfo()` takes the whole process down (0xC0000005, measured
            on 43.0.0 and 44.9.3+wvcus with no library loaded), so it is answered from the main
            process instead. Without this, one extension declaring `system.storage` could crash the
            host app with a single call.
          */
          if (declares('system.storage')) {
            api.storage = {
              getInfo: invokeExtension('system.storage.getInfo'),
              getAvailableCapacity: invokeExtension('system.storage.getAvailableCapacity'),
              ejectDevice: invokeExtension('system.storage.ejectDevice'),
              onAttached: inert(),
              onDetached: inert(),
              EjectDeviceResultCode: enumOf('success', 'in_use', 'no_such_device', 'failure'),
              StorageUnitType: enumOf('fixed', 'removable', 'unknown'),
            }
          }
          /*
            display: Electron's native methods all fail with "System display API is not available."
            The read half is answered from `screen`; the rest is what Chrome itself answers on
            desktop, where those methods exist only for ChromeOS.
          */
          if (declares('system.display')) {
            const chromeOSOnly = failWith('Function available only on ChromeOS.')
            api.display = {
              getInfo: invokeExtension('system.display.getInfo'),
              getDisplayLayout: chromeOSOnly,
              setDisplayProperties: chromeOSOnly,
              setDisplayLayout: chromeOSOnly,
              enableUnifiedDesktop: noop,
              overscanCalibrationStart: noop,
              overscanCalibrationAdjust: noop,
              overscanCalibrationReset: noop,
              overscanCalibrationComplete: noop,
              showNativeTouchCalibration: chromeOSOnly,
              startCustomTouchCalibration: noop,
              completeCustomTouchCalibration: noop,
              clearTouchCalibration: noop,
              setMirrorMode: chromeOSOnly,
              onDisplayChanged: new ExtensionEvent('system.display.onDisplayChanged'),
              ActiveState: enumOf('active', 'inactive'),
              LayoutPosition: enumOf('top', 'right', 'bottom', 'left'),
              MirrorMode: enumOf('off', 'normal', 'mixed'),
            }
          }
          return api
        },
      },

      contentSettings: {
        shouldInject: () => declares('contentSettings'),
        factory: () => {
          // Chrome's defaults, as Edge 156 answers them for a fresh profile.
          const defaults: Record<string, string> = {
            autoVerify: 'allow',
            automaticDownloads: 'ask',
            camera: 'ask',
            clipboard: 'ask',
            cookies: 'allow',
            fullscreen: 'allow',
            images: 'allow',
            javascript: 'allow',
            location: 'ask',
            microphone: 'ask',
            mouselock: 'allow',
            notifications: 'ask',
            plugins: 'block',
            popups: 'block',
            sound: 'allow',
            unsandboxedPlugins: 'block',
          }
          const api: Record<string, unknown> = {
            Scope: enumOf('regular', 'incognito_session_only'),
            AutoVerifyContentSetting: enumOf('allow', 'block'),
            CameraContentSetting: enumOf('allow', 'block', 'ask'),
            ClipboardContentSetting: enumOf('allow', 'block', 'ask'),
            CookiesContentSetting: enumOf('allow', 'block', 'session_only'),
            FullscreenContentSetting: enumOf('allow'),
            ImagesContentSetting: enumOf('allow', 'block'),
            JavascriptContentSetting: enumOf('allow', 'block'),
            LocationContentSetting: enumOf('allow', 'block', 'ask'),
            MicrophoneContentSetting: enumOf('allow', 'block', 'ask'),
            MouselockContentSetting: enumOf('allow'),
            MultipleAutomaticDownloadsContentSetting: enumOf('allow', 'block', 'ask'),
            NotificationsContentSetting: enumOf('allow', 'block', 'ask'),
            PluginsContentSetting: enumOf('block'),
            PopupsContentSetting: enumOf('allow', 'block'),
            PpapiBrokerContentSetting: enumOf('block'),
            SoundContentSetting: enumOf('allow', 'block'),
          }
          for (const [name, setting] of Object.entries(defaults)) {
            api[name] = new ContentSetting(setting)
          }
          return api
        },
      },

      // Desktop Chrome exposes one setting here (Edge 156: animationPolicy); the rest is ChromeOS.
      accessibilityFeatures: {
        shouldInject: () => declares('accessibilityFeatures.read', 'accessibilityFeatures.modify'),
        factory: () => ({ animationPolicy: new ChromeSetting('allowed') }),
      },

      bookmarks: {
        shouldInject: () => declares('bookmarks'),
        factory: () => {
          // The two folders every Chrome profile has, both empty: Rambox keeps no bookmarks.
          const created = Date.now()
          const folder = (id: string, title: string, index: number, folderType: string) => ({
            id,
            parentId: '0',
            index,
            title,
            dateAdded: created,
            folderType,
            syncing: false,
            children: [] as any[],
          })
          const tree = () => [
            {
              id: '0',
              title: '',
              dateAdded: created,
              syncing: false,
              children: [
                folder('1', 'Bookmarks bar', 0, 'bookmarks-bar'),
                folder('2', 'Other bookmarks', 1, 'other'),
              ],
            },
          ]
          const find = (id: unknown) => {
            const [root] = tree()
            const node = [root, ...root.children].find((n) => n.id === String(id))
            if (!node) throw new Error("Can't find bookmark for id.")
            return node
          }
          const withoutChildren = ({ children, ...node }: any) => node
          const notAvailable = failWith('Bookmarks are not available.')
          return {
            getTree: answering(tree),
            getSubTree: answering((id) => [find(id)]),
            getChildren: answering((id) => find(id).children.map(withoutChildren)),
            get: answering((idOrIds) =>
              (Array.isArray(idOrIds) ? idOrIds : [idOrIds]).map((id) => withoutChildren(find(id))),
            ),
            getRecent: answering(() => []),
            search: answering(() => []),
            create: notAvailable,
            move: notAvailable,
            update: notAvailable,
            remove: notAvailable,
            removeTree: notAvailable,
            onCreated: inert(),
            onRemoved: inert(),
            onChanged: inert(),
            onMoved: inert(),
            onChildrenReordered: inert(),
            onImportBegan: inert(),
            onImportEnded: inert(),
            MAX_WRITE_OPERATIONS_PER_HOUR: 1000000,
            MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE: 1000000,
            ROOT_NODE_ID: '0',
            BookmarkTreeNodeUnmodifiable: { MANAGED: 'managed' },
            FolderType: enumOf('bookmarks-bar', 'other', 'mobile', 'managed'),
          }
        },
      },

      // No history is kept here, which `topSites` already answers the same way.
      history: {
        shouldInject: () => declares('history'),
        factory: () => ({
          search: answering(() => []),
          getVisits: answering(() => []),
          addUrl: answering(() => undefined),
          deleteUrl: answering(() => undefined),
          deleteRange: answering(() => undefined),
          deleteAll: answering(() => undefined),
          onVisited: inert(),
          onVisitRemoved: inert(),
          TransitionType: enumOf(
            'link',
            'typed',
            'auto_bookmark',
            'auto_subframe',
            'manual_subframe',
            'generated',
            'auto_toplevel',
            'form_submit',
            'reload',
            'keyword',
            'keyword_generated',
          ),
        }),
      },

      sessions: {
        shouldInject: () => declares('sessions'),
        factory: () => ({
          getRecentlyClosed: answering(() => []),
          getDevices: answering(() => []),
          restore: failWith((sessionId?: string) =>
            sessionId === undefined
              ? 'There are no recently closed sessions.'
              : `Invalid session id: "${sessionId}".`,
          ),
          onChanged: inert(),
          MAX_SESSION_RESULTS: 25,
        }),
      },

      // The embedder's tabs are never grouped: every query is empty, every id unknown.
      tabGroups: {
        shouldInject: () => declares('tabGroups'),
        factory: () => {
          const noGroup = failWith((groupId: unknown) => `No group with id: ${groupId}.`)
          return {
            query: answering(() => []),
            get: noGroup,
            update: noGroup,
            move: noGroup,
            onCreated: inert(),
            onMoved: inert(),
            onRemoved: inert(),
            onUpdated: inert(),
            TAB_GROUP_ID_NONE: -1,
            Color: enumOf(
              'grey',
              'blue',
              'red',
              'yellow',
              'green',
              'pink',
              'purple',
              'cyan',
              'orange',
            ),
          }
        },
      },

      readingList: {
        shouldInject: () => declares('readingList'),
        factory: () => ({
          query: answering(() => []),
          addEntry: failWith('Reading list is not available.'),
          removeEntry: failWith('URL not found.'),
          updateEntry: failWith('URL not found.'),
          onEntryAdded: inert(),
          onEntryRemoved: inert(),
          onEntryUpdated: inert(),
        }),
      },

      tts: {
        shouldInject: () => declares('tts'),
        factory: () => ({
          getVoices: answering(() => []),
          isSpeaking: answering(() => false),
          // There is no voice to speak with. The utterance's own onEvent learns it the way Chrome
          // tells it about a failed utterance; the call itself succeeds, as Chrome's does.
          speak: answering((_utterance: unknown, options?: { onEvent?: Function }) => {
            if (options && typeof options.onEvent === 'function') {
              const onEvent = options.onEvent
              queueMicrotask(() =>
                onEvent({ type: 'error', charIndex: 0, errorMessage: 'No voice available.' }),
              )
            }
            return undefined
          }),
          stop: noop,
          pause: noop,
          resume: noop,
          onEvent: inert(),
          onVoicesChanged: inert(),
          EventType: enumOf(
            'start',
            'end',
            'word',
            'sentence',
            'marker',
            'interrupted',
            'cancelled',
            'error',
            'pause',
            'resume',
          ),
          VoiceGender: enumOf('male', 'female'),
        }),
      },

      // A speech engine nobody here will ask to speak: the calls go nowhere, the events never fire.
      ttsEngine: {
        shouldInject: () => declares('ttsEngine'),
        factory: () => ({
          updateVoices: noop,
          updateLanguage: noop,
          sendTtsEvent: noop,
          sendTtsAudio: noop,
          onSpeak: inert(),
          onSpeakWithAudioStream: inert(),
          onStop: inert(),
          onPause: inert(),
          onResume: inert(),
          onInstallLanguageRequest: inert(),
          onLanguageStatusRequest: inert(),
          onUninstallLanguageRequest: inert(),
          LanguageInstallStatus: {
            NOT_INSTALLED: 'notInstalled',
            INSTALLING: 'installing',
            INSTALLED: 'installed',
            FAILED: 'failed',
          },
          TtsClientSource: enumOf('chromefeature', 'extension'),
          VoiceGender: enumOf('male', 'female'),
        }),
      },

      /*
        instanceID rides on the `gcm` permission, as in Chrome. The identity half is local and real
        (a stable id per extension, kept in the session); tokens need Google's servers, which only
        Chrome's GCM client reaches, and fail as `gcm.register` does.
      */
      instanceID: {
        shouldInject: () => declares('gcm'),
        factory: () => ({
          getID: invokeExtension('instanceID.getID'),
          getCreationTime: invokeExtension('instanceID.getCreationTime'),
          deleteID: invokeExtension('instanceID.deleteID'),
          getToken: failWith('UNKNOWN_ERROR'),
          deleteToken: failWith('UNKNOWN_ERROR'),
          onTokenRefresh: inert(),
        }),
      },

      desktopCapture: {
        shouldInject: () => declares('desktopCapture'),
        factory: () => {
          let nextRequestId = 0
          return {
            /*
              Callback-only, returning a request id, as Chrome's. There is no picker in the host, so
              the answer is the one Chrome gives when the user cancels it: an empty stream id.
            */
            chooseDesktopMedia: (...args: any[]) => {
              const callback = args.reverse().find((arg) => typeof arg === 'function')
              const requestId = ++nextRequestId
              if (callback) queueMicrotask(() => callback('', { canRequestAudioTrack: false }))
              return requestId
            },
            cancelChooseDesktopMedia: noop,
            DesktopCaptureSourceType: enumOf('screen', 'window', 'tab', 'audio'),
            SelfCapturePreferenceEnum: enumOf('include', 'exclude'),
            SystemAudioPreferenceEnum: enumOf('include', 'exclude'),
            WindowAudioPreferenceEnum: enumOf('system', 'window', 'exclude'),
          }
        },
      },

      tabCapture: {
        shouldInject: () => declares('tabCapture'),
        factory: () => ({
          getMediaStreamId: failWith(
            'Extension has not been invoked for the current page (see activeTab permission). Chrome pages cannot be captured.',
          ),
          getCapturedTabs: answering(() => []),
          onStatusChanged: inert(),
          TabCaptureState: enumOf('pending', 'active', 'stopped', 'error'),
        }),
      },

      pageCapture: {
        shouldInject: () => declares('pageCapture'),
        factory: () => {
          const save = invokeExtension('pageCapture.saveAsMHTML')
          return {
            // The main process saves the page as MHTML and sends the bytes; the Blob is built here,
            // since a Blob does not cross the IPC.
            saveAsMHTML: (...args: any[]) => {
              const callback = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
              const promise = (save(args[0] || {}) as Promise<Uint8Array>).then(
                (bytes) => new Blob([bytes as any], { type: 'multipart/related' }),
              )
              if (!callback) return promise
              promise.then(
                (blob) => callback(blob),
                (error) => withLastError(errorMessage(error), () => callback()),
              )
            },
          }
        },
      },

      // Declared by a manifest key, not a permission. There is no address bar for it to live in.
      omnibox: {
        shouldInject: () => !!(manifest as any).omnibox,
        factory: () => ({
          setDefaultSuggestion: answering(() => undefined),
          sendSuggestions: noop,
          onInputStarted: inert(),
          onInputChanged: inert(),
          onInputEntered: inert(),
          onInputCancelled: inert(),
          onDeleteSuggestion: inert(),
          onActionExecuted: inert(),
          DescriptionStyleType: enumOf('url', 'match', 'dim'),
          OnInputEnteredDisposition: {
            CURRENT_TAB: 'currentTab',
            NEW_FOREGROUND_TAB: 'newForegroundTab',
            NEW_BACKGROUND_TAB: 'newBackgroundTab',
          },
        }),
      },

      search: {
        shouldInject: () => declares('search'),
        factory: () => ({
          // Failing is the honest answer: resolving would tell the extension a search ran.
          query: failWith('Search is not available.'),
          Disposition: { CURRENT_TAB: 'CURRENT_TAB', NEW_TAB: 'NEW_TAB', NEW_WINDOW: 'NEW_WINDOW' },
        }),
      },

      debugger: {
        shouldInject: () => declares('debugger'),
        factory: () => {
          const notAttached = failWith(
            (target?: { tabId?: number }) =>
              `Debugger is not attached to the tab with id: ${target?.tabId}.`,
          )
          return {
            attach: failWith('Cannot attach to this target.'),
            detach: notAttached,
            sendCommand: notAttached,
            getTargets: answering(() => []),
            onEvent: inert(),
            onDetach: inert(),
            DetachReason: enumOf('target_closed', 'canceled_by_user'),
            TargetInfoType: enumOf('page', 'background_page', 'worker', 'other'),
          }
        },
      },

      webAuthenticationProxy: {
        shouldInject: () => declares('webAuthenticationProxy'),
        factory: () => {
          const noRequest = failWith('Invalid requestId.')
          return {
            // Chrome's attach resolves with an error string when it cannot attach, never rejects.
            attach: answering(() => 'Web authentication proxying is not available.'),
            detach: answering(() => undefined),
            completeCreateRequest: noRequest,
            completeGetRequest: noRequest,
            completeIsUvpaaRequest: noRequest,
            onCreateRequest: inert(),
            onGetRequest: inert(),
            onIsUvpaaRequest: inert(),
            onRemoteSessionStateChange: inert(),
            onRequestCanceled: inert(),
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
    // The floor goes through the same loop, so its namespaces get the same isolation and mirroring.
    const allDefinitions: Record<
      string,
      { shouldInject?: () => boolean; factory: (base: any) => any }
    > = { ...(apiDefinitions as Record<string, any>), ...floorDefinitions }
    Object.keys(allDefinitions).forEach((key: any) => {
      const apiName: keyof typeof chrome = key
      try {
        const api = allDefinitions[apiName]!

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
      Object.keys(allDefinitions).filter((apiName) => !!(chrome as any)[apiName]),
    )

    // Seed the active tab cache eagerly in extension contexts so early
    // incoming messages (e.g. content scripts connecting on page load) get a
    // correct sender.tab.active value.
    if (extensionId) activeTabCache.init()

    const isServiceWorker =
      typeof (self as any).ServiceWorkerGlobalScope !== 'undefined' &&
      (self as any) instanceof (self as any).ServiceWorkerGlobalScope

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
