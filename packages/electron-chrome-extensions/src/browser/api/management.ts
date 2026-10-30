import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

/**
 * Builds a chrome.management.ExtensionInfo from a loaded Electron extension.
 * All extensions run unpacked in Electron, hence the 'development' install
 * type and the always-enabled state.
 */
const createExtensionInfo = (extension: Electron.Extension): chrome.management.ExtensionInfo => {
  const manifest: chrome.runtime.Manifest = extension.manifest || {}
  const optionsPage = manifest.options_page || manifest.options_ui?.page
  const icons = Object.entries(manifest.icons || {})
    .map(([size, file]) => ({ size: Number(size), url: `${extension.url}${file}` }))
    .filter((icon) => Number.isFinite(icon.size))
  /*
    The fields Chrome sends, and no more. `disabledReason`, `icons` and `updateUrl` were always
    present, as `undefined` when there was nothing to say, and Chrome leaves them out then (measured
    in Edge 156: sixteen fields for an extension with no icons and no update URL; this answered
    nineteen). `homepageUrl` and `versionName` are the empty string there, not absent.
  */
  const info: Record<string, unknown> = {
    id: extension.id,
    name: extension.name,
    shortName: manifest.short_name || extension.name,
    description: manifest.description || '',
    version: extension.version,
    versionName: manifest.version_name || '',
    enabled: true,
    offlineEnabled: !!manifest.offline_enabled,
    // Chrome gives the options page's full URL; extensions open it from their own UI with it.
    optionsUrl: optionsPage ? `${extension.url}${optionsPage}` : '',
    homepageUrl: manifest.homepage_url || '',
    permissions: (manifest.permissions as string[]) || [],
    // MV2 mixes host permissions into 'permissions'; filter for URL patterns.
    hostPermissions:
      manifest.manifest_version === 3
        ? manifest.host_permissions || []
        : ((manifest.permissions as string[]) || []).filter((permission) =>
            /:\/\/|<all_urls>/.test(permission),
          ),
    /*
      'normal', not 'development'. Electron can only "load unpacked", but what the embedder unpacks
      is the Web Store package the user chose, and 'development' is the answer Chrome gives for a
      developer's own checkout: extensions read it to switch on debug behaviour (verbose logging,
      a dev backend, telemetry off) that the user of a store install never sees.
    */
    installType: 'normal',
    isApp: false,
    mayDisable: false,
    type: 'extension',
  }
  if (manifest.update_url) info.updateUrl = manifest.update_url
  if (icons.length) info.icons = icons
  return info as unknown as chrome.management.ExtensionInfo
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
    // Warnings are Chrome's install-time UI; a loaded extension has none left to show.
    handle('management.getPermissionWarningsById', () => [])
    handle('management.getPermissionWarningsByManifest', () => [])
    handle('management.setEnabled', () => {
      throw new Error('The user did not accept the re-enable dialog.')
    })
    handle('management.uninstallSelf', () => {
      throw new Error('Extension uninstall is not available here.')
    })
    // Uninstalling is the embedder's to offer; the id is checked first, as Chrome checks it.
    handle('management.uninstall', (event: ExtensionEvent, id: string) => {
      this.extensionOrThrow(id)
      throw new Error('Extension uninstall is not available here.')
    })
    /*
      App methods. Everything loaded here is an extension, and for an extension Chrome answers
      "Extension <id> is not an App." (measured in Chromium 147 for launchApp). generateAppForLink
      creates an app, which nothing here can hold.
    */
    const notAnApp = (event: ExtensionEvent, id: string) => {
      this.extensionOrThrow(id)
      throw new Error(`Extension ${id} is not an App.`)
    }
    handle('management.launchApp', notAnApp)
    handle('management.setLaunchType', notAnApp)
    handle('management.createAppShortcut', notAnApp)
    handle('management.generateAppForLink', () => {
      throw new Error('Apps cannot be created here.')
    })

    /*
      onInstalled and onUninstalled, from the session's own load and unload events. An extension that
      watches what else is installed (an enterprise agent, a conflicting-extension check) registers
      them at worker start, and a namespace without them threw there.
    */
    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-loaded', (_event, extension) => {
      this.ctx.router.broadcastEvent('management.onInstalled', createExtensionInfo(extension))
    })
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.ctx.router.broadcastEvent('management.onUninstalled', extension.id)
    })
  }

  private getSessionExtensions() {
    return this.ctx.session.extensions || this.ctx.session
  }

  // Chrome's message has no quotes around the id (Chromium 147 and Edge 156).
  private extensionOrThrow(id: string) {
    const extension = typeof id === 'string' ? this.getSessionExtensions().getExtension(id) : null
    if (!extension) {
      throw new Error(`Failed to find extension with id ${id}.`)
    }
    return extension
  }

  private get(event: ExtensionEvent, id: string) {
    return createExtensionInfo(this.extensionOrThrow(id))
  }

  private getAll(event: ExtensionEvent) {
    return this.getSessionExtensions().getAllExtensions().map(createExtensionInfo)
  }

  private getSelf(event: ExtensionEvent) {
    return createExtensionInfo(event.extension as any)
  }
}
