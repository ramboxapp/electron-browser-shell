import { expect } from 'chai'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { patchContentScriptStorage, CONTENT_SCRIPT_STORAGE_SHIM_FILE } from '../'
import { useExtensionBrowser, useServer } from './hooks'

const FIXTURES = path.join(__dirname, 'fixtures')

/**
 * `chrome.storage.sync` and `chrome.storage.managed` in a content script.
 *
 * A content script's isolated world is the one extension context the preload cannot reach, so it
 * sees Chromium's native `chrome` — where both of those THROW on property access ("sync" is not
 * available in this instance of Chrome) while a real Chromium answers in every context. Extensions
 * read their own settings from a content script routinely (password managers, Grammarly), and the
 * exception takes out whatever ran it.
 */
describe('content script storage patch', () => {
  describe('patchContentScriptStorage()', () => {
    let dir: string

    const writeManifest = (manifest: object) =>
      fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))

    const readManifest = async () =>
      JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8'))

    beforeEach(async () => {
      dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crx-cs-storage-'))
    })

    afterEach(async () => {
      await fs.rm(dir, { recursive: true, force: true })
    })

    it('puts the shim first in every isolated-world entry', async () => {
      await writeManifest({
        name: 'cs',
        version: '1.0',
        manifest_version: 3,
        content_scripts: [
          { matches: ['<all_urls>'], js: ['a.js', 'b.js'] },
          { matches: ['https://example.com/*'], js: ['c.js'], run_at: 'document_start' },
        ],
      })

      expect(await patchContentScriptStorage(dir)).to.be.true

      const manifest = await readManifest()
      expect(manifest.content_scripts[0].js).to.deep.equal([
        CONTENT_SCRIPT_STORAGE_SHIM_FILE,
        'a.js',
        'b.js',
      ])
      expect(manifest.content_scripts[1].js).to.deep.equal([
        CONTENT_SCRIPT_STORAGE_SHIM_FILE,
        'c.js',
      ])
      // The entries' own matches are untouched: the shim must not widen where a content script runs.
      expect(manifest.content_scripts[1].matches).to.deep.equal(['https://example.com/*'])
      await fs.access(path.join(dir, CONTENT_SCRIPT_STORAGE_SHIM_FILE))
    })

    it('leaves a MAIN-world entry alone', async () => {
      await writeManifest({
        name: 'cs',
        version: '1.0',
        manifest_version: 3,
        content_scripts: [{ matches: ['<all_urls>'], js: ['main.js'], world: 'MAIN' }],
      })

      // Nothing to alias in the page's own world, so there is nothing to do at all.
      expect(await patchContentScriptStorage(dir)).to.be.false
      expect((await readManifest()).content_scripts[0].js).to.deep.equal(['main.js'])
    })

    it('is idempotent', async () => {
      await writeManifest({
        name: 'cs',
        version: '1.0',
        manifest_version: 3,
        content_scripts: [{ matches: ['<all_urls>'], js: ['a.js'] }],
      })

      expect(await patchContentScriptStorage(dir)).to.be.true
      expect(await patchContentScriptStorage(dir)).to.be.false
      expect((await readManifest()).content_scripts[0].js).to.deep.equal([
        CONTENT_SCRIPT_STORAGE_SHIM_FILE,
        'a.js',
      ])
    })

    it('refreshes a stale shim even when the manifest already points at it', async () => {
      // A newer version of this library ships a newer shim — one that defines APIs the old one did
      // not. The manifest already names the file, so without rewriting it an extension patched by an
      // older version keeps the stale copy for as long as its folder survives.
      await writeManifest({
        name: 'cs',
        version: '1.0',
        manifest_version: 3,
        content_scripts: [{ matches: ['<all_urls>'], js: ['a.js'] }],
      })
      expect(await patchContentScriptStorage(dir)).to.be.true

      const shimPath = path.join(dir, CONTENT_SCRIPT_STORAGE_SHIM_FILE)
      await fs.writeFile(shimPath, '/* a shim from an older version */', 'utf-8')

      // Nothing left to change in the manifest, so it reports false — and still refreshes the file.
      expect(await patchContentScriptStorage(dir)).to.be.false
      const shim = await fs.readFile(shimPath, 'utf-8')
      expect(shim, 'the stale shim survived a patch').to.not.equal(
        '/* a shim from an older version */',
      )
      expect(shim).to.contain('openOrClosedShadowRoot')
    })

    it('is a no-op for an extension with no content scripts', async () => {
      await writeManifest({ name: 'cs', version: '1.0', manifest_version: 3 })
      expect(await patchContentScriptStorage(dir)).to.be.false
    })

    it('puts the shim first in every embeddable page, and in no other', async () => {
      await writeManifest({
        name: 'pages',
        version: '1.0',
        manifest_version: 3,
        web_accessible_resources: [
          { resources: ['inline/menu.html', 'images/*', 'glob/*.html', '../outside.html'], matches: ['<all_urls>'] },
          'legacy.html',
        ],
      })
      await fs.mkdir(path.join(dir, 'inline'))
      await fs.writeFile(
        path.join(dir, 'inline', 'menu.html'),
        '<!doctype html><html><head><title>m</title><script src="menu.js"></script></head><body></body></html>',
      )
      await fs.writeFile(path.join(dir, 'legacy.html'), '<body><script src="a.js"></script></body>')
      await fs.writeFile(path.join(dir, 'popup.html'), '<head></head><script src="p.js"></script>')

      expect(await patchContentScriptStorage(dir)).to.be.true
      const tag = `<script src="/${CONTENT_SCRIPT_STORAGE_SHIM_FILE}"></script>`
      const menu = await fs.readFile(path.join(dir, 'inline', 'menu.html'), 'utf-8')
      expect(menu.indexOf(tag), 'right after <head>, before the page scripts').to.equal(
        menu.indexOf('<head>') + '<head>'.length,
      )
      const legacy = await fs.readFile(path.join(dir, 'legacy.html'), 'utf-8')
      expect(legacy.indexOf(tag)).to.equal(legacy.indexOf('<body>') + '<body>'.length)
      // Not web-accessible: no web page can embed it, so the preload always reaches it.
      expect(await fs.readFile(path.join(dir, 'popup.html'), 'utf-8')).to.not.contain(tag)
      expect(await fs.readFile(path.join(dir, CONTENT_SCRIPT_STORAGE_SHIM_FILE), 'utf-8')).to.contain(
        'invokeExtension',
      )

      // Idempotent: a second run neither reports a change nor adds a second tag.
      expect(await patchContentScriptStorage(dir)).to.be.false
      const again = await fs.readFile(path.join(dir, 'inline', 'menu.html'), 'utf-8')
      expect(again.split(tag).length - 1).to.equal(1)
    })

    it('tolerates a UTF-8 BOM in manifest.json (Chromium does)', async () => {
      await fs.writeFile(
        path.join(dir, 'manifest.json'),
        '﻿' +
          JSON.stringify({
            name: 'cs',
            version: '1.0',
            manifest_version: 3,
            content_scripts: [{ matches: ['<all_urls>'], js: ['a.js'] }],
          }),
      )
      expect(await patchContentScriptStorage(dir)).to.be.true
    })

    it('never throws on a nonexistent path', async () => {
      expect(await patchContentScriptStorage(path.join(dir, 'nope'))).to.be.false
    })
  })

  describe('in a real content script', () => {
    const server = useServer()
    let patchedDir: string

    before(async () => {
      // A copy of the fixture, patched the way a host app patches an extension before loading it.
      patchedDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crx-cs-storage-ext-'))
      await fs.cp(path.join(FIXTURES, 'rpc-mv3'), patchedDir, { recursive: true })
      await patchContentScriptStorage(patchedDir)
    })

    after(async () => {
      await fs.rm(patchedDir, { recursive: true, force: true })
    })

    const browser = useExtensionBrowser({
      url: server.getUrl,
      extensionPath: () => patchedDir,
    })

    it('can read and write storage.sync', async () => {
      const result: any = await browser.crx.raw({ type: 'content-script-storage' })
      // 'ok' proves the shim ran AND both aliases took; a failure here is a different bug from a
      // storage call that then misbehaves.
      expect(result.shim, `shim state: ${result.shim}`).to.equal('ok')
      expect(result.local.ok, `local failed: ${result.local.error}`).to.be.true
      expect(result.sync.ok, `sync failed: ${result.sync.error}`).to.be.true
      // Aliased onto local, like every other context in this library: the write to sync is what
      // local reads back, also on an Electron with a native sync area of its own (45.2+).
      expect(result.sync.value).to.equal('sync')
      expect(result.localAfterSync.value, 'sync is a store of its own, not the alias').to.equal('sync')
    })

    it('gives storage.managed the same empty read-only policy store as every other context', async () => {
      const result: any = await browser.crx.raw({ type: 'content-script-storage' })
      expect(result.managed.ok, `managed failed: ${result.managed.error}`).to.be.true
      // Aliasing it onto local, as `sync` is, would report the extension's own data as
      // administrator policy — and local holds `__probe` by the time this runs.
      expect(result.managed.value.keys, 'local data leaked in as policy').to.deep.equal([])
      expect(result.managed.value.defaults).to.deep.equal({ PolicyKey: 'fallback' })
      expect(result.managed.value.setRejection, 'a policy write should be refused').to.contain(
        'read-only',
      )
    })

    it('defines chrome.dom and chrome.extension, which Electron does not', async () => {
      const result: any = await browser.crx.raw({ type: 'content-script-storage' })
      // Measured against a real Chromium with the same extension: Chrome's content-script world has
      // both namespaces and ours had neither, so an extension that walks shadow DOM found nothing.
      expect(result.dom.ok, `chrome.dom failed: ${result.dom.error}`).to.be.true
      expect(result.dom.value.reached, 'an open shadow root should come back').to.be.true
      expect(result.dom.value.noRoot, 'an element with no shadow root answers null').to.be.true
      expect(result.extensionNs.ok, `chrome.extension failed: ${result.extensionNs.error}`).to.be
        .true
      expect(result.extensionNs.value.inIncognitoContext).to.equal(false)
      expect(result.extensionNs.value.hasViewType).to.equal('object')
    })

    it('leaves storage.session throwing, as Chrome does', async () => {
      const result: any = await browser.crx.raw({ type: 'content-script-storage' })
      // Chrome also throws here unless the extension raises the session access level, so this must
      // stay broken on purpose rather than being aliased along with the other two.
      expect(result.session.ok).to.be.false
    })
  })

  describe('without the patch', () => {
    const server = useServer()
    const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

    /*
      Electron 45.2.0 added a native storage.sync (electron/electron#55253): a second local area with
      Chrome's sync quotas. Measured on 45.2.1+wvcus: the call no longer rejects, and the area is a
      DIFFERENT store from local. The patch stays anyway, and has to: every other context of this
      library aliases sync onto local, and every install made before 45.2 has its sync data there, so a
      native area here would show a content script an empty, separate copy of the extension's settings.
    */
    const nativeSync = (() => {
      const [major, minor] = process.versions.electron.split('.').map((n) => parseInt(n, 10))
      return major > 45 || (major === 45 && minor >= 2)
    })()

    it(
      nativeSync
        ? 'storage.sync is a store of its own in a content script, split from local'
        : 'storage.sync throws in a content script',
      async () => {
        const result: any = await browser.crx.raw({ type: 'content-script-storage' })
        expect(result.local.ok).to.be.true
        if (!nativeSync) {
          // The bug this patch exists for. If this starts passing below 45.2, Electron backported the
          // sync area and the gate above moves.
          expect(result.sync.ok, 'storage.sync works natively on this Electron').to.be.false
          return
        }
        expect(result.sync.ok, `native storage.sync failed: ${result.sync.error}`).to.be.true
        expect(
          result.localAfterSync.value,
          'native sync now writes into local: the alias would be redundant',
        ).to.equal('local')
      },
    )
  })
})
