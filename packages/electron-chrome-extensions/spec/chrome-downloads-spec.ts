import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.downloads', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc' })

  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'crx-downloads-'))

    // Redirect downloads away from the real downloads folder. This listener
    // runs after the API's own 'will-download' listener, so it wins.
    browser.session.on('will-download', (event, item) => {
      item.setSavePath(path.join(tmpDir, 'download.html'))
    })
  })

  afterEach(async () => {
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  })

  describe('download()', () => {
    it('starts a download and resolves an id', async () => {
      const id = await browser.crx.exec('downloads.download', { url: server.getUrl() })
      expect(id).to.be.a('number')

      const results = await browser.crx.exec('downloads.search', { id })
      expect(results).to.have.lengthOf(1)
      expect(results[0].url).to.equal(server.getUrl())
    })
  })

  describe('onCreated', () => {
    it('emits for new downloads', async () => {
      const eventPromise = browser.crx.eventOnce('downloads.onCreated')
      // Give the event listener time to register
      await new Promise((resolve) => setTimeout(resolve, 500))

      browser.session.downloadURL(server.getUrl())

      const [details] = await eventPromise
      expect(details.url).to.equal(server.getUrl())
      expect(details.state).to.equal('in_progress')
    })
  })

  describe('erase()', () => {
    it('removes the download from history', async () => {
      const id = await browser.crx.exec('downloads.download', { url: server.getUrl() })

      const erasedIds = await browser.crx.exec('downloads.erase', { id })
      expect(erasedIds).to.deep.equal([id])

      const results = await browser.crx.exec('downloads.search', { id })
      expect(results).to.be.empty
    })
  })

  describe('search()', () => {
    it('returns empty results for unknown ids', async () => {
      const results = await browser.crx.exec('downloads.search', { id: 999999 })
      expect(results).to.be.empty
    })
  })

  /*
    A filename is relative to the downloads folder and must stay in it. It was joined as given, so
    `../` walked out of the folder and an absolute path went wherever it pointed. Chrome refuses both
    with "Invalid filename", before anything starts.
  */
  describe('download() filename', () => {
    const attempt = async (filename: string) => {
      const before = await browser.crx.exec('downloads.search', {})
      const result = await browser.crx.exec('downloads.download', { url: server.getUrl(), filename })
      const after = await browser.crx.exec('downloads.search', {})
      return { result, started: after.length - before.length }
    }

    it('refuses a path that leaves the downloads folder', async () => {
      const { result, started } = await attempt('../escaped.html')
      expect(result, 'no download id').to.equal(null)
      expect(started).to.equal(0)
    })

    it('refuses an absolute path', async () => {
      // Forward slashes on Windows too: path.isAbsolute accepts them, and backslashes do not survive
      // the string quoting the fixture's exec() goes through.
      const absolute = process.platform === 'win32' ? 'C:/Windows/escaped.html' : '/tmp/escaped.html'
      const { result, started } = await attempt(absolute)
      expect(result).to.equal(null)
      expect(started).to.equal(0)
    })

    it('accepts a name inside a subfolder', async () => {
      const { result } = await attempt('sub/inside.html')
      expect(result).to.be.a('number')
    })
  })
})
