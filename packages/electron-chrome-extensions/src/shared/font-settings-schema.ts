/** chrome.fontSettings' schema, shared by the main process and the preload. */

/** The generic families Chrome accepts, in the order its validation error lists them. */
export const GENERIC_FAMILIES = [
  'cursive',
  'fantasy',
  'fixed',
  'math',
  'sansserif',
  'serif',
  'standard',
]

/** Every script code Chrome's schema accepts (the list its own validation error spells out). */
export const SCRIPT_CODES =
  'Afak Arab Armi Armn Avst Bali Bamu Bass Batk Beng Blis Bopo Brah Brai Bugi Buhd Cakm Cans Cari Cham Cher Cirt Copt Cprt Cyrl Cyrs Deva Dsrt Dupl Egyd Egyh Egyp Elba Ethi Geok Geor Glag Goth Gran Grek Gujr Guru Hang Hani Hano Hans Hant Hebr Hluw Hmng Hung Inds Ital Java Jpan Jurc Kali Khar Khmr Khoj Knda Kpel Kthi Lana Laoo Latf Latg Latn Lepc Limb Lina Linb Lisu Loma Lyci Lydi Mand Mani Maya Mend Merc Mero Mlym Mong Moon Mroo Mtei Mymr Narb Nbat Nkgb Nkoo Nshu Ogam Olck Orkh Orya Osma Palm Perm Phag Phli Phlp Phlv Phnx Plrd Prti Rjng Roro Runr Samr Sara Sarb Saur Sgnw Shaw Shrd Sind Sinh Sora Sund Sylo Syrc Syre Syrj Syrn Tagb Takr Tale Talu Taml Tang Tavt Telu Teng Tfng Tglg Thaa Thai Tibt Tirh Ugar Vaii Visp Wara Wole Xpeo Xsux Yiii Zmth Zsym Zyyy'.split(
    ' ',
  )

const signature = (method: string) =>
  `Error in invocation of fontSettings.${method}(object details, optional function callback)`

/**
 * Chrome's schema error for a fontSettings call, or undefined when the details are valid. Chrome throws
 * these synchronously; the library rejects (or sets `lastError`) with the same text instead, as it does
 * for every schema error, because throwing is the side that breaks an extension.
 */
export const fontSettingsSchemaError = (
  method: string,
  details: any,
  required: { genericFamily?: boolean; fontId?: boolean; pixelSize?: boolean },
): string | undefined => {
  const optionalDetails = !required.genericFamily && !required.fontId && !required.pixelSize
  if (details === undefined && optionalDetails) return undefined
  if (!details || typeof details !== 'object') return `${signature(method)}: No matching signature.`
  const at = (property: string, message: string) =>
    `${signature(method)}: Error at parameter 'details': ${property ? `Error at property '${property}': ` : ''}${message}`
  if (required.genericFamily) {
    if (details.genericFamily === undefined)
      return at('', "Missing required property 'genericFamily'.")
    if (!GENERIC_FAMILIES.includes(details.genericFamily))
      return at('genericFamily', `Value must be one of ${GENERIC_FAMILIES.join(', ')}.`)
  }
  if (details.script !== undefined && !SCRIPT_CODES.includes(details.script))
    return at('script', `Value must be one of ${SCRIPT_CODES.join(', ')}.`)
  if (required.fontId) {
    if (details.fontId === undefined) return at('', "Missing required property 'fontId'.")
    if (typeof details.fontId !== 'string')
      return at('fontId', `Invalid type: expected string, found ${typeName(details.fontId)}.`)
  }
  if (required.pixelSize) {
    if (details.pixelSize === undefined) return at('', "Missing required property 'pixelSize'.")
    if (!Number.isInteger(details.pixelSize))
      return at(
        'pixelSize',
        `Invalid type: expected integer, found ${typeName(details.pixelSize)}.`,
      )
  }
  return undefined
}

const typeName = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
