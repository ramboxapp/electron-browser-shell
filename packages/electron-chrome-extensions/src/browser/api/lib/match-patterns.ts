/**
 * Chrome match-pattern containment, as `chrome.permissions.contains()` needs it.
 *
 * https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns
 *
 * The question these answer is not "does this pattern match this URL" but "is this requested pattern
 * already covered by one of the granted ones" — which is what Chromium's URLPatternSet::Contains
 * decides. Comparing the two strings for equality instead (what this API did before) answers `false`
 * for every extension that declares a wildcard and then asks about a concrete site: Grammarly holds
 * the host permission for all https hosts and asks whether it has the one for its own domain, got
 * `false`, and silently gave up on reading its own session cookie ("No browser permissions to read
 * CSRFToken cookie").
 */

/** The schemes `<all_urls>` stands for, per Chrome's documentation. */
const ALL_URLS_SCHEMES = ['http', 'https', 'ws', 'wss', 'ftp', 'data', 'file']

interface ParsedPattern {
  scheme: string
  /** Lower-cased, without a leading `*.`; `*` means any host. */
  host: string
  /** True for a `*.example.com` pattern, which also covers `example.com` itself. */
  matchSubdomains: boolean
  path: string
}

/**
 * Parses a match pattern, or a plain URL (extensions pass those too: Grammarly asks about
 * `https://grammarly.com/`). Returns undefined for anything unparseable, which callers treat as
 * "cannot prove it is covered".
 */
export const parseMatchPattern = (pattern: string): ParsedPattern | undefined => {
  if (!pattern) return undefined
  if (pattern === '<all_urls>') return { scheme: '*', host: '*', matchSubdomains: true, path: '/*' }

  const schemeEnd = pattern.indexOf('://')
  if (schemeEnd <= 0) return undefined
  const scheme = pattern.slice(0, schemeEnd).toLowerCase()
  const rest = pattern.slice(schemeEnd + 3)
  if (!rest) return undefined

  // `file:///path` has an empty host; everything else needs one.
  const pathStart = rest.indexOf('/')
  const hostPart = (pathStart === -1 ? rest : rest.slice(0, pathStart)).toLowerCase()
  const path = pathStart === -1 ? '/*' : rest.slice(pathStart)

  const matchSubdomains = hostPart.startsWith('*.')
  const host = matchSubdomains ? hostPart.slice(2) : hostPart
  if (matchSubdomains && !host) return undefined

  return { scheme, host, matchSubdomains, path }
}

/** Does a granted path glob cover a requested one? Only `*` is special in a match pattern path. */
const pathCovers = (granted: string, requested: string): boolean => {
  if (granted === '/*' || granted === requested) return true
  if (!granted.includes('*')) return false
  // Translate the glob to a regular expression and test the requested path against it. A requested
  // glob is tested as its literal text, which is conservative: `/a*` does not count as covering
  // `/*`, matching Chromium, where a broader request is not contained in a narrower grant.
  const expression = granted
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${expression}$`).test(requested)
}

const schemeCovers = (granted: string, requested: string): boolean => {
  if (granted === requested) return true
  // A `*` scheme means http or https only — not every scheme.
  if (granted === '*') return requested === 'http' || requested === 'https' || requested === '*'
  return false
}

const hostCovers = (granted: ParsedPattern, requested: ParsedPattern): boolean => {
  if (granted.host === '*') return true
  if (requested.host === '*') return false
  if (granted.host === requested.host) return granted.matchSubdomains || !requested.matchSubdomains
  // `*.example.com` covers any subdomain of example.com, but `example.com` covers only itself.
  return granted.matchSubdomains && requested.host.endsWith(`.${granted.host}`)
}

/** Is `requested` entirely covered by `granted`? Both may be match patterns or plain URLs. */
export const patternCovers = (granted: string, requested: string): boolean => {
  const g = parseMatchPattern(granted)
  const r = parseMatchPattern(requested)
  if (!g || !r) return false
  if (granted === '<all_urls>') return r.scheme === '*' || ALL_URLS_SCHEMES.includes(r.scheme)
  return schemeCovers(g.scheme, r.scheme) && hostCovers(g, r) && pathCovers(g.path, r.path)
}

/** Is every requested pattern covered by at least one of the granted ones? */
export const patternsCover = (granted: readonly string[], requested: readonly string[]): boolean =>
  requested.every((pattern) =>
    granted.some((grantedPattern) => patternCovers(grantedPattern, pattern)),
  )
