/* eslint-disable */

// MV3 enforces the extension CSP on the content script's isolated world, so
// inline <script> injection is blocked. This script runs in the main world
// via the "world": "MAIN" manifest key instead.

window.exec = (json) => window.postMessage(JSON.parse(json))

// Relay results from the isolated world to the test runner.
window.addEventListener('message', (event) => {
  const data = event.data
  if (data && data.type === 'spec-ipc') {
    electronTest.sendIpc(data.name, ...(data.args || []))
  }
})
