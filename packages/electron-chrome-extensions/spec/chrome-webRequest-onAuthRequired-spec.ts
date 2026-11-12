import { expect } from 'chai'
import * as http from 'http'
import { AddressInfo } from 'net'
import { app } from 'electron'

import { ElectronChromeExtensions } from '../'
import { useExtensionBrowser } from './hooks'

/**
 * chrome.webRequest.onAuthRequired, which Electron's native webRequest never fires.
 *
 * Measured 04/11/2026 on 44.9.3+wvcus and 44.10.1+wvcus, with and without this library: a `401`
 * with `WWW-Authenticate: Basic` fires Electron's `login` event and the extension's listener never
 * runs (0 of 1; in Edge, 1 of 1 — Enpass and NordVPN measured). Keeper, 1Password, Enpass and
 * NordVPN register it; for the password managers it is how basic auth gets autofilled.
 *
 * The embedder hands the challenge over from its `login` handler
 * (`ElectronChromeExtensions#handleAuthRequest`), and the library delivers it the way Chrome does:
 * a 'blocking' listener answers by return value, an 'asyncBlocking' one through its callback, an
 * observer is told and not waited for, the listener's url filter is honoured, and the first
 * extension to cancel or supply credentials decides. Without any listener the call resolves at
 * once with nothing, so an embedder can always ask first.
 */
describe('chrome.webRequest.onAuthRequired', () => {
  let server: http.Server
  let url: string
  let authorizations: string[] = []

  before(async () => {
    server = http.createServer((req, res) => {
      const authorization = req.headers.authorization
      if (authorization) authorizations.push(authorization)
      if (!authorization) {
        res.writeHead(401, {
          'WWW-Authenticate': 'Basic realm="spec"',
          'Content-Type': 'text/html',
        })
        res.end('<!doctype html><title>401</title>')
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html><title>ok</title>')
    })
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
        resolve()
      }),
    )
  })
  after(() => server.close())

  // The window starts on a 200 page; each case navigates to the protected one itself.
  const browser = useExtensionBrowser({ url: () => `${url}open`, extensionName: 'rpc-mv3' })

  const listen = (
    extra: string[],
    response?: object,
    filter?: object,
    delay?: number,
    promise?: boolean,
  ) => browser.crx.raw({ type: 'auth-listen', extra, response, filter, delay, promise })
  const seen = () => browser.crx.raw({ type: 'auth-seen' }) as Promise<any[]>

  /**
   * Loads the protected page while the spec plays the embedder: its `login` handler asks the
   * library first and answers Electron with what it decided, or cancels like a prompt dismissed.
   */
  const challenge = async () => {
    const extensions = ElectronChromeExtensions.fromSession(browser.session)!
    let decision: any = 'not asked'
    const onLogin = (
      event: Electron.Event,
      webContents: Electron.WebContents | null,
      details: Electron.AuthenticationResponseDetails,
      authInfo: Electron.AuthInfo,
      callback: (username?: string, password?: string) => void,
    ) => {
      if (!webContents || webContents !== browser.webContents) return
      event.preventDefault()
      extensions
        .handleAuthRequest(webContents, { url: details.url, resourceType: 'main_frame' }, authInfo)
        .then((result) => {
          decision = result
          if (result && 'authCredentials' in result) {
            callback(result.authCredentials.username, result.authCredentials.password)
          } else {
            callback()
          }
        })
    }
    app.on('login', onLogin)
    try {
      await browser.webContents.loadURL(`${url}protected`).catch(() => {})
      // The 401 body is a page too: wait for the navigation that follows a credential.
      await new Promise((resolve) => setTimeout(resolve, 300))
    } finally {
      app.off('login', onLogin)
    }
    return decision
  }

  // Each case gets a fresh session and worker from the hook, so listeners never carry over.
  beforeEach(() => {
    authorizations = []
  })

  it('resolves nothing at once when no extension listens', async () => {
    const extensions = ElectronChromeExtensions.fromSession(browser.session)!
    const started = Date.now()
    const result = await extensions.handleAuthRequest(
      browser.webContents,
      { url },
      { isProxy: false, scheme: 'basic', host: '127.0.0.1', port: 1, realm: 'spec' },
    )
    expect(result).to.equal(undefined)
    expect(Date.now() - started).to.be.below(1000)
  })

  it('delivers the challenge to a blocking listener and uses the credentials it returns', async function () {
    this.timeout(20000)
    await listen(['blocking'], { authCredentials: { username: 'ada', password: 'lovelace' } })
    const decision = await challenge()
    expect(decision).to.deep.equal({
      authCredentials: { username: 'ada', password: 'lovelace' },
    })
    expect(authorizations).to.include(`Basic ${Buffer.from('ada:lovelace').toString('base64')}`)
    expect(await browser.webContents.getTitle()).to.equal('ok')

    const [details] = await seen()
    expect(details).to.include({
      isProxy: false,
      scheme: 'basic',
      realm: 'spec',
      statusCode: 401,
      type: 'main_frame',
      method: 'GET',
      tabId: browser.webContents.id,
    })
    expect(details.url).to.equal(`${url}protected`)
    expect(details.challenger).to.deep.equal({ host: '127.0.0.1', port: Number(new URL(url).port) })
    expect(details.requestId).to.be.a('string')
  })

  /*
    An auth id is `<requestId>:<extensionId>` and request ids are sequential: any other extension
    could answer one and hand a site's login challenge the credentials of its choice.
  */
  it('ignores an answer from an extension the challenge was not sent to', async function () {
    this.timeout(20000)
    await listen(['asyncBlocking'], { cancel: true }, undefined, 1500)
    const extensions = ElectronChromeExtensions.fromSession(browser.session)!
    const webRequest = (extensions as any).api.webRequest
    const decided = challenge()
    let authId: string | undefined
    for (let i = 0; i < 50 && !authId; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      authId = Array.from(webRequest.pending.keys() as Iterable<string>)[0]
    }
    expect(authId, 'the challenge never reached the extension').to.be.a('string')
    webRequest.authResponse({ type: 'frame', extension: { id: 'b'.repeat(32) } }, authId, {
      authCredentials: { username: 'eve', password: 'intruder' },
    })
    expect(await decided).to.deep.equal({ cancel: true })
    expect(authorizations).to.deep.equal([])
  })

  it('waits for an asyncBlocking listener, and a cancel cancels', async function () {
    this.timeout(20000)
    await listen(['asyncBlocking'], { cancel: true }, undefined, 200)
    const decision = await challenge()
    expect(decision).to.deep.equal({ cancel: true })
    expect(authorizations).to.deep.equal([])
  })

  it('tells an observer and does not wait for it, and skips a listener whose filter does not match', async function () {
    this.timeout(20000)
    await listen([], undefined)
    await listen(
      ['blocking'],
      { authCredentials: { username: 'x', password: 'y' } },
      {
        urls: ['https://never.invalid/*'],
      },
    )
    const decision = await challenge()
    expect(decision).to.equal(undefined)
    expect(authorizations).to.deep.equal([])
    const heard = await seen()
    expect(heard, 'the observer heard it, the filtered listener did not').to.have.length(1)
  })

  it('takes the promise an asyncBlocking listener returns instead of calling back', async function () {
    this.timeout(20000)
    // What 1Password and Keeper do: the callback is never called, the returned promise answers.
    await listen(
      ['asyncBlocking'],
      { authCredentials: { username: 'ada', password: 'promised' } },
      undefined,
      100,
      true,
    )
    const started = Date.now()
    const decision = await challenge()
    expect(decision).to.deep.equal({ authCredentials: { username: 'ada', password: 'promised' } })
    expect(Date.now() - started, 'a promise is an answer, not a timeout').to.be.below(5000)
    expect(await browser.webContents.getTitle()).to.equal('ok')
  })

  it('answers an asyncBlocking listener that gives nothing by moving on', async function () {
    this.timeout(20000)
    await listen(['asyncBlocking'], undefined)
    await listen(['blocking'], { authCredentials: { username: 'ada', password: 'second' } })
    const decision = await challenge()
    expect(decision).to.deep.equal({ authCredentials: { username: 'ada', password: 'second' } })
  })

  it('removes a listener, and hasListener/hasListeners say so', async () => {
    const added: any = await listen(['blocking'], { cancel: true })
    expect(added.hasListener).to.equal(true)
    const forgotten: any = await browser.crx.raw({ type: 'auth-forget' })
    expect(forgotten.hasListeners).to.equal(false)
  })
})
