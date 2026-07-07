import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

type AlarmCreateInfo = chrome.alarms.AlarmCreateInfo

interface AlarmEntry {
  alarm: chrome.alarms.Alarm
  timer: NodeJS.Timeout
}

// Chrome only enforces its 30s minimum delay on packed extensions. All
// extensions run unpacked in Electron, so any delay is honored.
const toMs = (minutes: number) => minutes * 60 * 1000

/**
 * Implementation of the chrome.alarms API.
 *
 * Alarms are kept in memory and backed by Node timers, so they don't persist
 * across app restarts. Chrome persists them, but extensions are already
 * required to handle missed alarms after a browser restart.
 */
export class AlarmsAPI {
  private alarms = new Map</* extensionId */ string, Map</* name */ string, AlarmEntry>>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('alarms.create', this.create.bind(this))
    handle('alarms.get', this.get.bind(this))
    handle('alarms.getAll', this.getAll.bind(this))
    handle('alarms.clear', this.clear.bind(this))
    handle('alarms.clearAll', this.clearAll.bind(this))

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (event, extension) => {
      this.clearAllForExtension(extension.id)
    })
  }

  private getExtensionAlarms(extensionId: string) {
    let extensionAlarms = this.alarms.get(extensionId)
    if (!extensionAlarms) {
      extensionAlarms = new Map()
      this.alarms.set(extensionId, extensionAlarms)
    }
    return extensionAlarms
  }

  private create(event: ExtensionEvent, arg1?: string | AlarmCreateInfo, arg2?: AlarmCreateInfo) {
    const name = typeof arg1 === 'string' ? arg1 : ''
    const info: AlarmCreateInfo = (typeof arg1 === 'object' ? arg1 : arg2) || {}
    const extensionId = event.extension.id

    const extensionAlarms = this.getExtensionAlarms(extensionId)

    // Replace any existing alarm of the same name
    const existing = extensionAlarms.get(name)
    if (existing) {
      clearTimeout(existing.timer)
    }

    // 'when' is an absolute epoch time; otherwise fall back to the relative
    // delay, and lastly to the period for periodic alarms with no delay.
    const periodInMinutes = info.periodInMinutes
    const delayMs =
      typeof info.when === 'number'
        ? Math.max(info.when - Date.now(), 0)
        : toMs(info.delayInMinutes ?? periodInMinutes ?? 0)

    const alarm: chrome.alarms.Alarm = {
      name,
      scheduledTime: Date.now() + delayMs,
      ...(typeof periodInMinutes === 'number' ? { periodInMinutes } : null),
    }

    const fire = () => {
      const entry = extensionAlarms.get(name)
      if (!entry) return

      // Periodic alarms reschedule themselves; one-shot alarms are removed
      // once fired.
      if (typeof periodInMinutes === 'number') {
        entry.alarm.scheduledTime = Date.now() + toMs(periodInMinutes)
        entry.timer = setTimeout(fire, toMs(periodInMinutes))
      } else {
        extensionAlarms.delete(name)
      }

      this.ctx.router.sendEvent(extensionId, 'alarms.onAlarm', { ...entry.alarm })
    }

    extensionAlarms.set(name, { alarm, timer: setTimeout(fire, delayMs) })
  }

  private get(event: ExtensionEvent, name?: string): chrome.alarms.Alarm | undefined {
    const entry = this.alarms.get(event.extension.id)?.get(name || '')
    return entry ? { ...entry.alarm } : undefined
  }

  private getAll(event: ExtensionEvent): chrome.alarms.Alarm[] {
    const extensionAlarms = this.alarms.get(event.extension.id)
    if (!extensionAlarms) return []
    return Array.from(extensionAlarms.values()).map((entry) => ({ ...entry.alarm }))
  }

  private clear(event: ExtensionEvent, name?: string): boolean {
    const extensionAlarms = this.alarms.get(event.extension.id)
    const entry = extensionAlarms?.get(name || '')
    if (!entry) return false

    clearTimeout(entry.timer)
    extensionAlarms!.delete(name || '')
    return true
  }

  private clearAll(event: ExtensionEvent): boolean {
    this.clearAllForExtension(event.extension.id)
    return true
  }

  private clearAllForExtension(extensionId: string) {
    const extensionAlarms = this.alarms.get(extensionId)
    if (!extensionAlarms) return

    for (const entry of extensionAlarms.values()) {
      clearTimeout(entry.timer)
    }
    this.alarms.delete(extensionId)
  }
}
