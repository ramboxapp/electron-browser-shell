/** App-specific implementation details for extensions. */
export interface ChromeExtensionImpl {
  createTab?(
    details: chrome.tabs.CreateProperties,
  ): Promise<[Electron.WebContents, Electron.BaseWindow]>
  selectTab?(tab: Electron.WebContents, window: Electron.BaseWindow): void
  removeTab?(tab: Electron.WebContents, window: Electron.BaseWindow): void

  /**
   * Populate additional details to a tab descriptor which gets passed back to
   * background pages and content scripts.
   */
  assignTabDetails?(details: chrome.tabs.Tab, tab: Electron.WebContents): void

  /**
   * Unloads a tab to free its memory, for `chrome.tabs.discard` — an app that hibernates its pages
   * is the one that can say what discarding means. Resolve `false` to refuse; resolve the tab, or
   * nothing, once it is unloaded; resolve another WebContents when the tab was replaced by one (the
   * embedder registers it with `addTab`), which extensions then see as `tabs.onReplaced`. The tab
   * counts as discarded until its main frame navigates again. Without this hook `tabs.discard`
   * fails the way Chrome does for a tab it cannot discard.
   */
  discardTab?(
    tab: Electron.WebContents,
  ): Promise<Electron.WebContents | boolean | void> | Electron.WebContents | boolean | void

  createWindow?(details: chrome.windows.CreateData): Promise<Electron.BaseWindow>
  removeWindow?(window: Electron.BaseWindow): void

  requestPermissions?(
    extension: Electron.Extension,
    permissions: chrome.permissions.Permissions,
  ): Promise<boolean>
}
