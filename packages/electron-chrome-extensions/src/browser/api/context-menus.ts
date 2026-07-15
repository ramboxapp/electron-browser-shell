import { Menu, MenuItem } from 'electron'
import { MenuItemConstructorOptions } from 'electron/main'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { ContextMenuType, getIconImage, matchesPattern } from './common'

type ContextItemProps = chrome.contextMenus.CreateProperties & { id: string }

type ContextItemConstructorOptions = {
  extension: Electron.Extension
  props: ContextItemProps
  webContents: Electron.WebContents
  params?: Electron.ContextMenuParams
  showIcon?: boolean
}

const DEFAULT_CONTEXTS = ['page']

const getContextTypesFromParams = (params: Electron.ContextMenuParams): Set<ContextMenuType> => {
  const contexts = new Set<ContextMenuType>(['all'])

  switch (params.mediaType) {
    case 'audio':
    case 'video':
    case 'image':
      contexts.add(params.mediaType)
  }

  if (params.pageURL) contexts.add('page')
  if (params.linkURL) contexts.add('link')
  if (params.frameURL) contexts.add('frame')
  if (params.selectionText) contexts.add('selection')
  if (params.isEditable) contexts.add('editable')

  return contexts
}

const formatTitle = (title: string, params: Electron.ContextMenuParams) => {
  if (params.selectionText && title.includes('%s')) {
    title = title.split('%s').join(params.selectionText)
  }
  return title
}

const matchesConditions = (
  props: ContextItemProps,
  conditions: {
    contextTypes: Set<ContextMenuType>
    targetUrl?: string
    documentUrl?: string
  },
) => {
  if (props.visible === false) return false

  const { contextTypes, targetUrl, documentUrl } = conditions

  const contexts = props.contexts
    ? Array.isArray(props.contexts)
      ? props.contexts
      : [props.contexts]
    : DEFAULT_CONTEXTS
  const inContext = contexts.some((context) => contextTypes.has(context as ContextMenuType))
  if (!inContext) return false

  if (props.targetUrlPatterns && props.targetUrlPatterns.length > 0 && targetUrl) {
    if (!props.targetUrlPatterns.some((pattern) => matchesPattern(pattern, targetUrl))) {
      return false
    }
  }

  if (props.documentUrlPatterns && props.documentUrlPatterns.length > 0 && documentUrl) {
    if (!props.documentUrlPatterns.some((pattern) => matchesPattern(pattern, documentUrl))) {
      return false
    }
  }

  return true
}

export class ContextMenusAPI {
  private menus = new Map<
    /* extensionId */ string,
    Map</* menuItemId */ string, ContextItemProps>
  >()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('contextMenus.create', this.create)
    handle('contextMenus.update', this.update)
    handle('contextMenus.remove', this.remove)
    handle('contextMenus.removeAll', this.removeAll)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (event, extension) => {
      if (this.menus.has(extension.id)) {
        this.menus.delete(extension.id)
      }
    })

    this.ctx.store.buildMenuItems = this.buildMenuItemsForExtension.bind(this)
  }

  private addContextItem(extensionId: string, props: ContextItemProps) {
    let contextItems = this.menus.get(extensionId)
    if (!contextItems) {
      contextItems = new Map()
      this.menus.set(extensionId, contextItems)
    }
    contextItems.set(props.id, props)
  }

  private buildMenuItem = (opts: ContextItemConstructorOptions) => {
    const { extension, props, webContents, params } = opts

    // TODO: try to get the appropriately sized image before resizing
    let icon = opts.showIcon ? getIconImage(extension) : undefined
    if (icon) {
      icon = icon.resize({ width: 16, height: 16 })
    }

    const menuItemOptions: MenuItemConstructorOptions = {
      id: props.id,
      type: props.type as any,
      label: params ? formatTitle(props.title || '', params) : props.title || '',
      icon,
      enabled: props.enabled,
      click: () => {
        this.onClicked(extension.id, props.id, webContents, params)
      },
    }

    return menuItemOptions
  }

  private buildMenuItemsFromTemplate = (menuItemTemplates: ContextItemConstructorOptions[]) => {
    const itemMap = new Map<string, MenuItemConstructorOptions>()

    // Group by ID
    for (const item of menuItemTemplates) {
      const menuItem = this.buildMenuItem(item)
      itemMap.set(item.props.id, menuItem)
    }

    // Organize in tree
    for (const item of menuItemTemplates) {
      const menuItem = itemMap.get(item.props.id)
      if (item.props.parentId) {
        const parentMenuItem = itemMap.get(`${item.props.parentId}`)
        if (parentMenuItem) {
          const submenu = (parentMenuItem.submenu || []) as Electron.MenuItemConstructorOptions[]
          submenu.push(menuItem!)
          parentMenuItem.submenu = submenu
        }
      }
    }

    const menuItems: Electron.MenuItem[] = []

    const buildFromTemplate = (opts: Electron.MenuItemConstructorOptions) => {
      if (Array.isArray(opts.submenu)) {
        const submenu = new Menu()
        opts.submenu.forEach((item) => submenu.append(buildFromTemplate(item)))
        opts.submenu = submenu
      }
      return new MenuItem({
        ...opts,
        // Force submenu type when submenu items are present
        type: opts.type === 'normal' && opts.submenu ? 'submenu' : opts.type,
      })
    }

    // Build all final MenuItems in-order
    for (const item of menuItemTemplates) {
      // Items with parents will be handled recursively
      if (item.props.parentId) continue

      const menuItem = itemMap.get(item.props.id)!
      menuItems.push(buildFromTemplate(menuItem))
    }

    return menuItems
  }

  buildMenuItemsForParams(
    webContents: Electron.WebContents,
    params: Electron.ContextMenuParams,
  ): Electron.MenuItem[] {
    if (webContents.session !== this.ctx.session) return []

    let menuItemOptions: ContextItemConstructorOptions[] = []

    const conditions = {
      contextTypes: getContextTypesFromParams(params),
      targetUrl: params.srcURL || params.linkURL,
      documentUrl: params.frameURL || params.pageURL,
    }

    const sessionExtensions = this.ctx.session.extensions || this.ctx.session

    for (const [extensionId, propItems] of this.menus) {
      const extension = sessionExtensions.getExtension(extensionId)
      if (!extension) continue

      const extensionMenuItemOptions: ContextItemConstructorOptions[] = []

      for (const [, props] of propItems) {
        if (matchesConditions(props, conditions)) {
          const menuItem = {
            extension,
            props,
            webContents,
            params,
          }
          extensionMenuItemOptions.push(menuItem)
        }
      }

      const topLevelItems = extensionMenuItemOptions.filter((opt) => !opt.props.parentId)

      if (topLevelItems.length > 1) {
        // Create new top-level item to group children
        const groupId = `group${extension.id}`
        const groupMenuItemOptions: ContextItemConstructorOptions = {
          extension,
          webContents,
          props: {
            id: groupId,
            title: extension.name,
          },
          params,
          showIcon: true,
        }

        // Reassign children to group item
        const children = extensionMenuItemOptions.map((opt) =>
          opt.props.parentId
            ? opt
            : {
                ...opt,
                props: {
                  ...opt.props,
                  parentId: groupId,
                },
              },
        )

        menuItemOptions = [...menuItemOptions, groupMenuItemOptions, ...children]
      } else if (extensionMenuItemOptions.length > 0) {
        // Set all top-level children to show icon
        const children = extensionMenuItemOptions.map((opt) => ({
          ...opt,
          showIcon: !opt.props.parentId,
        }))
        menuItemOptions = [...menuItemOptions, ...children]
      }
    }

    return this.buildMenuItemsFromTemplate(menuItemOptions)
  }

  private buildMenuItemsForExtension(
    extensionId: string,
    menuType: ContextMenuType,
  ): Electron.MenuItem[] {
    const extensionItems = this.menus.get(extensionId)
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    const extension = sessionExtensions.getExtension(extensionId)
    const activeTab = this.ctx.store.getActiveTabOfCurrentWindow()

    const menuItemOptions = []

    if (extensionItems && extension && activeTab) {
      const conditions = {
        contextTypes: new Set<ContextMenuType>(['all', menuType]),
      }

      for (const [, props] of extensionItems) {
        if (matchesConditions(props, conditions)) {
          const menuItem = { extension, props, webContents: activeTab }
          menuItemOptions.push(menuItem)
        }
      }
    }

    return this.buildMenuItemsFromTemplate(menuItemOptions)
  }

  private create = ({ extension }: ExtensionEvent, createProperties: ContextItemProps) => {
    const { id, type, title } = createProperties

    if (this.menus.has(id)) {
      // TODO: duplicate error
      return
    }

    if (!title && type !== 'separator') {
      // TODO: error
      return
    }

    this.addContextItem(extension.id, createProperties)
  }

  // Merges updates into the stored item; menus are rebuilt from the stored
  // props the next time they're shown.
  private update = (
    { extension }: ExtensionEvent,
    menuItemId: string | number,
    updateProperties: Partial<ContextItemProps>,
  ) => {
    const items = this.menus.get(extension.id)
    const props = items?.get(`${menuItemId}`)
    if (!props) return

    // The item ID can't be changed by an update
    const { id: _ignored, ...updates } = updateProperties
    items!.set(`${menuItemId}`, { ...props, ...updates })
  }

  private remove = ({ extension }: ExtensionEvent, menuItemId: string) => {
    const items = this.menus.get(extension.id)
    if (items && items.has(menuItemId)) {
      items.delete(menuItemId)
      if (items.size === 0) {
        this.menus.delete(extension.id)
      }
    }
  }

  private removeAll = ({ extension }: ExtensionEvent) => {
    this.menus.delete(extension.id)
  }

  /**
   * Resolves the chrome frameId of the frame the context menu was invoked in.
   *
   * Chrome reports the real frameId here (0 for the top frame). Extensions like
   * Bitwarden key their collected page details by frameId and fill using
   * `info.frameId`, so returning -1 made context-menu autofill target a
   * non-existent frame and silently do nothing. The scheme mirrors
   * web-navigation's getFrameId (and Electron's native MessageSender.frameId)
   * so the id matches what content scripts report.
   */
  private getClickedFrameId(
    webContents: Electron.WebContents,
    params?: Electron.ContextMenuParams,
  ): number {
    // No frame info, or the click was in the top document.
    if (!params?.frameURL || params.frameURL === params.pageURL) return 0
    try {
      const frame = webContents.mainFrame.framesInSubtree.find(
        (f) => !f.isDestroyed() && f.url === params.frameURL,
      )
      if (frame) return frame === frame.top ? 0 : frame.frameTreeNodeId
    } catch {
      // Frame tree may be unavailable (e.g. destroyed); fall back to top frame.
    }
    return 0
  }

  private onClicked(
    extensionId: string,
    menuItemId: string,
    webContents: Electron.WebContents,
    params?: Electron.ContextMenuParams,
  ) {
    if (webContents.isDestroyed()) return

    const tab = this.ctx.store.tabDetailsCache.get(webContents.id)
    if (!tab) {
      console.error(`[Extensions] Unable to find tab for id=${webContents.id}`)
      return
    }

    // Report the real parent menu id so extensions can distinguish which
    // submenu an item was clicked in (Bitwarden uses this to pick the Identity
    // vs. Card autofill flow). Chrome omits it for top-level items.
    const parentMenuItemId = this.menus.get(extensionId)?.get(menuItemId)?.parentId

    const data: chrome.contextMenus.OnClickData = {
      selectionText: params?.selectionText,
      checked: false, // TODO
      menuItemId,
      frameId: this.getClickedFrameId(webContents, params),
      frameUrl: params?.frameURL,
      editable: params?.isEditable || false,
      // TODO(mv3): limit possible string enums
      mediaType: params?.mediaType as any,
      wasChecked: false, // TODO
      pageUrl: params?.pageURL as any, // types are inaccurate
      linkUrl: params?.linkURL,
      parentMenuItemId: parentMenuItemId as any,
      srcUrl: params?.srcURL,
    }

    this.ctx.router.sendEvent(extensionId, 'contextMenus.onClicked', data, tab)
  }
}
