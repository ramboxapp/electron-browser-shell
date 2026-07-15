import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { WebSocketConnection } from './lib/websocket-connection'

/**
 * Proxies `WebSocket` connections opened from extension contexts through the
 * main process.
 *
 * This exists purely to work around an Electron bug: `WebSocket` connections
 * silently fail to open from an MV3 service worker in this Electron version,
 * while Node's networking in the main process is unaffected. The renderer
 * preload replaces `globalThis.WebSocket` (service workers only) with a shim
 * that routes here. See docs/EXTENSIONS_API_MANUAL_TEST.md §9 Bug #2.
 *
 * Not a Chrome API — `WebSocket` is a standard Web API and isn't permission
 * gated, so no manifest permission is required to reach these handlers.
 */
export class WebSocketAPI {
  private connections = new Map</* connectionId */ string, WebSocketConnection>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('websocket.connect', this.connect)
    handle('websocket.close', this.close)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.destroyForExtension(extension.id)
    })
  }

  private connect = (
    event: ExtensionEvent,
    connectionId: string,
    url: string,
    protocols?: string[],
  ) => {
    const connection = new WebSocketConnection(
      this.ctx,
      event,
      connectionId,
      url,
      protocols,
      () => this.connections.delete(connectionId),
    )
    this.connections.set(connectionId, connection)
  }

  private close = (
    event: ExtensionEvent,
    connectionId: string,
    code?: number,
    reason?: string,
  ) => {
    this.connections.get(connectionId)?.close(code, reason)
  }

  private destroyForExtension(extensionId: string) {
    for (const connection of this.connections.values()) {
      if (connection.extensionId === extensionId) {
        connection.destroy()
      }
    }
  }
}
