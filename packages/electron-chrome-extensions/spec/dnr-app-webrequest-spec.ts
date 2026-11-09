import { expect } from 'chai'
import { BrowserWindow } from 'electron'
import * as http from 'node:http'
import * as path from 'node:path'
import { AddressInfo } from 'node:net'

import { createCrxSession } from './crx-helpers'
import { ElectronChromeExtensions } from '../'

/**
 * What an app-level `session.webRequest` listener does to an extension's declarativeNetRequest rules.
 *
 * This is the question behind "uBlock is enabled in Rambox and blocks nothing". Rambox installs a
 * catch-all `onBeforeRequest({ urls: ['<all_urls>'] })` on every service session — it has to, for the
 * Remote Config block rules and the OAuth loopback rewrite — and that listener lives on the very
 * session the extensions are loaded into. Everything else checked out: the rule budget is 330,000,
 * regexFilter and modifyHeaders do not poison a ruleset, 88,772 rules across three rulesets load and
 * enforce, a `<webview>` guest in the extension's partition is filtered, and rule priority is not it.
 *
 * So this spec asks the one remaining question directly, with a listener that does nothing but let
 * every request through.
 */
describe('declarativeNetRequest with an app-level webRequest listener', () => {
  const fixtures = path.join(__dirname, 'fixtures')
  let server: http.Server
  let url: string
  let win: BrowserWindow
  let customSession: Electron.Session

  before(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!doctype html><title>host</title>ok')
    })
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
        resolve()
      }),
    )
  })

  after(() => {
    server.close()
  })

  let seen = 0

  const installAppListener = () => {
    seen = 0
    customSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (_details, callback) => {
      seen += 1
      // The shape Rambox uses: decide nothing, let it through.
      callback({})
    })
  }

  const loadDnrExtension = () => customSession.loadExtension(path.join(fixtures, 'dnr'))

  beforeEach(async () => {
    customSession = createCrxSession().session
    new ElectronChromeExtensions({
      license: 'internal-license-do-not-use' as any,
      session: customSession,
      async createTab() {
        throw new Error('not used')
      },
    })
    win = new BrowserWindow({
      show: false,
      webPreferences: { session: customSession, nodeIntegration: false, contextIsolation: true },
    })
  })

  afterEach(() => {
    customSession.webRequest.onBeforeRequest(null)
    if (win && !win.isDestroyed()) win.destroy()
  })

  const fetchResult = () =>
    win.webContents.executeJavaScript(
      `fetch('${url}dnr-static-blocked?x='+Date.now()).then(() => 'fetched', () => 'blocked')`,
    ) as Promise<'fetched' | 'blocked'>

  /** The library enables the manifest ruleset at service-worker startup, which is async. */
  const waitForRule = async () => {
    for (let i = 0; i < 80; i++) {
      if ((await fetchResult()) === 'blocked') return true
      await new Promise((r) => setTimeout(r, 100))
    }
    return false
  }

  it('sees ordinary requests, and never sees the ones the ruleset blocks', async () => {
    await loadDnrExtension()
    await win.loadURL(url)
    expect(await waitForRule(), 'the ruleset never took effect').to.be.true

    installAppListener()
    const allowed = (await win.webContents.executeJavaScript(
      `fetch('${url}dnr-static-allowed?x='+Date.now()).then(() => 'fetched', () => 'blocked')`,
    )) as string
    const blocked = await fetchResult()
    console.log(
      `[dnr-webrequest] after-load listener: allowed=${allowed} blocked=${blocked} seen=${seen}`,
    )

    expect(allowed, 'an allowed request still goes through').to.equal('fetched')
    // Measured: once the extension's DNR owns the session, the app-level listener is not consulted at
    // all — not even for the requests that go through. The two layers are mutually exclusive, and the
    // one installed first wins the session.
    expect(seen, 'the app listener is not consulted once DNR owns the session').to.equal(0)
    expect(blocked).to.equal('blocked')
  })

  it('displaces the ruleset entirely when it is installed before the extension loads', async function () {
    // waitForRule polls for 8 s when the rule never takes, which is the expected outcome here; with
    // the extension load on top, the default 10 s timed out in the full run on 45.2.1 (09/11/2026)
    // while the spec alone passed.
    this.timeout(30000)
    // Rambox's order: the catch-all listener goes on at web-contents-created, before a profile's
    // extensions are loaded into that session.
    installAppListener()
    await loadDnrExtension()
    await win.loadURL(url)

    const enforced = await waitForRule()
    console.log(`[dnr-webrequest] listener-first: ruleset enforced=${enforced} seen=${seen}`)
    expect(seen, 'the listener never ran at all').to.be.greaterThan(0)
    /*
      THIS is why uBlock blocks nothing in Rambox. The app-level listener was there first, so the
      extension's rules — loaded, enabled and correct — are never consulted for anything in that
      session. Asserted as `false` because that is what Electron does today: the day it composes the
      two layers instead of letting one displace the other, this fails and the host can drop its
      workaround.
    */
    expect(
      enforced,
      'an app-level onBeforeRequest listener no longer displaces the extension ruleset',
    ).to.be.false
  })

  it('gives the session back to the ruleset when the listener is removed before the extension loads', async () => {
    /*
      The shape of the host-side fix: install the catch-all only while something needs it, and take it
      off again. That only works if removal actually hands the session back, which is what this pins.
    */
    installAppListener()
    customSession.webRequest.onBeforeRequest(null)

    await loadDnrExtension()
    await win.loadURL(url)

    const enforced = await waitForRule()
    console.log(`[dnr-webrequest] installed-then-removed: ruleset enforced=${enforced}`)
    expect(enforced, 'removing the listener did not give the session back to the ruleset').to.be
      .true
  })

  it('does NOT give the session back once the extension has already loaded', async function () {
    // Two waitForRule() rounds at 8s each do not fit in mocha's default 10s.
    this.timeout(40000)
    // The other order: rules arrive from Remote Config while the profile is already running, then go
    // away. If this one fails, a session that ever had a block rule stays poisoned until restart.
    installAppListener()
    await loadDnrExtension()
    await win.loadURL(url)
    expect(
      await fetchResult(),
      'sanity: the listener should be displacing the ruleset here',
    ).to.equal('fetched')

    customSession.webRequest.onBeforeRequest(null)
    const enforced = await waitForRule()
    console.log(`[dnr-webrequest] removed-after-load: ruleset enforced=${enforced}`)
    /*
      Measured: once the listener has taken the session, removing it does not hand it back — the
      ruleset stays inert until the session is recreated. That is what makes the fix one-directional:
      a host must not install the catch-all BEFORE the extensions load, because there is no undo.
    */
    expect(enforced, 'removing the listener now restores the ruleset — the fix can be simpler').to
      .be.false
  })
})
