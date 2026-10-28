import * as path from 'node:path'
import { expect } from 'chai'
import { BrowserView, Extension, ipcMain, session, WebContents, WebContentsView } from 'electron'

import { emittedOnce } from './events-helpers'
import { uuid } from './spec-helpers'
import { useExtensionBrowser, useServer } from './hooks'
import { createCrxRemoteWindow } from './crx-helpers'
import { ElectronChromeExtensions } from '../'

describe('chrome.browserAction', () => {
  const server = useServer()

  const defaultAnchorRect = {
    x: 0,
    y: 0,
    width: 16,
    height: 16,
  }

  const activateExtension = async (
    partition: string,
    webContents: WebContents,
    extension: Extension,
    tabId: number = -1,
  ) => {
    const details = {
      eventType: 'click',
      extensionId: extension.id,
      tabId,
      anchorRect: defaultAnchorRect,
    }

    const js = `browserAction.activate('${partition}', ${JSON.stringify(details)})`
    await webContents.executeJavaScript(js)
  }

  describe('messaging', () => {
    const browser = useExtensionBrowser({
      url: server.getUrl,
      extensionName: 'chrome-browserAction-click',
    })

    it('supports cross-session communication', async () => {
      const otherSession = session.fromPartition(`persist:crx-${uuid()}`)

      if ('registerPreloadScript' in otherSession) {
        browser.session.getPreloadScripts().forEach((script: any) => {
          otherSession.registerPreloadScript(script)
        })
      } else {
        // @ts-expect-error Deprecated electron@<35
        otherSession.setPreloads(browser.session.getPreloads())
      }

      const view = new BrowserView({
        webPreferences: { session: otherSession, nodeIntegration: false, contextIsolation: true },
      })
      await view.webContents.loadURL(server.getUrl())
      browser.window.addBrowserView(view)
      await activateExtension(browser.partition, view.webContents, browser.extension)
    })

    it('can request action for specific tab', async () => {
      const tab = browser.window.webContents
      await activateExtension(browser.partition, tab, browser.extension, tab.id)
    })

    it('throws for unknown tab', async () => {
      const tab = browser.window.webContents
      const unknownTabId = 99999
      let caught = false
      try {
        await activateExtension(browser.partition, tab, browser.extension, unknownTabId)
      } catch {
        caught = true
      }
      expect(caught).to.be.true
    })
  })

  describe('onClicked', () => {
    const browser = useExtensionBrowser({
      url: server.getUrl,
      extensionName: 'chrome-browserAction-click',
    })

    it('fires listeners when activated', async () => {
      const tabPromise = emittedOnce(ipcMain, 'success')
      await activateExtension(browser.partition, browser.window.webContents, browser.extension)
      const [_, tabDetails] = await tabPromise
      expect(tabDetails).to.be.an('object')
      expect(tabDetails.id).to.equal(browser.window.webContents.id)
    })
  })

  describe('popup', () => {
    const browser = useExtensionBrowser({
      url: server.getUrl,
      extensionName: 'chrome-browserAction-popup',
    })

    it('opens when the browser action is clicked', async () => {
      const popupPromise = emittedOnce(browser.extensions, 'browser-action-popup-created')
      await activateExtension(browser.partition, browser.window.webContents, browser.extension)
      const [popup] = await popupPromise
      expect(popup.extensionId).to.equal(browser.extension.id)
    })

    it('opens when BrowserView is the active tab', async () => {
      const view = new BrowserView({
        webPreferences: {
          session: browser.session,
          nodeIntegration: false,
          contextIsolation: true,
        },
      })
      await view.webContents.loadURL(server.getUrl())
      browser.window.addBrowserView(view)
      browser.extensions.addTab(view.webContents, browser.window)
      browser.extensions.selectTab(view.webContents)

      const popupPromise = emittedOnce(browser.extensions, 'browser-action-popup-created')
      await activateExtension(browser.partition, browser.window.webContents, browser.extension)
      const [popup] = await popupPromise
      expect(popup.extensionId).to.equal(browser.extension.id)
    })
  })

  describe('details', () => {
    const browser = useExtensionBrowser({
      url: server.getUrl,
      extensionName: 'rpc',
    })

    const props = [
      { method: 'BadgeBackgroundColor', detail: 'color', value: '#cacaca' },
      { method: 'BadgeText', detail: 'text' },
      { method: 'Popup', detail: 'popup' },
      { method: 'Title', detail: 'title' },
    ]

    for (const { method, detail, value } of props) {
      it(`sets and gets '${detail}'`, async () => {
        const newValue = value || uuid()
        await browser.crx.exec(`browserAction.set${method}`, { [detail]: newValue })
        const result = await browser.crx.exec(`browserAction.get${method}`)
        expect(result).to.equal(newValue)
      })

      it(`restores initial values for '${detail}'`, async () => {
        const newValue = value || uuid()
        const initial = await browser.crx.exec(`browserAction.get${method}`)
        await browser.crx.exec(`browserAction.set${method}`, { [detail]: newValue })
        await browser.crx.exec(`browserAction.set${method}`, { [detail]: null })
        const result = await browser.crx.exec(`browserAction.get${method}`)
        expect(result).to.equal(initial)
      })
    }

    /*
      Chrome answers these with an empty string when nothing is set, never with undefined. An
      extension that renders its own badge or title puts the answer straight into the DOM, where
      undefined shows up as the literal text "undefined". Measured on uBlock in Rambox, whose badge
      count came back undefined.
    */
    it("answers '' rather than undefined when nothing is set", async () => {
      for (const [method, detail] of [
        ['BadgeText', 'text'],
        ['Popup', 'popup'],
      ]) {
        await browser.crx.exec(`browserAction.set${method}`, { [detail]: null })
        const result = await browser.crx.exec(`browserAction.get${method}`)
        expect(result, `get${method} with nothing set`).to.equal('')
      }
      // Title is different on purpose: the manifest declares default_title, and Chrome answers with
      // it rather than with an empty string.
      await browser.crx.exec('browserAction.setTitle', { title: null })
      expect(await browser.crx.exec('browserAction.getTitle')).to.equal('RPC')
    })

    it('uses custom popup when opening browser action', async () => {
      const popupUuid = uuid()
      const popupPath = `popup.html?${popupUuid}`
      await browser.crx.exec('browserAction.setPopup', { popup: popupPath })
      const popupPromise = emittedOnce(browser.extensions, 'browser-action-popup-created')
      await activateExtension(browser.partition, browser.window.webContents, browser.extension)
      const [popup] = await popupPromise
      await popup.whenReady()
      expect(popup.browserWindow.webContents.getURL()).to.equal(
        `chrome-extension://${browser.extension.id}/${popupPath}`,
      )
    })
  })

  describe('<browser-action-list> element', () => {
    const basePath = path.join(__dirname, 'fixtures/browser-action-list')

    const browser = useExtensionBrowser({
      extensionName: 'chrome-browserAction-popup',
    })

    const getExtensionActionIds = async (
      webContents: Electron.WebContents = browser.webContents,
    ) => {
      // Await update propagation to avoid flaky tests
      await new Promise((resolve) => setTimeout(resolve, 10))

      return await webContents.executeJavaScript(
        `(${() => {
          const list = document.querySelector('browser-action-list')!
          const actions = list.shadowRoot!.querySelectorAll('.action')
          const ids = Array.from(actions).map((elem) => elem.id)
          return ids
        }})();`,
      )
    }

    it('lists actions', async () => {
      await browser.webContents.loadFile(path.join(basePath, 'default.html'))
      const extensionIds = await getExtensionActionIds()
      expect(extensionIds).to.deep.equal([browser.extension.id])
    })

    it('lists actions in remote partition', async () => {
      const remoteWindow = createCrxRemoteWindow()
      const remoteTab = remoteWindow.webContents

      await remoteTab.loadURL(server.getUrl())

      // Add <browser-action-list> for remote partition.
      await remoteTab.executeJavaScript(
        `(${(partition: string) => {
          const list = document.createElement('browser-action-list')
          list.setAttribute('partition', partition)
          document.body.appendChild(list)
        }})('${browser.partition}');`,
      )

      const extensionIds = await getExtensionActionIds(remoteTab)
      expect(extensionIds).to.deep.equal([browser.extension.id])
    })

    /*
      The buttons have to be allowed to wrap, because an embedder shows this list inside a panel of
      its own width. Rambox's panel is 320px and anchored to its toolbar button; with the 20
      extensions of its catalog enabled the list was 665px in one row, so the last five buttons sat
      past the right edge of the window — unreachable with a mouse at any window width. The width cap
      is the host's to set; what the element owes it is the ability to use a second row.
    */
    it('lets its buttons wrap when the host constrains the width', async () => {
      await browser.webContents.loadFile(path.join(basePath, 'default.html'))
      // The list renders its buttons asynchronously, same reason getExtensionActionIds waits.
      await new Promise((resolve) => setTimeout(resolve, 50))
      const wraps = await browser.webContents.executeJavaScript(
        `(${() => {
          const list = document.querySelector('browser-action-list')!
          list.setAttribute('style', 'max-width: 60px')
          const style = getComputedStyle(list)
          // Not the row count: the harness loads one extension, so it would read 1 either way. The
          // real count (3 with the catalog's 20) only exists in an app, and lives in its doc.
          return {
            flexWrap: style.flexWrap,
            overflows: list.scrollWidth > list.clientWidth,
          }
        }})();`,
      )
      expect(wraps.flexWrap, 'the list must be allowed to use a second row').to.equal('wrap')
      expect(wraps.overflows, 'the list overflowed its own width instead of wrapping').to.be.false
    })

    it('removes action for unloaded extension', async () => {
      await browser.webContents.loadFile(path.join(basePath, 'default.html'))
      expect(browser.session.getExtension(browser.extension.id)).to.be.an('object')
      browser.session.removeExtension(browser.extension.id)
      expect(browser.session.getExtension(browser.extension.id)).to.be.an('null')

      const extensionIds = await getExtensionActionIds()
      expect(extensionIds).to.have.lengthOf(0)
    })
  })

  /*
    What <browser-action> draws for a badge. Proton Pass sets a white background for every tab
    (setBadgeBackgroundColor({ color: '#FFFFFF' })) and the site's login count per tab
    (setBadgeText({ tabId, text: '1' })). Measured in Rambox on 28/10/2026: the badge held "1", drawn
    in a fixed white on that white — an empty white box on the icon. Chrome picks the text color for
    contrast when the extension sets none (IconWithBadgeImageSource, GetColorWithMaxContrast).
  */
  describe('<browser-action> badge', () => {
    const browser = useExtensionBrowser({
      url: server.getUrl,
      extensionName: 'rpc',
    })

    const readBadge = async () => {
      await browser.webContents.executeJavaScript(
        `(${() => {
          if (!document.querySelector('browser-action-list')) {
            document.body.appendChild(document.createElement('browser-action-list'))
          }
        }})();`,
      )
      // The list fetches its state and draws on an animation frame.
      await new Promise((resolve) => setTimeout(resolve, 200))
      return browser.webContents.executeJavaScript(
        `(${(id: string) => {
          const list = document.querySelector('browser-action-list')!
          const badge = list.shadowRoot!.querySelector(`[id="${id}"] .badge`) as HTMLElement | null
          if (!badge) return null
          const style = getComputedStyle(badge)
          return { text: badge.textContent, color: style.color, background: style.backgroundColor }
        }})('${browser.extension.id}');`,
      )
    }

    it('draws the text dark on a light background nobody set a text color for', async () => {
      const tabId = browser.webContents.id
      await browser.crx.exec('browserAction.setBadgeBackgroundColor', { color: '#FFFFFF' })
      await browser.crx.exec('browserAction.setBadgeText', { tabId, text: '1' })
      const badge = await readBadge()
      expect(badge, 'the badge must be drawn').to.not.be.null
      expect(badge.text).to.equal('1')
      expect(badge.background).to.equal('rgb(255, 255, 255)')
      // Google Grey 900, what Chrome uses for "dark" (color_utils g_darkest_color).
      expect(badge.color, 'white text on a white badge is invisible').to.equal('rgb(32, 33, 36)')
    })

    it('draws the text white on a dark background', async () => {
      await browser.crx.exec('browserAction.setBadgeBackgroundColor', { color: [0, 0, 128, 255] })
      await browser.crx.exec('browserAction.setBadgeText', { text: '7' })
      const badge = await readBadge()
      expect(badge.background).to.equal('rgb(0, 0, 128)')
      expect(badge.color).to.equal('rgb(255, 255, 255)')
    })

    it('uses the text color the extension set', async () => {
      await browser.crx.exec('browserAction.setBadgeBackgroundColor', { color: '#FFFFFF' })
      await browser.crx.exec('browserAction.setBadgeTextColor', { color: '#FF0000' })
      await browser.crx.exec('browserAction.setBadgeText', { text: '3' })
      expect(await browser.crx.exec('browserAction.getBadgeTextColor')).to.equal('#FF0000')
      const badge = await readBadge()
      expect(badge.color).to.equal('rgb(255, 0, 0)')
    })

    it("prefers the active tab's text over the one set for every tab", async () => {
      const tabId = browser.webContents.id
      await browser.crx.exec('browserAction.setBadgeText', { text: 'all' })
      await browser.crx.exec('browserAction.setBadgeText', { tabId, text: 'tab' })
      expect((await readBadge()).text).to.equal('tab')
    })

    it("hides the badge when the active tab's text is empty", async () => {
      const tabId = browser.webContents.id
      await browser.crx.exec('browserAction.setBadgeText', { text: 'all' })
      await browser.crx.exec('browserAction.setBadgeText', { tabId, text: '' })
      expect(await readBadge()).to.be.null
    })
  })

  describe('crx:// protocol', () => {
    const browser = useExtensionBrowser({
      url: server.getUrl,
      extensionName: 'chrome-browserAction-popup',
    })

    it('supports same-session requests', async () => {
      ElectronChromeExtensions.handleCRXProtocol(browser.session)

      // Load again now that crx protocol is handled
      await browser.webContents.loadURL(server.getUrl())

      const result = await browser.webContents.executeJavaScript(
        `(${function (extensionId: any, tabId: any) {
          const img = document.createElement('img')
          const params = new URLSearchParams({
            tabId: `${tabId}`,
            t: `${Date.now()}`,
          })
          const src = `crx://extension-icon/${extensionId}/32/2?${params.toString()}`
          return new Promise((resolve, reject) => {
            img.onload = () => resolve('success')
            img.onerror = () => {
              reject(new Error('error loading img, check devtools console' + src))
            }
            img.src = src
          })
        }})(${[browser.extension.id, browser.webContents.id]
          .map((v) => JSON.stringify(v))
          .join(', ')});`,
      )

      expect(result).to.equal('success')
    })

    it('supports cross-session requests', async () => {
      const extensionsPartition = browser.partition
      const otherSession = session.fromPartition(`persist:crx-${uuid()}`)
      ElectronChromeExtensions.handleCRXProtocol(otherSession)

      browser.session.getPreloadScripts().forEach((script) => {
        otherSession.registerPreloadScript(script)
      })

      const view = new WebContentsView({
        webPreferences: { session: otherSession, nodeIntegration: false, contextIsolation: true },
      })
      browser.window.contentView.addChildView(view)
      await view.webContents.loadURL(server.getUrl())

      const result = await view.webContents.executeJavaScript(
        `(${function (extensionId: any, tabId: any, partition: any) {
          const img = document.createElement('img')
          const params = new URLSearchParams({
            tabId: `${tabId}`,
            partition,
            t: `${Date.now()}`,
          })
          const src = `crx://extension-icon/${extensionId}/32/2?${params.toString()}`
          return new Promise((resolve, reject) => {
            img.onload = () => resolve('success')
            img.onerror = () => {
              reject(new Error('error loading img, check devtools console'))
            }
            img.src = src
          })
        }})(${[browser.extension.id, browser.webContents.id, extensionsPartition]
          .map((v) => JSON.stringify(v))
          .join(', ')});`,
      )

      expect(result).to.equal('success')
    })
  })
})
