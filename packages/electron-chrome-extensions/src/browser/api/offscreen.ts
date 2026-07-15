import { BrowserWindow } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import debug from 'debug'

const d = debug('electron-chrome-extensions:offscreen')

interface CreateParameters {
  url: string
  reasons: string[]
  justification: string
}

/**
 * Implementation of the chrome.offscreen API using a hidden BrowserWindow per
 * extension. Chrome allows at most one offscreen document per extension.
 */
export class OffscreenAPI {
  private documents = new Map</* extensionId */ string, BrowserWindow>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('offscreen.createDocument', this.createDocument.bind(this))
    handle('offscreen.closeDocument', this.closeDocument.bind(this))
    handle('offscreen.hasDocument', this.hasDocument.bind(this))

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (event, extension) => {
      this.destroyDocument(extension.id)
    })
  }

  private getDocument(extensionId: string) {
    const win = this.documents.get(extensionId)
    if (win && !win.isDestroyed()) return win
    this.documents.delete(extensionId)
    return undefined
  }

  private destroyDocument(extensionId: string) {
    const win = this.getDocument(extensionId)
    if (win) win.destroy()
    this.documents.delete(extensionId)
  }

  private async createDocument(event: ExtensionEvent, params: CreateParameters) {
    const { extension } = event

    if (this.getDocument(extension.id)) {
      throw new Error('Only a single offscreen document may be created.')
    }

    // Resolve relative paths against the extension origin and reject any URL
    // outside of it, matching Chrome's same-origin requirement.
    const url = new URL(params.url, extension.url).href
    if (!url.startsWith(extension.url)) {
      throw new Error('URL must be same-origin with the extension.')
    }

    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: this.ctx.session,
        contextIsolation: true,
        nodeIntegration: false,
      },
    })

    this.documents.set(extension.id, win)

    // MV3 service workers can be recycled by Electron while awaiting a reply
    // from an offscreen document they just created, since nothing else
    // signals that the SW is still "doing work" during that async gap. That
    // leaves the offscreen document waiting forever for a reply from a
    // service worker that no longer exists (observed via Keeper's popup
    // hanging on "Decrypting your Vault data..." indefinitely). Pin the
    // calling SW alive for the offscreen document's full lifetime, ended via
    // the window's own 'destroyed' event so every teardown path (explicit
    // closeDocument, extension-unloaded, or an unexpected crash) is covered
    // by a single source of truth. This matches Chrome's own behavior, where
    // an open offscreen document keeps its extension's service worker alive.
    if (event.type === 'service-worker' && !event.sender.isDestroyed()) {
      const task = event.sender.startTask()
      win.webContents.once('destroyed', () => task.end())
    }

    d(`creating offscreen document for ${extension.id} [url:${url}]`)

    try {
      await win.webContents.loadURL(url)
    } catch (error) {
      this.destroyDocument(extension.id)
      throw error
    }
  }

  private closeDocument(event: ExtensionEvent) {
    const { extension } = event

    if (!this.getDocument(extension.id)) {
      throw new Error('No current offscreen document.')
    }

    this.destroyDocument(extension.id)
  }

  private hasDocument(event: ExtensionEvent): boolean {
    return Boolean(this.getDocument(event.extension.id))
  }
}
