import { expect } from 'chai'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { grantActiveTabHostAccess, patchActiveTabManifest } from '../'

describe('activeTab manifest patch', () => {
  describe('grantActiveTabHostAccess()', () => {
    it('adds <all_urls> host_permissions to an MV3 activeTab extension', () => {
      const manifest: any = {
        manifest_version: 3,
        permissions: ['activeTab', 'scripting'],
      }
      expect(grantActiveTabHostAccess(manifest)).to.be.true
      expect(manifest.host_permissions).to.include('<all_urls>')
    })

    it('preserves existing host_permissions entries', () => {
      const manifest: any = {
        manifest_version: 3,
        permissions: ['activeTab'],
        host_permissions: ['https://example.com/*'],
      }
      expect(grantActiveTabHostAccess(manifest)).to.be.true
      expect(manifest.host_permissions).to.have.members(['https://example.com/*', '<all_urls>'])
    })

    it('is a no-op when broad host access already exists (MV3)', () => {
      const manifest: any = {
        manifest_version: 3,
        permissions: ['activeTab'],
        host_permissions: ['<all_urls>'],
      }
      expect(grantActiveTabHostAccess(manifest)).to.be.false
      expect(manifest.host_permissions).to.deep.equal(['<all_urls>'])
    })

    it('adds <all_urls> to permissions for MV2 extensions', () => {
      const manifest: any = {
        manifest_version: 2,
        permissions: ['activeTab', 'storage'],
      }
      expect(grantActiveTabHostAccess(manifest)).to.be.true
      expect(manifest.permissions).to.include('<all_urls>')
    })

    it('is a no-op when MV2 permissions already include a broad pattern', () => {
      const manifest: any = {
        manifest_version: 2,
        permissions: ['activeTab', '*://*/*'],
      }
      expect(grantActiveTabHostAccess(manifest)).to.be.false
    })

    it('is a no-op without the activeTab permission', () => {
      const manifest: any = {
        manifest_version: 3,
        permissions: ['storage'],
      }
      expect(grantActiveTabHostAccess(manifest)).to.be.false
      expect(manifest.host_permissions).to.be.undefined
    })
  })

  describe('patchActiveTabManifest()', () => {
    let tmpDir: string

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crx-activetab-'))
    })

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true })
    })

    const writeManifest = (manifest: any) =>
      fs.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest))

    const readManifest = async () =>
      JSON.parse(await fs.readFile(path.join(tmpDir, 'manifest.json'), 'utf-8'))

    it('patches the manifest on disk and is idempotent', async () => {
      await writeManifest({ manifest_version: 3, permissions: ['activeTab'] })

      expect(await patchActiveTabManifest(tmpDir)).to.be.true
      expect((await readManifest()).host_permissions).to.include('<all_urls>')

      // Second run: broad access already granted, nothing to write.
      expect(await patchActiveTabManifest(tmpDir)).to.be.false
    })

    it('returns false for directories without a manifest', async () => {
      expect(await patchActiveTabManifest(tmpDir)).to.be.false
    })

    it('tolerates a UTF-8 BOM in manifest.json (Chromium does)', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'manifest.json'),
        String.fromCharCode(0xfeff) + JSON.stringify({ manifest_version: 3, permissions: ['activeTab'] }),
      )
      expect(await patchActiveTabManifest(tmpDir)).to.be.true
      expect((await readManifest()).host_permissions).to.include('<all_urls>')
    })

    it('never throws — a malformed manifest degrades to an unpatched load', async () => {
      await fs.writeFile(path.join(tmpDir, 'manifest.json'), '{ not json at all')
      expect(await patchActiveTabManifest(tmpDir)).to.be.false
    })
  })
})
