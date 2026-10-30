import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import debug from 'debug'
import { CRX_I18N_KEY, CrxI18nPayload, formatExtensionMessage } from '../../shared/i18n-format'

const d = debug('electron-chrome-extensions:locale-patch')

/**
 * Gives an extension its messages in the host application's language.
 *
 * Electron never tells Chromium's extension l10n which locale the application runs in
 * (`extension_l10n_util::SetProcessLocale` is not called), so `CurrentLocaleOrDefault()` falls back
 * to `en` — measured on Electron 43 with `--lang` set: every extension's `chrome.i18n.getMessage`
 * answered in the default locale, and the user saw a Spanish app with English extensions.
 *
 * The bundle is resolved here, in the main process, with Chrome's own fallback chain (the exact
 * locale, then its language, over the manifest's `default_locale`), and written INTO manifest.json
 * under `crx_i18n`. The manifest is the one thing every extension context can read synchronously —
 * `chrome.runtime.getManifest()` works in the service worker, in extension pages and in content
 * scripts alike — and `getMessage` is a synchronous API, so there is no other channel that reaches
 * all three without a race at worker start-up. Chromium keeps unrecognised manifest keys (with an
 * install warning) and hands them back from getManifest, which the preload and the content-script
 * shim then read. Like the other patches, this rewrites a file on disk and so must run BEFORE
 * `session.extensions.loadExtension()`, and again on every load: the application's language can
 * change between two of them.
 *
 * Idempotent — the payload is rewritten only when it differs — and it never throws: a failed patch
 * leaves the extension in the default locale, which is where it was.
 *
 * Returns true when it changed the manifest, for logging and for tests.
 */
export async function patchExtensionLocale(
  extensionPath: string,
  locale: string,
): Promise<boolean> {
  try {
    return await patchExtensionLocaleUnsafe(extensionPath, locale)
  } catch (error) {
    console.error(
      `electron-chrome-extensions: patchExtensionLocale failed for ${extensionPath}; ` +
        'the extension keeps its default locale',
      error,
    )
    return false
  }
}

/**
 * The `_locales` folders to try for a locale, most specific first — Chrome's parent-locale chain.
 * `es-AR` → `es_AR`, `es`; `zh-Hant-TW` → `zh_Hant_TW`, `zh_Hant`, `zh`. The default locale is not
 * in this list: the caller appends it, because it comes from the manifest.
 */
export function localeCandidates(locale: string): string[] {
  const parts = String(locale || '')
    .trim()
    .split(/[-_]/)
    .filter(Boolean)
  const candidates: string[] = []
  for (let i = parts.length; i > 0; i--) candidates.push(parts.slice(0, i).join('_'))
  return candidates
}

const readJson = async (file: string): Promise<any> => {
  const raw = await fs.readFile(file, 'utf-8')
  // Chromium tolerates a UTF-8 BOM; JSON.parse does not.
  return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
}

/** The folder under `_locales` whose name matches `candidate`, ignoring case and `-`/`_`. */
const findLocaleDir = (dirs: string[], candidate: string): string | undefined => {
  const wanted = candidate.toLowerCase().replace(/-/g, '_')
  return dirs.find((dir) => dir.toLowerCase().replace(/-/g, '_') === wanted)
}

/**
 * The merged message bundle for a locale: the default locale's messages, overlaid by the language's,
 * overlaid by the exact locale's. Undefined when the extension has no `default_locale` (then it has
 * no bundle at all, and Chrome's getMessage answers '' for everything).
 */
export async function resolveExtensionMessages(
  extensionPath: string,
  locale: string,
  defaultLocale: string | undefined,
): Promise<CrxI18nPayload['messages'] | undefined> {
  if (!defaultLocale) return undefined
  const localesDir = path.join(extensionPath, '_locales')
  let dirs: string[]
  try {
    dirs = (await fs.readdir(localesDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return undefined
  }

  // Least specific first, so a later (more specific) bundle wins on a key both define.
  const chain = [defaultLocale, ...localeCandidates(locale).reverse()]
  const merged: CrxI18nPayload['messages'] = {}
  const seen = new Set<string>()
  for (const candidate of chain) {
    const dir = findLocaleDir(dirs, candidate)
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    let messages: any
    try {
      messages = await readJson(path.join(localesDir, dir, 'messages.json'))
    } catch (error) {
      d('skipping %s/%s: %o', extensionPath, dir, error)
      continue
    }
    if (!messages || typeof messages !== 'object') continue
    for (const [name, entry] of Object.entries<any>(messages)) {
      if (!entry || typeof entry.message !== 'string') continue
      merged[name] =
        entry.placeholders && typeof entry.placeholders === 'object'
          ? { message: entry.message, placeholders: entry.placeholders }
          : { message: entry.message }
    }
  }
  return merged
}

/**
 * Where the patch keeps the original values of the manifest fields it localized, so the next run —
 * in another language, or with none — starts again from the `__MSG_x__` placeholders and not from
 * the previous language's text.
 */
export const CRX_I18N_MANIFEST_KEY = 'crx_i18n_manifest'

/** The manifest fields Chrome localizes, as paths: Chromium's extension_l10n_util list, the parts an extension here can have. */
const localizableFields = (manifest: any): string[][] => [
  ['name'],
  ['short_name'],
  ['description'],
  ['action', 'default_title'],
  ['browser_action', 'default_title'],
  ['page_action', 'default_title'],
  ['omnibox', 'keyword'],
  ...Object.keys(
    manifest.commands && typeof manifest.commands === 'object' ? manifest.commands : {},
  ).map((command) => ['commands', command, 'description']),
]

const readPath = (object: any, keys: string[]) =>
  keys.reduce((value, key) => (value && typeof value === 'object' ? value[key] : undefined), object)

const writePath = (object: any, keys: string[], value: unknown) => {
  const parent = readPath(object, keys.slice(0, -1))
  if (parent && typeof parent === 'object') parent[keys[keys.length - 1]] = value
}

/*
  The manifest's own `__MSG_x__` strings — the extension's name, its description, its action title,
  its command descriptions — in the app's language. Chromium localizes them at load with the same
  locale it uses for getMessage, which Electron leaves at `en` (see above), so a Spanish app showed
  the extension's English name and tooltip even once getMessage answered in Spanish. They are
  replaced here with the resolved bundle, and the originals are kept under CRX_I18N_MANIFEST_KEY.
  A name the bundle does not have stays a placeholder, for Chromium to resolve as it did.
*/
const localizeManifest = (manifest: any, payload: CrxI18nPayload | undefined) => {
  const originals = manifest[CRX_I18N_MANIFEST_KEY]
  if (Array.isArray(originals)) {
    for (const [keys, value] of originals) {
      if (Array.isArray(keys)) writePath(manifest, keys, value)
    }
  }
  delete manifest[CRX_I18N_MANIFEST_KEY]
  if (!payload) return

  const state = { ...payload, extensionId: '' }
  const kept: Array<[string[], string]> = []
  for (const keys of localizableFields(manifest)) {
    const value = readPath(manifest, keys)
    if (typeof value !== 'string' || !value.includes('__MSG_')) continue
    const localized = value.replace(/__MSG_([A-Za-z0-9_@]+)__/g, (placeholder, name: string) => {
      const message = formatExtensionMessage(state, name)
      return message || placeholder
    })
    if (localized === value) continue
    writePath(manifest, keys, localized)
    kept.push([keys, value])
  }
  if (kept.length) manifest[CRX_I18N_MANIFEST_KEY] = kept
}

/** `es_ES` and `es-ES` both read as `es-ES`, the form `i18n.getUILanguage()` answers with. */
const toBcp47 = (locale: string) =>
  String(locale || '')
    .trim()
    .replace(/_/g, '-')

async function patchExtensionLocaleUnsafe(extensionPath: string, locale: string): Promise<boolean> {
  const manifestPath = path.join(extensionPath, 'manifest.json')
  let manifest: any
  try {
    manifest = await readJson(manifestPath)
  } catch {
    // Not an unpacked extension directory — nothing to patch.
    return false
  }

  const bcp47 = toBcp47(locale)
  const messages = bcp47
    ? await resolveExtensionMessages(extensionPath, bcp47, manifest.default_locale)
    : undefined
  const next: CrxI18nPayload | undefined = messages ? { locale: bcp47, messages } : undefined
  const before = JSON.stringify(manifest)

  localizeManifest(manifest, next)
  // Always last, after the originals localizeManifest may have re-added: the same content in the
  // same key order, so an unchanged locale compares equal and the file is not rewritten.
  delete manifest[CRX_I18N_KEY]
  if (next) manifest[CRX_I18N_KEY] = next

  if (JSON.stringify(manifest) === before) return false
  await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8')
  d(
    `wrote %s messages for %s (%d keys)`,
    bcp47,
    extensionPath,
    next ? Object.keys(next.messages).length : 0,
  )
  return true
}
