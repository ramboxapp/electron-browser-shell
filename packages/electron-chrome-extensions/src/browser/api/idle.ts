import { powerMonitor } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

type IdleState = chrome.idle.IdleState

// Defaults mirror Chrome: 60s detection interval, 15s allowed minimum.
const DEFAULT_DETECTION_INTERVAL = 60
const MIN_DETECTION_INTERVAL = 15
// Poll at the minimum detection interval so state changes are never missed.
const POLL_INTERVAL_MS = 15 * 1000

const getIdleState = (detectionIntervalSeconds: number): IdleState => {
  const state = powerMonitor.getSystemIdleState(detectionIntervalSeconds)
  // Chrome has no 'unknown' state
  return state === 'unknown' ? 'active' : state
}

/**
 * Implementation of the chrome.idle API on top of Electron's powerMonitor.
 * The onStateChanged event is emitted by polling since powerMonitor exposes
 * no equivalent event.
 */
export class IdleAPI {
  private detectionIntervals = new Map</* extensionId */ string, number>()
  private lastStates = new Map</* extensionId */ string, IdleState>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('idle.queryState', this.queryState.bind(this))
    handle('idle.setDetectionInterval', this.setDetectionInterval.bind(this))
    handle('idle.getAutoLockDelay', this.getAutoLockDelay.bind(this))

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (event, extension) => {
      this.detectionIntervals.delete(extension.id)
      this.lastStates.delete(extension.id)
    })

    // unref() so the polling timer doesn't keep the process alive on quit.
    setInterval(this.pollStates, POLL_INTERVAL_MS).unref()
  }

  private queryState(event: ExtensionEvent, detectionIntervalInSeconds: number): IdleState {
    return getIdleState(Math.max(detectionIntervalInSeconds, MIN_DETECTION_INTERVAL))
  }

  private setDetectionInterval(event: ExtensionEvent, intervalInSeconds: number) {
    this.detectionIntervals.set(
      event.extension.id,
      Math.max(intervalInSeconds, MIN_DETECTION_INTERVAL),
    )
  }

  private getAutoLockDelay(): number {
    // Only meaningful on ChromeOS; Chrome returns 0 on other desktop platforms.
    return 0
  }

  private pollStates = () => {
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session

    for (const extension of sessionExtensions.getAllExtensions()) {
      const interval = this.detectionIntervals.get(extension.id) ?? DEFAULT_DETECTION_INTERVAL
      const state = getIdleState(interval)
      const lastState = this.lastStates.get(extension.id)

      if (state !== lastState) {
        this.lastStates.set(extension.id, state)
        // Skip the initial transition observed for each extension
        if (lastState) {
          this.ctx.router.sendEvent(extension.id, 'idle.onStateChanged', state)
        }
      }
    }
  }
}
