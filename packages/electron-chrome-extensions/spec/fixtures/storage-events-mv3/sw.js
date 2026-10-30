/* global chrome */

/*
  Every storage change this worker hears, by event: what chrome-storage-onChanged-spec.ts asserts.
  Listeners at the top level, as an MV3 worker registers them.
*/
const heard = []
chrome.storage.onChanged.addListener((changes, areaName) =>
  heard.push({ event: 'onChanged', areaName, changes }),
)
chrome.storage.local.onChanged.addListener((changes) => heard.push({ event: 'local', changes }))
chrome.storage.session.onChanged.addListener((changes) => heard.push({ event: 'session', changes }))

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  switch (message && message.type) {
    case 'heard':
      reply(heard.splice(0))
      return
    case 'write': {
      const area = chrome.storage[message.area]
      area[message.method](...message.args).then(
        () => reply({ ok: true }),
        (error) => reply({ ok: false, error: String((error && error.message) || error) }),
      )
      return true
    }
    case 'write-callback': {
      chrome.storage.local.set(message.items, () => {
        reply({ lastError: chrome.runtime.lastError ? chrome.runtime.lastError.message : null })
      })
      return true
    }
  }
})
