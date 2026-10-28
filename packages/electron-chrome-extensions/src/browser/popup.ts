import { EventEmitter } from 'node:events'
import { BrowserWindow, Session } from 'electron'
import { getAllWindows } from './api/common'
import { wakeExtensionServiceWorker } from './patch/service-worker-wake'
import debug from 'debug'

const d = debug('electron-chrome-extensions:popup')

export interface PopupAnchorRect {
  x: number
  y: number
  width: number
  height: number
}

interface PopupViewOptions {
  extensionId: string
  session: Session
  parent: Electron.BaseWindow
  url: string
  anchorRect: PopupAnchorRect
  alignment?: string
}

const supportsPreferredSize = () => {
  const major = parseInt(process.versions.electron.split('.').shift() || '', 10)
  return major >= 12
}

export class PopupView extends EventEmitter {
  static POSITION_PADDING = 5

  static BOUNDS = {
    minWidth: 25,
    minHeight: 25,
    maxWidth: 800,
    maxHeight: 600,
  }

  browserWindow?: BrowserWindow
  parent?: Electron.BaseWindow
  extensionId: string

  private session: Session
  private anchorRect: PopupAnchorRect
  private destroyed: boolean = false
  private hidden: boolean = true
  private alignment?: string

  /** Preferred size changes are only received in Electron v12+ */
  private usingPreferredSize = supportsPreferredSize()

  /** Whether Chromium has reported a preferred size yet. It only starts after the load stops. */
  private receivedPreferredSize = false

  private readyPromise: Promise<void>

  constructor(opts: PopupViewOptions) {
    super()

    this.parent = opts.parent
    this.extensionId = opts.extensionId
    this.anchorRect = opts.anchorRect
    this.alignment = opts.alignment
    this.session = opts.session

    this.browserWindow = new BrowserWindow({
      show: false,
      frame: false,
      parent: opts.parent,
      movable: false,
      maximizable: false,
      minimizable: false,
      // https://github.com/electron/electron/issues/47579
      fullscreenable: false,
      resizable: false,
      // On Windows, frameless windows still get invisible WS_THICKFRAME resize
      // borders (8px left/right/bottom) which are included in setBounds() sizes,
      // shrinking the web viewport below the extension's preferred size.
      // Upstream Electron regression: reproduced on stock 42.5.2, absent on
      // stock 37. setContentSize() doesn't help: for frameless windows
      // Electron treats content size == window bounds, ignoring the borders.
      thickFrame: false,
      skipTaskbar: true,
      backgroundColor: '#ffffff',
      roundedCorners: false,
      webPreferences: {
        session: opts.session,
        sandbox: true,
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        enablePreferredSizeMode: true,
      },
    })

    const untypedWebContents = this.browserWindow.webContents as any
    untypedWebContents.on('preferred-size-changed', this.updatePreferredSize)

    this.browserWindow.webContents.on('devtools-closed', this.maybeClose)
    this.browserWindow.on('blur', this.maybeClose)
    this.browserWindow.on('closed', this.destroy)
    this.parent.once('closed', this.destroy)

    /*
      Start small *before* the page loads, not after. Electron only turns preferred-size mode on when
      the load stops, so for the whole load the page sees whatever size the window has — and the old
      reset to the minimum right after did-finish-load landed exactly when extensions run their
      start-up code. A popup that sizes itself from its own viewport (Proton Pass reads
      documentElement.clientWidth and adopts it as its width, on start-up and on every resize) caught
      the 25x25 window there and made it its size: the preferred size then *was* 25x25 (32x39 after
      Windows clamps it) and nothing grew it back. 3 of 10 opens in Rambox, 28/10/2026.
      The page's own size reaches us earlier, from the preload (see setContentSizeHint).
    */
    if (this.usingPreferredSize) {
      this.setSize({ width: PopupView.BOUNDS.minWidth, height: PopupView.BOUNDS.minHeight })
    }

    this.readyPromise = this.load(opts.url)
  }

  private show() {
    this.hidden = false
    this.browserWindow?.show()
  }

  private async load(url: string): Promise<void> {
    const win = this.browserWindow!

    // See service-worker-wake.ts: the popup's first message to the
    // extension's service worker can hang if the worker went idle, so wake
    // it before the popup's own page begins loading.
    await wakeExtensionServiceWorker(this.session, this.extensionId)

    try {
      await win.webContents.loadURL(url)
    } catch (e) {
      console.error(e)
    }

    if (this.destroyed) return

    if (this.usingPreferredSize) {
      // No resize here: the window already has the hint's size, or the minimum it started at, and
      // preferred-size mode (on from now) grows it from there. Shrinking it now is what Proton caught.
      // Chromium reports a first preferred size after the load; if it ever doesn't, show the popup
      // anyway rather than leave an invisible window that eats the next click.
      setTimeout(() => {
        if (this.destroyed || !this.hidden) return
        d('no preferred size after load, showing anyway')
        this.updatePosition()
        this.show()
      }, 250)
    } else {
      // Set large initial size to avoid overflow
      this.setSize({ width: PopupView.BOUNDS.maxWidth, height: PopupView.BOUNDS.maxHeight })

      // Wait for content and layout to load
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (this.destroyed) return

      await this.queryPreferredSize()
      if (this.destroyed) return

      this.show()
    }
  }

  destroy = () => {
    if (this.destroyed) return

    this.destroyed = true

    d(`destroying ${this.extensionId}`)

    if (this.parent) {
      if (!this.parent.isDestroyed()) {
        this.parent.off('closed', this.destroy)
      }
      this.parent = undefined
    }

    if (this.browserWindow) {
      if (!this.browserWindow.isDestroyed()) {
        const { webContents } = this.browserWindow

        if (!webContents.isDestroyed() && webContents.isDevToolsOpened()) {
          webContents.closeDevTools()
        }

        this.browserWindow.off('closed', this.destroy)
        this.browserWindow.destroy()
      }

      this.browserWindow = undefined
    }
  }

  isDestroyed() {
    return this.destroyed
  }

  /** Resolves when the popup finishes loading. */
  whenReady() {
    return this.readyPromise
  }

  setSize(rect: Partial<Electron.Rectangle>) {
    if (!this.browserWindow || !this.parent) return

    const width = Math.floor(
      Math.min(PopupView.BOUNDS.maxWidth, Math.max(rect.width || 0, PopupView.BOUNDS.minWidth)),
    )

    const height = Math.floor(
      Math.min(PopupView.BOUNDS.maxHeight, Math.max(rect.height || 0, PopupView.BOUNDS.minHeight)),
    )

    const size = { width, height }
    d(`setSize`, size)

    this.emit('will-resize', size)

    this.browserWindow?.setBounds({
      ...this.browserWindow.getBounds(),
      ...size,
    })

    this.emit('resized')
  }

  private maybeClose = () => {
    // Keep open if webContents is being inspected
    if (!this.browserWindow?.isDestroyed() && this.browserWindow?.webContents.isDevToolsOpened()) {
      d('preventing close due to DevTools being open')
      return
    }

    // For extension popups with a login form, the user may need to access a
    // program outside of the app. Closing the popup would then add
    // inconvenience.
    if (!getAllWindows().some((win) => win.isFocused())) {
      d('preventing close due to focus residing outside of the app')
      return
    }

    this.destroy()
  }

  private updatePosition() {
    if (!this.browserWindow || !this.parent) return

    const winBounds = this.parent.getBounds()
    const winContentBounds = this.parent.getContentBounds()
    const nativeTitlebarHeight = winBounds.height - winContentBounds.height

    const viewBounds = this.browserWindow.getBounds()

    let x = winBounds.x + this.anchorRect.x + this.anchorRect.width - viewBounds.width
    let y =
      winBounds.y +
      nativeTitlebarHeight +
      this.anchorRect.y +
      this.anchorRect.height +
      PopupView.POSITION_PADDING

    // If aligned to a differently then we need to offset the popup position
    if (this.alignment?.includes('right')) x = winBounds.x + this.anchorRect.x
    if (this.alignment?.includes('top'))
      y =
        winBounds.y +
        nativeTitlebarHeight -
        viewBounds.height +
        this.anchorRect.y -
        PopupView.POSITION_PADDING

    // Convert to ints
    x = Math.floor(x)
    y = Math.floor(y)

    const position = { x, y }
    d(`updatePosition`, position)

    this.emit('will-move', position)

    this.browserWindow.setBounds({
      ...this.browserWindow.getBounds(),
      ...position,
    })

    this.emit('moved')
  }

  /** Backwards compat for Electron <12 */
  private async queryPreferredSize() {
    if (this.usingPreferredSize || this.destroyed) return

    const rect = await this.browserWindow!.webContents.executeJavaScript(
      `((${() => {
        const rect = document.body.getBoundingClientRect()
        return { width: rect.width, height: rect.height }
      }})())`,
    )

    if (this.destroyed) return

    this.setSize({ width: rect.width, height: rect.height })
    this.updatePosition()
  }

  /**
   * The page's own size, measured by the preload when the document becomes interactive — before the
   * page's deferred scripts run, so before an extension can read its viewport. Chrome's popup never
   * shows a page a viewport other than its content size (auto-resize sizes the frame inside the
   * layout itself); Electron's preferred-size mode only starts after the load, so this is how the
   * window gets there first. For a popup that declares its size (`html, body { width: 600px }`)
   * the measure is exact; for a fluid one it is a first guess the preferred size then corrects.
   * Ignored once Chromium has reported a preferred size, which is the authority.
   */
  setContentSizeHint(size: Electron.Size) {
    if (this.destroyed || !this.usingPreferredSize || this.receivedPreferredSize) return
    if (!(size?.width > 0 && size?.height > 0)) return
    d('setContentSizeHint', size)
    this.setSize(size)
    this.updatePosition()
  }

  private updatePreferredSize = (event: Electron.Event, size: Electron.Size) => {
    d('updatePreferredSize', size)
    this.usingPreferredSize = true
    this.receivedPreferredSize = true
    this.setSize(size)
    this.updatePosition()

    // Wait to reveal popup until it's sized and positioned correctly
    if (this.hidden) this.show()
  }
}
