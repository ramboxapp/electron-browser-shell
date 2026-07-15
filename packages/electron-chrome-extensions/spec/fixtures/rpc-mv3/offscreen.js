/* global chrome */

// Echoes 'offscreen-echo' messages back to the caller, so specs can drive a
// real service-worker <-> offscreen-document chrome.runtime.sendMessage
// round trip via the rpc dispatcher's generic 'api' case
// (browser.crx.exec('runtime.sendMessage', {...})).
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message && message.type === 'offscreen-echo') {
    reply({ echoed: message.payload })
    return true
  }
})
