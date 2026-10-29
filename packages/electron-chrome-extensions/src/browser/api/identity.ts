import { BrowserWindow } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import debug from 'debug'

const d = debug('electron-chrome-extensions:identity')

interface WebAuthFlowDetails {
  url: string
  interactive?: boolean
}

export class IdentityAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('identity.launchWebAuthFlow', this.launchWebAuthFlow.bind(this), {
      permission: 'identity',
    })
  }

  /** How long a non-interactive flow may take before it is deemed to need the user, as Chrome does. */
  static readonly NON_INTERACTIVE_TIMEOUT_MS = 30_000

  private launchWebAuthFlow = (
    event: ExtensionEvent,
    details: WebAuthFlowDetails,
  ): Promise<string | undefined> => {
    const extensionId = event.extension.id
    const redirectBase = `https://${extensionId}.chromiumapp.org`

    d(`launchWebAuthFlow [ext:${extensionId}, interactive:${details.interactive}]`)

    return new Promise<string | undefined>((resolve, reject) => {
      let settled = false

      const win = new BrowserWindow({
        show: details.interactive !== false,
        webPreferences: {
          /*
            The extension's own session, not the default one. Chrome runs the flow in the profile, so
            the provider sees the cookies the user already has there; in the default session every
            flow started signed out, and a non-interactive refresh — which only works when the
            provider recognises the session — could never succeed.
          */
          session: this.ctx.session,
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      })

      // A hidden flow that has not redirected needs the user: Chrome fails it with this message
      // rather than leaving it pending for ever behind a window nobody can see.
      const timer =
        details.interactive === false
          ? setTimeout(
              () => settle(new Error('User interaction required.')),
              IdentityAPI.NON_INTERACTIVE_TIMEOUT_MS,
            )
          : undefined

      const settle = (result: string | undefined | Error) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (!win.isDestroyed()) win.destroy()
        if (result instanceof Error) {
          reject(result)
        } else {
          resolve(result)
        }
      }

      const checkUrl = (url: string): boolean => {
        if (url.startsWith(redirectBase)) {
          d(`captured redirect URL: ${url}`)
          settle(url)
          return true
        }
        return false
      }

      win.webContents.on('will-navigate', (e, url) => {
        if (checkUrl(url)) e.preventDefault()
      })

      win.webContents.on('will-redirect', (e, url) => {
        if (checkUrl(url)) e.preventDefault()
      })

      win.on('closed', () => {
        settle(new Error('User closed the auth window'))
      })

      win.webContents.loadURL(details.url).catch(settle)
    })
  }
}
