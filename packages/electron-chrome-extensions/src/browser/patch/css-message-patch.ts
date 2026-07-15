import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import debug from 'debug'

const d = debug('electron-chrome-extensions:css-message-patch')

/** Chrome's predefined i18n message that expands to the extension's ID. */
const EXTENSION_ID_TOKEN = '__MSG_@@extension_id__'

/**
 * Marker written into an extension directory once its CSS has been patched, so
 * subsequent loads skip the directory walk. Bump the suffix if the substitution
 * logic changes and already-patched extensions must be re-processed.
 */
const MARKER_FILENAME = '.crx-css-patched'

/**
 * Substitutes Chrome's `__MSG_@@extension_id__` i18n token with the real
 * extension ID in a CSS string. Pure and side-effect free so it can be unit
 * tested; returns the input unchanged when there's nothing to replace.
 */
export function substituteExtensionIdInCss(css: string, extensionId: string): string {
  if (!css.includes(EXTENSION_ID_TOKEN)) return css
  return css.split(EXTENSION_ID_TOKEN).join(extensionId)
}

/**
 * Recursively collects `.css` file paths under `dir`. Only enumerates
 * directory entries — it never reads non-CSS files, so an extension's large
 * asset/model directories (e.g. Grammarly's `data/*.pt`) cost only a readdir.
 */
async function collectCssFiles(dir: string, acc: string[]): Promise<void> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectCssFiles(full, acc)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.css')) {
      acc.push(full)
    }
  }
}

/**
 * Works around Electron not substituting the `__MSG_@@extension_id__` i18n
 * token when serving/injecting an extension's CSS.
 *
 * Chrome expands `__MSG_@@extension_id__` (and other `__MSG_*__` messages) to
 * the extension's ID when it serves a `.css` resource. Electron doesn't, so
 * CSS that references assets as `url(chrome-extension://__MSG_@@extension_id__/…)`
 * (e.g. Grammarly's 330 icon/font references) resolves to a bogus host and
 * 404s — the extension's icons and CSS-drawn underlines silently break.
 *
 * There is no Electron hook to post-process served CSS without replacing the
 * whole native `chrome-extension://` handler (which would mean reimplementing
 * `web_accessible_resources` gating), so instead we rewrite the token in the
 * extension's CSS files on disk. CSS is served/injected lazily per request, so
 * a disk rewrite fixes both `<link>`-served and content-script-injected CSS.
 *
 * Unlike {@link patchActiveTabManifest} this runs *after* `loadExtension`,
 * because the substitution value (`@@extension_id`) is the ID Electron only
 * assigns once the extension is loaded. Callers pass the loaded extension's
 * `id`. Idempotent (a marker file short-circuits repeat loads; even without it,
 * a patched file has no token left to replace).
 *
 * Scope: `@@extension_id` only — the predefined message that dominates real CSS
 * usage. Full `__MSG_<key>__` (`_locales`) / `@@ui_locale` support can be added
 * later if a fleet extension needs it.
 *
 * Never throws: a failed patch degrades to "assets stay broken", never to a
 * failure that could disrupt the caller's load flow.
 *
 * @returns whether any file was modified.
 */
export async function patchExtensionCssMessages(
  extensionPath: string,
  extensionId: string,
): Promise<boolean> {
  try {
    return await patchExtensionCssMessagesUnsafe(extensionPath, extensionId)
  } catch (error) {
    console.error(
      `electron-chrome-extensions: patchExtensionCssMessages failed for ${extensionPath}; ` +
        'leaving its CSS assets unpatched',
      error,
    )
    return false
  }
}

async function patchExtensionCssMessagesUnsafe(
  extensionPath: string,
  extensionId: string,
): Promise<boolean> {
  const markerPath = path.join(extensionPath, MARKER_FILENAME)
  try {
    await fs.access(markerPath)
    return false // already patched on a previous load
  } catch {
    // no marker — proceed
  }

  const cssFiles: string[] = []
  await collectCssFiles(extensionPath, cssFiles)

  let changed = false
  for (const file of cssFiles) {
    const original = await fs.readFile(file, 'utf-8')
    const patched = substituteExtensionIdInCss(original, extensionId)
    if (patched !== original) {
      await fs.writeFile(file, patched)
      changed = true
    }
  }

  // Always drop the marker (even when nothing changed) so future loads of this
  // unchanged extension version skip the walk entirely.
  await fs.writeFile(markerPath, '')

  if (changed) d(`substituted ${EXTENSION_ID_TOKEN} in CSS for ${extensionId} at ${extensionPath}`)
  return changed
}
