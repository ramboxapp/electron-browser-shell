import { patternsCover } from './match-patterns'

/** The host patterns a manifest grants: MV3 lists them apart, MV2 mixes them into `permissions`. */
export const hostPatternsOf = (extension: Electron.Extension): string[] => {
  const manifest: chrome.runtime.Manifest = extension.manifest || {}
  const mixed = ((manifest.permissions as string[]) || []).filter(
    (permission) => permission === '<all_urls>' || permission.includes('://'),
  )
  const patterns =
    manifest.manifest_version === 3 ? [...(manifest.host_permissions || []), ...mixed] : mixed
  // A host permission is about the host: its path is ignored, as Chrome ignores it.
  return patterns.map((pattern) => pattern.replace(/^([^:]+:\/\/[^/]*)\/.*$/, '$1/*'))
}

/** Whether the extension's host permissions cover the host of this URL (its port and path aside). */
export const hostPermissionCovers = (extension: Electron.Extension, url: string): boolean => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return patternsCover(hostPatternsOf(extension), [`${parsed.protocol}//${parsed.hostname}/`])
}
