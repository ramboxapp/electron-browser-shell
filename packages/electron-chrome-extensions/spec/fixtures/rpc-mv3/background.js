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

    // Exercises the WebSocket proxy from a real MV3 service worker: open a
    // socket, receive an unsolicited text frame, request + receive a binary
    // frame, then close. Replies with an ordered log of what happened.
    case 'websocket-test': {
      const { url } = message
      const got = []
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
