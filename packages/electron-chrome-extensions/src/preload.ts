import { contextBridge } from 'electron'
import { injectExtensionAPIs } from './renderer'

/**
 * The URL of the context this preload runs for.
 *
 * In a page or frame the preload world has `location`. In a service worker it has none (nor `self`):
 * only the main world does, reached through `contextBridge.executeInMainWorld`, which returns the
 * function's result synchronously.
 */
const contextUrl = (): string => {
  if (typeof location !== 'undefined') return String(location.href)
  try {
    if ('executeInMainWorld' in contextBridge) {
      return String(
        (contextBridge as any).executeInMainWorld({
          func: () => String((globalThis as any).location?.href ?? ''),
        }),
      )
    }
  } catch {
    // Fall through: an unknown context gets nothing.
  }
  return ''
}

// Only load within an extension's own contexts: its pages and its service worker.
//
// The session registers this file as a `service-worker` preload too, and Electron runs those in
// EVERY service worker of the session — a web page's worker included (WhatsApp Web's, measured in
// Rambox on 28/10/2026). Entering on `process.type === 'service-worker'` alone exposed the
// extension IPC bridge (`electron`) to a site's worker and tried to bolt `chrome.*` onto it, which
// Chrome never does. A worker's location is its script URL, so one origin check covers both.
const url = contextUrl()
const ownExtensionId = /^chrome-extension:\/\/([^/?#]+)/.exec(url)?.[1]
if (ownExtensionId) {
  // Every IPC this context sends to the main process names this id, whatever the page passes: the
  // router checks it against the sender's origin (see getSenderExtensionId in browser/router.ts).
  injectExtensionAPIs(ownExtensionId)
}
