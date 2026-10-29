import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

type RemovalOptions = {
  since?: number
  origins?: string[]
  excludeOrigins?: string[]
  originTypes?: { unprotectedWeb?: boolean; protectedWeb?: boolean; extension?: boolean }
}
type DataTypeSet = Partial<Record<string, boolean>>
type StorageType = NonNullable<Electron.ClearStorageDataOptions['storages']>[number]

/**
 * Data an extension can ask to remove that Chromium regenerates on its own. Clearing more of it than
 * asked for — Electron cannot filter by time, and the HTTP cache cannot be filtered by origin — costs
 * a reload, never a session.
 */
const REGENERABLE: Record<string, StorageType | 'httpCache' | null> = {
  appcache: null, // Gone from Chromium; nothing to remove.
  cache: 'httpCache',
  cacheStorage: 'cachestorage',
  serviceWorkers: 'serviceworkers',
}

/** Site data that is the user's: logged-in sessions and saved state. */
const SITE_DATA: Record<string, StorageType> = {
  cookies: 'cookies',
  fileSystems: 'filesystem',
  indexedDB: 'indexdb',
  localStorage: 'localstorage',
}

/** Kinds Chrome keeps and this host does not: removing them succeeds with nothing to do. */
// WebSQL is gone from Chromium (and from Electron's storage kinds), so there is none of it either.
const NOT_KEPT = new Set(['downloads', 'formData', 'history', 'passwords', 'pluginData', 'webSQL'])

/**
 * chrome.browsingData on the session's own storage.
 *
 * Real, with two refusals where Electron cannot do what Chrome does without doing more damage than
 * the extension asked for — each one fails the call with nothing removed, instead of over-deleting:
 *
 * - A time range (`since` > 0) over site data. Electron clears storage without a time filter, so
 *   "the last hour of cookies" would log the user out of every service in the partition.
 * - Storage kinds other than cookies over every origin. Chrome's default leaves extension origins
 *   out (`originTypes: {unprotectedWeb}`); Electron's clear cannot exclude them, and it would wipe
 *   every extension's own IndexedDB, local storage and service worker registration in the session.
 *   With `origins` it is exact, which is how Keeper calls it (its web vault's caches, by origin).
 */
export class BrowsingDataAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('browsingData.remove', this.remove.bind(this), {
      permission: 'browsingData' as chrome.runtime.ManifestPermissions,
    })
  }

  private async remove(
    _event: ExtensionEvent,
    options: RemovalOptions = {},
    dataToRemove: DataTypeSet = {},
  ) {
    const wanted = Object.keys(dataToRemove || {}).filter((type) => dataToRemove[type])
    const unknown = wanted.filter(
      (type) => !(type in REGENERABLE) && !(type in SITE_DATA) && !NOT_KEPT.has(type),
    )
    if (unknown.length) throw new Error(`Unexpected data type: ${unknown[0]}.`)

    // Extension origins are never touched, whatever the caller passes: Chrome protects them by default.
    const origins = (options.origins ?? []).filter((origin) => !/^chrome-extension:/i.test(origin))
    const byOrigin = Array.isArray(options.origins)
    const siteData = wanted.filter((type) => type in SITE_DATA)

    if (options.excludeOrigins?.length && wanted.some((type) => type !== 'cache')) {
      throw new Error('Removing data with excludeOrigins is not supported.')
    }
    if ((options.since ?? 0) > 0 && siteData.length) {
      throw new Error('Removing site data for a time range is not supported; pass since: 0.')
    }
    const everyOrigin = wanted.filter(
      (type) =>
        type !== 'cache' && type !== 'cookies' && type !== 'appcache' && !NOT_KEPT.has(type),
    )
    if (!byOrigin && everyOrigin.length) {
      throw new Error(
        `Removing ${everyOrigin.join(', ')} for every origin is not supported; pass origins.`,
      )
    }

    const session = this.ctx.session
    const storages = wanted
      .map((type) => (type in SITE_DATA ? SITE_DATA[type] : REGENERABLE[type]))
      .filter((storage): storage is StorageType => !!storage && storage !== 'httpCache')

    if (wanted.includes('cache')) await session.clearCache()
    if (!storages.length) return

    if (byOrigin) {
      for (const origin of origins) await session.clearStorageData({ origin, storages })
    } else {
      // Only cookies reach here (the checks above): every site's, as Chrome removes them.
      await session.clearStorageData({ storages })
    }
  }
}
