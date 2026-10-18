import { expect } from 'chai'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { patchModuleServiceWorker } from '../'

/**
 * The rewrite that turns a `"type": "module"` service worker into a classic script.
 *
 * Two behaviours matter and both were learned the hard way against Rambox's extension catalog:
 * on an Electron that registers module service workers natively the patch must not run at all, and
 * when it does run it must never leave a half-converted script behind. uBlock 25.5.0 was dead in
 * Rambox for exactly that reason — the conversion left real `import` statements in a file Electron
 * then loaded as classic, so the worker never registered and the ad blocker did nothing.
 */
describe('module service worker patch', () => {
  let dir: string

  const writeExtension = async (serviceWorker: string, files: Record<string, string> = {}) => {
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        name: 'module-sw',
        version: '1.0',
        manifest_version: 3,
        background: { service_worker: 'sw.js', type: 'module' },
      }),
    )
    await fs.writeFile(path.join(dir, 'sw.js'), serviceWorker)
    for (const [name, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true })
      await fs.writeFile(path.join(dir, name), content)
    }
  }

  const readManifest = async () => JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8'))

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crx-module-sw-'))
  })

  afterEach(async () => {
    delete process.env.CRX_FORCE_MODULE_SW_PATCH
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('leaves a module service worker alone on an Electron that supports one', async () => {
    const original = 'import { thing } from "./vendor.js";\nconsole.log(thing)\n'
    await writeExtension(original, { 'vendor.js': 'export const thing = 1\n' })

    await patchModuleServiceWorker(dir)

    // Electron 43+ registers module service workers itself, and converting uBlock's import graph
    // breaks it, so the correct behaviour here is to touch nothing.
    expect(await fs.readFile(path.join(dir, 'sw.js'), 'utf-8')).to.equal(original)
    expect((await readManifest()).background.type).to.equal('module')
  })

  it('converts a service worker whose imports it can express', async () => {
    process.env.CRX_FORCE_MODULE_SW_PATCH = '1'
    await writeExtension(';import { thing } from "./vendor.js";console.log(thing)', {
      'vendor.js': 'const thing = 1;export{thing}',
    })

    await patchModuleServiceWorker(dir)

    const patched = await fs.readFile(path.join(dir, 'sw.js'), 'utf-8')
    expect(patched).to.contain('/* __crx_patched */')
    expect(patched).to.contain('importScripts("./vendor.js")')
    expect(patched).to.not.match(/(^|[;}\n])\s*import[\s{*"']/)
    expect((await readManifest()).background.type).to.equal(undefined)
  })

  it('restores the originals when ES module syntax survives the conversion', async () => {
    process.env.CRX_FORCE_MODULE_SW_PATCH = '1'
    // uBlock's shape: a side-effect-only import, and the first import at offset 0 with no `;` before
    // it. Neither form is matched by the rewriter, so the file would stay a module in a classic
    // script — "Uncaught SyntaxError: Cannot use import statement outside a module".
    const original = 'import"./sentry.js";import{a as b}from"./api.js";console.log(b)'
    await writeExtension(original, { 'sentry.js': 'self.x = 1\n', 'api.js': 'const a = 1;export{a}' })

    await patchModuleServiceWorker(dir)

    expect(await fs.readFile(path.join(dir, 'sw.js'), 'utf-8')).to.equal(original)
    // The manifest must keep "type": "module" too: unpatched is the documented fallback, and a
    // module script declared as classic is worse than no patch at all.
    expect((await readManifest()).background.type).to.equal('module')
    // Imported files are put back as they were, not left rewritten against a worker that is not.
    expect(await fs.readFile(path.join(dir, 'api.js'), 'utf-8')).to.equal('const a = 1;export{a}')
  })

  it('is a no-op for an extension that is not a module service worker', async () => {
    process.env.CRX_FORCE_MODULE_SW_PATCH = '1'
    await fs.writeFile(
      path.join(dir, 'manifest.json'),
      JSON.stringify({
        name: 'classic-sw',
        version: '1.0',
        manifest_version: 3,
        background: { service_worker: 'sw.js' },
      }),
    )
    await fs.writeFile(path.join(dir, 'sw.js'), 'console.log(1)')

    await patchModuleServiceWorker(dir)

    expect(await fs.readFile(path.join(dir, 'sw.js'), 'utf-8')).to.equal('console.log(1)')
  })

  it('never throws on a nonexistent path', async () => {
    await patchModuleServiceWorker(path.join(dir, 'does-not-exist'))
  })
})
