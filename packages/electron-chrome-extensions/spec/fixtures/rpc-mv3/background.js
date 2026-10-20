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
  }

  // Respond asynchronously
  return true
})

console.log('background-script-evaluated')
