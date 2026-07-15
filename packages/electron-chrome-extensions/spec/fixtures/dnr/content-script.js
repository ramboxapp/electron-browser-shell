/* eslint-disable */

// MV3 blocks inline script injection into the page, so results are relayed
// through a postMessage handled by main-world.js instead.
function sendIpc(name, ...args) {
  window.postMessage({ type: 'spec-ipc', name, args })
}

async function exec(action) {
  const send = async () => {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(action, (result) => {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError.message)
        } else {
          resolve(result)
        }
      })
    })
  }

  // Retry logic - the connection doesn't seem to always be available when
  // attempting to send. This started when upgrading to Electron 22 from 15.
  let result
  for (let i = 0; i < 3; i++) {
    try {
      result = await send()
      break
    } catch (e) {
      console.error(e)
      await new Promise((resolve) => setTimeout(resolve, 100)) // sleep
    }
  }

  sendIpc('success', result)
}

window.addEventListener('message', (event) => {
  const data = event.data
  // Relay any command posted by the test runner to the background/service
  // worker. Exclude the 'spec-ipc' relay messages this content script itself
  // posts to main-world.js, to avoid re-entering.
  if (data && data.type && data.type !== 'spec-ipc') {
    exec(data)
  }
})

chrome.runtime.onMessage.addListener((message) => {
  switch (message.type) {
    case 'send-ipc': {
      const [name] = message.args
      sendIpc(name)
      break
    }
  }
})
