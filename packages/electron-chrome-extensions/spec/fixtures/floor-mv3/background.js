/* global chrome */

/*
  The worker of the floor fixture. It walks the namespaces of the anti-crash floor and reports the
  shape of every member (chrome-absent-namespaces-spec), and runs the few scenarios the real parts
  need from inside an extension (browsingData, system, pageCapture, instanceID specs).
*/

const NAMESPACES = [
  'accessibilityFeatures',
  'bookmarks',
  'browsingData',
  'contentSettings',
  'debugger',
  'declarativeContent',
  'desktopCapture',
  'history',
  'instanceID',
  'omnibox',
  'pageCapture',
  'readingList',
  'search',
  'sessions',
  'system',
  'tabCapture',
  'tabGroups',
  'tts',
  'ttsEngine',
  'webAuthenticationProxy',
]

const settle = (value) =>
  Promise.race([
    Promise.resolve(value).then(
      () => 'resolved',
      () => 'rejected',
    ),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 3000)),
  ])

const isEvent = (value) =>
  value && typeof value === 'object' && typeof value.addListener === 'function'

/*
  Every member, one level into nested objects (contentSettings.cookies, system.storage, the
  ChromeSettings). Capitalised members are constructors and enums and are not called; a function is
  called with no arguments, which is the cheapest way to see what it returns when an extension gets
  it slightly wrong — and the floor's promise is that it never returns `undefined` where Chrome
  returns a promise, and never throws where Chrome answers.
*/
const describeMembers = async (object, prefix, depth) => {
  const out = {}
  for (const key of Object.keys(object)) {
    const name = `${prefix}.${key}`
    let value
    try {
      value = object[key]
    } catch (error) {
      out[name] = { kind: 'getter-throws', detail: String(error && error.message) }
      continue
    }
    if (typeof value === 'function') {
      if (/^[A-Z]/.test(key)) {
        out[name] = { kind: 'constructor' }
        continue
      }
      let returned
      try {
        returned = value.call(object)
      } catch (error) {
        out[name] = { kind: 'call', returned: 'throws', detail: String(error && error.message) }
        continue
      }
      if (returned && typeof returned.then === 'function') {
        out[name] = { kind: 'call', returned: 'promise', settled: await settle(returned) }
      } else {
        out[name] = {
          kind: 'call',
          returned: returned === undefined ? 'undefined' : typeof returned,
        }
      }
    } else if (isEvent(value)) {
      let accepts = true
      try {
        const listener = () => {}
        value.addListener(listener)
        value.removeListener(listener)
      } catch {
        accepts = false
      }
      out[name] = {
        kind: 'event',
        accepts,
        hasListener: typeof value.hasListener,
        hasListeners: typeof value.hasListeners,
      }
    } else if (value && typeof value === 'object' && depth < 1 && !/^[A-Z]/.test(key)) {
      Object.assign(out, await describeMembers(value, name, depth + 1))
    } else {
      out[name] = { kind: 'value', type: typeof value }
    }
  }
  return out
}

const handlers = {
  async api({ method, args }) {
    const path = method.split('.')
    const name = path.pop()
    const owner = path.reduce((object, key) => (object ? object[key] : undefined), chrome)
    try {
      return { ok: true, value: await owner[name](...(args || [])) }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }
  },

  async 'floor-shapes'() {
    const present = {}
    const members = {}
    for (const ns of NAMESPACES) {
      present[ns] = typeof chrome[ns]
      if (chrome[ns]) Object.assign(members, await describeMembers(chrome[ns], ns, 0))
    }
    return { present, members }
  },

  async 'floor-present'() {
    return Object.fromEntries(NAMESPACES.map((ns) => [ns, typeof chrome[ns]]))
  },

  async constants() {
    return {
      tabs: {
        TAB_ID_NONE: chrome.tabs.TAB_ID_NONE,
        TAB_INDEX_NONE: chrome.tabs.TAB_INDEX_NONE,
        MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND:
          chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND,
        WindowType: chrome.tabs.WindowType,
        TabStatus: chrome.tabs.TabStatus,
      },
      windows: {
        WindowType: chrome.windows.WindowType,
        WindowState: chrome.windows.WindowState,
        CreateType: chrome.windows.CreateType,
      },
      contextMenus: {
        ACTION_MENU_TOP_LEVEL_LIMIT: chrome.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT,
        ContextType: chrome.contextMenus.ContextType,
        ItemType: chrome.contextMenus.ItemType,
      },
    }
  },

  // The first call of a named event, at any depth (`system.display.onDisplayChanged`).
  'await-event'({ name }) {
    const path = name.split('.')
    const event = path.reduce((object, key) => (object ? object[key] : undefined), chrome)
    return new Promise((resolve) => {
      const listener = (...args) => {
        event.removeListener(listener)
        resolve({ fired: true, args })
      }
      event.addListener(listener)
      setTimeout(() => resolve({ fired: false }), 5000)
    })
  },

  async 'page-capture'(_message, sender) {
    try {
      const blob = await chrome.pageCapture.saveAsMHTML({ tabId: sender.tab.id })
      return {
        isBlob: blob instanceof Blob,
        type: blob.type,
        size: blob.size,
        head: (await blob.text()).slice(0, 400),
      }
    } catch (error) {
      return { error: String((error && error.message) || error) }
    }
  },

  // Rules round trip, and what the constructors serialise to.
  'declarative-content'() {
    const { onPageChanged, PageStateMatcher, ShowAction } = chrome.declarativeContent
    const rule = {
      conditions: [new PageStateMatcher({ pageUrl: { hostEquals: 'x.invalid' } })],
      actions: [new ShowAction()],
    }
    return new Promise((resolve) => {
      onPageChanged.removeRules(undefined, () => {
        onPageChanged.addRules([rule], (added) => {
          onPageChanged.getRules((all) => {
            let withoutNew = null
            try {
              PageStateMatcher({})
            } catch (error) {
              withoutNew = String(error && error.message)
            }
            resolve({ added, all, withoutNew })
          })
        })
      })
    })
  },

  // speak() succeeds and the utterance's own onEvent learns there was no voice.
  'tts-speak'() {
    return new Promise((resolve) => {
      let resolved
      chrome.tts
        .speak('hello', { onEvent: (event) => resolve({ resolved, event }) })
        .then(() => (resolved = true))
      setTimeout(() => resolve({ resolved, event: null }), 3000)
    })
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
