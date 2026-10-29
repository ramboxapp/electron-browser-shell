import { app, screen } from 'electron'
import { createHash } from 'node:crypto'
import * as fsp from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

/*
  One `screen` subscription for the process, fanned out to every session's router: an app with one
  session per profile (Rambox) would otherwise add three listeners to `screen` per session.
*/
const displayRouters = new Set<ExtensionContext['router']>()
let watchingDisplays = false
const watchDisplaysOnce = () => {
  if (watchingDisplays) return
  watchingDisplays = true
  const subscribe = () => {
    const changed = () => {
      for (const router of displayRouters) router.broadcastEvent('system.display.onDisplayChanged')
    }
    screen.on('display-added', changed)
    screen.on('display-removed', changed)
    screen.on('display-metrics-changed', changed)
  }
  // `screen` cannot be touched before the app is ready.
  if (app.isReady()) subscribe()
  else app.whenReady().then(subscribe)
}

// fs.statfs is in every Node an Electron 30+ ships; the @types/node this package builds with predates it.
const statfs = (fsp as any).statfs as (
  path: string,
) => Promise<{ bsize: number; blocks: number; bavail: number }>

type StorageUnitInfo = {
  id: string
  name: string
  type: 'fixed' | 'removable' | 'unknown'
  capacity: number
}

/**
 * The parts of chrome.system that Electron provides and that do not work.
 *
 * - `system.storage.getInfo()` natively crashes the process (0xC0000005), measured on Electron
 *   43.0.0 and 44.9.3+wvcus with no library loaded. It is answered here instead, and so are its two
 *   siblings so the namespace stays consistent. Only the volume holding the user's profile is
 *   listed: enumerating every drive means probing each letter, and a disconnected network drive can
 *   hang that. Chrome lists all fixed and removable units; one is a subset, not a lie.
 * - `system.display.*` natively fails with "System display API is not available." The read half and
 *   the change event are answered from Electron's `screen`.
 *
 * `system.cpu` and `system.memory` work natively and are left to Electron.
 */
export class SystemAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    const storage = { permission: 'system.storage' as chrome.runtime.ManifestPermissions }
    const display = { permission: 'system.display' as chrome.runtime.ManifestPermissions }
    handle('system.storage.getInfo', this.getStorageInfo.bind(this), storage)
    handle('system.storage.getAvailableCapacity', this.getAvailableCapacity.bind(this), storage)
    handle('system.storage.ejectDevice', this.ejectDevice.bind(this), storage)
    handle('system.display.getInfo', this.getDisplayInfo.bind(this), display)

    displayRouters.add(this.ctx.router)
    watchDisplaysOnce()
  }

  private profileVolume(): string {
    return path.parse(os.homedir()).root || '/'
  }

  private unitId(root: string) {
    return createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 32)
  }

  private async getStorageInfo(): Promise<StorageUnitInfo[]> {
    const root = this.profileVolume()
    try {
      const stats = await statfs(root)
      return [
        { id: this.unitId(root), name: root, type: 'fixed', capacity: stats.bsize * stats.blocks },
      ]
    } catch {
      return []
    }
  }

  private async getAvailableCapacity(_event: ExtensionEvent, id: string) {
    const root = this.profileVolume()
    if (id !== this.unitId(root)) throw new Error(`Invalid storage id: ${id}.`)
    const stats = await statfs(root)
    return { id, availableCapacity: stats.bsize * stats.bavail }
  }

  private ejectDevice(_event: ExtensionEvent, id: string) {
    // The profile's own volume is never ejectable; anything else is not a unit this API listed.
    return id === this.unitId(this.profileVolume()) ? 'in_use' : 'no_such_device'
  }

  private getDisplayInfo() {
    const primaryId = screen.getPrimaryDisplay().id
    return screen.getAllDisplays().map((display) => {
      const dpi = Math.round(96 * display.scaleFactor)
      const rect = (r: Electron.Rectangle) => ({
        left: r.x,
        top: r.y,
        width: r.width,
        height: r.height,
      })
      return {
        id: String(display.id),
        name: display.label || `Display ${display.id}`,
        mirroringSourceId: '',
        mirroringDestinationIds: [],
        isPrimary: display.id === primaryId,
        isInternal: display.internal,
        isEnabled: true,
        isUnified: false,
        activeState: 'active',
        dpiX: dpi,
        dpiY: dpi,
        rotation: display.rotation,
        bounds: rect(display.bounds),
        overscan: { left: 0, top: 0, right: 0, bottom: 0 },
        workArea: rect(display.workArea),
        modes: [],
        hasTouchSupport: display.touchSupport === 'available',
        hasAccelerometerSupport: display.accelerometerSupport === 'available',
        availableDisplayZoomFactors: [],
        displayZoomFactor: 0,
      }
    })
  }
}
