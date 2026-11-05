/* global chrome */

/*
  The worker of the capture fixture: it answers the spec's exec() for the worker's side of
  chrome.tabCapture and chrome.desktopCapture (the id, the errors, the picker request, the events).
  The capture itself happens in capture.html, the only context with a getUserMedia.
*/

const shape = (value) => (value === undefined ? '__undefined__' : value)

const handlers = {
  // The namespaces as the worker sees them: `capture` must be absent here, as in Chrome.
  shapes() {
    const describe = (object) =>
      Object.fromEntries(
        Object.keys(object).map((key) => [
          key,
          typeof object[key] === 'function'
            ? 'function'
            : object[key] && typeof object[key].addListener === 'function'
              ? 'event'
              : object[key],
        ]),
      )
    return { tabCapture: describe(chrome.tabCapture), desktopCapture: describe(chrome.desktopCapture) }
  },

  // Promise form: what it answered, or the error it rejected with.
  outcome({ method, args }) {
    const path = method.split('.')
    const name = path.pop()
    const owner = path.reduce((object, key) => (object ? object[key] : undefined), chrome)
    try {
      return Promise.resolve(owner[name].apply(owner, args || [])).then(
        (value) => ({ value: shape(value) }),
        (error) => ({ error: String((error && error.message) || error) }),
      )
    } catch (error) {
      return { threw: String((error && error.message) || error) }
    }
  },

  // Callback form: what the callback got, and runtime.lastError while it ran.
  'outcome-callback'({ method, args }) {
    const path = method.split('.')
    const name = path.pop()
    const owner = path.reduce((object, key) => (object ? object[key] : undefined), chrome)
    return new Promise((resolve) => {
      let returned
      try {
        returned = owner[name].apply(owner, [
          ...(args || []),
          (...cbArgs) => {
            const error = chrome.runtime.lastError
            resolve({ cbArgs: cbArgs.map(shape), lastError: error ? error.message : null, returned })
          },
        ])
      } catch (error) {
        resolve({ threw: String((error && error.message) || error) })
        return
      }
      setTimeout(() => resolve({ timeout: true, returned }), 3000)
    })
  },

  // chooseDesktopMedia, cancelled from the worker after `cancelAfter` ms: did the callback ever run?
  'choose-then-cancel'({ sources, targetTab, cancelAfter, waitFor }) {
    return new Promise((resolve) => {
      let called = null
      const args = [sources]
      if (targetTab) args.push(targetTab)
      const requestId = chrome.desktopCapture.chooseDesktopMedia(...args, (...cbArgs) => {
        called = { cbArgs: cbArgs.map(shape), lastError: chrome.runtime.lastError?.message ?? null }
      })
      setTimeout(() => chrome.desktopCapture.cancelChooseDesktopMedia(requestId), cancelAfter)
      setTimeout(() => resolve({ requestId, called }), waitFor)
    })
  },

  'record-events'({ names }) {
    self.__recorded = self.__recorded || {}
    for (const name of names) {
      if (self.__recorded[name]) {
        self.__recorded[name].length = 0
        continue
      }
      const path = name.split('.')
      const event = path.reduce((object, key) => (object ? object[key] : undefined), chrome)
      const seen = (self.__recorded[name] = [])
      event.addListener((...args) => seen.push(JSON.parse(JSON.stringify(args))))
    }
    return true
  },

  recorded({ name }) {
    return (self.__recorded && self.__recorded[name]) || null
  },
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  const handler = handlers[message && message.type]
  if (!handler) return false
  Promise.resolve(handler(message, sender)).then(reply, (error) =>
    reply({ handlerError: String((error && error.message) || error) }),
  )
  return true
})

console.log('background-script-evaluated')
