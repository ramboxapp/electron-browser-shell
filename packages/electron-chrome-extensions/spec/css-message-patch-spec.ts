import { expect } from 'chai'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { BrowserWindow } from 'electron'

import {
  electronSubstitutesCssMessages,
  patchExtensionCssMessages,
  substituteExtensionIdInCss,
} from '../'
import { createCrxSession } from './crx-helpers'

const EXT_ID = 'kbfnbcaeplbcioakkpcpgfkobkghlhen'

describe('CSS __MSG_@@extension_id__ patch', () => {
  describe('substituteExtensionIdInCss()', () => {
    it('replaces the token in a real Grammarly-style url()', () => {
      const css =
        '.gr_spell{background-image:url(chrome-extension://__MSG_@@extension_id__/src/images/underline-inline-cards.svg)}'
      const out = substituteExtensionIdInCss(css, EXT_ID)
      expect(out).to.equal(
        `.gr_spell{background-image:url(chrome-extension://${EXT_ID}/src/images/underline-inline-cards.svg)}`,
      )
    })

    it('replaces every occurrence', () => {
      const css = '__MSG_@@extension_id__ a __MSG_@@extension_id__ b __MSG_@@extension_id__'
      const out = substituteExtensionIdInCss(css, 'ID')
      expect(out).to.equal('ID a ID b ID')
    })

    it('leaves placeholder-free CSS byte-identical', () => {
      const css = 'body{color:red;background:url(chrome-extension://someid/x.png)}'
      expect(substituteExtensionIdInCss(css, EXT_ID)).to.equal(css)
    })
  })

  describe('patchExtensionCssMessages()', () => {
    let dir: string
    let forced: string | undefined

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crx-css-'))
      // The rewrite itself, whatever the binary: from 45.1 it is skipped (see the next block).
      forced = process.env.CRX_FORCE_CSS_MESSAGE_PATCH
      process.env.CRX_FORCE_CSS_MESSAGE_PATCH = '1'
    })

    afterEach(async () => {
      if (forced === undefined) delete process.env.CRX_FORCE_CSS_MESSAGE_PATCH
      else process.env.CRX_FORCE_CSS_MESSAGE_PATCH = forced
      await fs.rm(dir, { recursive: true, force: true })
    })

    it('rewrites the token in .css files and writes the marker', async () => {
      await fs.mkdir(path.join(dir, 'src', 'css'), { recursive: true })
      const cssPath = path.join(dir, 'src', 'css', 'a.styles.css')
      await fs.writeFile(
        cssPath,
        'a{background:url(chrome-extension://__MSG_@@extension_id__/i.svg)}',
      )

      const changed = await patchExtensionCssMessages(dir, EXT_ID)
      expect(changed).to.be.true
      expect(await fs.readFile(cssPath, 'utf-8')).to.equal(
        `a{background:url(chrome-extension://${EXT_ID}/i.svg)}`,
      )
      // Marker written.
      await fs.access(path.join(dir, '.crx-css-patched'))
    })

    it('is idempotent — a second run is a no-op', async () => {
      const cssPath = path.join(dir, 'x.css')
      await fs.writeFile(cssPath, 'x{content:"__MSG_@@extension_id__"}')
      expect(await patchExtensionCssMessages(dir, EXT_ID)).to.be.true
      // Second run short-circuits on the marker and reports no change.
      expect(await patchExtensionCssMessages(dir, EXT_ID)).to.be.false
      expect(await fs.readFile(cssPath, 'utf-8')).to.equal(`x{content:"${EXT_ID}"}`)
    })

    it('ignores non-.css files', async () => {
      const jsPath = path.join(dir, 'bg.js')
      await fs.writeFile(jsPath, 'const u = "chrome-extension://__MSG_@@extension_id__/"')
      await patchExtensionCssMessages(dir, EXT_ID)
      // JS untouched — only CSS is patched.
      expect(await fs.readFile(jsPath, 'utf-8')).to.contain('__MSG_@@extension_id__')
    })

    it('never throws on a nonexistent path', async () => {
      const result = await patchExtensionCssMessages(path.join(dir, 'does-not-exist'), EXT_ID)
      expect(result).to.be.false
    })
  })

  describe('on this binary', () => {
    let dir: string

    before(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crx-css-native-'))
      await fs.writeFile(
        path.join(dir, 'manifest.json'),
        JSON.stringify({ name: 'css-native', version: '1.0', manifest_version: 3 }),
      )
      await fs.writeFile(
        path.join(dir, 'page.html'),
        '<!doctype html><link rel="stylesheet" href="page.css"><body>page</body>',
      )
      await fs.writeFile(path.join(dir, 'page.css'), 'body { --crx-id: "__MSG_@@extension_id__"; }')
    })

    after(async () => {
      await fs.rm(dir, { recursive: true, force: true })
    })

    it('substitutes the token in a page stylesheet exactly when the gate says it does', async () => {
      // An extension page's own <link> is the case 44.10.1 still leaves raw (measured 09/11/2026);
      // a content-script stylesheet is already substituted there.
      const { session } = createCrxSession()
      const extension = await session.extensions.loadExtension(dir)
      const win = new BrowserWindow({ show: false, webPreferences: { session } })
      try {
        await win.loadURL(`chrome-extension://${extension.id}/page.html`)
        const value: string = await win.webContents.executeJavaScript(
          `getComputedStyle(document.body).getPropertyValue('--crx-id')`,
        )
        const native = value.includes(extension.id)
        expect(
          native,
          `Electron ${process.versions.electron} answered ${value}; move electronSubstitutesCssMessages`,
        ).to.equal(electronSubstitutesCssMessages())
        // Without the force, the patch is a no-op exactly where Electron does it natively.
        expect(await patchExtensionCssMessages(dir, extension.id)).to.equal(!native)
      } finally {
        win.destroy()
        session.extensions.removeExtension(extension.id)
      }
    })
  })
})
