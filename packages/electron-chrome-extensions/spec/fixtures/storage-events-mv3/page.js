/* global chrome */
// What the page hears natively, to prove the relay does not double it.
window.heardByPage = []
chrome.storage.onChanged.addListener((changes, areaName) =>
  window.heardByPage.push({ areaName, keys: Object.keys(changes) }),
)
