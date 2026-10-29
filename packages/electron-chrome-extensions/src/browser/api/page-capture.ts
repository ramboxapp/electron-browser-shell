import { randomUUID } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

/**
 * chrome.pageCapture.saveAsMHTML on `webContents.savePage(…, 'MHTML')`.
 *
 * Electron only saves to a file, so the page goes to a temporary one, its bytes come back over the
 * IPC and the preload wraps them in the Blob Chrome answers with (a Blob does not cross the IPC).
 */
export class PageCaptureAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('pageCapture.saveAsMHTML', this.saveAsMHTML.bind(this), {
      permission: 'pageCapture' as chrome.runtime.ManifestPermissions,
    })
  }

  private async saveAsMHTML(_event: ExtensionEvent, details: { tabId?: number } = {}) {
    const tab =
      typeof details.tabId === 'number' ? this.ctx.store.getTabById(details.tabId) : undefined
    if (!tab || tab.isDestroyed()) throw new Error(`No tab with id: ${details.tabId}.`)

    const file = path.join(os.tmpdir(), `crx-page-capture-${randomUUID()}.mhtml`)
    try {
      await tab.savePage(file, 'MHTML')
      return new Uint8Array(await readFile(file))
    } finally {
      await rm(file, { force: true }).catch(() => {})
    }
  }
}
