/* global chrome */

/*
  importScripts during the worker's initial evaluation, which is the only time a service worker
  allows it — and how a real extension pulls in its heavy chunks (Dashlane loads its argon2,
  libsodium and opaque modules exactly this way, inside a try that swallows any failure).
*/
self.__crxImportResult = (() => {
  try {
    importScripts('imported-chunk.js')
    return self.__crxImportedChunk === 'loaded' ? 'loaded' : 'ran but set nothing'
  } catch (error) {
    return 'threw: ' + ((error && error.message) || error)
  }
})()

/*
  webRequest listeners registered at the worker's top level, the way every real extension registers
  them (Chrome requires it for a service worker to be woken for them). Which events reach an MV3
  worker is the question the webRequest spec asks under each Electron.
*/
const webRequestSeen = { onBeforeRequest: [], onHeadersReceived: [], onCompleted: [], errors: [] }
for (const name of ['onBeforeRequest', 'onHeadersReceived', 'onCompleted']) {
  try {
    chrome.webRequest[name].addListener((details) => {
      webRequestSeen[name].push(details.url)
    }, { urls: ['<all_urls>'] })
  } catch (error) {
    webRequestSeen.errors.push(name + ': ' + ((error && error.message) || error))
  }
}

const sendIpc = ({ tabId, name }) => {
  chrome.tabs.sendMessage(tabId, { type: 'send-ipc', args: [name] })
}

const transformArgs = (args, sender) => {
  const tabId = sender.tab.id

  const transformArg = (arg) => {
    if (arg && typeof arg === 'object') {
      // Convert object to function that sends IPC
      if ('__IPC_FN__' in arg) {
        return () => {
          sendIpc({ tabId, name: arg.__IPC_FN__ })
        }
      } else {
        // Deep transform objects
        for (const key of Object.keys(arg)) {
          if (arg.hasOwnProperty(key)) {
            arg[key] = transformArg(arg[key])
          }
        }
      }
    }

    return arg
  }

  return args.map(transformArg)
}

/*
  The background half of http-matches-content-script.js: a port and a one-shot message, which is how
  a content script talks to its own extension. A content script that cannot reach its background
  looks, from the page, exactly like one that never ran.
*/
chrome.runtime.onConnect.addListener((port) => {
  port.onMessage.addListener(() => {
    port.postMessage({ reply: 'pong' })
  })
})

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  switch (message.type) {
    case 'api': {
      const { method, args } = message

      /*
        Any depth, not just `api.method`: `chrome.privacy` nests its settings two levels further
        (`privacy.services.passwordSavingEnabled.get`), and the owner object has to stay the
        receiver so `this` still works inside the method.
      */
      const path = method.split('.')
      const subMethod = path.pop()
      const apiObject = path.reduce((object, key) => (object ? object[key] : undefined), chrome)

      if (apiObject && typeof apiObject[subMethod] === 'function') {
        const transformedArgs = transformArgs(args, sender)
        const ret = apiObject[subMethod](...transformedArgs, reply)
        // Support promise-only APIs which ignore the callback argument.
        // Skip undefined results so callback-style APIs whose wrapper promise
        // resolves early (e.g. tabs.executeScript) don't clobber the reply.
        if (ret && typeof ret.then === 'function') {
          ret.then((value) => {
            if (value !== undefined) reply(value)
          })
        }
      }

      break
    }

    case 'event-once': {
      const { name } = message

      const [apiName, eventName] = name.split('.')

      if (typeof chrome[apiName][eventName] === 'object') {
        const event = chrome[apiName][eventName]
        event.addListener(function callback(...args) {
          if (chrome.runtime.lastError) {
            reply(chrome.runtime.lastError)
          } else {
            reply(args)
          }

          event.removeListener(callback)
        })
      }
      break
    }

    // Reports what the `browser` global looks like from inside the service worker. Electron defines
    // one holding only its natively implemented namespaces, and cross-browser extensions prefer it
    // over `chrome`, so anything this library injects has to be mirrored onto it too.
    // Resolves with the first commands.onCommand this worker receives, so a spec can prove the event
    // fires rather than just that addListener accepted a function.
    case 'await-command': {
      const onCommand = (command, tab) => {
        chrome.commands.onCommand.removeListener(onCommand)
        reply({ command, tabId: tab && tab.id })
      }
      chrome.commands.onCommand.addListener(onCommand)
      break
    }

    /*
      What the administrator-policy store answers, asked from inside the worker.

      Not reachable through 'api', which addresses an API as `namespace.method` and so cannot name
      `storage.managed.get`. The blocked-loop part at the end is the point of the whole case: the
      bug it pins down only appears when the worker is busy past a caller's deadline.
    */
    case 'managed-storage': {
      ;(async () => {
        const out = {}
        // Something in local, so the managed area can be caught reporting it as policy.
        await chrome.storage.local.set({ managedLeakProbe: 'local-only' })

        out.getKey = await chrome.storage.managed.get('PolicyKey')
        out.getDefaults = await chrome.storage.managed.get({ PolicyKey: 'fallback' })
        out.getAll = await chrome.storage.managed.get(null)
        out.getKeys =
          typeof chrome.storage.managed.getKeys === 'function'
            ? await chrome.storage.managed.getKeys()
            : null
        out.bytesInUse = await chrome.storage.managed.getBytesInUse(null)
        out.setRejection = await chrome.storage.managed.set({ PolicyKey: 'written' }).then(
          () => null,
          (err) => String((err && err.message) || err),
        )
        // And a write must not land anywhere either.
        out.afterWrite = await chrome.storage.managed.get('PolicyKey')

        // A caller that races the read against a short timer has to win even when the worker's loop
        // was blocked past the timer's deadline: that is Grammarly's 3s race, and what an answer
        // needing the main process loses.
        out.beatsTimer = await new Promise((resolve) => {
          let winner = null
          chrome.storage.managed.get('PolicyKey', () => {
            winner = winner || 'answer'
          })
          setTimeout(() => resolve(winner || 'timer'), 10)
          const until = Date.now() + 60
          while (Date.now() < until) {
            /* block the loop, the way a heavy startup does */
          }
        })

        await chrome.storage.local.remove('managedLeakProbe')
        reply(out)
      })()
      return true
    }

    case 'tabs-send-message': {
      chrome.tabs.sendMessage(message.tabId, { type: 'ping-from-background' }, (response) => {
        const error = chrome.runtime.lastError
        reply(error ? { lastError: error.message } : response)
      })
      return true
    }

    case 'import-scripts': {
      reply({ result: self.__crxImportResult, chunk: typeof self.__crxImportedChunk })
      break
    }

    case 'content-script-ping': {
      reply({ reply: 'pong' })
      break
    }

    /*
      The shape of a chrome.privacy setting, which `api` cannot ask about: what matters is that
      onChange carries its whole event interface, because an extension that adds a listener on
      start-up removes it on teardown and a missing removeListener throws there.
    */
    case 'privacy-setting-shape': {
      const setting = chrome.privacy.services.passwordSavingEnabled
      reply({
        get: typeof setting.get,
        set: typeof setting.set,
        clear: typeof setting.clear,
        addListener: typeof setting.onChange.addListener,
        removeListener: typeof setting.onChange.removeListener,
        hasListener: typeof setting.onChange.hasListener,
        // Returning a promise is the point: `undefined` here is what broke callers.
        getReturnsPromise: (() => {
          const returned = setting.get({})
          return !!(returned && typeof returned.then === 'function')
        })(),
      })
      break
    }

    case 'browser-global': {
      const globalBrowser = globalThis.browser
      reply({
        exists: !!globalBrowser,
        isChrome: globalBrowser === chrome,
        namespaces: globalBrowser ? Object.keys(globalBrowser).sort() : [],
        // Namespaces this library injects, and whether browser.X is the very object chrome.X is.
        mirrored: [
          'windows',
          'webNavigation',
          'cookies',
          'contextMenus',
          'permissions',
          'notifications',
        ].filter(
          (name) => globalBrowser && globalBrowser[name] && globalBrowser[name] === chrome[name],
        ),
        windowsEvent: !!(
          globalBrowser &&
          globalBrowser.windows &&
          globalBrowser.windows.onFocusChanged
        ),
        webRequestEvent: !!(
          globalBrowser &&
          globalBrowser.webRequest &&
          globalBrowser.webRequest.onBeforeRequest &&
          typeof globalBrowser.webRequest.onBeforeRequest.addListener === 'function'
        ),
      })
      break
    }

    /*
      What runtime.lastError reads inside a callback Chromium fails: a message from the worker that
      no extension page is open to receive. RoboForm broadcasts to its popup exactly this way and
      reads lastError to say it handled the failure.
    */
    case 'last-error-in-callback': {
      chrome.runtime.sendMessage({ type: 'nobody-listens' }, () => {
        const error = chrome.runtime.lastError
        // Chrome clears it once the callback returns: read again on the next task.
        setTimeout(() =>
          reply({
            lastError: error ? error.message : null,
            afterCallback: typeof chrome.runtime.lastError,
          }),
        )
      })
      break
    }

    /*
      A native port to a host that is not installed — what every user without the vendor's desktop
      app gets: RoboForm and 1Password both connect on start. Reports what onDisconnect was called
      with, and lastError while it ran.
    */
    case 'native-port-missing-host': {
      const port = chrome.runtime.connectNative(
        message.application || 'com.crx.host.that.is.not.installed',
      )
      const timer = setTimeout(() => reply({ timedOut: true }), 10e3)
      port.onDisconnect.addListener((...args) => {
        clearTimeout(timer)
        const error = chrome.runtime.lastError
        reply({
          argCount: args.length,
          argIsPort: args[0] === port,
          lastError: error ? error.message : null,
        })
      })
      break
    }

    // sendNativeMessage's callback, and lastError while it ran.
    case 'send-native-message': {
      chrome.runtime.sendNativeMessage(message.application, { ping: true }, (response) => {
        const error = chrome.runtime.lastError
        reply({
          response: response === undefined ? null : response,
          lastError: error ? error.message : null,
        })
      })
      break
    }

    // Whether disconnect() fires onDisconnect on the port that called it. Chrome does not.
    case 'native-port-own-disconnect': {
      const port = chrome.runtime.connectNative('com.crx.host.that.is.not.installed')
      let fired = false
      port.onDisconnect.addListener(() => {
        fired = true
      })
      port.disconnect()
      setTimeout(() => reply({ fired }), 1000)
      break
    }

    // What a service worker sees of chrome.extension.getViews: in Chrome, nothing (MV3 workers have
    // no views to list, and the function is not there).
    case 'extension-get-views-in-worker': {
      reply({ type: typeof (chrome.extension && chrome.extension.getViews) })
      break
    }

    // Both shapes of runtime.requestUpdateCheck, and whether either left a lastError behind.
    case 'request-update-check': {
      chrome.runtime.requestUpdateCheck((status, details) => {
        const callback = {
          status,
          details,
          lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null,
        }
        let promise
        try {
          promise = chrome.runtime.requestUpdateCheck()
        } catch (error) {
          reply({ callback, promise: 'threw ' + error.message })
          return
        }
        Promise.resolve(promise).then(
          (value) => reply({ callback, promise: value }),
          (error) => reply({ callback, promise: 'rejected ' + error.message }),
        )
      })
      break
    }

    // A WebSocket from a real MV3 service worker: open a socket, receive an unsolicited text frame,
    // request + receive a binary frame, then close. Replies with an ordered log of what happened,
    // and whether the constructor is the browser's own.
    case 'websocket-test': {
      const { url } = message
      const got = [/\[native code\]/.test(String(WebSocket)) ? 'native' : 'replaced']
      const ws = new WebSocket(url)
      ws.binaryType = 'arraybuffer'
      ws.onopen = () => {
        got.push('open')
        ws.send('want-binary')
      }
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          got.push('text:' + e.data)
        } else if (e.data instanceof ArrayBuffer) {
          got.push('binary:' + new Uint8Array(e.data).join(','))
          ws.close(3001, 'done')
        }
      }
      ws.onerror = () => got.push('error')
      ws.onclose = (e) => {
        got.push('close:' + e.code + ':' + e.wasClean)
        reply(got)
      }
      break
    }

    /*
      How an error of the main process reaches the extension, both ways a Chrome API is called.
      offscreen.closeDocument() with no document open fails deterministically ("No current
      offscreen document."), in Chrome and here.
    */
    case 'main-process-error-shapes': {
      ;(async () => {
        const out = {}
        out.promise = await chrome.offscreen.closeDocument().then(
          () => 'resolved',
          (error) => 'rejected: ' + ((error && error.message) || error),
        )
        out.callback = await new Promise((resolve) => {
          chrome.offscreen.closeDocument((...args) => {
            const error = chrome.runtime.lastError
            const during = error ? error.message : null
            // Chrome clears it once the callback returns.
            setTimeout(() =>
              resolve({ during, argCount: args.length, after: typeof chrome.runtime.lastError }),
            )
          })
        })
        reply(out)
      })()
      return true
    }

    // setIcon with an ImageData drawn in the worker: Chrome accepts it, and so should this.
    case 'set-icon-image-data': {
      const size = message.size || 16
      const image = new ImageData(size, size)
      for (let i = 0; i < image.data.length; i += 4) {
        image.data[i] = message.rgba[0]
        image.data[i + 1] = message.rgba[1]
        image.data[i + 2] = message.rgba[2]
        image.data[i + 3] = message.rgba[3]
      }
      chrome.action.setIcon({ imageData: image }).then(
        () => reply({ ok: true }),
        (error) => reply({ ok: false, error: String((error && error.message) || error) }),
      )
      return true
    }

    // The account half of chrome.identity, which a worker with no Google account can still call.
    case 'identity-shapes': {
      ;(async () => {
        const out = {}
        out.profile = await chrome.identity.getProfileUserInfo()
        out.tokenPromise = await chrome.identity.getAuthToken({ interactive: false }).then(
          (token) => 'resolved: ' + JSON.stringify(token),
          (error) => 'rejected: ' + ((error && error.message) || error),
        )
        out.tokenCallback = await new Promise((resolve) => {
          chrome.identity.getAuthToken({ interactive: false }, (token) => {
            resolve({
              token: token === undefined ? 'undefined' : token,
              lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null,
            })
          })
        })
        out.accounts = await chrome.identity.getAccounts()
        out.cleared = await chrome.identity.clearAllCachedAuthTokens().then(() => 'ok')
        out.onSignInChanged = typeof chrome.identity.onSignInChanged.addListener
        out.redirect = chrome.identity.getRedirectURL('/done')
        out.accountStatus = chrome.identity.AccountStatus
        reply(out)
      })()
      return true
    }

    /*
      gcm, proxy and the sync constants: the shapes a worker reads at start-up (Endpoint
      Verification's gcm.onMessage, NordVPN's proxy.settings, LanguageTool's sync.MAX_ITEMS) and
      what each answers where Chrome, with no GCM client and a proxy it does not control, fails.
    */
    case 'platform-shapes': {
      ;(async () => {
        const out = {}
        out.gcm = {
          onMessage: typeof (chrome.gcm && chrome.gcm.onMessage && chrome.gcm.onMessage.addListener),
          maxSize: chrome.gcm && chrome.gcm.MAX_MESSAGE_SIZE,
          register: await chrome.gcm.register(['1234']).then(
            (id) => 'resolved: ' + id,
            (error) => 'rejected: ' + ((error && error.message) || error),
          ),
          registerCallback: await new Promise((resolve) =>
            chrome.gcm.register(['1234'], () =>
              resolve(chrome.runtime.lastError ? chrome.runtime.lastError.message : null),
            ),
          ),
        }
        out.proxy = {
          get: await chrome.proxy.settings.get({}),
          set: await chrome.proxy.settings.set({ value: { mode: 'direct' } }).then(() => 'resolved'),
          after: await chrome.proxy.settings.get({}),
          onProxyError: typeof (chrome.proxy.onProxyError && chrome.proxy.onProxyError.addListener),
          mode: chrome.proxy.Mode && chrome.proxy.Mode.SYSTEM,
        }
        await chrome.storage.sync.set({ syncProbe: 'via-sync' })
        out.sync = {
          maxItems: chrome.storage.sync.MAX_ITEMS,
          perItem: chrome.storage.sync.QUOTA_BYTES_PER_ITEM,
          quota: chrome.storage.sync.QUOTA_BYTES,
          // The alias still writes through to local.
          readBack: (await chrome.storage.local.get('syncProbe')).syncProbe,
          onChanged: typeof (chrome.storage.sync.onChanged && chrome.storage.sync.onChanged.addListener),
        }
        await chrome.storage.local.remove('syncProbe')
        out.events = {
          onSignInChangedHasListener: typeof chrome.identity.onSignInChanged.hasListener,
          privacyOnChangeHasListeners:
            typeof chrome.privacy.services.passwordSavingEnabled.onChange.hasListeners,
        }
        reply(out)
      })()
      return true
    }

    // What the top-level webRequest listeners of this worker have seen so far.
    case 'webrequest-mv3-results': {
      reply(webRequestSeen)
      break
    }

    // chrome.i18n from the worker: what getMessage answers once the host app's language is known.
    case 'i18n-shapes': {
      ;(async () => {
        const g = (...args) => chrome.i18n.getMessage(...args)
        reply({
          uiLanguage: chrome.i18n.getUILanguage(),
          acceptLanguages: await chrome.i18n.getAcceptLanguages(),
          greeting: g('greeting', ['Ana', '3']),
          greetingUpper: g('GREETING', ['Ana', '3']),
          greetingOneSub: g('greeting', 'Ana'),
          tagline: g('tagline'),
          onlyInEn: g('only_in_en'),
          price: g('price'),
          positional: g('positional', ['a', 'b']),
          withLt: g('with_lt'),
          withLtEscaped: g('with_lt', [], { escapeLt: true }),
          unknown: g('no_such_message'),
          extensionId: g('@@extension_id'),
          uiLocale: g('@@ui_locale'),
          bidiDir: g('@@bidi_dir'),
          tooMany: (() => {
            try {
              g('positional', ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
              return 'no throw'
            } catch (error) {
              return 'threw: ' + error.message
            }
          })(),
        })
      })()
      return true
    }

    /*
      What a call answers, in the two shapes Chrome has: `outcome` calls without a callback and
      reports the resolved value or the rejection; `outcome-callback` passes one and reports what it
      received and `runtime.lastError` while it ran. `value` is '__undefined__' for undefined, so a
      resolution with nothing is not confused with no answer.
    */
    case 'outcome':
    case 'outcome-callback': {
      const path = message.method.split('.')
      const name = path.pop()
      const owner = path.reduce((object, key) => (object ? object[key] : undefined), chrome)
      const fn = owner && owner[name]
      const shape = (value) => (value === undefined ? '__undefined__' : value)
      if (typeof fn !== 'function') {
        reply({ absent: true })
        break
      }
      try {
        if (message.type === 'outcome') {
          Promise.resolve(fn.apply(owner, message.args || [])).then(
            (value) => reply({ value: shape(value) }),
            (error) => reply({ error: String((error && error.message) || error) }),
          )
        } else {
          fn.apply(owner, [
            ...(message.args || []),
            (value) => {
              const error = chrome.runtime.lastError
              reply({ value: shape(value), lastError: error ? error.message : null })
            },
          ])
        }
      } catch (error) {
        reply({ threw: String((error && error.message) || error) })
      }
      break
    }

    /*
      Every dispatch of the named events from here on, kept until `recorded` reads them: how a spec
      asserts that an event FIRES, with what, and how many times — and that one did not.
    */
    case 'record-events': {
      self.__recorded = self.__recorded || {}
      for (const name of message.names) {
        if (self.__recorded[name]) {
          self.__recorded[name].length = 0
          continue
        }
        const path = name.split('.')
        const event = path.reduce((object, key) => (object ? object[key] : undefined), chrome)
        const seen = (self.__recorded[name] = [])
        event.addListener((...args) => seen.push(JSON.parse(JSON.stringify(args))))
      }
      reply(true)
      break
    }

    /*
      chrome.tts.speak with the events it delivers to the call's own onEvent, which `outcome`
      cannot carry (a function). Records until a final event (end, error, interrupted, cancelled)
      or the deadline, and reports whether speak itself resolved, with what error.
    */
    case 'tts-speak': {
      const events = []
      let resolved = false
      let error = null
      const finish = () => reply({ resolved, error, events })
      const timer = setTimeout(finish, message.deadline || 8000)
      const options = Object.assign({}, message.options || {}, {
        onEvent: (event) => {
          events.push(event)
          if (['end', 'error', 'interrupted', 'cancelled'].includes(event.type)) {
            clearTimeout(timer)
            // Let a second utterance's events (an interrupt test) land before answering.
            setTimeout(finish, message.settle || 0)
          }
        },
      })
      chrome.tts.speak(message.text, options).then(
        () => (resolved = true),
        (e) => {
          error = String((e && e.message) || e)
          clearTimeout(timer)
          finish()
        },
      )
      return true
    }

    /*
      A webRequest.onAuthRequired listener with the spec and filter the spec asks for, answering
      what the spec says: `response` as the return value ('blocking'), through the callback
      ('asyncBlocking', after `delay` ms), or nothing (an observer). What it received is kept for
      'auth-seen'.
    */
    /*
      A sequence of tts steps run from one RPC, because two RPCs in flight share one reply channel:
      `speak` (text, options), `wait` (ms), `stop`, `isSpeaking`. Every speak's events are recorded
      until each reaches a final event or the deadline passes.
    */
    case 'tts-sequence': {
      const FINAL = ['end', 'error', 'interrupted', 'cancelled']
      const speaks = []
      const probes = []
      let deadline
      const done = () => speaks.every((entry) => entry.error || entry.events.some((e) => FINAL.includes(e.type)))
      const finish = () => {
        clearTimeout(deadline)
        reply({ speaks, probes })
      }
      ;(async () => {
        for (const step of message.steps || []) {
          if (step.action === 'speak') {
            const entry = { resolved: false, error: null, events: [] }
            speaks.push(entry)
            const options = Object.assign({}, step.options || {}, {
              onEvent: (event) => {
                entry.events.push(event)
                if (FINAL.includes(event.type) && done()) setTimeout(finish, 50)
              },
            })
            chrome.tts.speak(step.text, options).then(
              () => (entry.resolved = true),
              (e) => (entry.error = String((e && e.message) || e)),
            )
          } else if (step.action === 'wait') {
            await new Promise((resolve) => setTimeout(resolve, step.ms || 0))
          } else if (step.action === 'stop') {
            await chrome.tts.stop()
          } else if (step.action === 'isSpeaking') {
            probes.push(await chrome.tts.isSpeaking())
          }
        }
        deadline = setTimeout(finish, message.deadline || 15000)
        if (done()) setTimeout(finish, 50)
      })()
      return true
    }

    case 'auth-listen': {
      self.__authSeen = self.__authSeen || []
      const listener = (details, asyncCallback) => {
        self.__authSeen.push(JSON.parse(JSON.stringify(details)))
        // `promise`: answer the way 1Password and Keeper do, by returning a promise and never calling back.
        if (message.promise) {
          return new Promise((resolve) => setTimeout(() => resolve(message.response), message.delay || 0))
        }
        if (typeof asyncCallback === 'function') {
          setTimeout(() => asyncCallback(message.response), message.delay || 0)
          return
        }
        return message.response
      }
      self.__authListeners = self.__authListeners || []
      self.__authListeners.push(listener)
      chrome.webRequest.onAuthRequired.addListener(listener, message.filter || { urls: ['<all_urls>'] }, message.extra || [])
      reply({ hasListener: chrome.webRequest.onAuthRequired.hasListener(listener) })
      break
    }

    case 'auth-seen': {
      reply(self.__authSeen || [])
      break
    }

    case 'auth-forget': {
      for (const listener of self.__authListeners || []) chrome.webRequest.onAuthRequired.removeListener(listener)
      self.__authListeners = []
      self.__authSeen = []
      reply({ hasListeners: chrome.webRequest.onAuthRequired.hasListeners() })
      break
    }

    case 'event-method': {
      const { name, method, args } = message
      const path = name.split('.')
      const event = path.reduce((object, key) => (object ? object[key] : undefined), chrome)
      try {
        const result =
          event && typeof event[method] === 'function' ? event[method](...(args || [])) : undefined
        reply({ ok: true, result })
      } catch (e) {
        reply({ ok: false, error: String((e && e.message) || e) })
      }
      break
    }

    case 'recorded': {
      reply((self.__recorded && self.__recorded[message.name]) || null)
      break
    }

    case 'font-settings-enums': {
      const f = chrome.fontSettings
      reply({
        GenericFamily: f.GenericFamily,
        LevelOfControl: f.LevelOfControl,
        scriptCodes: Object.keys(f.ScriptCode).length,
        ZYYY: f.ScriptCode.ZYYY,
      })
      break
    }

    case 'notifications-surface': {
      const n = chrome.notifications
      const events = {}
      for (const name of [
        'onButtonClicked',
        'onClicked',
        'onClosed',
        'onPermissionLevelChanged',
        'onShowSettings',
      ]) {
        events[name] = typeof (n[name] && n[name].addListener)
      }
      Promise.resolve(n.getPermissionLevel()).then((permissionLevel) =>
        reply({
          PermissionLevel: n.PermissionLevel,
          TemplateType: n.TemplateType,
          events,
          permissionLevel,
        }),
      )
      break
    }

    // What the worker sees of the tabs and management events it registers at start-up.
    case 'event-shapes': {
      const shape = (event) => ({
        addListener: typeof (event && event.addListener),
        hasListener: typeof (event && event.hasListener),
      })
      reply({
        tabs: {
          onHighlighted: shape(chrome.tabs.onHighlighted),
          onZoomChange: shape(chrome.tabs.onZoomChange),
          onMoved: shape(chrome.tabs.onMoved),
          onDetached: shape(chrome.tabs.onDetached),
          onAttached: shape(chrome.tabs.onAttached),
        },
        management: {
          onInstalled: shape(chrome.management.onInstalled),
          onUninstalled: shape(chrome.management.onUninstalled),
          onEnabled: shape(chrome.management.onEnabled),
          onDisabled: shape(chrome.management.onDisabled),
        },
      })
      break
    }
  }

  // Respond asynchronously
  return true
})

console.log('background-script-evaluated')
