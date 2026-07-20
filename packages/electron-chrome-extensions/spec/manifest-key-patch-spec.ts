import { expect } from 'chai'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { applyManifestPublicKey } from '../'

describe('manifest publicKey patch', () => {
  describe('applyManifestPublicKey()', () => {
    let tmpDir: string

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'crx-manifestkey-'))
    })

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true })
    })

    const writeManifest = (manifest: any) =>
      fs.writeFile(path.join(tmpDir, 'manifest.json'), JSON.stringify(manifest))

    const readManifest = async () =>
      JSON.parse(await fs.readFile(path.join(tmpDir, 'manifest.json'), 'utf-8'))

    it('writes the given key into manifest.json', async () => {
      await writeManifest({ manifest_version: 3, name: 'Test' })

      expect(await applyManifestPublicKey(tmpDir, 'FAKEKEY==')).to.be.true
      expect((await readManifest()).key).to.equal('FAKEKEY==')
    })

    it('never overwrites an existing key', async () => {
      await writeManifest({ manifest_version: 3, name: 'Test', key: 'EXISTINGKEY==' })

      expect(await applyManifestPublicKey(tmpDir, 'FAKEKEY==')).to.be.false
      expect((await readManifest()).key).to.equal('EXISTINGKEY==')
    })

    it('is a no-op when no key is provided', async () => {
      await writeManifest({ manifest_version: 3, name: 'Test' })

      expect(await applyManifestPublicKey(tmpDir, undefined)).to.be.false
      expect((await readManifest()).key).to.be.undefined
    })

    it('returns false for directories without a manifest', async () => {
      expect(await applyManifestPublicKey(tmpDir, 'FAKEKEY==')).to.be.false
    })

    it('tolerates a UTF-8 BOM in manifest.json (Chromium does)', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'manifest.json'),
        String.fromCharCode(0xfeff) + JSON.stringify({ manifest_version: 3, name: 'Test' }),
      )
      expect(await applyManifestPublicKey(tmpDir, 'FAKEKEY==')).to.be.true
      expect((await readManifest()).key).to.equal('FAKEKEY==')
    })

    it('never throws — a malformed manifest degrades to an unpatched load', async () => {
      await fs.writeFile(path.join(tmpDir, 'manifest.json'), '{ not json at all')
      expect(await applyManifestPublicKey(tmpDir, 'FAKEKEY==')).to.be.false
    })
  })
})
