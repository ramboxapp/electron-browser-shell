import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

/*
  chrome.fontSettings against Chromium 147 (measured 30/10/2026, Windows):

  - getFontList is the system's font families, `{fontId, displayName}`, sorted by fontId code unit
    by code unit. The library reads them from an offscreen page with the Local Font Access API, which
    on the measuring machine gave the same 235 families as Chromium. It was a stub with three generic
    names that are not fonts, which is all Dark Reader's font picker listed.
  - getFont gives the font the renderer really uses for the family in the common script, and '' for
    another script. Everything is `not_controllable` and the setters change nothing and fire nothing:
    Electron cannot change a running page's default fonts, and that is how Chrome answers when a
    policy holds the pref. In Chrome without a policy, a set would store the value for the extension
    and fire on*Changed — which here would be a lie.
  - Schema errors carry Chrome's text, as a rejection or `lastError` (Chrome throws them).
*/
describe('chrome.fontSettings', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  const outcome = (method: string, ...args: any[]) =>
    browser.crx.raw({ type: 'outcome', method, args })
  const outcomeCallback = (method: string, ...args: any[]) =>
    browser.crx.raw({ type: 'outcome-callback', method, args })

  it('lists the system font families, sorted, with no generic names', async () => {
    const { value: fonts } = await outcome('fontSettings.getFontList')
    expect(fonts).to.be.an('array').that.is.not.empty
    for (const font of fonts) {
      expect(Object.keys(font).sort()).to.deep.equal(['displayName', 'fontId'])
      expect(font.fontId).to.be.a('string').that.is.not.empty
    }
    const ids = fonts.map((font: any) => font.fontId)
    expect(ids).to.deep.equal([...ids].sort())
    expect(new Set(ids).size).to.equal(ids.length)
    expect(ids).to.not.include.members(['sans-serif', 'serif', 'monospace'])

    const called = await outcomeCallback('fontSettings.getFontList')
    expect(called.lastError).to.equal(null)
    expect(called.value).to.deep.equal(fonts)
  })

  it('gives the font a family really uses, not controllable, and "" for another script', async () => {
    const { value: fonts } = await outcome('fontSettings.getFontList')
    const ids = fonts.map((font: any) => font.fontId)
    for (const genericFamily of ['standard', 'sansserif', 'fixed']) {
      const { value } = await outcome('fontSettings.getFont', { genericFamily })
      expect(value.levelOfControl).to.equal('not_controllable')
      expect(ids).to.include(value.fontId)
    }
    const { value: script } = await outcome('fontSettings.getFont', {
      genericFamily: 'serif',
      script: 'Jpan',
    })
    expect(script).to.deep.equal({ fontId: '', levelOfControl: 'not_controllable' })
  })

  it("answers Electron's default sizes, not controllable", async () => {
    expect((await outcome('fontSettings.getDefaultFontSize')).value).to.deep.equal({
      levelOfControl: 'not_controllable',
      pixelSize: 16,
    })
    expect((await outcome('fontSettings.getDefaultFixedFontSize', {})).value.pixelSize).to.equal(13)
    expect((await outcome('fontSettings.getMinimumFontSize')).value.pixelSize).to.equal(0)
  })

  it('resolves a set or a clear without changing anything or firing an event', async () => {
    await browser.crx.raw({
      type: 'record-events',
      names: ['fontSettings.onFontChanged', 'fontSettings.onDefaultFontSizeChanged'],
    })
    const before = (await outcome('fontSettings.getFont', { genericFamily: 'standard' })).value
    expect(
      await outcome('fontSettings.setFont', { genericFamily: 'standard', fontId: 'Some Font' }),
    ).to.deep.equal({ value: '__undefined__' })
    expect(await outcome('fontSettings.setDefaultFontSize', { pixelSize: 20 })).to.deep.equal({
      value: '__undefined__',
    })
    expect(
      await outcomeCallback('fontSettings.clearFont', { genericFamily: 'standard' }),
    ).to.deep.equal({ value: '__undefined__', lastError: null })
    expect(
      (await outcome('fontSettings.getFont', { genericFamily: 'standard' })).value,
    ).to.deep.equal(before)
    expect((await outcome('fontSettings.getDefaultFontSize')).value.pixelSize).to.equal(16)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(
      await browser.crx.raw({ type: 'recorded', name: 'fontSettings.onFontChanged' }),
    ).to.deep.equal([])
    expect(
      await browser.crx.raw({ type: 'recorded', name: 'fontSettings.onDefaultFontSizeChanged' }),
    ).to.deep.equal([])
  })

  it("fails a call that does not match the schema with Chrome's message", async () => {
    const signature = (method: string) =>
      `Error in invocation of fontSettings.${method}(object details, optional function callback)`
    expect((await outcome('fontSettings.getFont', { genericFamily: 'nope' })).error).to.equal(
      `${signature('getFont')}: Error at parameter 'details': Error at property 'genericFamily': Value must be one of cursive, fantasy, fixed, math, sansserif, serif, standard.`,
    )
    expect((await outcome('fontSettings.setFont', { genericFamily: 'serif' })).error).to.equal(
      `${signature('setFont')}: Error at parameter 'details': Missing required property 'fontId'.`,
    )
    const message = `${signature('setDefaultFontSize')}: Error at parameter 'details': Error at property 'pixelSize': Invalid type: expected integer, found number.`
    expect(await outcome('fontSettings.setDefaultFontSize', { pixelSize: 12.5 })).to.deep.equal({
      error: message,
    })
    expect(
      await outcomeCallback('fontSettings.setDefaultFontSize', { pixelSize: 12.5 }),
    ).to.deep.equal({ value: '__undefined__', lastError: message })
  })

  it("has Chrome's enums", async () => {
    const enums = await browser.crx.raw({ type: 'font-settings-enums' })
    expect(enums.GenericFamily).to.deep.equal({
      CURSIVE: 'cursive',
      FANTASY: 'fantasy',
      FIXED: 'fixed',
      MATH: 'math',
      SANSSERIF: 'sansserif',
      SERIF: 'serif',
      STANDARD: 'standard',
    })
    expect(enums.LevelOfControl).to.deep.equal({
      CONTROLLABLE_BY_THIS_EXTENSION: 'controllable_by_this_extension',
      CONTROLLED_BY_OTHER_EXTENSIONS: 'controlled_by_other_extensions',
      CONTROLLED_BY_THIS_EXTENSION: 'controlled_by_this_extension',
      NOT_CONTROLLABLE: 'not_controllable',
    })
    expect(enums.scriptCodes).to.equal(152)
    expect(enums.ZYYY).to.equal('Zyyy')
  })
})
