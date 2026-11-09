import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import debug from 'debug'
import { CRX_I18N_KEY, formatExtensionMessage } from '../../shared/i18n-format'

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
 * `sync` is aliased onto `local`, which is where this library keeps sync data in every other
 * context. `managed` is NOT: it gets the same empty read-only policy store the preload installs,
 * because aliasing it would hand the extension its own data back as administrator policy.
 *
 * `storage.session` is deliberately left alone: it throws in a content script in Chrome too, unless
 * the extension raises its access level, so the throw here is correct behaviour.
 */
const SHIM_SOURCE = `/* electron-chrome-extensions: the APIs a content script is missing here */
(function () {
  if (typeof chrome === 'undefined' || !chrome.storage) return
  // In an extension page this file also runs (see patchEmbeddablePages), and there it only has work
  // to do when this library's preload did not run: an extension page embedded in a web page, which
  // Electron stopped giving preloads to (43.7, 44.3, 45.0). The preload exposes its bridge as
  // \`electron\`; where it is present, the preload already defined all of this, and better.
  if (typeof electron !== 'undefined' && electron && typeof electron.invokeExtension === 'function') {
    self.__crxStorageShimRan = 'preload'
    return
  }
  var local = chrome.storage.local
  if (!local) return
  // Unconditional, and that is the point: Electron DOES define chrome.storage.sync and
  // chrome.storage.managed in a content script, as objects with the right method names whose calls
  // then reject with '"sync" is not available in this instance of Chrome'. So presence proves
  // nothing — a feature check on the property passes and the extension still breaks on first use —
  // and nothing synchronous can tell a working area from a stub.
  var defineOn = function (target, name, value) {
    try {
      Object.defineProperty(target, name, { value: value, configurable: true, enumerable: true })
      return true
    } catch (error) {
      try {
        target[name] = value
        return target[name] === value
      } catch (ignored) {
        return false
      }
    }
  }
  var define = function (name, value) {
    return defineOn(chrome.storage, name, value)
  }
  // Answers the way the preload answers in every other context: an administrator policy store that
  // is read-only and, with no policy installed, empty. Aliasing it onto local instead would report
  // the extension's own data as policy — the same leak, just in the one world the preload cannot
  // reach.
  var answer = function (value, args) {
    var callback = args.length && typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined
    if (callback) {
      Promise.resolve().then(function () { callback(value) })
      return undefined
    }
    return Promise.resolve(value)
  }
  var readOnly = function () {
    var args = Array.prototype.slice.call(arguments)
    var callback = args.length && typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined
    if (callback) {
      Promise.resolve().then(function () { callback() })
      return undefined
    }
    return Promise.reject(new Error('This is a read-only store.'))
  }
  var noop = function () {}
  var managed = {
    get: function (keys) {
      var args = Array.prototype.slice.call(arguments)
      // Chrome returns the defaults the caller passed and overrides none of them.
      var result = keys && typeof keys === 'object' && !Array.isArray(keys) && typeof keys !== 'function'
        ? Object.assign({}, keys)
        : {}
      return answer(result, args)
    },
    getKeys: function () { return answer([], Array.prototype.slice.call(arguments)) },
    getBytesInUse: function () { return answer(0, Array.prototype.slice.call(arguments)) },
    set: readOnly,
    remove: readOnly,
    clear: readOnly,
    onChanged: {
      addListener: noop,
      removeListener: noop,
      hasListener: function () { return false },
      hasListeners: function () { return false },
    },
  }
  /*
    chrome.dom: Chromium gives a content script openOrClosedShadowRoot, and Electron implements
    the namespace nowhere, so an extension that walks shadow DOM finds chrome.dom undefined.
    Measured against a real Chromium with the same extension: Chrome's content-script world has
    'dom' and 'extension', ours had neither.

    This covers an OPEN shadow root, which is what a page built out of web components has. A CLOSED
    root cannot be reached from script without a native binding, so it answers null — the same
    answer as "no shadow root here", which every caller already handles.
  */
  var dom = {
    openOrClosedShadowRoot: function (element) {
      try {
        return (element && element.shadowRoot) || null
      } catch (error) {
        return null
      }
    },
  }

  // chrome.extension in a content script: Chrome exposes exactly these two.
  var extension = {
    inIncognitoContext: false,
    ViewType: { TAB: 'tab', POPUP: 'popup' },
  }

  var failed = []
  if (!define('sync', local)) failed.push('sync')
  if (!define('managed', managed)) failed.push('managed')
  if (typeof chrome.dom === 'undefined' && !defineOn(chrome, 'dom', dom)) failed.push('dom')
  if (typeof chrome.extension === 'undefined' && !defineOn(chrome, 'extension', extension))
    failed.push('extension')

  /*
    chrome.i18n in the host application's language. Electron's own getMessage answers in the
    extension's default locale whatever the app's language is (see locale-patch.ts); the locale
    patch resolves the right bundle and leaves it in the manifest, the one thing a content script
    can read synchronously, and this replaces the three locale-dependent methods with ones that use
    it. An extension the patch found no bundle for keeps Electron's.
  */
  var i18nPayload = null
  try {
    i18nPayload = chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest()['__CRX_I18N_KEY__']
  } catch (error) {
    i18nPayload = null
  }
  if (i18nPayload && i18nPayload.messages && chrome.i18n) {
    var formatMessage = __FORMAT_EXTENSION_MESSAGE__
    var i18nState = {
      locale: i18nPayload.locale,
      messages: i18nPayload.messages,
      extensionId: chrome.runtime.id,
    }
    var acceptLanguages = i18nPayload.locale === 'en-US' ? ['en-US'] : [i18nPayload.locale, 'en-US']
    var i18nOk =
      defineOn(chrome.i18n, 'getMessage', function (name, substitutions, options) {
        return formatMessage(i18nState, name, substitutions, options)
      }) &&
      defineOn(chrome.i18n, 'getUILanguage', function () {
        return i18nPayload.locale
      }) &&
      defineOn(chrome.i18n, 'getAcceptLanguages', function (callback) {
        var languages = acceptLanguages.slice()
        if (typeof callback === 'function') {
          Promise.resolve().then(function () { callback(languages) })
          return undefined
        }
        return Promise.resolve(languages)
      })
    if (!i18nOk) failed.push('i18n')
  }
  // A failed definition is otherwise indistinguishable from the shim never having run at all.
  self.__crxStorageShimRan = failed.length === 0 ? 'ok' : 'failed:' + failed.join(',')
  if (failed.length) {
    console.error('electron-chrome-extensions: could not define chrome.storage.' + failed.join('/'))
  }
})()
`
  // The formatter is one self-contained function, written to be embedded this way (see
  // shared/i18n-format.ts); the key is the one the locale patch writes.
  .replace('__FORMAT_EXTENSION_MESSAGE__', formatExtensionMessage.toString())
  .replace('__CRX_I18N_KEY__', CRX_I18N_KEY)

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
  const pagesChanged = await patchEmbeddablePages(extensionPath, manifest)
  if (entries.length === 0 && !pagesChanged) return false

  let changed = false
  for (const entry of entries) {
    // A MAIN-world entry runs in the page's own world, where there is no chrome.storage to alias.
    if (entry?.world === 'MAIN') continue
    if (!Array.isArray(entry?.js) || entry.js.length === 0) continue
    if (entry.js[0] === SHIM_FILE) continue
    entry.js = [SHIM_FILE, ...entry.js.filter((file: string) => file !== SHIM_FILE)]
    changed = true
  }

  /*
    The shim file is written even when the manifest already points at it. A newer version of this
    library ships a newer shim — one that defines APIs the old one did not — and an extension
    patched by an older version would otherwise keep the stale copy for as long as its folder
    survives, which is to say for ever. Writing it is cheap and idempotent.
  */
  await fs.writeFile(path.join(extensionPath, SHIM_FILE), SHIM_SOURCE, 'utf-8')

  if (!changed) return pagesChanged

  await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8')
  d(`patched content script storage for ${manifest.name} ${manifest.version}`)
  return true
}

/** The tag put into an embeddable page. Root-relative, so a page in a subfolder finds the file too. */
const PAGE_SHIM_TAG = `<script src="/${SHIM_FILE}"></script>`

/**
 * The extension's pages a web page can put in an iframe: every literal `.html` path in
 * `web_accessible_resources` (a glob is not expanded; no extension in the catalog lists its in-field
 * UI by glob). Paths that leave the extension directory are dropped.
 */
const embeddablePages = (extensionPath: string, manifest: any): string[] => {
  const war: any[] = Array.isArray(manifest.web_accessible_resources)
    ? manifest.web_accessible_resources
    : []
  const resources = war.flatMap((entry) =>
    typeof entry === 'string' ? [entry] : Array.isArray(entry?.resources) ? entry.resources : [],
  )
  const root = path.resolve(extensionPath) + path.sep
  const pages = new Set<string>()
  for (const resource of resources) {
    if (typeof resource !== 'string' || !/\.html?$/i.test(resource) || /[*?]/.test(resource))
      continue
    const file = path.resolve(extensionPath, resource.replace(/^\/+/, ''))
    if (file.startsWith(root)) pages.add(file)
  }
  return [...pages]
}

/**
 * Puts the shim first in every page a web page can embed, which is the in-field UI of every password
 * manager in the catalog (Keeper's prompt, Bitwarden's notification bar, RoboForm's save dialog...).
 *
 * Electron stopped running session frame preloads in a `chrome-extension://` document embedded in an
 * ordinary page (it now follows `nodeIntegrationInSubFrames`; documented for 45.0 and backported to
 * 43.7.0, 44.3.0 and 42.11.3). Measured with spec/embedded-extension-frame-spec.ts: the frame gets the
 * library's surface on 43.0.0 and loses it on 44.9.3+wvcus and 45.2.1+wvcus. What a page script can
 * put back without the preload's IPC bridge is what the content-script shim already does —
 * `storage.sync` on `local` (from 45.2 Electron has a native `sync` that is a DIFFERENT store, so the
 * frame and the worker would read different data), `storage.managed`, and `i18n` in the app's
 * language. `chrome.windows` and this library's `tabs` need the bridge and stay missing there.
 *
 * The tag goes right after `<head>` (or before the first script, or first in the file), so it runs
 * before the page's own scripts. In a page that did get the preload the shim returns at once.
 */
async function patchEmbeddablePages(extensionPath: string, manifest: any): Promise<boolean> {
  let changed = false
  for (const file of embeddablePages(extensionPath, manifest)) {
    let html: string
    try {
      html = await fs.readFile(file, 'utf-8')
    } catch {
      continue
    }
    if (html.includes(SHIM_FILE)) continue
    const head = /<head(\s[^>]*)?>/i.exec(html)
    const script = /<script[\s>]/i.exec(html)
    const at = head ? head.index + head[0].length : script ? script.index : 0
    await fs.writeFile(file, html.slice(0, at) + PAGE_SHIM_TAG + html.slice(at), 'utf-8')
    changed = true
  }
  if (changed) await fs.writeFile(path.join(extensionPath, SHIM_FILE), SHIM_SOURCE, 'utf-8')
  return changed
}

/** Exported for specs: the name of the shim file written into an extension directory. */
export const CONTENT_SCRIPT_STORAGE_SHIM_FILE = SHIM_FILE
