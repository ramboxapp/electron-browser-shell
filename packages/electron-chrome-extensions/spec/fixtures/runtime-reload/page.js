/* global chrome */

// Ask the background to chrome.runtime.reload() — but only on the first load
// of this tab. sessionStorage survives the tab reload that the library
// performs after the extension reloads, so this guards against an infinite
// reload loop.
if (!sessionStorage.getItem('reload-sent')) {
  sessionStorage.setItem('reload-sent', '1')
  chrome.runtime.sendMessage('do-reload')
}
