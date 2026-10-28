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
    // Copies: grants and revocations edit these lists, and must not edit the manifest object.
    this.permissionMap.set(extension.id, {
      permissions: [...(manifest.permissions || [])] as chrome.runtime.ManifestPermissions[],
      origins: [...(manifest.host_permissions || [])],
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

  /**
   * Only what the extension was granted at runtime can be revoked: Chrome rejects removing anything
   * the manifest requires ("You cannot remove required permissions."). What was removed is announced
   * through permissions.onRemoved, which is how an extension's worker learns about it.
   */
  private remove = ({ extension }: ExtensionEvent, request: chrome.permissions.Permissions) => {
    const manifest: chrome.runtime.Manifest = extension.manifest
    const required = new Set<string>(manifest.permissions || [])
    const requiredOrigins = new Set<string>(manifest.host_permissions || [])
    if (
      (request.permissions || []).some((p) => required.has(p)) ||
      (request.origins || []).some((o) => requiredOrigins.has(o))
    ) {
      throw new Error('You cannot remove required permissions.')
    }

    const current = this.permissionMap.get(extension.id)
    if (!current) return false
    const removed = {
      permissions: (request.permissions || []).filter((p) => current.permissions.includes(p)),
      origins: (request.origins || []).filter((o) => current.origins.includes(o)),
    }
    current.permissions = current.permissions.filter((p) => !removed.permissions.includes(p))
    current.origins = current.origins.filter((o) => !removed.origins.includes(o))

    if (removed.permissions.length || removed.origins.length) {
      this.ctx.router.sendEvent(extension.id, 'permissions.onRemoved', removed)
    }
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
    // Only what is new is announced, the way Chrome does: re-requesting something already granted
    // grants nothing and fires nothing.
    const added = { permissions: [] as string[], origins: [] as string[] }
    if (request.origins) {
      for (const origin of request.origins) {
        if (!permissions.origins.includes(origin)) {
          permissions.origins.push(origin)
          added.origins.push(origin)
        }
      }
    }
    if (request.permissions) {
      for (const permission of request.permissions) {
        if (!permissions.permissions.includes(permission)) {
          permissions.permissions.push(permission)
          added.permissions.push(permission)
        }
      }
    }
    if (added.permissions.length || added.origins.length) {
      // An extension's worker keeps its idea of what it may do and refreshes it from this event
      // (Proton Pass does, for the clipboard permissions it asks for from its settings).
      this.ctx.router.sendEvent(extension.id, 'permissions.onAdded', added)
    }
    return true
  }
}
