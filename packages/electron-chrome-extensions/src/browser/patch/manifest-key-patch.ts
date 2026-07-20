import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import debug from 'debug'

const d = debug('electron-chrome-extensions:manifest-key-patch')

/**
 * Writes an extension's real Chrome Web Store signing key into its unpacked
 * manifest.json, so Electron/Chromium derive the extension's id from that key
 * instead of falling back to a hash of the install directory path.
 *
 * Chromium only assigns an unpacked extension the same id it has on the
 * Chrome Web Store when the manifest carries the extension's own `"key"`
 * field (the base64 DER public key CWS signs it with) — without it, the id
 * is derived from a hash of the extension's install path instead, which
 * breaks anything keyed to the real CWS id (native messaging host allow-lists,
 * OAuth redirect URIs, etc.). This matters specifically for consumers whose
 * installer unpacks a bare zip instead of a signed CRX — unlike
 * `electron-chrome-web-store`'s installer, which already extracts the key
 * from the CRX it downloads directly, those consumers have no other way to
 * recover the key and must supply it themselves (e.g. from wherever they
 * track the real CWS key out of band).
 *
 * Like {@link patchActiveTabManifest}, this must run *before* the caller's
 * `session.extensions.loadExtension(path)` — Electron only reads a
 * manifest's `"key"` field at load time. Never overwrites an existing key: a
 * manifest that already declares one is the source of truth.
 *
 * Never throws: a failed patch degrades to "extension loads under a
 * path-hash id" rather than skipping the load entirely.
 */
export async function applyManifestPublicKey(
  extensionPath: string,
  publicKeyBase64: string | undefined,
): Promise<boolean> {
  try {
    return await applyManifestPublicKeyUnsafe(extensionPath, publicKeyBase64)
  } catch (error) {
    console.error(
      `electron-chrome-extensions: applyManifestPublicKey failed for ${extensionPath}; ` +
        'loading the extension unpatched',
      error,
    )
    return false
  }
}

async function applyManifestPublicKeyUnsafe(
  extensionPath: string,
  publicKeyBase64: string | undefined,
): Promise<boolean> {
  if (!publicKeyBase64) {
    return false
  }

  const manifestPath = path.join(extensionPath, 'manifest.json')
  let manifestText: string
  try {
    manifestText = await fs.readFile(manifestPath, 'utf-8')
  } catch {
    // Not an unpacked extension directory — nothing to patch.
    return false
  }

  // Chromium tolerates a UTF-8 BOM in manifest.json; JSON.parse doesn't.
  const manifest = JSON.parse(
    manifestText.charCodeAt(0) === 0xfeff ? manifestText.slice(1) : manifestText,
  )

  if (manifest.key) {
    return false
  }

  manifest.key = publicKeyBase64
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  d(`applied publicKey to manifest at ${extensionPath}`)
  return true
}
