/* A dedicated worker the content script starts from an extension URL. */
self.addEventListener('message', (event) => {
  self.postMessage(event.data === 'ping' ? 'pong-from-worker' : 'unexpected: ' + event.data)
})
