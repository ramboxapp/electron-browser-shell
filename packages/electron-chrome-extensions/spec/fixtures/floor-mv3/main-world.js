/* eslint-disable */
// Relays the spec's exec() into the isolated world and the results back to the test runner.
window.exec = (json) => window.postMessage(JSON.parse(json))
window.addEventListener('message', (event) => {
  const data = event.data
  if (data && data.type === 'spec-ipc') electronTest.sendIpc(data.name, ...(data.args || []))
})
