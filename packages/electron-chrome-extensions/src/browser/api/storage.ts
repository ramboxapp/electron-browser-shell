import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

const AREAS = new Set(['local', 'session', 'sync'])

/**
 * Delivers `storage.onChanged` to an extension's service worker on an Electron that does not.
 *
 * Measured 30/10/2026 without this library: Electron 43.0.0 and 44.9.3+wvcus never deliver a
 * storage change to an MV3 worker — not one the worker made, not one a page made — while pages get
 * every one; 44.10.0 and 45.1.0 stock deliver all of them (electron/electron#55146). Each extension
 * context reports the writes it made (the preload's `storage` definition) and this re-emits them to
 * the extension's worker only, waking it if it sleeps, as Chrome does. Pages are not sent anything:
 * they already receive the native event.
 *
 * Remove once every supported binary is 44.10+ — `chrome-storage-onChanged-spec.ts` says when: its
 * "native delivery" case measures the binary it runs on, and the preload's gate turns the relay off
 * where the binary delivers.
 */
export class StorageAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('storage.reportChanges', this.reportChanges)
  }

  private reportChanges = (event: ExtensionEvent, areaName: unknown, changes: unknown) => {
    if (typeof areaName !== 'string' || !AREAS.has(areaName)) return
    if (!changes || typeof changes !== 'object' || Object.keys(changes).length === 0) return
    // `sync` is backed by `local` in this library, and the native event in pages says `local`.
    const area = areaName === 'sync' ? 'local' : areaName
    this.ctx.router.sendEvent(event.extension.id, 'storage.onChanged', changes, area)
  }
}
