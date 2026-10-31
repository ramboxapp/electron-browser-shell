import { expect } from 'chai'
import * as http from 'node:http'
import { AddressInfo } from 'node:net'

import { BrowserWindow, nativeImage } from 'electron'

import { useExtensionBrowser } from './hooks'
import { emittedOnce } from './events-helpers'

/*
  `chrome-extension://<id>/_favicon/?pageUrl=…&size=…`, against Edge 156 (measured 30/10/2026):
  a page never visited answers a generic icon of the size asked, a visited page its own favicon
  scaled to it, only the exact page URL counts, and no `pageUrl` fails. In Electron 44 the request
  never settled — a fetch hung and an image fired neither load nor error — which left every avatar
  of SafeInCloud's popup empty.
*/

/** A size×size image of one colour, BGRA, as PNG. */
const solidPng = (size: number, [b, g, r]: number[]) => {
  const bitmap = Buffer.alloc(size * size * 4)
  for (let i = 0; i < bitmap.length; i += 4) bitmap.set([b, g, r, 0xff], i)
  return nativeImage.createFromBitmap(bitmap, { width: size, height: size }).toPNG()
}

/** A 32×32 .ico of one colour with a single 32-bit DIB entry: what most `/favicon.ico` still are. */
const solidIco = ([b, g, r]: number[]) => {
  const size = 32
  const pixels = Buffer.alloc(size * size * 4)
  for (let i = 0; i < pixels.length; i += 4) pixels.set([b, g, r, 0xff], i)
  const mask = Buffer.alloc(size * 4) // one bit per pixel, rows padded to 4 bytes
  const dib = Buffer.alloc(40)
  dib.writeUInt32LE(40, 0)
  dib.writeInt32LE(size, 4)
  dib.writeInt32LE(size * 2, 8)
  dib.writeUInt16LE(1, 12)
  dib.writeUInt16LE(32, 14)
  const image = Buffer.concat([dib, pixels, mask])
  const header = Buffer.alloc(6 + 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header[6] = size
  header[7] = size
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(image.length, 14)
  header.writeUInt32LE(header.length, 18)
  return Buffer.concat([header, image])
}

const RED = [0x00, 0x00, 0xff]
const BLUE = [0xff, 0x00, 0x00]

describe('chrome-extension://<id>/_favicon/', () => {
  let server: http.Server
  let origin: string

  before(async () => {
    server = http.createServer((req, res) => {
      const route = req.url || '/'
      if (route === '/red.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' })
        return res.end(solidPng(32, RED))
      }
      if (route === '/blue.ico') {
        res.writeHead(200, { 'Content-Type': 'image/x-icon' })
        return res.end(solidIco(BLUE))
      }
      const icon = route.startsWith('/ico') ? '/blue.ico' : '/red.png'
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(`<!doctype html><title>site</title><link rel="icon" href="${icon}">`)
    })
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        resolve()
      }),
    )
  })

  after(() => {
    server.close()
  })

  const browser = useExtensionBrowser({ extensionName: 'favicon-mv3' })

  let page: BrowserWindow

  /** Shows `path` in the observed tab, and waits for it to report its favicon. */
  const visit = async (path: string) => {
    const favicon = emittedOnce(browser.webContents, 'page-favicon-updated')
    await browser.webContents.loadURL(origin + path)
    await favicon
    return origin + path
  }

  beforeEach(async () => {
    page = new BrowserWindow({ show: false, webPreferences: { session: browser.session } })
    await page.loadURL(`chrome-extension://${browser.extension.id}/page.html`)
  })

  afterEach(() => {
    if (!page.isDestroyed()) page.destroy()
  })

  const call = (expression: string) => page.webContents.executeJavaScript(expression)
  const json = (value: unknown) => JSON.stringify(value)

  it('answers a generic icon of the size asked for a page never shown', async () => {
    for (const size of [16, 32, 64]) {
      const icon = await call(`fetchIcon(${json('https://never.invalid/')}, ${size})`)
      expect(icon, `size ${size}`).to.include({ status: 200, width: size, height: size })
    }
    // The same for any page it does not know: what an extension compares with to mean "no icon".
    const a = await call(`fetchIcon(${json('https://never.invalid/')}, 32)`)
    const b = await call(`fetchIcon(${json('https://another.invalid/path')}, 32)`)
    expect(a).to.deep.equal(b)
  })

  it("answers a page's own favicon once it was shown, scaled to the size asked", async () => {
    const pageUrl = await visit('/site')
    for (const size of [16, 64]) {
      const icon = await call(`fetchIcon(${json(pageUrl)}, ${size})`)
      expect(icon).to.deep.equal({
        status: 200,
        width: size,
        height: size,
        center: [255, 0, 0, 255],
      })
    }
  })

  it('reads a 32-bit .ico favicon', async () => {
    const pageUrl = await visit('/ico-site')
    const icon = await call(`fetchIcon(${json(pageUrl)}, 16)`)
    expect(icon).to.deep.equal({ status: 200, width: 16, height: 16, center: [0, 0, 255, 255] })
  })

  it('matches the exact page URL only, as Chrome does', async () => {
    await visit('/site')
    const generic = await call(`fetchIcon(${json('https://never.invalid/')}, 16)`)
    expect(await call(`fetchIcon(${json(origin + '/other')}, 16)`)).to.deep.equal(generic)
    expect(await call(`fetchIcon(${json(origin + '/')}, 16)`)).to.deep.equal(generic)
  })

  it('fails a request with no pageUrl instead of hanging', async () => {
    expect(await call('fetchIcon(undefined, 16)')).to.deep.equal({
      error: 'TypeError: Failed to fetch',
    })
    expect(await call('imageIcon(undefined, 16)')).to.deep.equal({ error: 'error event' })
  })

  it('loads into an image, set as a property or an attribute, readable from a canvas', async () => {
    const pageUrl = await visit('/site')
    const expected = { width: 64, height: 64, center: [255, 0, 0, 255] }
    expect(await call(`imageIcon(${json(pageUrl)}, 64)`)).to.deep.equal(expected)
    expect(await call(`imageIcon(${json(pageUrl)}, 64, 'attribute')`)).to.deep.equal(expected)
  })

  it('answers a fetch from the service worker', async () => {
    const pageUrl = await visit('/site')
    expect(await call(`workerIcon(${json(pageUrl)}, 16)`)).to.deep.equal({
      status: 200,
      width: 16,
      height: 16,
      center: [255, 0, 0, 255],
    })
  })

  it('leaves every other request of the extension alone', async () => {
    const result = await call(`fetch('manifest.json').then((r) => r.json()).then((m) => m.name)`)
    expect(result).to.equal('chrome-favicon-mv3')
  })
})
