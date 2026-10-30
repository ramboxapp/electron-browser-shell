import { expect } from 'chai'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  patchExtensionLocale,
  patchContentScriptStorage,
  localeCandidates,
  resolveExtensionMessages,
  formatExtensionMessage,
  CRX_I18N_KEY,
  CRX_I18N_MANIFEST_KEY,
} from '../'
import { useExtensionBrowser, useServer } from './hooks'

const FIXTURES = path.join(__dirname, 'fixtures')

/*
  Extensions in the host application's language.

  Electron never tells Chromium's extension l10n the application locale, so `chrome.i18n.getMessage`
  answers in the extension's default locale whatever the app's language is (measured on Electron 43
  with `--lang`: still `en`). The locale patch resolves the bundle with Chrome's fallback chain and
  leaves it in the manifest, and the preload and the content-script shim read it from there — the
  manifest being the only thing all three contexts can read synchronously, and getMessage being
  synchronous. These specs cover the resolution, the formatting rules of Chrome's MessageBundle,
  and the three contexts.
*/
describe('locale patch', () => {
  describe('localeCandidates()', () => {
    it('lists the locale and its parents, most specific first', () => {
      expect(localeCandidates('es-AR')).to.deep.equal(['es_AR', 'es'])
      expect(localeCandidates('zh_Hant_TW')).to.deep.equal(['zh_Hant_TW', 'zh_Hant', 'zh'])
      expect(localeCandidates('en')).to.deep.equal(['en'])
      expect(localeCandidates('')).to.deep.equal([])
    })
  })

  describe('formatExtensionMessage()', () => {
    const state = () => ({
      locale: 'es-AR',
      extensionId: 'abcdefghijklmnopabcdefghijklmnop',
      messages: {
        greeting: {
          message: 'Hola $NAME$, tenés $COUNT$ mensajes',
          placeholders: { name: { content: '$1' }, count: { content: '$2' } },
        },
        price: { message: 'Costs $$5' },
        positional: { message: 'First $1, second $2' },
        with_lt: { message: 'a < b' },
        nested: { message: 'Says: $1' },
      },
    })

    it('substitutes placeholders and positional arguments', () => {
      expect(formatExtensionMessage(state(), 'greeting', ['Ana', '3'])).to.equal(
        'Hola Ana, tenés 3 mensajes',
      )
      expect(formatExtensionMessage(state(), 'positional', ['a', 'b'])).to.equal(
        'First a, second b',
      )
      // A single string is one substitution; a missing one is empty.
      expect(formatExtensionMessage(state(), 'greeting', 'Ana')).to.equal(
        'Hola Ana, tenés  mensajes',
      )
    })

    it('matches message names case-insensitively, as Chrome does', () => {
      expect(formatExtensionMessage(state(), 'GREETING', ['Ana', '3'])).to.equal(
        'Hola Ana, tenés 3 mensajes',
      )
    })

    it('keeps $$ as a literal dollar and does not expand a substitution twice', () => {
      expect(formatExtensionMessage(state(), 'price')).to.equal('Costs $5')
      expect(formatExtensionMessage(state(), 'nested', ['$2 and $$'])).to.equal('Says: $2 and $$')
    })

    it('escapes < in the message only with escapeLt', () => {
      expect(formatExtensionMessage(state(), 'with_lt')).to.equal('a < b')
      expect(formatExtensionMessage(state(), 'with_lt', [], { escapeLt: true })).to.equal(
        'a &lt; b',
      )
      expect(formatExtensionMessage(state(), 'nested', ['<b>'], { escapeLt: true })).to.equal(
        'Says: <b>',
      )
    })

    it('answers the reserved @@ messages and "" for an unknown one', () => {
      expect(formatExtensionMessage(state(), '@@extension_id')).to.equal(
        'abcdefghijklmnopabcdefghijklmnop',
      )
      expect(formatExtensionMessage(state(), '@@ui_locale')).to.equal('es_AR')
      expect(formatExtensionMessage(state(), '@@bidi_dir')).to.equal('ltr')
      expect(formatExtensionMessage({ ...state(), locale: 'ar' }, '@@bidi_dir')).to.equal('rtl')
      expect(formatExtensionMessage(state(), 'no_such_message')).to.equal('')
    })

    it('refuses more than nine substitutions, as Chrome does', () => {
      expect(() =>
        formatExtensionMessage(state(), 'positional', [
          '1',
          '2',
          '3',
          '4',
          '5',
          '6',
          '7',
          '8',
          '9',
          '10',
        ]),
      ).to.throw(/at most 9/)
    })
  })

  describe('patchExtensionLocale()', () => {
    let dir: string

    const readManifest = async () =>
      JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8'))

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crx-locale-'))
      await fs.cp(path.join(FIXTURES, 'rpc-mv3'), dir, { recursive: true })
    })

    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true })
    })

    it('merges the default locale, the language and the exact locale, most specific winning', async () => {
      const messages = await resolveExtensionMessages(dir, 'es-AR', 'en')
      expect(messages!.tagline.message).to.equal('From es_AR')
      expect(messages!.greeting.message).to.match(/^Hola/)
      expect(messages!.only_in_en.message).to.equal('English only')
    })

    it('writes the bundle into the manifest, once', async () => {
      expect(await patchExtensionLocale(dir, 'es_AR')).to.be.true
      const manifest = await readManifest()
      expect(manifest[CRX_I18N_KEY].locale).to.equal('es-AR')
      expect(manifest[CRX_I18N_KEY].messages.tagline.message).to.equal('From es_AR')
      // The rest of the manifest is untouched.
      expect(manifest.default_locale).to.equal('en')
      expect(manifest.background.service_worker).to.equal('background.js')
      // Same locale again: nothing to write.
      expect(await patchExtensionLocale(dir, 'es-AR')).to.be.false
    })

    it('rewrites the bundle when the language changes', async () => {
      await patchExtensionLocale(dir, 'es-AR')
      expect(await patchExtensionLocale(dir, 'en-US')).to.be.true
      const manifest = await readManifest()
      expect(manifest[CRX_I18N_KEY].locale).to.equal('en-US')
      expect(manifest[CRX_I18N_KEY].messages.tagline.message).to.equal('From en')
    })

    it('leaves no bundle in an extension without default_locale, and removes a stale one', async () => {
      await patchExtensionLocale(dir, 'es-AR')
      const manifest = await readManifest()
      delete manifest.default_locale
      await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
      expect(await patchExtensionLocale(dir, 'es-AR')).to.be.true
      expect((await readManifest())[CRX_I18N_KEY]).to.equal(undefined)
      expect(await patchExtensionLocale(dir, 'es-AR')).to.be.false
    })

    it('tolerates a UTF-8 BOM in manifest.json and messages.json', async () => {
      const manifestPath = path.join(dir, 'manifest.json')
      await fs.writeFile(manifestPath, '﻿' + (await fs.readFile(manifestPath, 'utf-8')))
      const messagesPath = path.join(dir, '_locales', 'es', 'messages.json')
      await fs.writeFile(messagesPath, '﻿' + (await fs.readFile(messagesPath, 'utf-8')))
      expect(await patchExtensionLocale(dir, 'es')).to.be.true
      expect((await readManifest())[CRX_I18N_KEY].messages.tagline.message).to.equal('From es')
    })

    /*
      Chromium localizes the manifest's own __MSG_x__ strings in the locale Electron leaves at en, so
      the name and the action title stayed English in a Spanish app. The patch writes them in the
      app's language and keeps the placeholders, so the next language starts from them again.
    */
    it('localizes the manifest fields Chrome localizes, and keeps the placeholders', async () => {
      const manifestPath = path.join(dir, 'manifest.json')
      const original = await readManifest()
      original.name = '__MSG_tagline__'
      original.description = 'Plain text'
      original.action = { ...original.action, default_title: '__MSG_only_in_en__ (__MSG_nope__)' }
      original.commands.lock_vault.description = '__MSG_tagline__'
      await fs.writeFile(manifestPath, JSON.stringify(original))

      expect(await patchExtensionLocale(dir, 'es-AR')).to.be.true
      let manifest = await readManifest()
      expect(manifest.name).to.equal('From es_AR')
      expect(manifest.description).to.equal('Plain text')
      // A name the bundle lacks stays a placeholder, for Chromium to resolve.
      expect(manifest.action.default_title).to.equal('English only (__MSG_nope__)')
      expect(manifest.commands.lock_vault.description).to.equal('From es_AR')
      expect(await patchExtensionLocale(dir, 'es-AR')).to.be.false

      expect(await patchExtensionLocale(dir, 'en-US')).to.be.true
      manifest = await readManifest()
      expect(manifest.name).to.equal('From en')

      // No bundle anymore: the placeholders come back as they were.
      delete manifest.default_locale
      await fs.writeFile(manifestPath, JSON.stringify(manifest))
      expect(await patchExtensionLocale(dir, 'es-AR')).to.be.true
      manifest = await readManifest()
      expect(manifest.name).to.equal('__MSG_tagline__')
      expect(manifest.action.default_title).to.equal('__MSG_only_in_en__ (__MSG_nope__)')
      expect(manifest[CRX_I18N_MANIFEST_KEY]).to.equal(undefined)
    })

    it('never throws on a nonexistent path', async () => {
      expect(await patchExtensionLocale(path.join(dir, 'nope'), 'es-AR')).to.be.false
    })
  })

  describe('in the extension, patched for es-AR', () => {
    const server = useServer()
    let patchedDir: string

    before(async () => {
      // A copy of the fixture, patched the way a host app patches an extension before loading it.
      patchedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crx-locale-ext-'))
      await fs.cp(path.join(FIXTURES, 'rpc-mv3'), patchedDir, { recursive: true })
      await patchContentScriptStorage(patchedDir)
      await patchExtensionLocale(patchedDir, 'es-AR')
    })

    after(async () => {
      await fs.rm(patchedDir, { recursive: true, force: true })
    })

    const browser = useExtensionBrowser({
      url: server.getUrl,
      extensionPath: () => patchedDir,
    })

    it('answers in the app language from the service worker', async () => {
      const result: any = await browser.crx.raw({ type: 'i18n-shapes' })
      expect(result.uiLanguage).to.equal('es-AR')
      expect(result.acceptLanguages).to.deep.equal(['es-AR', 'en-US'])
      expect(result.greeting).to.equal('Hola Ana, tenés 3 mensajes nuevos')
      expect(result.greetingUpper).to.equal('Hola Ana, tenés 3 mensajes nuevos')
      expect(result.greetingOneSub).to.equal('Hola Ana, tenés  mensajes nuevos')
      expect(result.tagline).to.equal('From es_AR')
      expect(result.onlyInEn).to.equal('English only')
      expect(result.price).to.equal('Costs $5')
      expect(result.positional).to.equal('First a, second b')
      expect(result.withLt).to.equal('a < b')
      expect(result.withLtEscaped).to.equal('a &lt; b')
      expect(result.unknown).to.equal('')
      expect(result.extensionId).to.equal(browser.extension.id)
      expect(result.uiLocale).to.equal('es_AR')
      expect(result.bidiDir).to.equal('ltr')
      expect(result.tooMany).to.match(/^threw: .*at most 9/)
    })

    it('answers in the app language from a content script', async () => {
      const result: any = await browser.crx.raw({ type: 'content-script-i18n' })
      expect(result.shim, `shim state: ${result.shim}`).to.equal('ok')
      expect(result.uiLanguage).to.equal('es-AR')
      expect(result.acceptLanguages).to.deep.equal(['es-AR', 'en-US'])
      expect(result.greeting).to.equal('Hola Ana, tenés 3 mensajes nuevos')
      expect(result.tagline).to.equal('From es_AR')
      expect(result.onlyInEn).to.equal('English only')
      expect(result.price).to.equal('Costs $5')
      expect(result.extensionId).to.equal(browser.extension.id)
      expect(result.unknown).to.equal('')
    })
  })

  describe('in the extension, unpatched', () => {
    const server = useServer()
    const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

    it("keeps Electron's default-locale answers", async () => {
      const result: any = await browser.crx.raw({ type: 'i18n-shapes' })
      expect(result.greeting).to.equal('Hello Ana, you have 3 new messages')
      expect(result.tagline).to.equal('From en')
    })
  })
})
