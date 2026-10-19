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

    it('is a no-op for an extension with no content scripts', async () => {
      await writeManifest({ name: 'cs', version: '1.0', manifest_version: 3 })
      expect(await patchContentScriptStorage(dir)).to.be.false
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
      // Aliased onto local, like every other context in this library.
      expect(result.sync.value).to.equal('sync')
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

    it('storage.sync throws in a content script', async () => {
      const result: any = await browser.crx.raw({ type: 'content-script-storage' })
      // The bug this patch exists for. If this ever starts passing, Electron implemented the sync
      // backend (or started aliasing it) and the patch can go.
      expect(result.local.ok).to.be.true
      expect(result.sync.ok, 'storage.sync works natively now — the patch may be unnecessary').to.be
        .false
    })
  })
})
