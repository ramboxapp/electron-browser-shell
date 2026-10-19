/* global chrome */

/*
  A content script declared with the http scheme wildcard as its match pattern rather than
  `<all_urls>`, which also opens a port to its own background.

  Both halves are what a password manager's content script does on every page, and both were
  suspects when three of the four password managers in Rambox's catalog left no trace at all on a
  login page while the fourth filled it. The page reads these attributes back.
*/
document.documentElement.setAttribute('data-crx-http-matches', 'ran')

try {
  const port = chrome.runtime.connect({ name: 'content-script-port' })
  port.onMessage.addListener((message) => {
    document.documentElement.setAttribute('data-crx-port-reply', String(message && message.reply))
  })
  port.postMessage({ hello: 'from-content-script' })
  document.documentElement.setAttribute('data-crx-port-opened', 'yes')
} catch (error) {
  document.documentElement.setAttribute('data-crx-port-opened', 'threw: ' + error.message)
}

// sendMessage is the other half of the same question: a one-shot round trip to the background.
try {
  chrome.runtime.sendMessage({ type: 'content-script-ping' }, (reply) => {
    const error = chrome.runtime.lastError
    document.documentElement.setAttribute(
      'data-crx-sendmessage-reply',
      error ? 'lastError: ' + error.message : String(reply && reply.reply),
    )
  })
} catch (error) {
  document.documentElement.setAttribute('data-crx-sendmessage-reply', 'threw: ' + error.message)
}

/*
  Inject a script of the extension's own origin into the page's MAIN world, the way a password
  manager reaches page internals. Reported back through an attribute the page can read.
*/
try {
  const el = document.createElement('script')
  el.src = chrome.runtime.getURL('page-script.js')
  el.onload = () => document.documentElement.setAttribute('data-crx-page-script-loaded', 'yes')
  el.onerror = (event) =>
    document.documentElement.setAttribute('data-crx-page-script-loaded', 'error')
  ;(document.head || document.documentElement).appendChild(el)
} catch (error) {
  document.documentElement.setAttribute('data-crx-page-script-loaded', 'threw: ' + error.message)
}
