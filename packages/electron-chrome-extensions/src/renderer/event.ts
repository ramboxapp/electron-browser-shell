import { ipcRenderer } from 'electron'

const formatIpcName = (name: string) => `crx-${name}`

const listenerMap = new Map<string, number>()

export const addExtensionListener = (extensionId: string, name: string, callback: Function) => {
  const listenerCount = listenerMap.get(name) || 0

  if (listenerCount === 0) {
    // TODO: should these IPCs be batched in a microtask?
    ipcRenderer.send('crx-add-listener', extensionId, name)
  }

  listenerMap.set(name, listenerCount + 1)

  ipcRenderer.addListener(formatIpcName(name), function (event, ...args) {
    if (process.env.NODE_ENV === 'development') {
      console.log(name, '(result)', ...args)
    }
    callback(...args)
  })
}

/**
 * Whether any listener is currently registered for the given event name.
 * Only tracks a count per name, not specific callback identity, so this is
 * an approximation of chrome.events.Event#hasListener/#hasListeners (which
 * check a specific callback) — good enough to answer "is anyone listening"
 * without crossing the IPC boundary to inspect actual callback references.
 */
export const hasExtensionListeners = (name: string): boolean => {
  return (listenerMap.get(name) || 0) > 0
}

export const removeExtensionListener = (extensionId: string, name: string, callback: any) => {
  if (listenerMap.has(name)) {
    const listenerCount = listenerMap.get(name) || 0

    if (listenerCount <= 1) {
      listenerMap.delete(name)

      ipcRenderer.send('crx-remove-listener', extensionId, name)
    } else {
      listenerMap.set(name, listenerCount - 1)
    }
  }

  ipcRenderer.removeListener(formatIpcName(name), callback)
}
