import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import { patternsCover } from './lib/match-patterns'

enum CookieStoreID {
  Default = '0',
  Incognito = '1',
}

/*
  Electron's causes in Chrome's words. Electron 44 reports a new cookie as 'inserted' (and has
  'unknown-deletion' and two 'inserted-no-...-overwrite' causes), none of which chrome.cookies has:
  Chrome reports a cookie a page or an extension set as 'explicit' (measured in Chromium 147, for
  the same document.cookie write that Electron 44.9.3 reported as 'inserted').
*/
const onChangedCauseTranslation: { [key: string]: string } = {
  'expired-overwrite': 'expired_overwrite',
  inserted: 'explicit',
  'inserted-no-change-overwrite': 'explicit',
  'inserted-no-value-change-overwrite': 'explicit',
  'unknown-deletion': 'explicit',
}

const createCookieDetails = (cookie: Electron.Cookie): chrome.cookies.Cookie => ({
  ...cookie,
  domain: cookie.domain || '',
  hostOnly: Boolean(cookie.hostOnly),
  session: Boolean(cookie.session),
  path: cookie.path || '',
  httpOnly: Boolean(cookie.httpOnly),
  secure: Boolean(cookie.secure),
  storeId: CookieStoreID.Default,
})

/**
 * The URL Chrome checks a cookie's host permission against: the cookie's domain without its leading
 * dot, over https only when the cookie is secure. So a non-secure cookie on example.com needs
 * `http://example.com/*` (or `*://`), and `https://example.com/*` alone does not cover it —
 * measured in Chromium 147, where such an extension sees none of that site's cookies.
 */
const cookieUrl = (cookie: Electron.Cookie) =>
  `${cookie.secure ? 'https' : 'http'}://${(cookie.domain || '').replace(/^\./, '')}/`

/** The host patterns a manifest grants: MV3 lists them apart, MV2 mixes them into `permissions`. */
const hostPatternsOf = (extension: Electron.Extension): string[] => {
  const manifest: chrome.runtime.Manifest = extension.manifest || {}
  const mixed = ((manifest.permissions as string[]) || []).filter(
    (permission) => permission === '<all_urls>' || permission.includes('://'),
  )
  const patterns =
    manifest.manifest_version === 3 ? [...(manifest.host_permissions || []), ...mixed] : mixed
  // A host permission is about the host: its path is ignored, as Chrome ignores it.
  return patterns.map((pattern) => pattern.replace(/^([^:]+:\/\/[^/]*)\/.*$/, '$1/*'))
}

const mayAccessCookie = (extension: Electron.Extension, cookie: Electron.Cookie) =>
  patternsCover(hostPatternsOf(extension), [cookieUrl(cookie)])

/**
 * The `url` of a get/set/remove, checked as Chrome checks it (measured in Chromium 147 on 30/10/2026):
 * against the URL the extension passed, with its own scheme, and not against the cookie. So with
 * `https://example.com/*` alone, `get({url: 'http://example.com/'})` fails while
 * `get({url: 'https://example.com/'})` returns even a non-secure cookie. An unparseable URL fails
 * first, with its own message. Both fail the promise and set `lastError` for a callback, which then
 * receives nothing. The message quotes the parsed URL (Chrome's `GURL::spec()`), not the raw string.
 */
const checkCookieUrl = (extension: Electron.Extension, url: unknown): string => {
  let parsed: URL
  try {
    parsed = new URL(String(url))
  } catch {
    throw new Error(`Invalid url: "${url}".`)
  }
  // A match pattern without a port covers every port: compare the host alone.
  const hostUrl = `${parsed.protocol}//${parsed.hostname}/`
  if (!patternsCover(hostPatternsOf(extension), [hostUrl])) {
    throw new Error(`No host permissions for cookies at url: "${parsed.href}".`)
  }
  return parsed.href
}

export class CookiesAPI {
  private get cookies() {
    return this.ctx.session.cookies
  }

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('cookies.get', this.get.bind(this))
    handle('cookies.getAll', this.getAll.bind(this))
    handle('cookies.set', this.set.bind(this))
    handle('cookies.remove', this.remove.bind(this))
    handle('cookies.getAllCookieStores', this.getAllCookieStores.bind(this))

    this.cookies.addListener('changed', this.onChanged)
  }

  private async get(
    event: ExtensionEvent,
    details: chrome.cookies.CookieDetails,
  ): Promise<chrome.cookies.Cookie | null> {
    checkCookieUrl(event.extension, details?.url)
    // TODO: storeId
    const cookies = await this.cookies.get({
      url: details.url,
      name: details.name,
    })

    // TODO: If more than one cookie of the same name exists for the given URL,
    // the one with the longest path will be returned. For cookies with the
    // same path length, the cookie with the earliest creation time will be returned.
    return cookies.length > 0 ? createCookieDetails(cookies[0]) : null
  }

  private async getAll(
    event: ExtensionEvent,
    details: chrome.cookies.GetAllDetails,
  ): Promise<chrome.cookies.Cookie[]> {
    // TODO: storeId
    const cookies = await this.cookies.get({
      url: details.url,
      name: details.name,
      domain: details.domain,
      path: details.path,
      secure: details.secure,
      session: details.session,
    })

    // Only the cookies of hosts the extension may access, as Chrome filters getAll.
    return cookies
      .filter((cookie) => mayAccessCookie(event.extension, cookie))
      .map(createCookieDetails)
  }

  private async set(
    event: ExtensionEvent,
    details: chrome.cookies.SetDetails,
  ): Promise<chrome.cookies.Cookie | null> {
    checkCookieUrl(event.extension, details?.url)
    await this.cookies.set(details)
    const cookies = await this.cookies.get(details)
    return cookies.length > 0 ? createCookieDetails(cookies[0]) : null
  }

  private async remove(
    event: ExtensionEvent,
    details: chrome.cookies.CookieDetails,
  ): Promise<chrome.cookies.CookieDetails | null> {
    checkCookieUrl(event.extension, details?.url)
    try {
      await this.cookies.remove(details.url, details.name)
    } catch {
      return null
    }
    // Chrome answers `{name, storeId, url}`, also for a cookie that was not there.
    return { name: details.name, storeId: CookieStoreID.Default, url: details.url }
  }

  private async getAllCookieStores(event: ExtensionEvent): Promise<chrome.cookies.CookieStore[]> {
    const tabIds = Array.from(this.ctx.store.tabs)
      .map((tab) => (tab.isDestroyed() ? undefined : tab.id))
      .filter(Boolean) as number[]
    return [{ id: CookieStoreID.Default, tabIds }]
  }

  private onChanged = (
    event: Electron.Event,
    cookie: Electron.Cookie,
    cause: string,
    removed: boolean,
  ) => {
    const changeInfo: chrome.cookies.CookieChangeInfo = {
      cause: onChangedCauseTranslation[cause] || cause,
      cookie: createCookieDetails(cookie),
      removed,
    }

    /*
      To each extension whose host permissions cover the cookie, and to no other: Chrome does not
      tell an extension about a cookie it could not read (measured in Chromium 147, a cookie set on a
      host the extension has no permission for fires nothing there). This was a broadcast, so every
      extension with the cookies permission saw every cookie of every site.
    */
    const sessionExtensions = this.ctx.session.extensions || this.ctx.session
    for (const extension of sessionExtensions.getAllExtensions()) {
      if (mayAccessCookie(extension, cookie)) {
        this.ctx.router.sendEvent(extension.id, 'cookies.onChanged', changeInfo)
      }
    }
  }
}
