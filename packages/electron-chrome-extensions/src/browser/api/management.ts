import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

/**
 * Builds a chrome.management.ExtensionInfo from a loaded Electron extension.
 * All extensions run unpacked in Electron, hence the 'development' install
 * type and the always-enabled state.
 */
const createExtensionInfo = (extension: Electron.Extension): chrome.management.ExtensionInfo => {
  const manifest: chrome.runtime.Manifest = extension.manifest || {}
  return {
    id: extension.id,
    name: extension.name,
    shortName: manifest.short_name || extension.name,
    description: manifest.description || '',
    version: extension.version,
    enabled: true,
    disabledReason: undefined,
    offlineEnabled: false,
    optionsUrl: '',
    permissions: (manifest.permissions as string[]) || [],
    // MV2 mixes host permissions into 'permissions'; filter for URL patterns.
    hostPermissions:
      manifest.manifest_version === 3
        ? manifest.host_permissions || []
        : ((manifest.permissions as string[]) || []).filter((permission) =>
            /:\/\/|<all_urls>/.test(permission),
          ),
    installType: 'development',
    isApp: false,
    mayDisable: false,
    type: 'extension',
  } as chrome.management.ExtensionInfo
}

/**
 * Implementation of the chrome.management API, limited to read-only methods.
 * Install/uninstall/enable operations aren't applicable to unpacked
 * extensions loaded programmatically.
 */
export class ManagementAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('management.get', this.get.bind(this))
    handle('management.getAll', this.getAll.bind(this))
    handle('management.getSelf', this.getSelf.bind(this))
  }

  private getSessionExtensions() {
    return this.ctx.session.extensions || this.ctx.session
  }

  private get(event: ExtensionEvent, id: string) {
    const extension = this.getSessionExtensions().getExtension(id)
    if (!extension) {
      throw new Error(`Failed to find extension with id '${id}'.`)
    }
    return createExtensionInfo(extension)
  }

  private getAll(event: ExtensionEvent) {
    return this.getSessionExtensions().getAllExtensions().map(createExtensionInfo)
  }

  private getSelf(event: ExtensionEvent) {
    return createExtensionInfo(event.extension as any)
  }
}
