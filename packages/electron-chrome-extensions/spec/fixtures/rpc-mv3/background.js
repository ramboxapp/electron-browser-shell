/* global chrome */

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
    }
  }

  // Respond asynchronously
  return true
})

console.log('background-script-evaluated')
