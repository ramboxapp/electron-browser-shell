import debug from 'debug'

const d = debug('electron-chrome-extensions:service-worker-wake')

/**
 * Works around an apparent Electron limitation where a registered MV3
 * service worker that has gone idle doesn't reliably wake up when it
 * receives an incoming `chrome.runtime.sendMessage()` — the sender's
 * promise/callback just hangs forever instead of erroring or waking the
 * worker. Real Chrome wakes an idle service worker on demand for exactly
 * this case, since that's the whole point of the MV3 event-driven
 * background model.
 *
 * This is a distinct failure mode from the one `patchModuleServiceWorker`
 * (see `module-service-worker-patch.ts`) works around: that one is about a
 * service worker that never finishes *registering* in the first place
 * (`"type": "module"`); this one is about a worker that registered and ran
 * fine, then went idle and won't wake back up on message.
 *
 * Proactively starting the worker before anything is likely to message it —
 * right before opening a tab/window that belongs to an extension, or before
 * loading its popup — avoids the race. Safe to call unconditionally: it's a
 * no-op (silently caught) if the extension has no registered service worker
 * for this scope (e.g. MV2), or if it's already running.
 *
 * TODO(electron): re-verify this is still necessary next time Electron is
 * upgraded in a consuming app. If a recent Electron release still fails to
 * wake an idle MV3 service worker on an incoming runtime message, file it
 * upstream — this reads as an Electron bug (Chrome doesn't have this
 * problem), not something inherent to the extensions model itself.
 */
export async function wakeExtensionServiceWorker(
  session: Electron.Session,
  extensionId: string,
): Promise<void> {
  try {
    await session.serviceWorkers.startWorkerForScope(`chrome-extension://${extensionId}/`)
  } catch (error) {
    d('no service worker to wake for %s, or already running: %o', extensionId, error)
  }
}
