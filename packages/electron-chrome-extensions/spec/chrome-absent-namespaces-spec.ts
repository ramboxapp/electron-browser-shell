import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { useExtensionBrowser, useServer } from './hooks'

/*
  The anti-crash floor: every public namespace of desktop Chrome that Electron does not provide has
  to exist when the manifest asks for it, and only then.

  The failure it prevents was measured three times in Rambox's catalog (NordPass on chrome.privacy,
  Endpoint Verification on chrome.gcm, LastPass on chrome.windows): an access at service-worker top
  level to something undefined takes the whole extension down with nothing in any console. So this
  spec does not ask whether a namespace does anything; it asks what an extension that reaches for it
  gets back:

  - it exists with the permission (or, for omnibox, the manifest key) and not without it;
  - no method returns `undefined` where Chrome returns a promise, none throws, every promise settles;
  - every event takes a listener and answers hasListener/hasListeners.

  The few methods Chrome itself declares as returning nothing are listed below, each one checked
  against Edge 156.
*/

const fixtures = path.join(__dirname, 'fixtures')

/** Methods Chrome declares `void`: returning undefined is their shape, not a hole. */
const RETURNS_NOTHING = new Set([
  'system.display.enableUnifiedDesktop',
  'system.display.overscanCalibrationStart',
  'system.display.overscanCalibrationAdjust',
  'system.display.overscanCalibrationReset',
  'system.display.overscanCalibrationComplete',
  'system.display.startCustomTouchCalibration',
  'system.display.completeCustomTouchCalibration',
  'system.display.clearTouchCalibration',
  'tts.stop',
  'tts.pause',
  'tts.resume',
  'ttsEngine.updateVoices',
  'ttsEngine.updateLanguage',
  'ttsEngine.sendTtsEvent',
  'ttsEngine.sendTtsAudio',
  'desktopCapture.cancelChooseDesktopMedia',
  'omnibox.sendSuggestions',
])

/** Namespaces of the floor this library defines. power, system.cpu/memory and printerProvider are Electron's own. */
const FLOOR = [
  'accessibilityFeatures',
  'bookmarks',
  'browsingData',
  'contentSettings',
  'debugger',
  'declarativeContent',
  'desktopCapture',
  'history',
  'instanceID',
  'omnibox',
  'pageCapture',
  'readingList',
  'search',
  'sessions',
  'system',
  'tabCapture',
  'tabGroups',
  'tts',
  'ttsEngine',
  'webAuthenticationProxy',
]

describe('the anti-crash floor (absent namespaces)', () => {
  describe('with every permission declared', () => {
    const server = useServer()
    const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'floor-mv3' })

    it('injects every namespace of the floor', async () => {
      const present: Record<string, string> = await browser.crx.raw({ type: 'floor-present' })
      for (const ns of FLOOR) expect(present[ns], `chrome.${ns}`).to.equal('object')
    })

    it('answers every method with a promise or a value, never undefined, never a throw', async () => {
      const { members } = await browser.crx.raw({ type: 'floor-shapes' })
      const calls = Object.entries<any>(members).filter(([, m]) => m.kind === 'call')
      expect(calls.length, 'methods walked').to.be.greaterThan(80)

      const throwing = calls.filter(([, m]) => m.returned === 'throws')
      expect(throwing, 'methods that throw').to.deep.equal([])

      const undefinedReturns = calls
        .filter(([name, m]) => m.returned === 'undefined' && !RETURNS_NOTHING.has(name))
        .map(([name]) => name)
      expect(
        undefinedReturns,
        'methods returning undefined where Chrome returns a promise',
      ).to.deep.equal([])

      const pending = calls.filter(([, m]) => m.settled === 'pending').map(([name]) => name)
      expect(pending, 'promises that never settle').to.deep.equal([])

      const getterThrows = Object.entries<any>(members).filter(
        ([, m]) => m.kind === 'getter-throws',
      )
      expect(getterThrows, 'members whose read throws').to.deep.equal([])
    })

    it('gives every event the full shape', async () => {
      const { members } = await browser.crx.raw({ type: 'floor-shapes' })
      const events = Object.entries<any>(members).filter(([, m]) => m.kind === 'event')
      expect(events.length, 'events walked').to.be.greaterThan(40)
      for (const [name, event] of events) {
        expect(event.accepts, `${name}.addListener`).to.equal(true)
        expect(event.hasListener, `${name}.hasListener`).to.equal('function')
        expect(event.hasListeners, `${name}.hasListeners`).to.equal('function')
      }
    })

    it('has the constants and enums extensions read at worker top level', async () => {
      const constants: any = await browser.crx.raw({ type: 'constants' })
      expect(constants.tabs.TAB_ID_NONE).to.equal(-1)
      expect(constants.tabs.TAB_INDEX_NONE).to.equal(-1)
      expect(constants.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND).to.equal(2)
      expect(constants.tabs.WindowType.NORMAL).to.equal('normal')
      expect(constants.tabs.TabStatus.COMPLETE).to.equal('complete')
      expect(constants.windows.WindowType.POPUP).to.equal('popup')
      expect(constants.windows.WindowState.MAXIMIZED).to.equal('maximized')
      expect(constants.windows.CreateType.PANEL).to.equal('panel')
      expect(constants.contextMenus.ACTION_MENU_TOP_LEVEL_LIMIT).to.equal(6)
      expect(constants.contextMenus.ContextType.SELECTION).to.equal('selection')
      expect(constants.contextMenus.ItemType.SEPARATOR).to.equal('separator')
    })

    it('stores and answers declarativeContent rules, and its constructors need `new`', async () => {
      const result: any = await browser.crx.raw({ type: 'declarative-content' })
      expect(result.added).to.have.length(1)
      expect(result.added[0].priority).to.equal(100)
      expect(result.added[0].id).to.be.a('string')
      expect(result.added[0].conditions[0]).to.deep.equal({
        pageUrl: { hostEquals: 'x.invalid' },
        instanceType: 'declarativeContent.PageStateMatcher',
      })
      expect(result.all).to.deep.equal(result.added)
      expect(result.withoutNew).to.match(/new/)
    })

    it('answers tts.speak and tells the utterance there was no voice', async () => {
      const result: any = await browser.crx.raw({ type: 'tts-speak' })
      expect(result.event, 'onEvent never called').to.include({ type: 'error' })
    })

    it('fails stub writes through chrome.runtime.lastError / a rejection, with Chrome-like messages', async () => {
      const exec = (method: string, ...args: any[]) =>
        browser.crx.raw({ type: 'api', method, args })
      expect(await exec('bookmarks.get', '999')).to.deep.equal({
        ok: false,
        error: "Can't find bookmark for id.",
      })
      expect(await exec('tabGroups.get', 5)).to.deep.equal({
        ok: false,
        error: 'No group with id: 5.',
      })
      expect(await exec('sessions.restore', 'nope')).to.deep.equal({
        ok: false,
        error: 'Invalid session id: "nope".',
      })
      expect(
        (await exec('bookmarks.getTree')).value[0].children.map((c: any) => c.id),
      ).to.deep.equal(['1', '2'])
      expect(
        await exec('contentSettings.javascript.get', { primaryUrl: 'https://example.com/' }),
      ).to.deep.equal({
        ok: true,
        value: { setting: 'allow' },
      })
      expect((await exec('contentSettings.javascript.set', {})).ok).to.equal(false)
    })
  })

  describe('without the permissions', () => {
    const server = useServer()
    let bare: string
    before(() => {
      // The same extension with no permissions and no omnibox key.
      bare = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-floor-bare-'))
      for (const file of fs.readdirSync(path.join(fixtures, 'floor-mv3'))) {
        fs.copyFileSync(path.join(fixtures, 'floor-mv3', file), path.join(bare, file))
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(bare, 'manifest.json'), 'utf8'))
      manifest.permissions = []
      delete manifest.omnibox
      fs.writeFileSync(path.join(bare, 'manifest.json'), JSON.stringify(manifest))
    })
    after(() => fs.rmSync(bare, { recursive: true, force: true }))

    const browser = useExtensionBrowser({ url: server.getUrl, extensionPath: () => bare })

    it('injects none of them', async () => {
      const present: Record<string, string> = await browser.crx.raw({ type: 'floor-present' })
      for (const ns of FLOOR) expect(present[ns], `chrome.${ns}`).to.equal('undefined')
    })
  })
})
