import { expect } from 'chai'
import * as path from 'node:path'

import { useExtensionBrowser, useServer } from './hooks'

// chrome.management is implemented natively by Electron. These specs guard
// against the preload accidentally clobbering it.
describe('chrome.management', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })

  describe('getSelf()', () => {
    it('returns info about the calling extension', async () => {
      const info = await browser.crx.exec('management.getSelf')
      expect(info).to.be.an('object')
      expect(info.id).to.equal(browser.extension.id)
    })
  })

  describe('getAll()', () => {
    it('includes the loaded extension', async () => {
      const extensions = await browser.crx.exec('management.getAll')
      expect(extensions).to.be.an('array')
      expect(extensions.map((info: any) => info.id)).to.include(browser.extension.id)
    })
  })

  describe('ExtensionInfo', () => {
    /*
      'normal' is what Chrome reports for a store install, and the packages loaded here are the
      store's; 'development' is a developer's own checkout, and extensions switch debug behaviour
      on for it that a user never sees in Chrome.
    */
    it('reports a store install, with its urls', async () => {
      const info = await browser.crx.exec('management.getSelf')
      expect(info.installType).to.equal('normal')
      expect(info.enabled).to.equal(true)
      expect(info.optionsUrl).to.equal('')
    })
  })
})

describe('chrome.management events', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  it('are all present in the worker', async () => {
    const shapes = await browser.crx.raw({ type: 'event-shapes' })
    for (const [name, shape] of Object.entries<any>(shapes.management)) {
      expect(shape.addListener, `management.${name}.addListener`).to.equal('function')
    }
  })

  it('fires onInstalled when another extension loads, and onUninstalled when it unloads', async () => {
    // The worker boots lazily: make sure it is up and listening before the other extension loads.
    await browser.crx.raw({ type: 'content-script-ping' })
    const installed = browser.crx.eventOnce('management.onInstalled')
    await new Promise((resolve) => setTimeout(resolve, 500))
    const other = await browser.session.extensions.loadExtension(
      path.join(__dirname, 'fixtures', 'chrome-browserAction-popup'),
    )
    const [info] = await installed
    expect(info.id).to.equal(other.id)
    expect(info.name).to.equal('chrome-browserAction-popup')

    const uninstalled = browser.crx.eventOnce('management.onUninstalled')
    await new Promise((resolve) => setTimeout(resolve, 500))
    browser.session.extensions.removeExtension(other.id)
    const [removedId] = await uninstalled
    expect(removedId).to.equal(other.id)
  })
})

/*
  ExtensionInfo as Edge 156 sends it — sixteen fields for an extension with no icons and no update
  URL, the optional ones left out rather than sent as undefined — and the app methods Chrome has,
  failing as Chrome fails them for an extension.
*/
describe('chrome.management, as Chrome answers', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })
  const outcome = (method: string, ...args: any[]): Promise<any> =>
    browser.crx.raw({ type: 'outcome', method, args })

  it('sends only the fields Chrome sends', async () => {
    const { value } = await outcome('management.getSelf')
    expect(Object.keys(value).sort()).to.deep.equal([
      'description',
      'enabled',
      'homepageUrl',
      'hostPermissions',
      'id',
      'installType',
      'isApp',
      'mayDisable',
      'name',
      'offlineEnabled',
      'optionsUrl',
      'permissions',
      'shortName',
      'type',
      'version',
      'versionName',
    ])
    expect(value.homepageUrl).to.equal('')
    expect(value.versionName).to.equal('')
  })

  it("fails for an unknown id with Chrome's message", async () => {
    const missing = 'abcdefghijklmnopabcdefghijklmnop'
    const expected = { error: `Failed to find extension with id ${missing}.` }
    expect(await outcome('management.get', missing)).to.deep.equal(expected)
    expect(await outcome('management.uninstall', missing)).to.deep.equal(expected)
    expect(await outcome('management.launchApp', missing)).to.deep.equal(expected)
  })

  it('refuses the app methods for an extension', async () => {
    const id = browser.extension.id
    const notAnApp = { error: `Extension ${id} is not an App.` }
    expect(await outcome('management.launchApp', id)).to.deep.equal(notAnApp)
    expect(await outcome('management.setLaunchType', id, 'OPEN_AS_WINDOW')).to.deep.equal(notAnApp)
    expect(await outcome('management.createAppShortcut', id)).to.deep.equal(notAnApp)
    expect(
      (await outcome('management.generateAppForLink', 'https://example.com/', 'x')).error,
    ).to.be.a('string')
  })
})
