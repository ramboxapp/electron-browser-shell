import { expect } from 'chai'

import { ElectronChromeExtensions } from '../'
import { useExtensionBrowser, useServer } from './hooks'

/**
 * `chrome.commands`: what an extension is told about its own shortcuts, and whether the event ever
 * fires.
 *
 * Both halves were broken, and for a password manager this is the feature that matters — Ctrl+Shift+L
 * is how people autofill, not the toolbar button. Measured in Rambox before the fix: Bitwarden declares
 * 6 commands (`autofill_login` among them), 1Password 2, Dashlane 1, and `getAll()` reported every
 * shortcut as an empty string while nothing ever dispatched `onCommand`.
 *
 * Binding the actual keys stays with the embedder — accelerators compete with the host app's own, and
 * only the host knows which it can give up — so the library's half is: report the manifest's shortcut
 * honestly, and expose a way to fire the event.
 */
describe('chrome.commands', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  const getAll = () => browser.crx.exec('commands.getAll') as Promise<chrome.commands.Command[]>

  describe('getAll()', () => {
    it('reports every declared command', async () => {
      const commands = await getAll()
      const names = commands.map((command) => command.name).sort()
      expect(names).to.deep.equal([
        '_execute_action',
        'autofill_login',
        'lock_vault',
        'no_shortcut',
      ])
    })

    it('reports the shortcut the manifest asks for', async () => {
      const commands = await getAll()
      const autofill = commands.find((command) => command.name === 'autofill_login')!
      // On macOS Chrome reports the symbols; everywhere else the words, as written in the manifest.
      const expected = process.platform === 'darwin' ? '⌘⇧L' : 'Ctrl+Shift+L'
      expect(autofill.shortcut, 'an empty shortcut is what an extension shows the user').to.equal(
        expected,
      )
      expect(autofill.description).to.equal('Autofill the login')
    })

    it('leaves the shortcut empty only when the manifest asks for none', async () => {
      const commands = await getAll()
      expect(commands.find((command) => command.name === 'no_shortcut')!.shortcut).to.equal('')
    })
  })

  describe('dispatchCommand()', () => {
    it('fires onCommand in the extension', async function () {
      // Under load the worker needs a moment to register its listener, and a fixed sleep before
      // dispatching made this flaky in a full run. Dispatch until the event comes back instead: the
      // fixture's listener removes itself on the first one, so repeats cost nothing.
      this.timeout(30000)
      const extensions = ElectronChromeExtensions.fromSession(browser.session)!
      const received = browser.crx.raw({ type: 'await-command' }) as Promise<{
        command: string
        tabId?: number
      }>
      let arrived = false
      void received.then(() => {
        arrived = true
      })

      let dispatched = false
      for (let i = 0; i < 60 && !arrived; i++) {
        dispatched = extensions.dispatchCommand(browser.extension.id, 'autofill_login')
        expect(dispatched, 'dispatchCommand refused a declared command').to.be.true
        await new Promise((resolve) => setTimeout(resolve, 250))
      }

      const result = await received
      expect(result.command).to.equal('autofill_login')
    })

    it('refuses a command the extension never declared', async () => {
      const extensions = ElectronChromeExtensions.fromSession(browser.session)!
      expect(extensions.dispatchCommand(browser.extension.id, 'not_a_command')).to.be.false
    })

    it('refuses _execute_action, which opens the popup rather than firing the event', async () => {
      const extensions = ElectronChromeExtensions.fromSession(browser.session)!
      expect(extensions.dispatchCommand(browser.extension.id, '_execute_action')).to.be.false
    })
  })

  describe('getCommands()', () => {
    it('gives the embedder the same list, for deciding what to bind', async () => {
      const extensions = ElectronChromeExtensions.fromSession(browser.session)!
      const commands = extensions.getCommands(browser.extension.id)
      expect(commands.map((command) => command.name)).to.include('autofill_login')
      expect(commands.find((command) => command.name === 'lock_vault')!.shortcut).to.equal(
        process.platform === 'darwin' ? '⌘⇧K' : 'Ctrl+Shift+K',
      )
    })
  })
})
