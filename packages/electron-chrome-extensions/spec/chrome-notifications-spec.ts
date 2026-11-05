import { Notification } from 'electron'
import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'
import { uuid } from './spec-helpers'

const basicOpts: chrome.notifications.NotificationOptions = {
  type: 'basic',
  title: 'title',
  message: 'message',
  iconUrl: 'icon_16.png',
  silent: true,
}

describe('chrome.notifications', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })

  describe('create()', () => {
    it('creates and shows a basic notification', async () => {
      const notificationId = uuid()
      const result = await browser.crx.exec('notifications.create', notificationId, basicOpts)
      expect(result).to.equal(notificationId)
      await browser.crx.exec('notifications.clear', notificationId)
    })

    it('ignores invalid options', async () => {
      const notificationId = uuid()
      const result = await browser.crx.exec('notifications.create', notificationId, {})
      expect(result).is.null
    })

    it('ignores icons outside of extensions directory', async () => {
      const notificationId = uuid()
      const result = await browser.crx.exec('notifications.create', notificationId, {
        ...basicOpts,
        iconUrl: '../chrome-browserAction/icon_16.png',
      })
      expect(result).is.null
    })

    it('creates a notification with no ID given', async () => {
      const notificationId = await browser.crx.exec('notifications.create', basicOpts)
      expect(notificationId).to.be.string
      await browser.crx.exec('notifications.clear', notificationId)
    })
  })

  describe('getAll()', () => {
    it('lists created notifications as an object keyed by id, as in Chrome', async () => {
      const notificationId = uuid()
      await browser.crx.exec('notifications.create', notificationId, basicOpts)
      const all = await browser.crx.exec('notifications.getAll')
      // An array here is the bug: `Object.keys(await getAll())` — what an extension actually writes —
      // comes back empty from one, so every notification is invisible to its own owner.
      expect(all).to.deep.equal({ [notificationId]: true })
      expect(Object.keys(all)).to.deep.equal([notificationId])
      await browser.crx.exec('notifications.clear', notificationId)
    })
  })
})

// The enums and events Chrome has on the namespace (Chromium 147), read where a worker starts.
describe('chrome.notifications surface', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  it("has Chrome's enums and events, and answers the permission level", async () => {
    const result = await browser.crx.raw({ type: 'notifications-surface' })
    expect(result.PermissionLevel).to.deep.equal({ DENIED: 'denied', GRANTED: 'granted' })
    expect(result.TemplateType).to.deep.equal({
      BASIC: 'basic',
      IMAGE: 'image',
      LIST: 'list',
      PROGRESS: 'progress',
    })
    expect(result.events).to.deep.equal({
      onButtonClicked: 'function',
      onClicked: 'function',
      onClosed: 'function',
      onPermissionLevelChanged: 'function',
      onShowSettings: 'function',
    })
    // A Linux runner has no D-Bus, so there Electron reports no notification support: the answer is 'denied'.
    expect(result.permissionLevel).to.equal(Notification.isSupported() ? 'granted' : 'denied')
  })
})

/*
  Buttons, ids and the booleans of clear/update, as Chromium 147 answers them (measured 30/10/2026):
  `buttons` become the native notification's actions (two at most; three resolve with two shown), a
  click on one fires onButtonClicked(id, index), a button without a title fails with Chrome's schema
  error, an id-less create gets a fresh UUID each time, and clear/update resolve whether the
  notification existed. The buttons were dropped before, so onButtonClicked never fired.

  No toast is shown: Notification.prototype.show is replaced for the duration, and a click on a
  button is the 'action' event Electron emits for it.
*/
describe('chrome.notifications buttons', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })
  const icon =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
  const options = { type: 'basic', iconUrl: icon, title: 'title', message: 'message', silent: true }

  let shown: Notification[] = []
  let originalShow: () => void
  before(() => {
    originalShow = Notification.prototype.show
    Notification.prototype.show = function (this: Notification) {
      shown.push(this)
    }
  })
  after(() => {
    Notification.prototype.show = originalShow
  })
  beforeEach(() => {
    shown = []
  })

  const outcome = (method: string, ...args: any[]) =>
    browser.crx.raw({ type: 'outcome', method, args })

  it('shows two buttons at most, and fires onButtonClicked with the index clicked', async () => {
    await browser.crx.raw({ type: 'record-events', names: ['notifications.onButtonClicked'] })
    const { value: id } = await outcome('notifications.create', 'with-buttons', {
      ...options,
      buttons: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
    })
    expect(id).to.equal('with-buttons')
    expect(shown).to.have.lengthOf(1)
    expect(shown[0].actions).to.deep.equal([
      { type: 'button', text: 'One' },
      { type: 'button', text: 'Two' },
    ])

    shown[0].emit('action', { actionIndex: 1, selectionIndex: -1 }, 1)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const events = await browser.crx.raw({
      type: 'recorded',
      name: 'notifications.onButtonClicked',
    })
    expect(events).to.deep.equal([['with-buttons', 1]])
    await outcome('notifications.clear', 'with-buttons')
  })

  it('fires nothing for a notification without buttons', async () => {
    await browser.crx.raw({ type: 'record-events', names: ['notifications.onButtonClicked'] })
    await outcome('notifications.create', 'no-buttons', options)
    expect(shown[0].actions).to.deep.equal([])
    shown[0].emit('action', { actionIndex: 0, selectionIndex: -1 }, 0)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const events = await browser.crx.raw({
      type: 'recorded',
      name: 'notifications.onButtonClicked',
    })
    expect(events).to.deep.equal([])
    await outcome('notifications.clear', 'no-buttons')
  })

  it("rejects a button without a title with Chrome's schema error", async () => {
    const { error } = await outcome('notifications.create', 'bad-button', {
      ...options,
      buttons: [{}],
    })
    expect(error).to.equal(
      "Error in invocation of notifications.create(optional string notificationId, notifications.NotificationOptions options, optional function callback): Error at parameter 'options': Error at property 'buttons': Error at index 0: Missing required property 'title'.",
    )
    expect(shown).to.have.lengthOf(0)
  })

  it('gives each notification without an id a fresh UUID', async () => {
    const first = (await outcome('notifications.create', options)).value
    const second = (await outcome('notifications.create', options)).value
    expect(first).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(second).to.not.equal(first)
    const { value: all } = await outcome('notifications.getAll')
    expect(Object.keys(all).sort()).to.deep.equal([first, second].sort())
    await outcome('notifications.clear', first)
    await outcome('notifications.clear', second)
  })

  it('takes the icon as a path, the extension URL or a data: URL, and nothing else', async () => {
    const base = `chrome-extension://${browser.extension.id}`
    for (const iconUrl of ['icon16.png', '/icon16.png', `${base}/icon16.png`]) {
      const { value, error } = await outcome('notifications.create', 'icon', { ...options, iconUrl })
      expect(error, iconUrl).to.be.undefined
      expect(value).to.equal('icon')
    }
    const { error: foreign } = await outcome('notifications.create', 'icon', {
      ...options,
      iconUrl: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/icon16.png',
    })
    expect(foreign).to.equal('Invalid iconUrl')
    const { error: web } = await outcome('notifications.create', 'icon', {
      ...options,
      iconUrl: 'https://example.com/icon16.png',
    })
    expect(web).to.equal('Invalid iconUrl')
    const { error: brokenData } = await outcome('notifications.create', 'icon', {
      ...options,
      iconUrl: 'data:image/png;base64,AAAA',
    })
    expect(brokenData).to.equal('Invalid iconUrl')
    await outcome('notifications.clear', 'icon')
  })

  describe('onClosed', () => {
    const closed = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
      return browser.crx.raw({ type: 'recorded', name: 'notifications.onClosed' })
    }
    beforeEach(async () => {
      await browser.crx.raw({ type: 'record-events', names: ['notifications.onClosed'] })
    })

    it('reports a timed out toast as not closed by the user, and forgets it', async () => {
      await outcome('notifications.create', 'expired', options)
      shown[0].emit('close', { reason: 'timedOut' })
      expect(await closed()).to.deep.equal([['expired', false]])
      expect((await outcome('notifications.getAll')).value).to.deep.equal({})
    })

    it('reports a toast the user dismissed as closed by the user', async () => {
      await outcome('notifications.create', 'dismissed', options)
      shown[0].emit('close', { reason: 'userCanceled' })
      expect(await closed()).to.deep.equal([['dismissed', true]])
    })

    it("takes a 'close' without a reason as the user's", async () => {
      await outcome('notifications.create', 'no-reason', options)
      shown[0].emit('close', {})
      expect(await closed()).to.deep.equal([['no-reason', true]])
    })

    it('fires onClosed(id, false) once on clear, even if Electron then emits close', async () => {
      await outcome('notifications.create', 'cleared', options)
      expect((await outcome('notifications.clear', 'cleared')).value).to.equal(true)
      shown[0].emit('close', { reason: 'applicationHidden' })
      expect(await closed()).to.deep.equal([['cleared', false]])
    })

    it('fires nothing for a notification replaced by a create with the same id', async () => {
      await outcome('notifications.create', 'same', options)
      await outcome('notifications.create', 'same', options)
      shown[0].emit('close', { reason: 'applicationHidden' })
      expect(await closed()).to.deep.equal([])
      expect((await outcome('notifications.getAll')).value).to.deep.equal({ same: true })
      await outcome('notifications.clear', 'same')
    })
  })

  it('resolves whether there was a notification to clear or update', async () => {
    await outcome('notifications.create', 'exists', options)
    expect((await outcome('notifications.update', 'exists', { title: 'x' })).value).to.equal(true)
    expect((await outcome('notifications.update', 'missing', { title: 'x' })).value).to.equal(false)
    expect((await outcome('notifications.clear', 'exists')).value).to.equal(true)
    expect((await outcome('notifications.clear', 'missing')).value).to.equal(false)
  })
})
