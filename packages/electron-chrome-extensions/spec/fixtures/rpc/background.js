/* global chrome */

const sendIpc = ({ tabId, name }) => {
  chrome.tabs.sendMessage(tabId, { type: 'send-ipc', args: [name] })
}

// URLs observed by the webRequest coexistence probe (see webrequest-probe-*).
const webRequestProbe = { observed: [] }

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

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  switch (message.type) {
    case 'api': {
      const { method, args } = message

      const [apiName, subMethod] = method.split('.')

      if (typeof chrome[apiName][subMethod] === 'function') {
        const transformedArgs = transformArgs(args, sender)
        const ret = chrome[apiName][subMethod](...transformedArgs, reply)
        // Support promise-only APIs which ignore the callback argument.
        // Skip undefined results so callback-style APIs whose wrapper promise
        // resolves early (e.g. tabs.executeScript) don't clobber the reply.
        if (ret && typeof ret.then === 'function') {
          ret.then((value) => {
            if (value !== undefined) reply(value)
          })
        }
      } else {
        console.error(`missing method: ${method} (typeof ${apiName}=${typeof chrome[apiName]})`)
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

    // P2.0 spike: registers a native chrome.webRequest.onBeforeRequest
    // listener. With `blockPath` set it registers as a blocking listener and
    // cancels matching URLs (requires webRequestBlocking, MV2-only).
    case 'webrequest-probe-start': {
      const { blockPath } = message
      const extraInfo = blockPath ? ['blocking'] : []
      chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
          webRequestProbe.observed.push(details.url)
          if (blockPath && details.url.includes(blockPath)) {
            return { cancel: true }
          }
        },
        { urls: ['<all_urls>'] },
        extraInfo,
      )
      reply({ ok: true })
      break
    }

    case 'webrequest-probe-results': {
      reply({ observed: webRequestProbe.observed })
      break
    }

    // Calls a chrome.events.Event method (hasListener, hasListeners,
    // getRules, addRules, removeRules) directly, without a real callback
    // function crossing the RPC boundary. Used to verify these don't throw.
    case 'event-method': {
      const { name, method, args } = message

      const [apiName, eventName] = name.split('.')
      const event = chrome[apiName] && chrome[apiName][eventName]

      try {
        const result = event && typeof event[method] === 'function' ? event[method](...(args || [])) : undefined
        reply({ ok: true, result })
      } catch (e) {
        reply({ ok: false, error: String((e && e.message) || e) })
      }

      break
    }
  }

  // Respond asynchronously
  return true
})

console.log('background-script-evaluated')
