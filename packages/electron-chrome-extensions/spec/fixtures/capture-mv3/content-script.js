/* eslint-disable */
// Forwards each exec() payload to the service worker and posts its answer back as 'success'.
window.addEventListener('message', (event) => {
  const action = event.data
  if (!action || !action.type || action.type === 'spec-ipc') return
  chrome.runtime.sendMessage(action, (result) => {
    const error = chrome.runtime.lastError
    window.postMessage({
      type: 'spec-ipc',
      name: 'success',
      args: [error ? { lastError: error.message } : result],
    })
  })
})
