import { session as electronSession, WebContentsView } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { fontSettingsSchemaError, GENERIC_FAMILIES } from '../../shared/font-settings-schema'

/*
  chrome.fontSettings, answered from what this process really uses.

  Measured on 30/10/2026 in Chromium 147 (Windows) and Electron 44.9.3+wvcus / 43.0.0:

  - `getFontList` in Chrome is the DirectWrite system collection (fontconfig on Linux, CoreText on
    macOS): one `{fontId, displayName}` per family, sorted by fontId code unit by code unit — so
    "MV Boli" comes before "Magneto". Electron has no API for it, but the renderer has the Local Font
    Access API, which enumerates through the same platform code: from an offscreen page it returned
    the same 235 families as Chromium's getFontList on this machine, in ~90 ms, with no native module
    and on every platform. The page needs a secure context (a `file:` URL, served from memory by a
    private session so nothing is written to disk), the `local-fonts` permission, and to be visible —
    an offscreen view is.
    `displayName` is the family name: Chrome localises it to the browser locale when the font has a
    name in it, and Local Font Access gives the family only. With a Latin locale the two agree for
    every font measured (235 of 235).

  - `getFont` in Chrome answers the profile pref for the family and script. Electron keeps no such
    prefs, so the value given is the font the renderer actually uses for the generic family in the
    common script, read from an offscreen page through DevTools (`CSS.getPlatformFontsForNode`). On
    Windows it matches Chrome for six of seven families; `math` differs because Electron has no math
    default and falls back to the standard font (Times New Roman, Chrome: Cambria Math) — which is
    what a page in Electron gets, so it is the honest answer. A script other than the common one
    answers '', Chrome's own answer for a script with no font of its own: Electron does not say which
    per-script fonts it has, and a sample in that script would report the fallback font, not a pref.

  - `levelOfControl` is `not_controllable`, and the setters change nothing (see the preload). Electron
    reads the default fonts and sizes once, from a WebContents' webPreferences, and has no way to
    change them for a running page. Chrome answers exactly this way when a policy holds the pref: the
    set resolves, nothing changes, no event fires.
*/

const CSS_FAMILY: Record<string, string> = {
  cursive: 'cursive',
  fantasy: 'fantasy',
  fixed: 'monospace',
  math: 'math',
  sansserif: 'sans-serif',
  serif: 'serif',
  // The standard font is what a page with no font-family gets.
  standard: 'initial',
}

type FontName = { fontId: string; displayName: string }
type Measured = { fonts: FontName[]; defaults: Record<string, string> }

const PAGE_URL = 'file:///electron-chrome-extensions/font-settings.html'
const PAGE = `<!doctype html><meta charset="utf-8"><body>${GENERIC_FAMILIES.map(
  (family) => `<span id="${family}" style="font-family: ${CSS_FAMILY[family]}">abc</span>`,
).join('')}</body>`

/** One offscreen page per process, for as long as it takes to read the fonts. */
const measure = async (): Promise<Measured> => {
  // In memory, its own: the permission and the protocol handler touch nothing of the embedder's.
  const ses = electronSession.fromPartition('electron-chrome-extensions-font-settings')
  // 'local-fonts' is what Electron 43 and 44 pass for the Local Font Access API, though their typings
  // do not list it.
  ses.setPermissionCheckHandler(
    (_webContents, permission) => (permission as string) === 'local-fonts',
  )
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  if (!ses.protocol.isProtocolHandled('file')) {
    ses.protocol.handle(
      'file',
      () => new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    )
  }

  const view = new WebContentsView({ webPreferences: { session: ses, offscreen: true } })
  const { webContents } = view
  try {
    await webContents.loadURL(PAGE_URL)
    const families: string[] = await webContents.executeJavaScript(
      'queryLocalFonts().then((fonts) => [...new Set(fonts.map((font) => font.family))])',
    )
    // Code unit order, as Chrome sorts (std::sort over the UTF-8 names).
    const fonts = families
      .filter(Boolean)
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .map((family) => ({ fontId: family, displayName: family }))

    const defaults: Record<string, string> = {}
    try {
      webContents.debugger.attach('1.3')
      const send = (method: string, params?: object) =>
        webContents.debugger.sendCommand(method, params)
      await send('DOM.enable')
      await send('CSS.enable')
      const { root } = await send('DOM.getDocument', { depth: -1 })
      for (const family of GENERIC_FAMILIES) {
        const { nodeId } = await send('DOM.querySelector', {
          nodeId: root.nodeId,
          selector: `#${family}`,
        })
        const { fonts: used } = await send('CSS.getPlatformFontsForNode', { nodeId })
        defaults[family] = used?.[0]?.familyName || ''
      }
    } catch {
      // Without DevTools there is no way to tell: '' is what Chrome answers for "no font".
    }
    return { fonts, defaults }
  } finally {
    if (!webContents.isDestroyed()) webContents.close()
  }
}

let measured: Promise<Measured> | undefined
const measureOnce = () => {
  if (!measured) {
    measured = measure().catch((error) => {
      // Try again next time instead of caching the failure.
      measured = undefined
      throw error
    })
  }
  return measured
}

export class FontSettingsAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('fontSettings.getFontList', this.getFontList)
    handle('fontSettings.getFont', this.getFont)
  }

  private getFontList = async (_event: ExtensionEvent): Promise<FontName[]> => {
    try {
      return (await measureOnce()).fonts
    } catch {
      // A platform where the page cannot enumerate: no fonts, rather than a list of non-fonts.
      return []
    }
  }

  private getFont = async (
    _event: ExtensionEvent,
    details: { genericFamily: string; script?: string },
  ) => {
    const schemaError = fontSettingsSchemaError('getFont', details, { genericFamily: true })
    if (schemaError) throw new Error(schemaError)
    let fontId = ''
    if (details.script === undefined || details.script === 'Zyyy') {
      try {
        fontId = (await measureOnce()).defaults[details.genericFamily] || ''
      } catch {}
    }
    return { fontId, levelOfControl: 'not_controllable' }
  }
}
