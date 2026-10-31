import { nativeImage } from 'electron'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { TabContents } from './common'

/*
  `chrome-extension://<id>/_favicon/?pageUrl=…&size=…`, which Electron does not serve.

  In Electron 44.9.3 a request to it never settles: a `fetch` hangs, an `<img>` fires neither load
  nor error, and a page with one in its HTML never finishes loading. RoboForm and SafeInCloud declare
  the `favicon` permission and use it; SafeInCloud waits on the image before it draws an entry's
  avatar, so every avatar stayed empty, without even its letter.

  Measured on 30/10/2026 in Edge 156 (Chromium), with an extension holding the permission:
  - a page never visited answers 200 with a generic icon of the size asked (16, 32, 64);
  - a visited page answers its own favicon, scaled to the size asked;
  - only the exact page URL counts: another path of the same site, or its root, gets the generic one;
  - no `pageUrl` fails the request.

  Chrome answers from its favicon database, filled by browsing. Electron keeps none, so this answers
  from the pages this session has shown: an open tab with that URL, or one that showed it before.
  The request itself cannot be intercepted — `protocol.handle('chrome-extension')` takes the whole
  scheme and `net.fetch` cannot hand the rest back to Chromium (ERR_UNKNOWN_URL_SCHEME) — so the
  preload answers `fetch` and `img.src` for these URLs with what this returns (see mainWorldScript).
*/

const MAX_SIZE = 256
const DEFAULT_SIZE = 16
const MAX_REMEMBERED_PAGES = 500
const MAX_CACHED_ICONS = 200

/** Page URL → the favicon URL it last reported, newest last. */
const rememberedFavicons = new Map<string, string>()

/** Called for every `page-favicon-updated` of an observed tab. */
export const rememberFavicon = (pageUrl: string, faviconUrl: string | undefined) => {
  if (!pageUrl || !faviconUrl) return
  rememberedFavicons.delete(pageUrl)
  rememberedFavicons.set(pageUrl, faviconUrl)
  if (rememberedFavicons.size > MAX_REMEMBERED_PAGES) {
    rememberedFavicons.delete(rememberedFavicons.keys().next().value!)
  }
}

const parseSize = (value: unknown): number => {
  const size = Math.round(Number(value))
  if (!Number.isFinite(size) || size < 1) return DEFAULT_SIZE
  return Math.min(size, MAX_SIZE)
}

/*
  The generic icon: a grey globe, drawn here rather than shipped. What an extension does with it is
  compare it with what it gets for a page (SafeInCloud asks for `https://never.invalid/` and treats a
  match as "no icon"), so it only has to be the same for every unknown page of a given size.
*/
const genericIcons = new Map<number, string>()
const genericIcon = (size: number): string => {
  let png = genericIcons.get(size)
  if (png) return png
  const bitmap = Buffer.alloc(size * size * 4)
  const center = (size - 1) / 2
  const radius = size / 2 - Math.max(1, size / 16)
  const stroke = Math.max(1, size / 12)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - center
      const dy = y - center
      const distance = Math.hypot(dx, dy)
      const outline = Math.abs(distance - radius) <= stroke / 2
      const inside = distance < radius
      const equator = inside && Math.abs(dy) <= stroke / 2
      const meridian = inside && Math.abs(Math.hypot(dx / 0.45, dy) - radius) <= stroke / 2
      if (!outline && !equator && !meridian) continue
      const offset = (y * size + x) * 4
      // BGRA
      bitmap[offset] = 0x75
      bitmap[offset + 1] = 0x75
      bitmap[offset + 2] = 0x75
      bitmap[offset + 3] = 0xff
    }
  }
  png = nativeImage
    .createFromBitmap(bitmap, { width: size, height: size })
    .toPNG()
    .toString('base64')
  genericIcons.set(size, png)
  return png
}

/*
  An .ico as an image. `nativeImage.createFromBuffer` reads PNG and JPEG only, and a page that
  declares no icon reports `/favicon.ico`. Picks the largest entry: a PNG one as is, a 32-bit DIB
  one converted. Anything else (1-, 4-, 8- or 24-bit DIBs) is left to the generic icon.
*/
const imageFromIco = (buffer: Buffer): Electron.NativeImage | undefined => {
  if (buffer.length < 6 || buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return
  const count = buffer.readUInt16LE(4)
  let best: { width: number; size: number; offset: number } | undefined
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16
    if (entry + 16 > buffer.length) break
    const width = buffer[entry] || 256
    const size = buffer.readUInt32LE(entry + 8)
    const offset = buffer.readUInt32LE(entry + 12)
    if (offset + size > buffer.length) continue
    if (!best || width > best.width) best = { width, size, offset }
  }
  if (!best) return
  const data = buffer.subarray(best.offset, best.offset + best.size)
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return nativeImage.createFromBuffer(data)
  }
  if (data.length < 40) return
  const width = data.readInt32LE(4)
  const height = Math.abs(data.readInt32LE(8)) / 2 // the XOR image and the AND mask
  const bitCount = data.readUInt16LE(14)
  const headerSize = data.readUInt32LE(0)
  if (bitCount !== 32 || width <= 0 || height <= 0) return
  const rowBytes = width * 4
  if (headerSize + rowBytes * height > data.length) return
  const bitmap = Buffer.alloc(rowBytes * height)
  for (let row = 0; row < height; row++) {
    // DIB rows are bottom-up.
    const source = headerSize + (height - 1 - row) * rowBytes
    data.copy(bitmap, row * rowBytes, source, source + rowBytes)
  }
  return nativeImage.createFromBitmap(bitmap, { width, height })
}

const scaledIcons = new Map<string, string | null>()

export class FaviconAPI {
  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('_favicon.get', this.get, { permission: 'favicon' })
  }

  /** The favicon of `pageUrl` at `size`, as base64 PNG. */
  private get = async (_event: ExtensionEvent, pageUrl: unknown, sizeParam: unknown) => {
    if (typeof pageUrl !== 'string' || !pageUrl) throw new Error('Missing pageUrl')
    const size = parseSize(sizeParam)

    const openTab = Array.from(this.ctx.store.tabs).find(
      (tab) => !tab.isDestroyed() && tab.getURL() === pageUrl && (tab as TabContents).favicon,
    ) as TabContents | undefined
    const faviconUrl = openTab?.favicon || rememberedFavicons.get(pageUrl)
    if (!faviconUrl) return genericIcon(size)

    const key = `${size} ${faviconUrl}`
    if (!scaledIcons.has(key)) {
      scaledIcons.set(key, await this.scaledIcon(faviconUrl, size, openTab))
      if (scaledIcons.size > MAX_CACHED_ICONS) {
        scaledIcons.delete(scaledIcons.keys().next().value!)
      }
    }
    return scaledIcons.get(key) ?? genericIcon(size)
  }

  private async scaledIcon(faviconUrl: string, size: number, tab?: Electron.WebContents) {
    try {
      let image: Electron.NativeImage | undefined
      if (faviconUrl.startsWith('data:')) {
        image = nativeImage.createFromDataURL(faviconUrl)
      } else {
        // Through the page's own session, so its cookies and proxy apply as they did for the page.
        const session = tab && !tab.isDestroyed() ? tab.session : this.ctx.session
        const response = await session.fetch(faviconUrl, { signal: AbortSignal.timeout(10000) })
        if (!response.ok) return null
        const buffer = Buffer.from(await response.arrayBuffer())
        image = nativeImage.createFromBuffer(buffer)
        if (image.isEmpty()) image = imageFromIco(buffer)
      }
      if (!image || image.isEmpty()) return null
      return image.resize({ width: size, height: size, quality: 'best' }).toPNG().toString('base64')
    } catch {
      return null
    }
  }
}
