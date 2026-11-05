import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { hostPermissionCovers } from './lib/host-permissions'
import debug from 'debug'

const d = debug('electron-chrome-extensions:webRequest')

/*
  chrome.webRequest.onAuthRequired, delivered from the embedder's `login` event.

  Electron implements chrome.webRequest natively, and since 44.10 every event of it reaches an MV3
  service worker — except this one. Measured on 04/11/2026 (44.9.3+wvcus and 44.10.1+wvcus, with and
  without this library): a `401` with `WWW-Authenticate: Basic` fires the `login` event of `app` and
  of the webContents, and the extension's listener never runs; in Edge it runs. Chromium routes the
  challenge to the extension's listener before the browser's own dialog; Electron routes it to the
  embedder only. So the embedder is the one that can hand it to the extensions, and this is the
  half it hands it to.

  The embedder calls `ElectronChromeExtensions#handleAuthRequest` from its `login` handler, before
  showing its own prompt. The extensions that registered `onAuthRequired` with a blocking spec and
  hold a host permission for the URL are asked one at a time, in registration order, as Chrome asks
  them; the first to answer with credentials or a cancel decides, and one that only observes is told
  and skipped. No answer from anyone means the embedder goes on with its prompt.

  The preload replaces the native, silent `onAuthRequired` event object with one wired to this
  class (see the `webRequest` section of mainWorldScript in src/renderer/index.ts); it keeps the
  listener's `filter` and `extraInfoSpec` on its side and answers through `webRequest.authResponse`.
  Keeper, 1Password, Enpass and NordVPN register it; for the password managers it is how basic auth
  gets autofilled.
*/

export type AuthRequestDetails = {
  url: string
  method?: string
  /** What the embedder knows of the resource: a navigation of the tab, or anything else. */
  resourceType?: chrome.webRequest.ResourceType
}

export type AuthRequestDecision =
  | { cancel: true }
  | { authCredentials: { username: string; password: string } }

type AuthResponse = { cancel?: boolean; authCredentials?: { username: unknown; password: unknown } }

/** How long an extension may take to answer before it counts as not answering: Chrome waits for ever. */
const RESPONSE_TIMEOUT_MS = 30_000

let nextRequestId = 1

export class WebRequestAPI {
  private pending = new Map<string, (response: AuthResponse | undefined) => void>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('webRequest.authResponse', this.authResponse)
  }

  /** The extension's answer to one challenge, through the preload. */
  private authResponse = (_event: ExtensionEvent, authId: unknown, response: unknown) => {
    if (typeof authId !== 'string') return
    const settle = this.pending.get(authId)
    if (!settle) return
    settle(response && typeof response === 'object' ? (response as AuthResponse) : undefined)
  }

  /**
   * Offers a `login` challenge to the extensions listening for it.
   *
   * Resolves the decision of the first extension that cancels or supplies credentials, and
   * `undefined` when none does — including when none listens, in which case it resolves at once.
   */
  async handleAuthRequest(
    webContents: Electron.WebContents | null | undefined,
    request: AuthRequestDetails,
    authInfo: Electron.AuthInfo,
  ): Promise<AuthRequestDecision | undefined> {
    const listening = this.ctx.router.listeningExtensions('webRequest.onAuthRequired')
    if (listening.length === 0) return undefined

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    const candidates = listening.filter((extensionId) => {
      const extension = sessionExtensions.getExtension(extensionId)
      if (!extension) return false
      const manifest: chrome.runtime.Manifest = extension.manifest || {}
      const permissions = (manifest.permissions as string[]) || []
      if (!permissions.includes('webRequest')) return false
      // A proxy challenge is not about the site, so no host permission can be asked for it.
      return authInfo.isProxy || hostPermissionCovers(extension, request.url)
    })
    if (candidates.length === 0) return undefined

    const tab =
      webContents && !webContents.isDestroyed() && this.ctx.store.tabs.has(webContents)
        ? webContents
        : undefined
    const isNavigation =
      !authInfo.isProxy &&
      !!webContents &&
      !webContents.isDestroyed() &&
      (request.resourceType === 'main_frame' ||
        (request.resourceType === undefined && webContents.isLoadingMainFrame()))
    const details = {
      challenger: { host: authInfo.host, port: authInfo.port },
      documentLifecycle: 'active',
      frameId: 0,
      frameType: 'outermost_frame',
      isProxy: !!authInfo.isProxy,
      method: request.method || 'GET',
      parentFrameId: -1,
      realm: authInfo.realm,
      requestId: String(nextRequestId++),
      scheme: authInfo.scheme,
      statusCode: authInfo.isProxy ? 407 : 401,
      statusLine: authInfo.isProxy
        ? 'HTTP/1.1 407 Proxy Authentication Required'
        : 'HTTP/1.1 401 Unauthorized',
      tabId: tab ? tab.id : -1,
      timeStamp: Date.now(),
      type: request.resourceType || (isNavigation ? 'main_frame' : 'other'),
      url: request.url,
    }

    // Every extension is asked at once, as Chrome asks them, and the answers are read in order:
    // the first extension (by registration) that cancels or supplies credentials decides, whether
    // or not a later one is still thinking. Asking one at a time cost a full timeout per silent one.
    const answers = candidates.map((extensionId) => this.ask(extensionId, details))
    for (let index = 0; index < candidates.length; index++) {
      const extensionId = candidates[index]
      const response = await answers[index]
      d('%s answered %o for %s', extensionId, response, request.url)
      if (!response) continue
      if (response.cancel === true) return { cancel: true }
      const credentials = response.authCredentials
      if (credentials && typeof credentials === 'object') {
        return {
          authCredentials: {
            username: String(credentials.username ?? ''),
            password: String(credentials.password ?? ''),
          },
        }
      }
    }
    return undefined
  }

  private ask(extensionId: string, details: object): Promise<AuthResponse | undefined> {
    const authId = `${details && (details as any).requestId}:${extensionId}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => settle(undefined), RESPONSE_TIMEOUT_MS)
      const settle = (response: AuthResponse | undefined) => {
        clearTimeout(timer)
        this.pending.delete(authId)
        resolve(response)
      }
      this.pending.set(authId, settle)
      this.ctx.router.sendEvent(extensionId, 'webRequest.onAuthRequired', details, authId)
    })
  }
}
