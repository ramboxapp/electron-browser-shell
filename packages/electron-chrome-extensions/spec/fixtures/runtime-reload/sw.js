/* global chrome */

// Reloads the extension on demand, mimicking extensions that call
// chrome.runtime.reload() from their background at a moment when they have
// pages open (e.g. Dashlane's reloadOnLogout task during account creation).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg === 'do-reload') {
    chrome.runtime.reload()
  }
})
