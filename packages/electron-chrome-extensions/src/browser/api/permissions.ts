import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { patternsCover } from './lib/match-patterns'

/**
 * This is a very basic implementation of the permissions API. Likely
 * more work will be needed to integrate with the native permissions.
 */
export class PermissionsAPI {
  private permissionMap = new Map<
    /* extensionId */ string,
    {
      permissions: chrome.runtime.ManifestPermissions[]
      origins: string[]
    }
  >()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('permissions.contains', this.contains)
    handle('permissions.getAll', this.getAll)
    handle('permissions.remove', this.remove)
    handle('permissions.request', this.request)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.getAllExtensions().forEach((ext) => this.processExtension(ext))

    sessionExtensions.on('extension-loaded', (_event, extension) => {
      this.processExtension(extension)
    })

    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.permissionMap.delete(extension.id)
    })
  }

  private processExtension(extension: Electron.Extension) {
    const manifest: chrome.runtime.Manifest = extension.manifest
    this.permissionMap.set(extension.id, {
      permissions: (manifest.permissions || []) as chrome.runtime.ManifestPermissions[],
      origins: manifest.host_permissions || [],
    })
  }

  private contains = (
    { extension }: ExtensionEvent,
    permissions: chrome.permissions.Permissions,
  ) => {
    const currentPermissions = this.permissionMap.get(extension.id)!
    const hasPermissions = permissions.permissions
      ? permissions.permissions.every((permission) =>
          currentPermissions.permissions.includes(permission),
        )
      : true
    // Pattern containment, not string equality: a host permission of `https://*/*` covers
    // `https://*.grammarly.com/*`, and Chromium answers `true` for it. See lib/match-patterns.
    const hasOrigins = permissions.origins
      ? patternsCover(currentPermissions.origins, permissions.origins)
      : true
    return hasPermissions && hasOrigins
  }

  private getAll = ({ extension }: ExtensionEvent) => {
    return this.permissionMap.get(extension.id)
  }

  private remove = ({ extension }: ExtensionEvent, permissions: chrome.permissions.Permissions) => {
    // TODO
    return true
  }

  private request = async (
    { extension }: ExtensionEvent,
    request: chrome.permissions.Permissions,
  ) => {
    const declaredPermissions = new Set([
      ...(extension.manifest.permissions || []),
      ...(extension.manifest.optional_permissions || []),
    ])

    if (request.permissions && !request.permissions.every((p) => declaredPermissions.has(p))) {
      throw new Error('Permissions request includes undeclared permission')
    }

    const granted = await this.ctx.store.requestPermissions(extension, request)
    if (!granted) return false

    const permissions = this.permissionMap.get(extension.id)!
    if (request.origins) {
      for (const origin of request.origins) {
        if (!permissions.origins.includes(origin)) {
          permissions.origins.push(origin)
        }
      }
    }
    if (request.permissions) {
      for (const permission of request.permissions) {
        if (!permissions.permissions.includes(permission)) {
          permissions.permissions.push(permission)
        }
      }
    }
    return true
  }
}
