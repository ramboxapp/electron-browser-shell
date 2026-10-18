import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import debug from 'debug'

const d = debug('electron-chrome-extensions:module-sw-patch')

/**
 * Works around an Electron regression (verified through at least Electron
 * 42.5.2, both on stock builds and the castlabs/WideVine fork) where MV3
 * service workers declared with `"type": "module"` never finish
 * registering: `session.registerPreloadScript({type: 'service-worker'})`
 * augments `chrome.tabs`/`chrome.windows`/etc, but that injection doesn't
 * resolve before the module's own top-level code evaluates — code that
 * commonly references those namespaces at eval time (e.g.
 * `chrome.windows.WINDOW_ID_CURRENT`) throws, and the worker's registration
 * fails silently: no `service_worker` CDP target ever appears, and Chromium
 * reports "Service worker registration failed. Status code: 15" with no
 * further diagnostic. Classic (non-module) service workers aren't affected —
 * their preload has already run by the time their code executes.
 *
 * `session.extensions.loadExtension()` is Electron's own native API, called
 * directly by the app embedding this library — this library never sees an
 * extension's files until after Electron has already attempted to load it.
 * That means this can't be fixed from inside `ElectronChromeExtensions`
 * itself; callers must invoke this function on the unpacked extension
 * directory *before* their own `session.extensions.loadExtension(path)` call.
 *
 * The workaround: rewrite the service worker (and any vendor files it
 * statically imports) into a classic script, then drop `"type": "module"`
 * from the manifest so Electron treats it as an ordinary (non-module)
 * service worker. Idempotent via a `/* __crx_patched *\/` marker — safe to
 * call unconditionally on every extension; it's a no-op for anything that
 * isn't MV3 with `background.type === 'module'`.
 *
 * TODO(electron): remove once Electron reliably resolves `chrome.*` preload
 * injection for a module service worker before its top-level code evaluates.
 *
 * Never throws: this is a best-effort workaround, and a failed patch must
 * degrade to "extension loads unpatched" — callers invoke it right before
 * `loadExtension()`, so an escaping error (disk write failure, malformed
 * manifest, unexpected SW syntax) would otherwise skip loading the extension
 * entirely.
 */
export async function patchModuleServiceWorker(extensionPath: string): Promise<void> {
  try {
    await patchModuleServiceWorkerUnsafe(extensionPath)
  } catch (error) {
    console.error(
      `electron-chrome-extensions: patchModuleServiceWorker failed for ${extensionPath}; ` +
        'loading the extension unpatched',
      error,
    )
  }
}

/**
 * Electron versions that register a `"type": "module"` service worker correctly, where this patch is
 * not only unnecessary but harmful.
 *
 * Measured on Electron 43.0.0 (castlabs) with the four module-service-worker extensions in Rambox's
 * catalog — 1Password 8.12.28.25, Everhour 1.6.320, HubSpot Sales 3.1.1.42592 and uBlock 25.5.0:
 * every one of them registers, boots and calls chrome.* with the patch skipped. With the patch
 * applied, uBlock does not register at all ("Uncaught SyntaxError: Cannot use import statement
 * outside a module", then "Service worker registration failed. Status code: 15"), because the
 * rewriter below cannot express its import graph and leaves real `import` statements in a script
 * Electron now loads as classic. A dead ad blocker is a worse outcome than the bug this works around.
 */
const MODULE_SERVICE_WORKER_FIXED_FROM = 43

const electronMajor = (): number | null => {
  const version = process.versions?.electron
  const major = version ? Number.parseInt(version.split('.')[0]!, 10) : NaN
  return Number.isFinite(major) ? major : null
}

/**
 * Whether {@link patchModuleServiceWorker} would actually rewrite anything on this Electron.
 *
 * A host app needs this because the rewrite happens ON DISK: an install converted by an older
 * version of this library keeps running as a classic script even once the patch stops being applied,
 * so the host has to reinstall it — and it must only do that once this returns false, or it would
 * reinstall on every launch while the patch keeps converting the fresh copy again.
 */
export const willPatchModuleServiceWorker = (): boolean => {
  if (process.env.CRX_FORCE_MODULE_SW_PATCH === '1') return true
  const major = electronMajor()
  return major === null || major < MODULE_SERVICE_WORKER_FIXED_FROM
}

async function patchModuleServiceWorkerUnsafe(extensionPath: string): Promise<void> {
  const major = electronMajor()
  // CRX_FORCE_MODULE_SW_PATCH=1 runs the rewrite regardless of version, so the conversion itself
  // stays testable (and debuggable) on an Electron that no longer needs it.
  const forced = process.env.CRX_FORCE_MODULE_SW_PATCH === '1'
  if (!forced && major !== null && major >= MODULE_SERVICE_WORKER_FIXED_FROM) {
    d(`skipping ${extensionPath}: Electron ${major} registers module service workers natively`)
    return
  }

  const manifestPath = path.join(extensionPath, 'manifest.json')
  let manifestText: string
  try {
    manifestText = await fs.readFile(manifestPath, 'utf-8')
  } catch {
    return
  }

  // Chromium tolerates a UTF-8 BOM in manifest.json; JSON.parse doesn't.
  const manifest = JSON.parse(
    manifestText.charCodeAt(0) === 0xfeff ? manifestText.slice(1) : manifestText,
  )
  if (
    manifest.manifest_version !== 3 ||
    manifest.background?.type !== 'module' ||
    !manifest.background?.service_worker
  ) {
    return
  }

  const swRelPath: string = manifest.background.service_worker
  const swPath = path.join(extensionPath, swRelPath)
  const swDir = path.dirname(swPath)

  let bgContent: string
  try {
    bgContent = await fs.readFile(swPath, 'utf-8')
  } catch {
    return
  }

  if (bgContent.startsWith('/* __crx_patched */')) return

  d(`patching module service worker for ${manifest.name} ${manifest.version}`)

  // Collect static import statements: ;import X from 'file' or ;import{a,b}from'file'.
  // Minifiers strip whitespace around tokens, so \s* (not \s+) is required after "import".
  const importPattern = /;import\s*(\*\s*as\s+\w+|\{[^}]+\}|\w+)\s*from\s*["']([^"']+)["']/g
  const imports: Array<{ full: string; binding: string; from: string }> = []
  let m: RegExpExecArray | null
  while ((m = importPattern.exec(bgContent)) !== null) {
    imports.push({ full: m[0], binding: m[1].trim(), from: m[2] })
  }

  const fileProcessed = new Set<string>()
  /*
    Every file this function rewrites, with the bytes it had before. The rewrite is a regex
    transform of someone else's bundle, so "it did not work" is a normal outcome and has to be
    survivable: leaving a half-converted module in a script Electron loads as classic is strictly
    worse than not patching at all (the worker fails to register and the extension does nothing).
    Validated at the end; restored from here when the result still contains ES module syntax.
  */
  const originals = new Map<string, string>()
  const rememberOriginal = async (filePath: string) => {
    if (originals.has(filePath)) return
    try {
      originals.set(filePath, await fs.readFile(filePath, 'utf-8'))
    } catch {
      // Unreadable: nothing to restore, and the write below will fail loudly anyway.
    }
  }
  await rememberOriginal(swPath)
  // ES module imports are hoisted: every statically-imported module is fully
  // evaluated before ANY of the importing module's own top-level code runs
  // (even code textually before the import). importScripts() has no such
  // hoisting — it runs synchronously wherever it's called — so all
  // importScripts calls are collected here and prepended at the very top of
  // the file to emulate that ordering, instead of leaving them at the
  // original (textual) import position.
  const hoistedImportScripts: string[] = []

  for (const imp of imports) {
    const globalName =
      '__crxV_' +
      imp.from
        .replace(/[^a-zA-Z0-9]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')
    const absoluteFrom = imp.from.startsWith('/')
      ? path.join(extensionPath, imp.from)
      : path.resolve(swDir, imp.from)

    // Patch the vendor file once — replace its ES module exports with a global object assignment.
    if (!fileProcessed.has(imp.from)) {
      fileProcessed.add(imp.from)
      try {
        await rememberOriginal(absoluteFrom)
        let vc = await fs.readFile(absoluteFrom, 'utf-8')
        // export default X  or  export default X()  →  self.GLOBAL = {default: X} / {default: X()}
        vc = vc.replace(
          /\bexport\s+default\s+(\w+(?:\([^)]*\))?)/g,
          `self.${globalName} = {default: $1}`,
        )
        // export default { ... }  →  self.GLOBAL = {default: { ... }} with a closing brace appended at EOF
        if (/\bexport\s+default\s+\{/.test(vc)) {
          vc = vc.replace(/\bexport\s+default\s+\{/, `self.${globalName} = {default: {`)
          vc = vc.trimEnd() + '}'
        }
        // export{a as b, c}  →  self.GLOBAL = {b: a, c: c}
        vc = vc.replace(/\bexport\s*\{([^}]+)\}/g, (_match: string, exportsList: string) => {
          const entries = exportsList
            .split(',')
            .map((e: string) => e.trim())
            .filter(Boolean)
            .map((e: string) => {
              const parts = e.split(/\s+as\s+/)
              const internal = parts[0].trim()
              const external = (parts[1] || parts[0]).trim()
              return external === 'default' ? `default: ${internal}` : `${external}: ${internal}`
            })
          return `self.${globalName} = {${entries.join(', ')}}`
        })
        // Wrap in an IIFE so this file's own top-level vars (short minified
        // names like h, nt, no, etc.) don't leak into and collide with the
        // shared global scope that importScripts() puts everything into
        // (unlike isolated ES module scopes).
        vc = `;(function(){\n${vc}\n})();`
        await fs.writeFile(absoluteFrom, vc, 'utf-8')
      } catch (e) {
        console.error('[electron-chrome-extensions] module SW vendor patch failed:', imp.from, e)
      }
    }

    const isFirst = imports.filter((x) => x.from === imp.from).indexOf(imp) === 0
    if (isFirst) hoistedImportScripts.push(`importScripts(${JSON.stringify(imp.from)});`)

    const isNamed = imp.binding.startsWith('{')
    let varLine: string

    if (isNamed) {
      const names = imp.binding
        .slice(1, -1)
        .split(',')
        .map((s: string) => s.trim())
        .filter(Boolean)
      varLine = names
        .map((n: string) => {
          const parts = n.split(/\s+as\s+/)
          const expName = parts[0].trim()
          const localName = (parts[1] || parts[0]).trim()
          return `var ${localName}=self.${globalName}.${expName}`
        })
        .join(';')
    } else {
      const localName = imp.binding.startsWith('*')
        ? imp.binding.split('as').pop()!.trim()
        : imp.binding
      varLine = `var ${localName}=(self.${globalName}&&self.${globalName}.default!==undefined?self.${globalName}.default:self.${globalName})`
    }

    bgContent = bgContent.replace(imp.full, `;${varLine}`)
  }

  // Fix import.meta.url — has no equivalent in a classic script.
  bgContent = bgContent.replace(
    /import\.meta\.url/g,
    '(typeof self!=="undefined"&&self.location?self.location.href:"")',
  )
  // Remove a trailing export{...}; (ES module re-export marker that breaks classic scripts).
  bgContent = bgContent.replace(/export\s*\{[^}]*\};?\s*$/, '')
  // Rename 'import'/'export' class fields and method calls that Chromium's
  // classic-script parser mis-parses as module import/export statements
  // (e.g. `import=async()=>{}` inside a class body).
  bgContent = bgContent.replace(/(?<![a-zA-Z0-9_$"'`])import=/g, '__crxImport=')
  bgContent = bgContent.replace(/\.import\(/g, '.__crxImport(')
  bgContent = bgContent.replace(/(?<![a-zA-Z0-9_$"'`])export=/g, '__crxExport=')
  bgContent = bgContent.replace(/\.export\(/g, '.__crxExport(')

  // Some extensions bundle their own WebExtension polyfill that snapshots
  // `self.browser` from `chrome.*` at one point in time. If a chrome.*
  // namespace the polyfill expects isn't fully populated yet when that
  // snapshot happens, `browser.<namespace>` ends up permanently missing even
  // though `chrome.<namespace>` exists. Intercepting the assignment lets us
  // backfill any namespace the polyfill left out, regardless of which
  // polyfill library the extension bundles.
  const browserNamespaceFallback =
    '(function(){var __crxBrowser;try{Object.defineProperty(self,"browser",{configurable:true,' +
    'get:function(){return __crxBrowser},' +
    'set:function(v){if(v&&typeof v==="object"&&typeof chrome==="object"){for(var k in chrome){if(!(k in v)){try{v[k]=chrome[k]}catch(e){}}}}__crxBrowser=v}' +
    '})}catch(e){}})();'

  bgContent =
    '/* __crx_patched */\n' + browserNamespaceFallback + hoistedImportScripts.join('') + bgContent

  await fs.writeFile(swPath, bgContent, 'utf-8')

  /*
    Any ES module syntax left in a file this patch rewrote means the conversion did not hold — the
    import forms it handles are `;import <binding> from "..."`, so an import at the very start of a
    file, a side-effect-only `import "..."`, or an import nested one level deeper all survive it.
    Chromium then throws "Cannot use import statement outside a module" at the first line of the
    worker and registration fails with status 15, i.e. the extension is dead rather than degraded.
    Put the originals back and leave the manifest alone: unpatched is the documented fallback.
  */
  const moduleSyntax = /(^|[;}\n])\s*(import[\s{*"']|export[\s{])/
  const unconverted: string[] = []
  for (const filePath of originals.keys()) {
    try {
      const written = await fs.readFile(filePath, 'utf-8')
      if (moduleSyntax.test(written.replace('/* __crx_patched */', ''))) unconverted.push(filePath)
    } catch {
      // Cannot verify it; treat as converted rather than rolling back a file we cannot read.
    }
  }
  if (unconverted.length > 0) {
    for (const [filePath, content] of originals) await fs.writeFile(filePath, content, 'utf-8')
    console.error(
      `electron-chrome-extensions: patchModuleServiceWorker could not convert ${manifest.name} ` +
        `${manifest.version} to a classic service worker (ES module syntax remains in ` +
        `${unconverted.join(', ')}); restored the originals and left it unpatched`,
    )
    return
  }

  // Remove "type": "module" so Electron loads the service worker as a classic script.
  const patchedManifest = JSON.parse(manifestText)
  delete patchedManifest.background.type
  await fs.writeFile(manifestPath, JSON.stringify(patchedManifest), 'utf-8')

  d(`done patching ${manifest.name}`)
}
