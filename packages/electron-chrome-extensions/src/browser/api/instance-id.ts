import { randomBytes } from 'node:crypto'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { SessionStateFile } from './lib/session-state'

type InstanceRecord = Record<string, { id: string; creationTime: number }>

/**
 * The local half of chrome.instanceID: an identifier per extension that stays the same across
 * launches until the extension deletes it, and the time it was made — kept in the session, as Chrome
 * keeps it in the profile. Tokens need Google's servers and fail in the preload, as `gcm.register`
 * does. Gated on the `gcm` permission, as in Chrome.
 */
export class InstanceIDAPI {
  private ids: SessionStateFile<InstanceRecord>

  constructor(private ctx: ExtensionContext) {
    this.ids = new SessionStateFile(ctx.session, 'instance-id', () => ({}))
    const handle = this.ctx.router.apiHandler()
    const opts = { permission: 'gcm' as chrome.runtime.ManifestPermissions }
    handle('instanceID.getID', this.getID.bind(this), opts)
    handle('instanceID.getCreationTime', this.getCreationTime.bind(this), opts)
    handle('instanceID.deleteID', this.deleteID.bind(this), opts)
  }

  private record(extensionId: string) {
    const all = this.ids.get()
    if (!all[extensionId]) {
      // Chrome's ids are 8 random bytes, base64url without padding: 11 characters.
      all[extensionId] = { id: randomBytes(8).toString('base64url'), creationTime: Date.now() }
      this.ids.set(all)
    }
    return all[extensionId]
  }

  private getID(event: ExtensionEvent) {
    return this.record(event.extension.id).id
  }

  private getCreationTime(event: ExtensionEvent) {
    return this.record(event.extension.id).creationTime
  }

  private deleteID(event: ExtensionEvent) {
    const all = this.ids.get()
    delete all[event.extension.id]
    this.ids.set(all)
  }
}
