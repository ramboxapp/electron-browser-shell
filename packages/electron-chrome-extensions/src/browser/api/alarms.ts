import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

type AlarmCreateInfo = chrome.alarms.AlarmCreateInfo

interface AlarmEntry {
  alarm: chrome.alarms.Alarm
  timer: NodeJS.Timeout
}

const toMs = (minutes: number) => minutes * 60 * 1000

// Chrome's minimum alarm interval (30s) applies to every extension a real
// end user installs from the Web Store — this "packed" install path is the
// ONLY one any extension in this fleet is ever actually used through in
// practice. Chrome's exemption from this clamp is documented specifically
// for an extension author's own "Load unpacked" debugging session, which is
// not what's happening here even though `session.extensions.loadExtension()`
// is technically Electron's only loading mechanism either way.
const MIN_DELAY_MS = 30 * 1000
// A NaN delay would otherwise defeat this clamp: Math.max(NaN, ...) is NaN,
// and Node's setTimeout(fn, NaN) fires on the next tick instead of never.
// typeof NaN === 'number', so a naive `typeof x === 'number'` check (used
// everywhere below via Number.isFinite instead) would wrongly treat it as a
// valid, present value. Not the cause of the real reported bug (see
// MAX_TIMEOUT_MS below), but a real edge case worth guarding regardless.
const clampDelayMs = (ms: number) => (Number.isFinite(ms) ? Math.max(ms, MIN_DELAY_MS) : MIN_DELAY_MS)

// Node's setTimeout silently overflows when the delay doesn't fit in a
// signed 32-bit integer (~24.8 days): instead of erroring, it emits a
// TimeoutOverflowWarning and fires almost immediately instead of waiting.
// Chrome alarms have no such ceiling — confirmed live against the actual
// reported bug (Keeper's real 'logoutTimer' redirecting users back to login
// a couple seconds after every successful login): its `when` was a genuine,
// finite ~30-day-out timestamp (requested delay 2591999999ms), just over
// Node's 2147483647ms cap, which is exactly why it kept firing within
// milliseconds of creation despite the 30s-minimum clamp above already
// being correct. Long delays are chained through MAX_TIMEOUT_MS-sized hops
// (see scheduleLongTimeout) so the real remaining time is actually covered.
const MAX_TIMEOUT_MS = 2 ** 31 - 1

// Runs `fn` after `delayMs`, chaining through MAX_TIMEOUT_MS-sized hops as
// needed (see MAX_TIMEOUT_MS above). `onSchedule` is invoked synchronously
// with whichever native timer is currently outstanding — including on every
// intermediate hop — so callers can keep a single mutable reference current
// for cancellation; clearTimeout on a stale hop's timer would do nothing
// once a later hop has replaced it.
const scheduleLongTimeout = (
  fn: () => void,
  delayMs: number,
  onSchedule: (timer: NodeJS.Timeout) => void,
) => {
  if (delayMs > MAX_TIMEOUT_MS) {
    onSchedule(
      setTimeout(() => scheduleLongTimeout(fn, delayMs - MAX_TIMEOUT_MS, onSchedule), MAX_TIMEOUT_MS),
    )
  } else {
    onSchedule(setTimeout(fn, delayMs))
  }
}

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

    // Chrome requires at least one of these to be a real, finite number — not
    // just "not undefined". A caller that supplies none, or supplies NaN,
    // must not silently fall through to a near-0ms delay — that fires the
    // alarm on the next tick instead of never. Number.isFinite is used
    // everywhere below instead of `typeof x === 'number'` for exactly this
    // reason: NaN's typeof is 'number', so that check alone lets it
    // through. Validated before touching any existing alarm of the same
    // name, matching Chrome: a rejected create() must not cancel what was
    // there before.
    if (
      !Number.isFinite(info.when) &&
      !Number.isFinite(info.delayInMinutes) &&
      !Number.isFinite(info.periodInMinutes)
    ) {
      throw new Error('Either when or delayInMinutes must be specified.')
    }

    // Replace any existing alarm of the same name
    const existing = extensionAlarms.get(name)
    if (existing) {
      clearTimeout(existing.timer)
    }

    // 'when' is an absolute epoch time; otherwise fall back to the relative
    // delay, and lastly to the period for periodic alarms with no delay.
    // Chrome clamps all three to the 30s minimum (see clampDelayMs above) —
    // including 'when' set less than 30s in the future, per the spec.
    const periodInMinutes = Number.isFinite(info.periodInMinutes) ? info.periodInMinutes : undefined
    const requestedDelayMs = Number.isFinite(info.when)
      ? Math.max(info.when! - Date.now(), 0)
      : toMs(
          (Number.isFinite(info.delayInMinutes) ? info.delayInMinutes : undefined) ??
            periodInMinutes ??
            0,
        )
    const delayMs = clampDelayMs(requestedDelayMs)

    const alarm: chrome.alarms.Alarm = {
      name,
      scheduledTime: Date.now() + delayMs,
      ...(typeof periodInMinutes === 'number' ? { periodInMinutes } : null),
    }

    const fire = () => {
      const entry = extensionAlarms.get(name)
      if (!entry) return

      // Periodic alarms reschedule themselves; one-shot alarms are removed
      // once fired. The clamp (and the long-delay chaining below it) apply
      // to every repeat, not just the first.
      if (typeof periodInMinutes === 'number') {
        const nextDelayMs = clampDelayMs(toMs(periodInMinutes))
        entry.alarm.scheduledTime = Date.now() + nextDelayMs
        scheduleLongTimeout(fire, nextDelayMs, (timer) => {
          entry.timer = timer
        })
      } else {
        extensionAlarms.delete(name)
      }

      this.ctx.router.sendEvent(extensionId, 'alarms.onAlarm', { ...entry.alarm })
    }

    // `timer` is assigned synchronously by scheduleLongTimeout below, before
    // this entry can be read anywhere else (map lookups, clear(), etc.).
    const entry = { alarm } as AlarmEntry
    scheduleLongTimeout(fire, delayMs, (timer) => {
      entry.timer = timer
    })
    extensionAlarms.set(name, entry)
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
