import { expect } from 'chai'
import * as path from 'node:path'
import { session } from 'electron'
import { ElectronChromeExtensions } from '../'

describe('Extensions', () => {
  const testSession = session.fromPartition('test-extensions')
  const extensions = new ElectronChromeExtensions({
    license: 'internal-license-do-not-use' as any,
    session: testSession,
  })

  it('retrieves the instance with fromSession()', () => {
    expect(ElectronChromeExtensions.fromSession(testSession)).to.equal(extensions)
  })

  /*
    An explicit modulePath has to win over resolving this package from node_modules. Rambox bundles
    its main process from a local checkout of this library while node_modules still holds the
    published build; resolving first handed the extension contexts the PUBLISHED preload while the
    browser side ran the checkout, so every fix in the preload looked like it did nothing.
  */
  it('registers the preload from modulePath when one is given', () => {
    const modulePath = path.join(__dirname, 'fixtures', 'fake-module-path')
    const modulePathSession = session.fromPartition('test-extensions-module-path')
    new ElectronChromeExtensions({
      license: 'internal-license-do-not-use' as any,
      session: modulePathSession,
      modulePath,
    })
    const registered = (modulePathSession.getPreloadScripts?.() ?? []).map(
      (script) => script.filePath,
    )
    expect(registered).to.not.be.empty
    for (const filePath of registered) {
      expect(filePath).to.equal(path.join(modulePath, 'dist', 'chrome-extension-api.preload.js'))
    }
  })

  it('throws when two instances are created for session', () => {
    expect(() => {
      new ElectronChromeExtensions({
        license: 'internal-license-do-not-use' as any,
        session: testSession,
      })
    }).to.throw()
  })
})
