importScripts('describe-icon.js')

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'worker-fetch-icon') return
  fetchIcon(message.pageUrl, message.size).then(sendResponse)
  return true
})
