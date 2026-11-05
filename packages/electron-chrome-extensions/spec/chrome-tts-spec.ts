import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

/**
 * chrome.tts, spoken by the Web Speech API from a hidden page of the main process.
 *
 * Measured against Chromium 147 and Edge 156 on Windows (04/11/2026):
 *  - getVoices lists the platform's voices as `{voiceName, lang, remote, eventTypes}`; a native
 *    voice has no `extensionId`.
 *  - speak resolves once the utterance is queued (not when it ends), and the utterance's own
 *    `onEvent` gets `start`, `word`/`sentence` with `charIndex`, and `end` with `charIndex` at the
 *    text's length. A speak without `enqueue` interrupts the one speaking (`interrupted`) and drops
 *    the queued ones (`cancelled`); `stop` does the same.
 *  - A rate, pitch or volume out of range fails the call with Chrome's message, and so does an
 *    utterance over 32768 characters; a rejection without a callback, `lastError` with one.
 *  - `desiredEventTypes` narrows what onEvent receives.
 *
 * It was a stub: no voices, and every utterance told it had failed with "No voice available."
 *
 * A machine without a speech engine (a Linux CI without speech-dispatcher) has no voices; the cases
 * that need one say so and are skipped there rather than asserting a sound nobody can make.
 */
describe('chrome.tts', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  const outcome = (method: string, ...args: any[]) =>
    browser.crx.raw({ type: 'outcome', method, args })
  const outcomeCallback = (method: string, ...args: any[]) =>
    browser.crx.raw({ type: 'outcome-callback', method, args })
  const speak = (text: string, options: object = {}, extra: object = {}) =>
    browser.crx.raw({ type: 'tts-speak', text, options, ...extra }) as Promise<{
      resolved: boolean
      error: string | null
      events: { type: string; charIndex?: number; length?: number; errorMessage?: string }[]
    }>

  const voicesOf = async () => (await outcome('tts.getVoices')).value as any[]

  it('lists the voices of the platform in the shape Chrome does', async function () {
    this.timeout(15000)
    const voices = await voicesOf()
    expect(voices).to.be.an('array')
    for (const voice of voices) {
      expect(voice.voiceName).to.be.a('string').that.is.not.empty
      expect(voice.lang).to.be.a('string')
      expect(voice.remote).to.be.a('boolean')
      expect(voice.eventTypes).to.include.members(['start', 'end', 'error'])
      expect(voice).to.not.have.property('extensionId')
    }
    const called = await outcomeCallback('tts.getVoices')
    expect(called.lastError).to.equal(null)
    expect(called.value).to.deep.equal(voices)
  })

  it('speaks an utterance: resolves when queued, and the utterance hears start and end', async function () {
    this.timeout(30000)
    if ((await voicesOf()).length === 0) return this.skip()
    const result = await speak('Hello extensions.', { rate: 2 }, { deadline: 20000 })
    expect(result.error).to.equal(null)
    expect(result.resolved).to.equal(true)
    const types = result.events.map((event) => event.type)
    expect(types[0]).to.equal('start')
    expect(types[types.length - 1]).to.equal('end')
    expect(result.events[result.events.length - 1].charIndex).to.equal('Hello extensions.'.length)
    expect((await outcome('tts.isSpeaking')).value).to.equal(false)
  })

  it('interrupts the utterance speaking when a new one is not enqueued, and stop() cancels the rest', async function () {
    this.timeout(40000)
    if ((await voicesOf()).length === 0) return this.skip()
    const long = 'One two three four five six seven eight nine ten eleven twelve thirteen fourteen.'
    // A long first utterance, interrupted by a second one before it ends.
    const interrupted: any = await browser.crx.raw({
      type: 'tts-sequence',
      steps: [
        { action: 'speak', text: long, options: { rate: 0.5 } },
        { action: 'wait', ms: 800 },
        { action: 'isSpeaking' },
        { action: 'speak', text: 'Second.', options: { rate: 2 } },
      ],
      deadline: 20000,
    })
    expect(interrupted.probes).to.deep.equal([true])
    const [first, second] = interrupted.speaks
    expect(first.events.map((event: any) => event.type)).to.include('interrupted')
    expect(first.events.map((event: any) => event.type)).to.not.include('end')
    expect(second.events.map((event: any) => event.type)).to.include('end')

    // Enqueued behind a long one, then stopped: the speaking one is interrupted, the queued cancelled.
    const stopped: any = await browser.crx.raw({
      type: 'tts-sequence',
      steps: [
        { action: 'speak', text: long, options: { rate: 0.5 } },
        { action: 'speak', text: 'Queued.', options: { enqueue: true } },
        { action: 'wait', ms: 800 },
        { action: 'stop' },
        { action: 'isSpeaking' },
      ],
      deadline: 20000,
    })
    const [speaking, queued] = stopped.speaks
    expect(speaking.events.map((event: any) => event.type)).to.include('interrupted')
    expect(queued.events.map((event: any) => event.type)).to.include('cancelled')
    expect(stopped.probes).to.deep.equal([false])
  })

  it("delivers only the utterance's desiredEventTypes", async function () {
    this.timeout(30000)
    if ((await voicesOf()).length === 0) return this.skip()
    const result = await speak(
      'Only the end.',
      { rate: 2, desiredEventTypes: ['end'] },
      { deadline: 20000 },
    )
    expect(result.events.map((event) => event.type)).to.deep.equal(['end'])
  })

  it("fails a speak Chrome fails, with Chrome's message, without touching the queue", async function () {
    this.timeout(15000)
    expect((await speak('x', { rate: 50 })).error).to.equal('Invalid rate.')
    expect((await speak('x', { pitch: 3 })).error).to.equal('Invalid pitch.')
    expect((await speak('x', { volume: 2 })).error).to.equal('Invalid volume.')
    expect((await speak('a'.repeat(32769))).error).to.equal('Utterance length is too long.')
    const called = await outcomeCallback('tts.speak', 'x', { rate: 0 })
    expect(called.lastError).to.equal('Invalid rate.')
    expect((await outcome('tts.isSpeaking')).value).to.equal(false)
  })

  it('resolves pause and resume, and exists only with the tts permission', async () => {
    expect((await outcome('tts.pause')).value).to.equal('__undefined__')
    expect((await outcome('tts.resume')).value).to.equal('__undefined__')
    const shape = await browser.crx.eventMethod('tts.onVoicesChanged', 'hasListeners')
    expect(shape.ok, `onVoicesChanged.hasListeners failed: ${shape.error}`).to.be.true
    expect(shape.result).to.equal(false)
  })
})
