import { BrowserWindow, session as electronSession } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

/*
  chrome.tts, spoken by the Web Speech API from a hidden page of the main process.

  Chrome's tts runs the platform's speech engine (SAPI on Windows, NSSpeechSynthesizer on macOS,
  speech-dispatcher on Linux) through TtsController. Electron ships the same engine behind
  `speechSynthesis` in any renderer, so a hidden page in a private in-memory session speaks for
  every extension of the process: its voices are the ones Chrome lists (name, lang, local or
  remote), and its utterance events map one to one onto Chrome's event types. The page talks back
  through its console — a JSON line per event — which needs no preload, no IPC channel and no file on
  disk.

  What is Chrome's and kept:
  - `speak` validates the way tts_extension_api.cc does — "Utterance length is too long." over 32768
    characters, "Invalid rate.", "Invalid pitch.", "Invalid volume." outside their ranges — and
    resolves once the utterance is queued, not when it ends.
  - Without `enqueue`, a new utterance interrupts: the one speaking gets `interrupted`, the queued
    ones `cancelled`. `stop()` does the same to everything.
  - `isSpeaking` is "there is a current utterance", paused or not.
  - Events carry `charIndex`, `length` for a `word` or `sentence`, and `errorMessage` for an `error`.

  What is not: `requiredEventTypes` is accepted and ignored (Chrome uses it to pick a voice that
  supports them; every native voice here supports the same set), `gender` is deprecated in Chrome and
  ignored, and an `extensionId` voice (one a ttsEngine extension provides) does not exist because
  `ttsEngine` is a stub.
*/

export type TtsVoice = {
  voiceName: string
  lang: string
  remote: boolean
  eventTypes: string[]
}

export type TtsEvent = {
  type: string
  charIndex?: number
  length?: number
  errorMessage?: string
}

type SpeakOptions = {
  enqueue?: boolean
  voiceName?: string
  lang?: string
  gender?: string
  rate?: number
  pitch?: number
  volume?: number
  requiredEventTypes?: string[]
  desiredEventTypes?: string[]
}

/** The events every native voice of Chrome's TtsController reports on Windows, macOS and Linux. */
const NATIVE_EVENT_TYPES = [
  'start',
  'end',
  'word',
  'sentence',
  'marker',
  'interrupted',
  'cancelled',
  'error',
  'pause',
  'resume',
]

/** Chrome's limit (tts_extension_api.cc, kMaxUtteranceLength). */
const MAX_UTTERANCE_LENGTH = 32768

const PAGE_URL = 'file:///electron-chrome-extensions/tts.html'
const CONSOLE_PREFIX = '__crx_tts__'

/*
  The speaker page. It keeps the queue Chrome keeps (one current utterance plus the enqueued ones)
  so that interrupting and stopping can tell each utterance what happened to it: the Web Speech API
  only says "error: interrupted" or "error: canceled", and Chrome's extension API distinguishes
  `interrupted` from `cancelled` and both from `error`.
*/
const PAGE = `<!doctype html><meta charset="utf-8"><script>
(() => {
  const synth = speechSynthesis
  const report = (payload) => console.log(${JSON.stringify(CONSOLE_PREFIX)} + JSON.stringify(payload))
  const queue = [] // [{ id, utterance, text }], the first one is the current one
  const emit = (id, event) => report({ kind: 'event', id, event })

  const voices = () =>
    synth.getVoices().map((voice) => ({
      voiceName: voice.name,
      lang: voice.lang,
      remote: !voice.localService,
    }))
  // Some platforms fill the list after a tick; the first call races it.
  const voicesReady = () =>
    new Promise((resolve) => {
      const have = voices()
      if (have.length) return resolve(have)
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        resolve(voices())
      }
      synth.addEventListener('voiceschanged', done, { once: true })
      setTimeout(done, 1500)
    })
  let announced = false
  synth.addEventListener('voiceschanged', () => {
    // The first fill is the list being populated, not a change.
    if (announced) report({ kind: 'voiceschanged' })
    announced = true
  })

  const drop = (entry, type) => {
    const index = queue.indexOf(entry)
    if (index >= 0) queue.splice(index, 1)
    emit(entry.id, { type, charIndex: entry.charIndex || 0 })
  }
  // Everything goes: the current one as interrupted (or the given type), the rest as cancelled.
  const clear = (currentType) => {
    const entries = queue.splice(0)
    for (const entry of entries) {
      entry.settled = true
      emit(entry.id, { type: entry === entries[0] && synth.speaking ? currentType : 'cancelled', charIndex: entry.charIndex || 0 })
    }
    synth.cancel()
  }

  window.__tts = {
    voices: voicesReady,
    isSpeaking: () => queue.length > 0 && (synth.speaking || synth.paused),
    stop: () => clear('interrupted'),
    pause: () => {
      if (!queue.length || synth.paused) return
      synth.pause()
      emit(queue[0].id, { type: 'pause', charIndex: queue[0].charIndex || 0 })
    },
    resume: () => {
      if (!queue.length || !synth.paused) return
      synth.resume()
      emit(queue[0].id, { type: 'resume', charIndex: queue[0].charIndex || 0 })
    },
    speak: async (id, text, options) => {
      if (!options.enqueue) clear('interrupted')
      const utterance = new SpeechSynthesisUtterance(text)
      const entry = { id, utterance, text, charIndex: 0, settled: false }
      const list = synth.getVoices()
      const wanted = options.voiceName
        ? list.find((voice) => voice.name === options.voiceName)
        : options.lang
          ? list.find((voice) => voice.lang === options.lang) ||
            list.find((voice) => voice.lang.split('-')[0] === String(options.lang).split('-')[0])
          : undefined
      if (wanted) utterance.voice = wanted
      else if (options.lang) utterance.lang = options.lang
      if (typeof options.rate === 'number') utterance.rate = options.rate
      if (typeof options.pitch === 'number') utterance.pitch = options.pitch
      if (typeof options.volume === 'number') utterance.volume = options.volume
      const settle = (event) => {
        if (entry.settled) return
        entry.settled = true
        const index = queue.indexOf(entry)
        if (index >= 0) queue.splice(index, 1)
        emit(id, event)
      }
      utterance.onstart = () => emit(id, { type: 'start', charIndex: 0 })
      utterance.onboundary = (event) => {
        entry.charIndex = event.charIndex
        if (event.name === 'word' || event.name === 'sentence') {
          emit(id, { type: event.name, charIndex: event.charIndex, length: event.charLength })
        }
      }
      utterance.onmark = (event) => emit(id, { type: 'marker', charIndex: event.charIndex })
      utterance.onpause = () => {}
      utterance.onresume = () => {}
      utterance.onend = () => settle({ type: 'end', charIndex: text.length })
      utterance.onerror = (event) => {
        if (event.error === 'interrupted') settle({ type: 'interrupted', charIndex: entry.charIndex })
        else if (event.error === 'canceled') settle({ type: 'cancelled', charIndex: entry.charIndex })
        else settle({ type: 'error', charIndex: entry.charIndex, errorMessage: String(event.error || 'unknown') })
      }
      queue.push(entry)
      synth.speak(utterance)
      return true
    },
  }
  report({ kind: 'ready' })
})()
</script>`

type SpeakerCallbacks = {
  onEvent: (id: string, event: TtsEvent) => void
  onVoicesChanged: () => void
}

/** The hidden speaker page, one per process, created the first time an extension needs it. */
class Speaker {
  private window?: BrowserWindow
  private ready?: Promise<Electron.WebContents>

  constructor(private callbacks: SpeakerCallbacks) {}

  private open(): Promise<Electron.WebContents> {
    if (this.ready) return this.ready
    this.ready = (async () => {
      // In memory and its own: the protocol handler touches nothing of the embedder's sessions.
      const ses = electronSession.fromPartition('electron-chrome-extensions-tts')
      ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
      if (!ses.protocol.isProtocolHandled('file')) {
        ses.protocol.handle(
          'file',
          () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
        )
      }
      // A window, not an offscreen view: the page has to be able to play audio, and timers must
      // keep running while it is hidden (an utterance's events arrive on them).
      const window = new BrowserWindow({
        show: false,
        width: 1,
        height: 1,
        webPreferences: { session: ses, backgroundThrottling: false, sandbox: true },
      })
      this.window = window
      const { webContents } = window
      const ready = new Promise<void>((resolve) => {
        const onMessage = (event: any, _level: any, message: any) => {
          const text: unknown = typeof message === 'string' ? message : event?.message
          if (typeof text !== 'string' || !text.startsWith(CONSOLE_PREFIX)) return
          let payload: any
          try {
            payload = JSON.parse(text.slice(CONSOLE_PREFIX.length))
          } catch {
            return
          }
          if (payload.kind === 'ready') resolve()
          else if (payload.kind === 'event') this.callbacks.onEvent(payload.id, payload.event)
          else if (payload.kind === 'voiceschanged') this.callbacks.onVoicesChanged()
        }
        webContents.on('console-message' as any, onMessage)
      })
      webContents.once('destroyed', () => {
        this.window = undefined
        this.ready = undefined
      })
      await webContents.loadURL(PAGE_URL)
      await ready
      return webContents
    })()
    this.ready.catch(() => {
      this.ready = undefined
    })
    return this.ready
  }

  async call<T>(expression: string): Promise<T> {
    const webContents = await this.open()
    return webContents.executeJavaScript(expression, true)
  }

  destroy() {
    if (this.window && !this.window.isDestroyed()) this.window.destroy()
  }
}

let nextUtteranceId = 0

export class TtsAPI {
  /** Which extension asked for each utterance, so its events go to that extension only. */
  private utterances = new Map<string, string>()
  private speaker: Speaker

  constructor(private ctx: ExtensionContext) {
    this.speaker = new Speaker({
      onEvent: (id, event) => {
        const extensionId = this.utterances.get(id)
        if (!extensionId) return
        if (['end', 'error', 'interrupted', 'cancelled'].includes(event.type)) {
          this.utterances.delete(id)
        }
        this.ctx.router.sendEvent(extensionId, 'tts.utteranceEvent', id, event)
      },
      onVoicesChanged: () => this.ctx.router.broadcastEvent('tts.onVoicesChanged'),
    })

    const handle = this.ctx.router.apiHandler()
    const opts = { permission: 'tts' as const }
    handle('tts.getVoices', this.getVoices, opts)
    handle('tts.speak', this.speak, opts)
    handle('tts.stop', this.stop, opts)
    handle('tts.pause', this.pause, opts)
    handle('tts.resume', this.resume, opts)
    handle('tts.isSpeaking', this.isSpeaking, opts)
  }

  private getVoices = async (): Promise<TtsVoice[]> => {
    try {
      const voices = await this.speaker.call<Omit<TtsVoice, 'eventTypes'>[]>('__tts.voices()')
      return voices.map((voice) => ({ ...voice, eventTypes: [...NATIVE_EVENT_TYPES] }))
    } catch {
      // No speech engine on this platform: no voices, which is what Chrome answers there too.
      return []
    }
  }

  /**
   * Queues an utterance. The id comes from the calling context, which routes the utterance's events
   * to the `onEvent` the extension gave; it is the only part of the call that crosses back.
   */
  private speak = async (
    event: ExtensionEvent,
    utteranceId: unknown,
    utterance: unknown,
    options: SpeakOptions | undefined = {},
  ): Promise<void> => {
    if (typeof utterance !== 'string') throw new Error('Invalid utterance.')
    if (utterance.length > MAX_UTTERANCE_LENGTH) throw new Error('Utterance length is too long.')
    const inRange = (value: unknown, min: number, max: number) =>
      value === undefined || (typeof value === 'number' && value >= min && value <= max)
    if (!inRange(options.rate, 0.1, 10)) throw new Error('Invalid rate.')
    if (!inRange(options.pitch, 0, 2)) throw new Error('Invalid pitch.')
    if (!inRange(options.volume, 0, 1)) throw new Error('Invalid volume.')
    const id =
      typeof utteranceId === 'string' && utteranceId ? utteranceId : `_${nextUtteranceId++}`
    this.utterances.set(id, event.extension.id)
    const safe = {
      enqueue: !!options.enqueue,
      voiceName: typeof options.voiceName === 'string' ? options.voiceName : undefined,
      lang: typeof options.lang === 'string' ? options.lang : undefined,
      rate: options.rate,
      pitch: options.pitch,
      volume: options.volume,
    }
    try {
      await this.speaker.call(
        `__tts.speak(${JSON.stringify(id)}, ${JSON.stringify(utterance)}, ${JSON.stringify(safe)})`,
      )
    } catch (error) {
      this.utterances.delete(id)
      throw error
    }
  }

  private stop = () => this.speaker.call<void>('__tts.stop()')
  private pause = () => this.speaker.call<void>('__tts.pause()')
  private resume = () => this.speaker.call<void>('__tts.resume()')
  private isSpeaking = async (): Promise<boolean> => {
    try {
      return await this.speaker.call<boolean>('__tts.isSpeaking()')
    } catch {
      return false
    }
  }
}
