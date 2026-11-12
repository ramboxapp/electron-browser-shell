import { expect } from 'chai'
import { WebContentsView } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.tabs.captureVisibleTab', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })

  it('captures the active tab as a jpeg data URL by default', async () => {
    const result = await browser.crx.exec('tabs.captureVisibleTab')
    expect(result).to.be.a('string')
    expect(result).to.match(/^data:image\/jpeg;base64,/)
  })

  it('supports the png format', async () => {
    const result = await browser.crx.exec('tabs.captureVisibleTab', browser.window.id, {
      format: 'png',
    })
    expect(result).to.be.a('string')
    expect(result).to.match(/^data:image\/png;base64,/)
  })
})

/*
  captureVisibleTab answered for any extension, so one with no access to a site could screenshot
  it. It now asks for what Chrome asks: access to the page (a host permission over it here), or
  activeTab granted on the tab by a user action. Measured from an extension page of a copy of the
  rpc fixture without `<all_urls>`.
*/
describe('chrome.tabs.captureVisibleTab without host access', () => {
  const server = useServer()
  let extensionDir: string

  before(() => {
    extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-capture-'))
    fs.cpSync(path.join(__dirname, 'fixtures', 'rpc'), extensionDir, { recursive: true })
    const manifestPath = path.join(extensionDir, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    manifest.permissions = [
      ...manifest.permissions.filter((permission: string) => permission !== '<all_urls>'),
      'activeTab',
    ]
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  })

  after(() => {
    fs.rmSync(extensionDir, { recursive: true, force: true })
  })

  const browser = useExtensionBrowser({ url: server.getUrl, extensionPath: () => extensionDir })

  const captureFromExtensionPage = async () => {
    const view = new WebContentsView({ webPreferences: { session: browser.session } })
    try {
      await view.webContents.loadURL(`chrome-extension://${browser.extension.id}/popup.html`)
      return await view.webContents.executeJavaScript(
        `chrome.tabs.captureVisibleTab().then((url) => 'ok:' + url.slice(0, 22), (e) => 'error:' + e.message)`,
      )
    } finally {
      view.webContents.close()
    }
  }

  it("is refused with Chrome's message", async () => {
    expect(await captureFromExtensionPage()).to.equal(
      "error:Either the '<all_urls>' or 'activeTab' permission is required.",
    )
  })

  it('is allowed once a user action granted activeTab on the tab', async () => {
    ;(browser.extensions as any).ctx.store.noteInvocation(browser.extension.id, browser.webContents)
    expect(await captureFromExtensionPage()).to.equal('ok:data:image/jpeg;base64')
  })
})
