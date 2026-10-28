import { expect } from 'chai'
import { ipcMain } from 'electron'

import { useExtensionBrowser, useServer } from './hooks'
import { patternCovers, patternsCover } from '../src/browser/api/lib/match-patterns'

describe('chrome.permissions', () => {
  /**
   * Containment, not string equality. Chromium answers `contains()` with URLPatternSet::Contains, so
   * a broad grant covers a narrow request. Comparing the strings instead told Grammarly it had no
   * permission for its own domain while holding every https host, and it stopped reading its session
   * cookie over it ("No browser permissions to read CSRFToken cookie").
   */
  describe('match pattern containment', () => {
    it('covers a concrete host with an all-hosts grant', () => {
      expect(patternCovers('https://*/*', 'https://*.grammarly.com/*')).to.be.true
      expect(patternCovers('https://*/*', 'https://grammarly.com/')).to.be.true
      expect(patternCovers('http://*/*', 'http://example.com/path')).to.be.true
    })

    it('covers anything http or https with <all_urls>', () => {
      expect(patternCovers('<all_urls>', 'https://example.com/*')).to.be.true
      expect(patternCovers('<all_urls>', 'http://example.com/*')).to.be.true
      expect(patternCovers('<all_urls>', 'file:///tmp/x')).to.be.true
    })

    it('covers subdomains only when the grant asks for them', () => {
      expect(patternCovers('https://*.example.com/*', 'https://mail.example.com/*')).to.be.true
      expect(patternCovers('https://*.example.com/*', 'https://example.com/*')).to.be.true
      expect(patternCovers('https://example.com/*', 'https://mail.example.com/*')).to.be.false
    })

    it('does not let a narrow grant cover a broad request', () => {
      expect(patternCovers('https://example.com/*', 'https://*/*')).to.be.false
      expect(patternCovers('https://example.com/only/*', 'https://example.com/*')).to.be.false
      // A `*` scheme is http and https, not every scheme.
      expect(patternCovers('*://example.com/*', 'ftp://example.com/*')).to.be.false
    })

    it('honours the path part of a pattern', () => {
      expect(patternCovers('https://example.com/api/*', 'https://example.com/api/v1')).to.be.true
      expect(patternCovers('https://example.com/api/*', 'https://example.com/other')).to.be.false
    })

    it('answers false for an unparseable pattern instead of throwing', () => {
      expect(patternCovers('https://example.com/*', 'not a pattern')).to.be.false
      expect(patternCovers('', 'https://example.com/*')).to.be.false
    })

    it('requires every requested pattern to be covered by some grant', () => {
      const granted = ['https://*.example.com/*', 'http://localhost/*']
      expect(patternsCover(granted, ['https://mail.example.com/*', 'http://localhost/x'])).to.be
        .true
      expect(patternsCover(granted, ['https://mail.example.com/*', 'https://other.com/*'])).to.be
        .false
      // Nothing requested is vacuously covered, as Chrome does.
      expect(patternsCover(granted, [])).to.be.true
    })
  })

  describe('contains()', () => {
    const server = useServer()
    // rpc-mv3 declares host_permissions ["<all_urls>"] and the tabs/alarms/idle/scripting/offscreen
    // /webRequest API permissions.
    const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

    it('is true for a declared API permission', async () => {
      expect(await browser.crx.exec('permissions.contains', { permissions: ['tabs'] })).to.be.true
    })

    it('is false for a permission the extension does not have', async () => {
      expect(await browser.crx.exec('permissions.contains', { permissions: ['bookmarks'] })).to.be
        .false
    })

    it('is true for a concrete origin covered by the declared host permissions', async () => {
      // The whole point: <all_urls> is granted, and this is what an extension actually asks about.
      expect(await browser.crx.exec('permissions.contains', { origins: ['https://example.com/*'] }))
        .to.be.true
      expect(await browser.crx.exec('permissions.contains', { origins: ['https://example.com/'] }))
        .to.be.true
    })

    it('needs both the permissions and the origins to be covered', async () => {
      expect(
        await browser.crx.exec('permissions.contains', {
          permissions: ['tabs'],
          origins: ['https://example.com/*'],
        }),
      ).to.be.true
      expect(
        await browser.crx.exec('permissions.contains', {
          permissions: ['bookmarks'],
          origins: ['https://example.com/*'],
        }),
      ).to.be.false
    })
  })

  /*
    Granting and revoking have to be announced. Proton Pass keeps its "permissions granted" state in
    the worker and refreshes it only from permissions.onAdded / onRemoved: it asks for clipboardRead
    and clipboardWrite from its settings page, popup and dropdown, and its worker reacts to onAdded
    reporting them. The library granted the request and never said so, so the worker went on believing
    the permission was missing until it restarted. And remove() was a stub that answered true and kept
    the permission, so contains() still said yes after a revoke.
  */
  describe('request() and remove()', () => {
    const server = useServer()
    // rpc-mv3 declares clipboardRead and clipboardWrite as optional_permissions.
    const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    /*
      exec() and eventOnce() both resolve on the fixture's first 'success' IPC, so an event that fires
      in the same instant as the call that causes it is indistinguishable from that call's reply. This
      collects every 'success' while `action` runs and returns the event's arguments — the one reply
      that is an array — plus what the action itself answered.
    */
    const eventDuring = async (eventName: string, action: () => Promise<unknown>) => {
      const replies: unknown[] = []
      const onSuccess = (_event: unknown, reply: unknown) => replies.push(reply)
      ipcMain.on('success', onSuccess)
      try {
        const rpc = JSON.stringify({ type: 'event-once', name: eventName })
        await browser.webContents.executeJavaScript(`exec('${rpc}')`)
        await sleep(100)
        await action()
        for (let i = 0; i < 40 && !replies.some(Array.isArray); i++) await sleep(50)
        return {
          eventArgs: replies.find(Array.isArray) as any[] | undefined,
          others: replies.filter((r) => !Array.isArray(r)),
        }
      } finally {
        ipcMain.removeListener('success', onSuccess)
      }
    }

    it('grants a declared optional permission', async () => {
      expect(await browser.crx.exec('permissions.contains', { permissions: ['clipboardRead'] })).to
        .be.false
      expect(await browser.crx.exec('permissions.request', { permissions: ['clipboardRead'] })).to
        .be.true
      expect(await browser.crx.exec('permissions.contains', { permissions: ['clipboardRead'] })).to
        .be.true
    })

    it('fires onAdded with what was newly granted', async () => {
      const { eventArgs } = await eventDuring('permissions.onAdded', () =>
        browser.crx.exec('permissions.request', { permissions: ['clipboardRead', 'tabs'] }),
      )
      expect(eventArgs, 'permissions.onAdded never fired').to.be.an('array')
      const [details] = eventArgs!
      // `tabs` was already granted by the manifest, so Chrome reports only clipboardRead.
      expect(details.permissions).to.deep.equal(['clipboardRead'])
      expect(details.origins).to.deep.equal([])
    })

    it('removes an optional permission and fires onRemoved', async () => {
      await browser.crx.exec('permissions.request', { permissions: ['clipboardWrite'] })
      const { eventArgs, others } = await eventDuring('permissions.onRemoved', () =>
        browser.crx.exec('permissions.remove', { permissions: ['clipboardWrite'] }),
      )
      expect(others, 'what remove() answered').to.include(true)
      expect(eventArgs, 'permissions.onRemoved never fired').to.be.an('array')
      const [details] = eventArgs!
      expect(details.permissions).to.deep.equal(['clipboardWrite'])
      expect(await browser.crx.exec('permissions.contains', { permissions: ['clipboardWrite'] })).to
        .be.false
    })

    it('refuses to remove a required permission, and keeps it', async () => {
      // Chrome: "You cannot remove required permissions." The call does not succeed.
      const result = await browser.crx.exec('permissions.remove', { permissions: ['tabs'] })
      expect(result).to.not.equal(true)
      expect(await browser.crx.exec('permissions.contains', { permissions: ['tabs'] })).to.be.true
    })
  })
})
