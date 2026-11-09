/* eslint-disable */

// MV3 blocks inline script injection into the page, so results are relayed
// through a postMessage handled by main-world.js instead.
function sendIpc(name, ...args) {
  window.postMessage({ type: 'spec-ipc', name, args })
}

async function exec(action) {
  const send = async () => {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(action, (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError.message)
        } else {
          resolve(result)
        }
      })
    })
  }

  // Retry logic - the connection doesn't seem to always be available when
  // attempting to send. This started when upgrading to Electron 22 from 15.
  let result
  for (let i = 0; i < 3; i++) {
    try {
      result = await send()
      break
    } catch (e) {
      console.error(e)
      await new Promise((resolve) => setTimeout(resolve, 100)) // sleep
    }
  }

  sendIpc('success', result)
}

// Runs chrome.storage calls in the CONTENT SCRIPT's own isolated world, which is the one context
// the library's preload cannot reach, and reports what each one did. `sync` and `managed` throw on
// property access there unless something has aliased them onto `local`.
async function reportStorage() {
  const attempt = async (fn) => {
    try {
      return { ok: true, value: await fn() }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }
  }
  const result = {
    shim: typeof self.__crxStorageShimRan === 'undefined' ? 'absent' : self.__crxStorageShimRan,
    local: await attempt(async () => {
      await chrome.storage.local.set({ __probe: 'local' })
      return (await chrome.storage.local.get('__probe')).__probe
    }),
    sync: await attempt(async () => {
      await chrome.storage.sync.set({ __probe: 'sync' })
      return (await chrome.storage.sync.get('__probe')).__probe
    }),
    // What local holds once sync wrote last: 'sync' when sync is the alias of local, 'local' when it
    // is a store of its own (Electron's native sync area, from 45.2).
    localAfterSync: await attempt(async () => (await chrome.storage.local.get('__probe')).__probe),
    // local and sync both wrote __probe just above, so if this area were aliased onto local the
    // keys below would carry it — which is exactly how the leak would read from a content script.
    managed: await attempt(async () => ({
      keys: Object.keys(await chrome.storage.managed.get(null)),
      defaults: await chrome.storage.managed.get({ PolicyKey: 'fallback' }),
      setRejection: await chrome.storage.managed.set({ PolicyKey: 'written' }).then(
        () => null,
        (error) => String((error && error.message) || error),
      ),
    })),
    // chrome.dom and chrome.extension: Chromium gives a content script both, Electron gives neither.
    dom: await attempt(async () => {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const open = host.attachShadow({ mode: 'open' })
      const reached = chrome.dom.openOrClosedShadowRoot(host) === open
      const noRoot = chrome.dom.openOrClosedShadowRoot(document.body) === null
      host.remove()
      return { reached, noRoot }
    }),
    extensionNs: await attempt(async () => ({
      inIncognitoContext: chrome.extension.inIncognitoContext,
      hasViewType: typeof chrome.extension.ViewType,
    })),
    session: await attempt(async () => {
      await chrome.storage.session.set({ __probe: 'session' })
      return (await chrome.storage.session.get('__probe')).__probe
    }),
  }
  sendIpc('success', result)
}

// A dedicated Worker from an extension file: how an extension does heavy work (crypto, zip) off
// the page's thread. The script has to be web-accessible for the page's world to load it.
async function startWorker() {
  try {
    const worker = new Worker(chrome.runtime.getURL('worker-script.js'))
    const echo = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no answer in 5s')), 5000)
      worker.addEventListener('message', (event) => {
        clearTimeout(timer)
        resolve(event.data)
      })
      worker.addEventListener('error', (event) => {
        clearTimeout(timer)
        reject(new Error(event.message || 'worker error'))
      })
      worker.postMessage('ping')
    })
    worker.terminate()
    sendIpc('success', { ok: true, echo })
  } catch (error) {
    sendIpc('success', { ok: false, error: String((error && error.message) || error) })
  }
}

// chrome.i18n as the content script's isolated world sees it: the one context the preload cannot
// reach, so only the shim the locale patch leaves in the extension can localize it.
function reportI18n() {
  const g = (...args) => chrome.i18n.getMessage(...args)
  const result = {
    shim: typeof self.__crxStorageShimRan === 'undefined' ? 'absent' : self.__crxStorageShimRan,
    uiLanguage: chrome.i18n.getUILanguage(),
    greeting: g('greeting', ['Ana', '3']),
    tagline: g('tagline'),
    onlyInEn: g('only_in_en'),
    price: g('price'),
    extensionId: g('@@extension_id'),
    unknown: g('no_such_message'),
  }
  chrome.i18n.getAcceptLanguages((languages) => {
    result.acceptLanguages = languages
    sendIpc('success', result)
  })
}

window.addEventListener('message', (event) => {
  const data = event.data
  if (data && data.type === 'content-script-storage') {
    reportStorage()
    return
  }
  if (data && data.type === 'content-script-i18n') {
    reportI18n()
    return
  }
  if (data && data.type === 'content-script-worker') {
    startWorker()
    return
  }
  // Relay any command posted by the test runner to the background/service
  // worker. Exclude the 'spec-ipc' relay messages this content script itself
  // posts to main-world.js, to avoid re-entering.
  if (data && data.type && data.type !== 'spec-ipc') {
    exec(data)
  }
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.type) {
    case 'send-ipc': {
      const [name] = message.args
      sendIpc(name)
      break
    }
    // The other direction: the background pushing to the page, which is how an extension tells a
    // content script to act. A reply proves the round trip, not just that the send did not throw.
    case 'ping-from-background': {
      document.documentElement.setAttribute('data-crx-got-background-message', 'yes')
      sendResponse({ reply: 'pong-from-content-script' })
      break
    }
  }
})
