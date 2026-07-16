import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.alarms', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })

  describe('create()', () => {
    it('creates an alarm retrievable by get()', async () => {
      await browser.crx.exec('alarms.create', 'test-alarm', { delayInMinutes: 1 })
      const alarm = await browser.crx.exec('alarms.get', 'test-alarm')
      expect(alarm).to.be.an('object')
      expect(alarm.name).to.equal('test-alarm')
      expect(alarm.scheduledTime).to.be.a('number')
    })

    it('replaces an existing alarm of the same name', async () => {
      await browser.crx.exec('alarms.create', 'dupe', { delayInMinutes: 1 })
      await browser.crx.exec('alarms.create', 'dupe', { delayInMinutes: 2 })
      const alarms = await browser.crx.exec('alarms.getAll')
      expect(alarms).to.have.lengthOf(1)
    })

    it('fires onAlarm', async function () {
      // Real Chrome clamps every alarm to a 30s minimum for extensions
      // installed the only way any extension in this fleet ever is (see
      // clampDelayMs's doc comment in alarms.ts) — waiting out the clamp for
      // real is the only way to confirm firing genuinely still works end to
      // end, so this test needs more than mocha's default 10s timeout.
      this.timeout(40000)
      await browser.crx.exec('alarms.create', 'quick-alarm', { delayInMinutes: 0.01 })
      const [alarm] = await browser.crx.eventOnce('alarms.onAlarm')
      expect(alarm.name).to.equal('quick-alarm')
    })

    it('clamps delayInMinutes below 30s to the 30s minimum instead of firing immediately', async () => {
      // Regression test for the actual reported bug: Keeper's 'logoutTimer'
      // alarm — created with delayInMinutes at or near 0 — fired on
      // essentially the next tick instead of after a real timeout, which
      // Keeper read as an expired session and logged the user straight back
      // out on every login. Verified via the clamped scheduledTime instead
      // of waiting for a real fire, so this stays fast.
      const before = Date.now()
      await browser.crx.exec('alarms.create', 'near-zero-delay', { delayInMinutes: 0 })
      const alarm = await browser.crx.exec('alarms.get', 'near-zero-delay')
      expect(alarm.scheduledTime - before).to.be.at.least(29000)
    })

    it('treats a NaN when/delayInMinutes/periodInMinutes as if none were given, instead of firing immediately', async () => {
      // Regression test for the actual root cause behind the reported bug:
      // `typeof NaN === 'number'` is true, so a naive `typeof x === 'number'`
      // check (what this code used before) treats NaN as a valid, present
      // value — and `Math.max(NaN, 30000)` is NaN, so `setTimeout(fire, NaN)`
      // fires on the next tick rather than after any real delay, silently
      // bypassing the 30s clamp entirely. Reproduced live against real
      // Keeper: its 'logoutTimer' alarm's `when` was apparently NaN (likely
      // computed from an internal "time remaining" value not yet populated),
      // firing in ~6ms even with the (NaN-blind) clamp from the prior fix in
      // place. Number.isFinite(NaN) is false, so this now falls through to
      // the same "no valid timing field" rejection as the empty-options case
      // below, rather than scheduling anything.
      // NaN can't survive the RPC bridge as a literal arg (JSON.stringify(NaN)
      // is 'null'), so the rpc fixture reconstructs it from a marker object —
      // see background.js's transformArg.
      await browser.crx.exec('alarms.create', 'nan-when', { when: { __NAN__: true } })

      const alarm = await browser.crx.exec('alarms.get', 'nan-when')
      expect(alarm, 'nan-when alarm should never have been scheduled').to.not.exist
    })

    it('does not fire early when the delay exceeds Node setTimeout\'s 32-bit limit (~24.8 days)', async function () {
      // Regression test for the actual confirmed root cause of the reported
      // bug: Keeper's real 'logoutTimer' alarm used a `when` ~30 days out
      // (a genuine, finite timestamp — not NaN, ruling out that earlier
      // hypothesis). Node's setTimeout silently overflows for delays above
      // 2147483647ms (~24.8 days): instead of throwing, it fires within ~1ms
      // instead of waiting, which is exactly what made the alarm re-fire and
      // log the user straight back out a couple seconds after every login.
      // Confirmed live via a debug log capturing Node's own
      // TimeoutOverflowWarning for this exact alarm. scheduleLongTimeout
      // chains delays past the cap through smaller hops instead.
      this.timeout(5000)
      const before = Date.now()
      const twentyFiveDaysInMinutes = 25 * 24 * 60 // > MAX_TIMEOUT_MS (~24.8 days)
      await browser.crx.exec('alarms.create', 'long-delay', {
        delayInMinutes: twentyFiveDaysInMinutes,
      })

      const alarm = await browser.crx.exec('alarms.get', 'long-delay')
      expect(alarm.scheduledTime - before).to.be.at.least(twentyFiveDaysInMinutes * 60 * 1000 - 5000)

      // Give a (possibly chained) timer a moment to misfire the way the
      // overflow bug did -- it must not fire for actual days.
      await new Promise((resolve) => setTimeout(resolve, 300))
      const stillScheduled = await browser.crx.exec('alarms.get', 'long-delay')
      expect(stillScheduled, 'long-delay alarm fired prematurely due to setTimeout overflow').to.exist
    })

    it('does not schedule an alarm when neither when, delayInMinutes, nor periodInMinutes is given', async () => {
      // Regression test: the browser-side handler used to fall through to a
      // 0ms delay in this case, firing onAlarm on the next tick instead of
      // never — observed via Keeper creating a 'logoutTimer' with no timing
      // fields, which fired immediately and looked like an elapsed session
      // timeout, logging the user straight back out after every login.
      await browser.crx.exec('alarms.create', 'no-timing', {})

      const alarm = await browser.crx.exec('alarms.get', 'no-timing')
      expect(alarm, 'no-timing alarm should never have been scheduled').to.not.exist

      const all = await browser.crx.exec('alarms.getAll')
      expect(all.map((a: chrome.alarms.Alarm) => a.name)).to.not.include('no-timing')
    })
  })

  describe('getAll()', () => {
    it('returns all alarms for the extension', async () => {
      await browser.crx.exec('alarms.create', 'one', { delayInMinutes: 1 })
      await browser.crx.exec('alarms.create', 'two', { delayInMinutes: 1 })
      const alarms = await browser.crx.exec('alarms.getAll')
      expect(alarms.map((alarm: any) => alarm.name)).to.have.members(['one', 'two'])
    })
  })

  describe('clear()', () => {
    it('clears an alarm by name', async () => {
      await browser.crx.exec('alarms.create', 'to-clear', { delayInMinutes: 1 })
      const cleared = await browser.crx.exec('alarms.clear', 'to-clear')
      expect(cleared).to.be.true
      const alarm = await browser.crx.exec('alarms.get', 'to-clear')
      // undefined becomes null when serialized through the messaging channel
      expect(alarm).to.not.exist
    })

    it('returns false for unknown alarms', async () => {
      const cleared = await browser.crx.exec('alarms.clear', 'unknown')
      expect(cleared).to.be.false
    })
  })

  describe('clearAll()', () => {
    it('clears all alarms', async () => {
      await browser.crx.exec('alarms.create', 'one', { delayInMinutes: 1 })
      await browser.crx.exec('alarms.create', 'two', { delayInMinutes: 1 })
      const cleared = await browser.crx.exec('alarms.clearAll')
      expect(cleared).to.be.true
      const alarms = await browser.crx.exec('alarms.getAll')
      expect(alarms).to.be.empty
    })
  })
})
