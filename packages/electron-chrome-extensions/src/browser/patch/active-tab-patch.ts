import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import debug from 'debug'

const d = debug('electron-chrome-extensions:active-tab-patch')

const ALL_URLS = '<all_urls>'

/** Host patterns that on their own already imply access to every http(s) origin. */
const BROAD_HOST_PATTERNS = [ALL_URLS, '*://*/*']

/**
 * Whether the given host patterns already grant access to effectively every
 * web page, so there's nothing for the activeTab patch to add.
 *
 * Besides the single all-origins patterns in BROAD_HOST_PATTERNS, an extension
 * that declares BOTH the http and https all-hosts patterns (e.g. Bitwarden)
 * already covers all web origins. Missing this combination caused those
 * extensions to be needlessly re-granted `<all_urls>` and have their manifest
 * rewritten on disk, so treat it as broad too.
 */
const hasBroadHostAccess = (patterns: string[] | undefined): boolean => {
  if (!Array.isArray(patterns)) return false
  if (patterns.some((pattern) => BROAD_HOST_PATTERNS.includes(pattern))) return true
  return patterns.includes('http://*/*') && patterns.includes('https://*/*')
}

/**
 * Works around Electron never granting the `activeTab` permission.
 *
 * In Chrome, clicking an extension's toolbar action invokes Chromium's
 * ActiveTabPermissionGranter, temporarily granting the extension host access
 * to the active tab — this is what lets a popup call
 * `chrome.scripting.executeScript()` / `chrome.tabs.executeScript()` on the
 * page without any static host permissions (e.g. Google Translate's popup
 * reading the current selection). In this library the toolbar click is
 * synthesized (`<browser-action-list>` → PopupView), so Chromium never sees
 * an action invocation, never grants `activeTab`, and its native permission
 * check rejects the injection with "Cannot access contents of the page.
 * Extension manifest must request permission to access the respective host."
 *
 * There is no Electron API to grant `activeTab`, so instead we grant
 * equivalent *static* host access: extensions that declare `activeTab` get
 * `<all_urls>` added to their manifest on disk. Electron auto-grants declared
 * host permissions without prompting, which makes Chromium's check pass. The
 * trade-off — permanent access instead of Chrome's temporary per-gesture
 * grant — matches the trust model of an embedding app where every extension
 * was deliberately installed by the user and no permission prompt UI exists
 * anyway.
 *
 * Like {@link patchModuleServiceWorker}, this must run *before* the caller's
 * `session.extensions.loadExtension(path)`: the library never sees an
 * extension's files until Electron has already loaded the manifest.
 * Idempotent — it's a no-op when `activeTab` isn't declared or broad host
 * access is already present.
 *
 * TODO(electron): remove if Electron ever implements activeTab granting (or
 * exposes an API for embedders to grant it on action clicks).
 *
 * Never throws: this is a best-effort workaround, and a failed patch must
 * degrade to "extension loads unpatched" — callers invoke it right before
 * `loadExtension()`, so an escaping error (disk write failure, malformed
 * manifest) would otherwise skip loading the extension entirely.
 */
export async function patchActiveTabManifest(extensionPath: string): Promise<boolean> {
  try {
    return await patchActiveTabManifestUnsafe(extensionPath)
  } catch (error) {
    console.error(
      `electron-chrome-extensions: patchActiveTabManifest failed for ${extensionPath}; ` +
        'loading the extension unpatched',
      error,
    )
    return false
  }
}

async function patchActiveTabManifestUnsafe(extensionPath: string): Promise<boolean> {
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
  if (!grantActiveTabHostAccess(manifest)) {
    return false
  }

  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2))
  d(`granted <all_urls> host access to activeTab extension at ${extensionPath}`)
  return true
}

/**
 * Applies the activeTab → static host access grant to a parsed manifest.
 * Returns true when the manifest was modified. Split from the disk wrapper so
 * the logic is testable as a pure function.
 */
export function grantActiveTabHostAccess(manifest: chrome.runtime.Manifest): boolean {
  const permissions: string[] | undefined = manifest.permissions as string[] | undefined
  if (!permissions?.includes('activeTab')) {
    return false
  }

  if (manifest.manifest_version === 3) {
    if (hasBroadHostAccess(manifest.host_permissions)) {
      return false
    }
    manifest.host_permissions = [...(manifest.host_permissions || []), ALL_URLS]
  } else {
    // MV2 declares host patterns inside `permissions` itself.
    if (hasBroadHostAccess(permissions)) {
      return false
    }
    manifest.permissions = [...permissions, ALL_URLS]
  }

  return true
}
