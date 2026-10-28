// Mirrors Google Translate 2.0.18: its only context menu item is created in onInstalled, and
// nowhere else. Each delivery is reported on the console, where the spec reads it.
chrome.runtime.onInstalled.addListener((details) => {
  console.log('oninstalled ' + JSON.stringify(details))
  chrome.contextMenus.create({ id: 'translate', title: 'Translate', contexts: ['selection'] })
})

// Leaves the extension's storage on disk, which is how the library tells an extension that was
// already here before its install record existed from a first install.
chrome.storage.local.set({ ran: Date.now() }, () => console.log('storage-written'))
