import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import debug from 'debug'

const d = debug('electron-chrome-extensions:content-script-storage-patch')

/** The file written into the extension directory, and the guard that keeps it single-shot. */
// No leading underscore: Chromium refuses to load an extension that contains a file whose name
// starts with one ("Filenames starting with \"_\" are reserved for use by the system"), which took
// the whole extension down rather than just the shim.
const SHIM_FILE = 'crx_content_script_storage.js'

/**
 * Aliases `chrome.storage.sync` and `chrome.storage.managed` onto `chrome.storage.local`, the same
 * way this library's preload does for every other extension context.
 *
 * Written as a content script because a content script's isolated world is the one context the
 * preload cannot reach: `session.registerPreloadScript` has no content-script world, so a content
 * script sees Chromium's native `chrome` and nothing this library injects. Content scripts of the
 * same extension share one isolated world and the files of one entry run in array order, so putting
 * this first in each entry's `js` makes the aliases visible to the extension's own scripts.
 *
 * `storage.session` is deliberately left alone: it throws in a content script in Chrome too, unless
 * the extension raises its access level, so the throw here is correct behaviour.
 */
const SHIM_SOURCE = `/* electron-chrome-extensions: chrome.storage.sync/managed alias for content scripts */
(function () {
  if (typeof chrome === 'undefined' || !chrome.storage) return
  var local = chrome.storage.local
  if (!local) return
  // Unconditional, and that is the point: Electron DOES define chrome.storage.sync and
  // chrome.storage.managed in a content script, as objects with the right method names whose calls
  // then reject with '"sync" is not available in this instance of Chrome'. So presence proves
  // nothing — a feature check on the property passes and the extension still breaks on first use —
  // and nothing synchronous can tell a working area from a stub. Both are replaced the same way the
  // preload replaces them in every other extension context: aliased to storage.local.
  var alias = function (name) {
    try {
      Object.defineProperty(chrome.storage, name, { value: local, configurable: true, enumerable: true })
      return true
    } catch (error) {
      try {
        chrome.storage[name] = local
        return chrome.storage[name] === local
      } catch (ignored) {
        return false
      }
    }
  }
  var failed = ['sync', 'managed'].filter(function (name) {
    return !alias(name)
  })
  // A failed alias is otherwise indistinguishable from the shim never having run at all.
  self.__crxStorageShimRan = failed.length === 0 ? 'ok' : 'failed:' + failed.join(',')
  if (failed.length) {
    console.error('electron-chrome-extensions: could not alias chrome.storage.' + failed.join('/'))
  }
})()
`

/**
 * Makes `chrome.storage.sync` and `chrome.storage.managed` usable from an extension's content
 * scripts, by writing a shim file into the extension directory and putting it first in the `js` of
 * every content script entry that runs in an isolated world.
 *
 * Why this is needed at all: in a content script, calling `chrome.storage.sync` or
 * `chrome.storage.managed` fails with `"sync" is not available in this instance of Chrome`, while in
 * a service worker or an extension page this library aliases both to `storage.local`. Measured
 * against a real Chromium (Edge 155) both answer there, in every context. Worse than missing: the
 * properties are PRESENT, as objects carrying the right method names, so an extension's own feature
 * check passes and it breaks on first use. Extensions read their own settings from a content script
 * all the time — password managers and Grammarly do — and the rejection takes out whatever ran it.
 *
 * Like the other patches here, this rewrites files on disk and so must run BEFORE the caller's
 * `session.extensions.loadExtension()`: this library never sees an extension's files until Electron
 * has already loaded it. Idempotent — an entry that already starts with the shim is left alone.
 *
 * Never throws: a failed patch degrades to "extension loads unpatched", because callers invoke it
 * right before loadExtension() and an escaping error would skip loading the extension entirely.
 *
 * Returns true when it changed something, for logging and for tests.
 */
export async function patchContentScriptStorage(extensionPath: string): Promise<boolean> {
  try {
    return await patchContentScriptStorageUnsafe(extensionPath)
  } catch (error) {
    console.error(
      `electron-chrome-extensions: patchContentScriptStorage failed for ${extensionPath}; ` +
        'loading the extension unpatched',
      error,
    )
    return false
  }
}

async function patchContentScriptStorageUnsafe(extensionPath: string): Promise<boolean> {
  const manifestPath = path.join(extensionPath, 'manifest.json')
  let manifestText: string
  try {
    manifestText = await fs.readFile(manifestPath, 'utf-8')
  } catch {
    return false
  }

  // Chromium tolerates a UTF-8 BOM in manifest.json; JSON.parse doesn't.
  const manifest = JSON.parse(
    manifestText.charCodeAt(0) === 0xfeff ? manifestText.slice(1) : manifestText,
  )

  const entries: any[] = Array.isArray(manifest.content_scripts) ? manifest.content_scripts : []
  if (entries.length === 0) return false

  let changed = false
  for (const entry of entries) {
    // A MAIN-world entry runs in the page's own world, where there is no chrome.storage to alias.
    if (entry?.world === 'MAIN') continue
    if (!Array.isArray(entry?.js) || entry.js.length === 0) continue
    if (entry.js[0] === SHIM_FILE) continue
    entry.js = [SHIM_FILE, ...entry.js.filter((file: string) => file !== SHIM_FILE)]
    changed = true
  }

  if (!changed) return false

  await fs.writeFile(path.join(extensionPath, SHIM_FILE), SHIM_SOURCE, 'utf-8')
  await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8')
  d(`patched content script storage for ${manifest.name} ${manifest.version}`)
  return true
}

/** Exported for specs: the name of the shim file written into an extension directory. */
export const CONTENT_SCRIPT_STORAGE_SHIM_FILE = SHIM_FILE
