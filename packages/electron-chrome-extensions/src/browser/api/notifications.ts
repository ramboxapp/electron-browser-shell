import { app, Extension, nativeImage, Notification } from 'electron'
import { randomUUID } from 'node:crypto'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { toExtensionIconPath, validateExtensionResource } from './common'

enum TemplateType {
  Basic = 'basic',
  Image = 'image',
  List = 'list',
  Progress = 'progress',
}

const getBody = (opts: chrome.notifications.NotificationOptions) => {
  const { type = TemplateType.Basic } = opts

  switch (type) {
    case TemplateType.List: {
      if (!Array.isArray(opts.items)) {
        throw new Error('List items must be provided for list type')
      }
      return opts.items.map((item) => `${item.title} - ${item.message}`).join('\n')
    }
    default:
      return opts.message || ''
  }
}

const getUrgency = (
  priority?: number,
): Required<Electron.NotificationConstructorOptions>['urgency'] => {
  if (typeof priority !== 'number') {
    return 'normal'
  } else if (priority >= 2) {
    return 'critical'
  } else if (priority < 0) {
    return 'low'
  } else {
    return 'normal'
  }
}

const createScopedIdentifier = (extension: Extension, id: string) => `${extension.id}-${id}`
const stripScopeFromIdentifier = (id: string) => {
  const index = id.indexOf('-')
  return id.substr(index + 1)
}

export class NotificationsAPI {
  private registry = new Map<string, Notification>()
  /** Notifications whose onClosed was already sent, or must not be: Electron's 'close' skips them. */
  private settled = new WeakSet<Notification>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('notifications.clear', this.clear)
    handle('notifications.create', this.create)
    handle('notifications.getAll', this.getAll)
    handle('notifications.getPermissionLevel', this.getPermissionLevel)
    handle('notifications.update', this.update)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (event, extension) => {
      for (const [key, notification] of this.registry) {
        if (key.startsWith(extension.id)) {
          this.settled.add(notification)
          notification.close()
          this.registry.delete(key)
        }
      }
    })
  }

  /**
   * Chrome resolves whether there was a notification to clear (measured in Chromium 147), and fires
   * onClosed(id, false) for it (measured in Edge 156). Electron emits no 'close' for a toast that
   * never reached the screen, or one already in the Action Center, so the event is sent here.
   */
  private clear = ({ extension }: ExtensionEvent, id: string) => {
    const notificationId = createScopedIdentifier(extension, id)
    const notification = this.registry.get(notificationId)
    if (notification) {
      if (!this.settled.has(notification)) {
        this.settled.add(notification)
        this.ctx.router.sendEvent(extension.id, 'notifications.onClosed', id, false)
      }
      notification.close()
    }
    this.registry.delete(notificationId)
    return !!notification
  }

  private create = async ({ extension }: ExtensionEvent, arg1: unknown, arg2?: unknown) => {
    let id: string
    let opts: chrome.notifications.NotificationOptions

    if (typeof arg1 === 'object') {
      // A fresh UUID per notification, as Chromium 147 generates. This was the constant 'guid', so a
      // second notification without an id replaced the first one.
      id = randomUUID()
      opts = arg1 as chrome.notifications.NotificationOptions
    } else if (typeof arg1 === 'string') {
      id = arg1
      opts = arg2 as chrome.notifications.NotificationOptions
    } else {
      throw new Error('Invalid arguments')
    }

    if (typeof opts !== 'object' || !opts.type || !opts.iconUrl || !opts.title || !opts.message) {
      throw new Error('Missing required notification options')
    }

    const buttons = Array.isArray(opts.buttons) ? opts.buttons : []
    const untitled = buttons.findIndex((button) => !button || typeof button.title !== 'string')
    if (untitled !== -1) {
      throw new Error(
        `Error in invocation of notifications.create(optional string notificationId, notifications.NotificationOptions options, optional function callback): Error at parameter 'options': Error at property 'buttons': Error at index ${untitled}: Missing required property 'title'.`,
      )
    }

    const notificationId = createScopedIdentifier(extension, id)

    // A create with an id in use replaces that notification; the extension is not told it closed.
    const replaced = this.registry.get(notificationId)
    if (replaced) {
      this.settled.add(replaced)
      replaced.close()
    }

    let icon: string | Electron.NativeImage | undefined

    /*
      The icon as Chrome takes it: a path inside the extension, the extension's own absolute URL, or a
      data: URL. The absolute URL failed with "Invalid iconUrl" (joined to the extension's folder as a
      path), and a data: URL reached the toast as a string, which Electron reads as a file path, so
      Windows showed no icon. It is decoded to an image instead.
    */
    if (opts.iconUrl) {
      if (/^data:/i.test(opts.iconUrl)) {
        const image = nativeImage.createFromDataURL(opts.iconUrl)
        icon = image.isEmpty() ? undefined : image
      } else {
        const iconPath = toExtensionIconPath(extension, opts.iconUrl)
        icon = iconPath && (await validateExtensionResource(extension, iconPath))
      }

      if (!icon) {
        throw new Error('Invalid iconUrl')
      }
    }

    /*
      Buttons as the notification's actions. Chrome shows at most two and accepts more without an
      error (measured in Chromium 147: three resolve), so the rest are dropped here too. Electron
      renders `button` actions on Windows (in the toast) and macOS; elsewhere they are ignored and
      the notification shows without them, which is what Chrome does on a platform without buttons.
      A button's `iconUrl` has no counterpart in a native notification.

      Until now the buttons were dropped, so onButtonClicked never fired. Grammarly is the one in
      the catalog that needs it: after an update across a major version it shows "Grammarly needs
      to be reloaded" with a "Reload" button, and only the button (not the body) reloads the tabs.
    */
    const actions: Electron.NotificationAction[] = buttons
      .slice(0, 2)
      .map((button) => ({ type: 'button', text: button.title }))

    // TODO: template types

    const notification = new Notification({
      actions,
      title: opts.title,
      subtitle: app.name,
      body: getBody(opts),
      silent: opts.silent,
      icon,
      urgency: getUrgency(opts.priority),
      timeoutType: opts.requireInteraction ? 'never' : 'default',
    })

    this.registry.set(notificationId, notification)

    notification.on('click', () => {
      this.ctx.store.noteUserGesture(extension.id)
      this.ctx.router.sendEvent(extension.id, 'notifications.onClicked', id)
    })

    // Electron 44 passes the index in the details object; 43 passes it as the second argument.
    notification.on('action', (details: any, legacyIndex?: number) => {
      const buttonIndex =
        typeof details?.actionIndex === 'number' ? details.actionIndex : legacyIndex
      if (typeof buttonIndex !== 'number' || buttonIndex < 0 || buttonIndex >= actions.length) {
        return
      }
      this.ctx.store.noteUserGesture(extension.id)
      this.ctx.router.sendEvent(extension.id, 'notifications.onButtonClicked', id, buttonIndex)
    })

    /*
      Electron 44 says why the toast closed. A toast that times out used to be reported as closed by
      the user (byUser was always true) and was dropped from the registry, yet it stayed in the
      Action Center, where a click reached nothing: Grammarly's "needs to be reloaded" with its
      Reload button did nothing from Win+N. Edge reports a timeout as onClosed(id, false) and takes
      the toast out of the Action Center, so it is removed here too (a close() after the first
      'close' removes it without emitting again). Without a reason (other platforms, or Electron
      43), 'close' is the user's.
    */
    notification.once('close', (details?: { reason?: string }) => {
      const reason = details?.reason
      if (reason === 'timedOut') notification.close()
      // Only if it is still this one: a create with the same id replaces it before it closes.
      if (this.registry.get(notificationId) === notification) this.registry.delete(notificationId)
      if (this.settled.has(notification)) return
      this.settled.add(notification)
      const byUser = reason ? reason === 'userCanceled' : true
      this.ctx.router.sendEvent(extension.id, 'notifications.onClosed', id, byUser)
    })

    notification.show()

    return id
  }

  /**
   * Chrome resolves with an OBJECT keyed by notification id, not an array.
   *
   * This returned an array, so the idiomatic `Object.keys(await getAll())` an extension writes came
   * back empty — every notification invisible to its own owner, with nothing to log.
   */
  private getAll = ({ extension }: ExtensionEvent) => {
    const notifications: Record<string, true> = {}
    for (const key of this.registry.keys()) {
      if (key.startsWith(extension.id)) notifications[stripScopeFromIdentifier(key)] = true
    }
    return notifications
  }

  private getPermissionLevel = (event: ExtensionEvent) => {
    return Notification.isSupported() ? 'granted' : 'denied'
  }

  private update = (
    { extension }: ExtensionEvent,
    id: string,
    opts: chrome.notifications.NotificationOptions,
  ) => {
    const notificationId = createScopedIdentifier(extension, id)

    const notification = this.registry.get(notificationId)

    if (!notification) {
      return false
    }

    // TODO: remaining opts

    if (opts.priority) notification.urgency = getUrgency(opts.priority)
    if (opts.silent) notification.silent = opts.silent
    // Chrome resolves true for a notification that exists (measured in Chromium 147); this resolved
    // nothing.
    return true
  }
}
