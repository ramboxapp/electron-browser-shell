/* global chrome */

/*
  A page of the capture fixture: the one context that has a getUserMedia. The spec drives it with
  executeJavaScript; every function answers a plain object, never a MediaStream.
*/

const describeStream = (stream) => ({
  isStream: stream instanceof MediaStream,
  tracks: stream.getTracks().map((track) => ({
    kind: track.kind,
    label: track.label,
    readyState: track.readyState,
    deviceId: track.getSettings().deviceId,
  })),
})

const streams = []

/** getUserMedia with the given constraints; the stream is kept (for stopCapture) unless `release`. */
window.gum = async (constraints, release = false) => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    if (release) stream.getTracks().forEach((track) => track.stop())
    else streams.push(stream)
    return { ok: true, ...describeStream(stream) }
  } catch (error) {
    return { ok: false, name: error && error.name, error: String((error && error.message) || error) }
  }
}

window.stopCapture = () => {
  for (const stream of streams.splice(0)) stream.getTracks().forEach((track) => track.stop())
  return true
}

const tabConstraint = (streamId, extra = {}) => ({
  mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, ...extra },
})
const desktopConstraint = (streamId) => ({
  mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: streamId },
})

/** A tab capture the way Awesome Screenshot does it: one stream id on both the audio and the video. */
window.captureTab = (streamId, { audio = true } = {}) =>
  window.gum({
    ...(audio ? { audio: tabConstraint(streamId) } : {}),
    video: tabConstraint(streamId, { maxWidth: 1920, maxHeight: 1080 }),
  })

window.captureDesktop = (streamId, { audio = false } = {}) =>
  window.gum({ ...(audio ? { audio: desktopConstraint(streamId) } : {}), video: desktopConstraint(streamId) })

/** chrome.tabCapture.capture, callback-only: what the callback got, and lastError while it ran. */
window.capture = (options) =>
  new Promise((resolve) => {
    try {
      chrome.tabCapture.capture(options, (stream) => {
        const error = chrome.runtime.lastError
        if (stream) streams.push(stream)
        resolve({ stream: stream ? describeStream(stream) : stream, lastError: error ? error.message : null })
      })
    } catch (error) {
      resolve({ threw: String((error && error.message) || error) })
    }
  })

window.captureTypeOf = () => typeof chrome.tabCapture.capture

window.captureNoArgs = () => {
  try {
    chrome.tabCapture.capture()
    return 'returned'
  } catch (error) {
    return String((error && error.message) || error)
  }
}

/** chooseDesktopMedia from a page: the picker's answer, or that a cancel left the callback uncalled. */
window.choose = (sources, { cancelAfter, waitFor = 3000 } = {}) =>
  new Promise((resolve) => {
    let called = null
    let requestId
    try {
      requestId = chrome.desktopCapture.chooseDesktopMedia(sources, (streamId, options) => {
        called = { streamId, options, lastError: chrome.runtime.lastError?.message ?? null }
        if (cancelAfter === undefined) resolve({ requestId, called })
      })
    } catch (error) {
      resolve({ threw: String((error && error.message) || error) })
      return
    }
    if (cancelAfter !== undefined) {
      setTimeout(() => chrome.desktopCapture.cancelChooseDesktopMedia(requestId), cancelAfter)
      setTimeout(() => resolve({ requestId, called }), waitFor)
    } else {
      setTimeout(() => resolve({ requestId, called, timeout: true }), waitFor)
    }
  })

window.chooseThrows = (...args) => {
  try {
    chrome.desktopCapture.chooseDesktopMedia(...args)
    return 'returned'
  } catch (error) {
    return String((error && error.message) || error)
  }
}
