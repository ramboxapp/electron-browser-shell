import WebSocket from 'ws'
import debug from 'debug'
import { ExtensionContext } from '../../context'
import { ExtensionEvent } from '../../router'

const d = debug('electron-chrome-extensions:websocket')

/**
 * A single proxied WebSocket connection living in the main process.
 *
 * Works around an Electron bug where `WebSocket` connections fail to open from
 * an MV3 extension service-worker context (see docs/EXTENSIONS_API_MANUAL_TEST.md
 * §9 Bug #2). Node's networking is not affected, so the real socket is opened
 * here with the `ws` package and frames are relayed to the extension over IPC.
 *
 * Mirrors the transport shape of NativeMessagingHost: per-connection channels
 * keyed by `connectionId`, extension→main via `sender.ipc.on`, main→extension
 * via a wake-aware push (see `push`).
 */
export class WebSocketConnection {
  private socket?: WebSocket
  private disposed = false

  /**
   * Serializes main→extension pushes. Each push awaits the (re)started service
   * worker before sending, so without chaining, out-of-order resolution could
   * reorder a message stream. The chain preserves frame order.
   */
  private pushQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private ctx: ExtensionContext,
    private event: ExtensionEvent,
    private connectionId: string,
    url: string,
    protocols: string[] | undefined,
    /** Called once when the connection is fully torn down. */
    private onClosed: () => void,
  ) {
    // Outbound frames from the extension. Close is handled via the invoke path
    // in WebSocketAPI (it carries code/reason), so only 'send' needs a channel.
    this.event.sender.ipc.on(this.channel('send'), this.onExtensionSend)

    this.connect(url, protocols)
  }

  get extensionId() {
    return this.event.extension.id
  }

  private channel(evt: string) {
    return `crx-websocket-${evt}-${this.connectionId}`
  }

  private connect(url: string, protocols?: string[]) {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      d('invalid url %s', url)
      this.push('close', { code: 1006, reason: 'Invalid URL', wasClean: false })
      this.destroy()
      return
    }

    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      d('invalid protocol %s', parsed.protocol)
      this.push('close', { code: 1006, reason: 'Invalid protocol', wasClean: false })
      this.destroy()
      return
    }

    d('connecting %s [%s]', url, this.connectionId)

    let socket: WebSocket
    try {
      socket = new WebSocket(url, protocols && protocols.length ? protocols : undefined)
    } catch (error) {
      d('connect threw: %o', error)
      this.push('close', { code: 1006, reason: '', wasClean: false })
      this.destroy()
      return
    }

    // Deliver binary frames as Node Buffers so they serialize predictably over
    // IPC; the extension-side shim rebuilds an ArrayBuffer/Blob per binaryType.
    socket.binaryType = 'nodebuffer'
    this.socket = socket

    socket.on('open', () => {
      this.push('open', { protocol: socket.protocol, extensions: socket.extensions })
    })

    socket.on('message', (data: WebSocket.RawData, isBinary?: boolean) => {
      // ws@8 always yields a Buffer plus an `isBinary` flag; ws@7 yields a
      // string for text frames and a Buffer for binary with no flag. Normalize.
      const binary = typeof isBinary === 'boolean' ? isBinary : typeof data !== 'string'
      let payload: string | Uint8Array
      if (binary) {
        payload = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data as ArrayBuffer)
      } else {
        payload = typeof data === 'string' ? data : data.toString()
      }
      this.push('message', { data: payload, binary })
    })

    socket.on('close', (code: number, reason: Buffer) => {
      this.push('close', {
        code,
        reason: reason ? reason.toString() : '',
        // A 'close' preceded by an 'error' is unclean; ws reports 1006 in that
        // case, which the shim already surfaces as wasClean:false downstream.
        wasClean: code !== 1006,
      })
      this.destroy()
    })

    socket.on('error', (error) => {
      // WHATWG WebSocket exposes no error detail to script — a bare error event
      // is spec-correct. The subsequent 'close' carries the unclean code.
      d('socket error [%s]: %o', this.connectionId, error?.message)
      this.push('error')
    })
  }

  /** Frame sent by the extension to be written to the real socket. */
  private onExtensionSend = (_event: unknown, data: string | Uint8Array) => {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return
    try {
      this.socket.send(data)
    } catch (error) {
      d('send threw [%s]: %o', this.connectionId, error)
    }
  }

  /** Requested by the extension via WebSocketAPI's invoke-path close handler. */
  close(code?: number, reason?: string) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.close(code, reason)
        return
      } catch (error) {
        d('close threw [%s]: %o', this.connectionId, error)
      }
    }
    this.destroy()
  }

  /**
   * Pushes an event to the extension. For a service worker this goes through
   * `startWorkerForScope`, which resolves the currently-live worker and wakes
   * it if idle — the same mechanism the router uses for events, and the reason
   * incoming frames still reach a Grammarly-style checker whose SW has gone to
   * sleep. Pushes are chained to preserve order.
   */
  private push(evt: string, payload?: unknown) {
    const ipcName = this.channel(evt)
    this.pushQueue = this.pushQueue
      .then(async () => {
        if (this.disposed && evt !== 'close') return
        if (this.event.type === 'service-worker') {
          const scope = `chrome-extension://${this.event.extension.id}/`
          const serviceWorker = await this.ctx.session.serviceWorkers.startWorkerForScope(scope)
          serviceWorker.send(ipcName, payload)
        } else {
          const sender = this.event.sender as Electron.WebContents
          if (!sender.isDestroyed()) sender.send(ipcName, payload)
        }
      })
      .catch((error) => {
        d('push %s failed [%s]: %o', evt, this.connectionId, error)
      })
  }

  destroy() {
    if (this.disposed) return
    this.disposed = true

    this.event.sender.ipc.off(this.channel('send'), this.onExtensionSend)

    if (this.socket) {
      try {
        this.socket.removeAllListeners()
        this.socket.close()
      } catch {
        // ignore — socket may already be closing/closed
      }
      this.socket = undefined
    }

    this.onClosed()
  }
}
