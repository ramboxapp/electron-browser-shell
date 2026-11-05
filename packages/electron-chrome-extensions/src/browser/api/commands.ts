import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

/**
 * Commands declared in a manifest, and the shortcut each one asks for.
 *
 * Two things used to be missing here, both of which matter to a password manager — Ctrl+Shift+L is how
 * people autofill, not the toolbar button:
 *
 *  - `getAll()` returned every command with `shortcut: ''`, so an extension that shows the user their
 *    own shortcut showed a blank. Measured in Rambox: Bitwarden declares 6 commands (`autofill_login`
 *    among them), 1Password 2, Dashlane 1, and all of them came back empty.
 *  - nothing ever fired `commands.onCommand`, so no shortcut did anything at all.
 *
 * The parsing below fixes the first. The second needs the embedder, because only it owns the keyboard:
 * `ElectronChromeExtensions.dispatchCommand()` fires the event, and the host decides which accelerators
 * it is willing to hand to extensions (they compete with the app's own). This file deliberately does
 * NOT register global shortcuts on its own.
 */
export class CommandsAPI {
  private commandMap = new Map</* extensionId */ string, chrome.commands.Command[]>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('commands.getAll', this.getAll)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.getAllExtensions().forEach((ext) => this.processExtension(ext))

    sessionExtensions.on('extension-loaded', (_event, extension) => {
      this.processExtension(extension)
    })

    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.removeCommands(extension)
    })
  }

  /**
   * The shortcut for this platform, in the shape Chrome reports from `getAll()`.
   *
   * A manifest command carries `suggested_key` with an optional `default` plus per-platform overrides;
   * Chrome answers with the platform's own, and on macOS with the symbols rather than the words.
   */
  private shortcutFor(details: {
    suggested_key?: string | Record<string, string | undefined>
  }): string {
    const suggested =
      typeof details.suggested_key === 'string'
        ? { default: details.suggested_key }
        : details.suggested_key
    if (!suggested) return ''
    const platformKey =
      process.platform === 'darwin'
        ? 'mac'
        : process.platform === 'win32'
          ? 'windows'
          : process.platform === 'linux'
            ? 'linux'
            : 'chromeos'
    const raw =
      (suggested as Record<string, string | undefined>)[platformKey] ?? suggested.default ?? ''
    if (!raw) return ''
    if (process.platform !== 'darwin') return raw
    // Chrome shows macOS shortcuts as symbols: Command+Shift+L reads ⌘⇧L.
    return raw
      .split('+')
      .map((part: string) => {
        switch (part) {
          case 'Command':
            return '⌘'
          case 'Shift':
            return '⇧'
          case 'Alt':
            return '⌥'
          case 'MacCtrl':
          case 'Ctrl':
            return '⌃'
          default:
            return part
        }
      })
      .join('')
  }

  private processExtension(extension: Electron.Extension) {
    const manifest: chrome.runtime.Manifest = extension.manifest
    if (!manifest.commands) return

    const commands: chrome.commands.Command[] = []
    for (const [name, details] of Object.entries(manifest.commands!)) {
      commands.push({
        name,
        description: details.description,
        shortcut: this.shortcutFor(details),
      })
    }
    this.commandMap.set(extension.id, commands)
  }

  private removeCommands(extension: Electron.Extension) {
    this.commandMap.delete(extension.id)
  }

  private getAll = ({ extension }: ExtensionEvent): chrome.commands.Command[] => {
    return this.commandMap.get(extension.id) || []
  }

  /** The commands an extension declared, for an embedder deciding what to bind. */
  getCommands(extensionId: string): chrome.commands.Command[] {
    return this.commandMap.get(extensionId) || []
  }

  /**
   * Fires `commands.onCommand` for one extension, as a keypress would.
   *
   * Returns false when the extension never declared that command, so a host can tell a typo from a
   * delivered event. `_execute_action` and its MV2 spelling are not dispatched here: those open the
   * popup in Chrome, which is the toolbar-click path the host already drives.
   */
  dispatch(extensionId: string, command: string, tab?: chrome.tabs.Tab): boolean {
    const declared = this.commandMap.get(extensionId)
    if (!declared?.some((entry) => entry.name === command)) return false
    if (command === '_execute_action' || command === '_execute_browser_action') return false
    this.ctx.store.noteUserGesture(extensionId)
    const invokedTab = tab ? this.ctx.store.getTabById(tab.id!) : undefined
    if (invokedTab) this.ctx.store.noteInvocation(extensionId, invokedTab)
    /*
      A plain copy of the tab, and no argument at all without one: `ServiceWorkerMain.send` refuses
      what it cannot serialize ("Failed to serialize arguments", seen in Rambox with the cached tab
      details), and the event then never reaches the worker while the dispatch reports success.
    */
    const args: unknown[] = [command]
    if (tab) args.push(JSON.parse(JSON.stringify(tab)))
    this.ctx.router.sendEvent(extensionId, 'commands.onCommand', ...args)
    return true
  }
}
