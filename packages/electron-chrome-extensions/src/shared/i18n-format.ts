/**
 * `chrome.i18n.getMessage` over a resolved message bundle, the way Chrome's MessageBundle does it.
 *
 * Shared by the preload (service workers and extension pages) and by the content-script shim, which
 * embeds this function's SOURCE in the file it writes into the extension (see
 * content-script-storage-patch.ts). That is why it is one self-contained function with no imports,
 * no helpers and no syntax esbuild would rewrite into helper calls: `Function.prototype.toString`
 * has to yield something that runs on its own in an isolated world.
 */

/** The manifest key the locale patch writes the resolved messages under. */
export const CRX_I18N_KEY = 'crx_i18n'

export interface CrxI18nPayload {
  /** The locale the messages were resolved for, in BCP-47 form (`es-AR`). */
  locale: string
  /** The merged bundle: the default locale's messages overlaid by the more specific ones. */
  messages: Record<string, { message: string; placeholders?: Record<string, { content: string }> }>
}

export interface CrxI18nState extends CrxI18nPayload {
  extensionId: string
  /** Lowercased name → original key, built on first use: Chrome's message names are case-insensitive. */
  index?: Record<string, string>
}

export function formatExtensionMessage(
  state: CrxI18nState,
  name: unknown,
  substitutions?: unknown,
  options?: { escapeLt?: boolean },
): string {
  if (typeof name !== 'string' || !state || !state.messages) return ''

  const subs: string[] = []
  if (Array.isArray(substitutions)) {
    for (let i = 0; i < substitutions.length; i++) {
      subs.push(substitutions[i] === undefined || substitutions[i] === null ? '' : String(substitutions[i]))
    }
  } else if (substitutions !== undefined && substitutions !== null) {
    subs.push(String(substitutions))
  }
  // Chrome refuses more than nine; the error text is Chromium's.
  if (subs.length > 9) throw new Error('Substitutions array must be at most 9 elements.')

  // $1..$9 → the substitutions; a missing one is the empty string, as in Chrome.
  const positional = (text: string) =>
    text.replace(/\$([1-9])/g, (_match: string, digit: string) => {
      const value = subs[Number(digit) - 1]
      return value === undefined ? '' : value
    })

  // The reserved @@ messages.
  if (name.charAt(0) === '@' && name.charAt(1) === '@') {
    const lower = name.toLowerCase()
    const language = String(state.locale || '').split(/[-_]/)[0].toLowerCase()
    const rtl = ['ar', 'he', 'iw', 'fa', 'ur', 'yi', 'ps', 'sd', 'ug', 'dv'].indexOf(language) !== -1
    if (lower === '@@extension_id') return state.extensionId || ''
    if (lower === '@@ui_locale') return String(state.locale || '').replace(/-/g, '_')
    if (lower === '@@bidi_dir') return rtl ? 'rtl' : 'ltr'
    if (lower === '@@bidi_reversed_dir') return rtl ? 'ltr' : 'rtl'
    if (lower === '@@bidi_start_edge') return rtl ? 'right' : 'left'
    if (lower === '@@bidi_end_edge') return rtl ? 'left' : 'right'
    return ''
  }

  if (!state.index) {
    const index: Record<string, string> = {}
    for (const key of Object.keys(state.messages)) index[key.toLowerCase()] = key
    state.index = index
  }
  const key = state.index[name.toLowerCase()]
  const entry = key === undefined ? undefined : state.messages[key]
  if (!entry || typeof entry.message !== 'string') return ''

  // escapeLt applies to the message text only, never to what a placeholder or substitution brings in.
  let text = entry.message
  if (options && options.escapeLt) text = text.replace(/</g, '&lt;')

  // `$$` is a literal dollar. Parked while the placeholders and substitutions are replaced, so a
  // substitution that itself contains `$1` is not expanded again (Chrome substitutes once).
  const DOLLAR = '\u0000'
  text = text.replace(/\$\$/g, DOLLAR)

  const placeholders = entry.placeholders || {}
  const byLowerName: Record<string, string> = {}
  for (const placeholderName of Object.keys(placeholders)) {
    const content = placeholders[placeholderName] && placeholders[placeholderName].content
    byLowerName[placeholderName.toLowerCase()] = typeof content === 'string' ? content : ''
  }
  // $NAME$ → the placeholder's content, with its own $n already substituted. An unknown name is
  // left as it was written, which is what Chrome shows for a bundle it loaded anyway.
  text = text.replace(/\$([A-Za-z0-9_@]+)\$/g, (match: string, placeholderName: string) => {
    const content = byLowerName[placeholderName.toLowerCase()]
    return content === undefined ? match : positional(content).replace(/\$/g, DOLLAR)
  })
  text = positional(text)

  return text.replace(new RegExp(DOLLAR, 'g'), '$')
}
