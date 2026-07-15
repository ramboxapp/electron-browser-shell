import { expect } from 'chai'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { patchExtensionCssMessages, substituteExtensionIdInCss } from '../'

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

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crx-css-'))
    })

    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true })
    })

    it('rewrites the token in .css files and writes the marker', async () => {
      await fs.mkdir(path.join(dir, 'src', 'css'), { recursive: true })
      const cssPath = path.join(dir, 'src', 'css', 'a.styles.css')
      await fs.writeFile(cssPath, 'a{background:url(chrome-extension://__MSG_@@extension_id__/i.svg)}')

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
})
