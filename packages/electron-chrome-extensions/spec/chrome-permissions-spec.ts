import { expect } from 'chai'

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
      expect(patternsCover(granted, ['https://mail.example.com/*', 'http://localhost/x'])).to.be.true
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
      expect(await browser.crx.exec('permissions.contains', { origins: ['https://example.com/'] })).to
        .be.true
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
})
