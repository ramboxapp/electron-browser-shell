import { expect } from 'chai'
import { promisify } from 'node:util'
import * as cp from 'node:child_process'
import * as path from 'node:path'
import * as fs from 'node:fs'

import { useExtensionBrowser, useServer } from './hooks'
import { getExtensionId } from './crx-helpers'

const exec = promisify(cp.exec)

/*
  `chrome.runtime.lastError` reaches the extension, and so do the errors of a native port.

  The preload replaces `chrome.runtime` with `{ ...base, ... }`. Chromium defines `lastError` on ITS
  runtime object only while one of its callbacks runs, so the spread never carried it, and on the
  replacement `chrome.runtime.lastError` was always undefined: a failed callback-style call read as
  a success. Chromium, whose getter was never reached, also logged "Unchecked runtime.lastError" for
  every caller that did check — RoboForm 10.0.2.0 left 11 to 18 "Could not establish connection.
  Receiving end does not exist." per boot that way, one per broadcast to a popup that was not open.

  The native port is the preload's own JavaScript, so it gets lastError from the preload. Measured in
  Edge 156 against a host that is not installed: onDisconnect is called with the port and lastError
  "Specified native messaging host not found."; a port's own disconnect() does not fire it.
*/
describe('chrome.runtime.lastError', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  it('is readable inside a callback Chromium failed, and cleared after it', async () => {
    const result = await browser.crx.raw({ type: 'last-error-in-callback' })
    expect(result.lastError, 'runtime.lastError inside the failed callback').to.be.a('string')
    expect(result.lastError).to.match(/Receiving end does not exist/)
    expect(result.afterCallback).to.equal('undefined')
  })

  describe('a native port to a host that is not installed', () => {
    it('calls onDisconnect with the port, with lastError set', async () => {
      const result = await browser.crx.raw({ type: 'native-port-missing-host' })
      expect(result.timedOut, 'onDisconnect never fired').to.not.equal(true)
      expect(result.argIsPort, 'onDisconnect was not called with the port').to.equal(true)
      expect(result.lastError).to.equal('Specified native messaging host not found.')
    })

    it('does not fire onDisconnect for its own disconnect()', async () => {
      const result = await browser.crx.raw({ type: 'native-port-own-disconnect' })
      expect(result.fired).to.equal(false)
    })
  })

  /*
    Why the port closed comes from the main process now, in Chromium's words. The preload used to
    infer it — "not found" for any port that never heard from its host — so a host that is installed
    but does not list the extension in allowed_origins read as not installed, and the extension told
    its user to install a desktop app they already had.
  */
  describe('the reason a native port closed', () => {
    before(async function () {
      if (process.platform === 'linux') return this.skip()
      this.timeout(60e3)
      // Installs com.crx.test for the 'rpc' fixture only (as chrome-nativeMessaging-spec does), so
      // for rpc-mv3 the host is there and forbidden.
      const rpcId = await getExtensionId('rpc')
      const build = path.join(__dirname, '..', 'script', 'native-messaging-host', 'build.js')
      await exec(`node ${build} ${rpcId}`)
    })

    it('is "forbidden" for a host whose allowed_origins leave the extension out', async () => {
      const result = await browser.crx.raw({
        type: 'native-port-missing-host',
        application: 'com.crx.test',
      })
      expect(result.timedOut, 'onDisconnect never fired').to.not.equal(true)
      expect(result.lastError).to.equal(
        'Access to the specified native messaging host is forbidden.',
      )
    })

    /*
      A host manifest may give `path` relative to the manifest's own folder, and Windows' own
      Microsoft Single Sign On host does exactly that (C:\Windows\BrowserCore\manifest.json:
      "path": "BrowserCore.exe"). It was resolved against the app's working directory, so the host
      "failed to start" in Rambox while Chrome runs it (measured on 28/10/2026 from the extension's
      own worker in the app).
    */
    it('runs a host whose manifest gives a path relative to the manifest', async function () {
      if (process.platform !== 'win32') return this.skip()
      const hostDir = path.join(__dirname, '..', 'script', 'native-messaging-host')
      const hostName = 'com.crx.test.relative'
      const manifestPath = path.join(hostDir, `${hostName}.json`)
      const registryKey = [
        'HKCU',
        'Software',
        'Google',
        'Chrome',
        'NativeMessagingHosts',
        hostName,
      ].join('\\')
      try {
        fs.writeFileSync(
          manifestPath,
          JSON.stringify({
            name: hostName,
            description: 'relative path',
            path: 'crxtesthost.exe',
            type: 'stdio',
            allowed_origins: [`chrome-extension://${browser.extension.id}/`],
          }),
        )
        await exec(`reg add "${registryKey}" /ve /t REG_SZ /d "${manifestPath}" /f`)
        const result: any = await browser.crx.raw({
          type: 'send-native-message',
          application: hostName,
        })
        expect(result.lastError).to.equal(null)
        expect(result.response).to.deep.equal({ ping: true })
      } finally {
        await exec(`reg delete "${registryKey}" /f`).catch(() => {})
        fs.rmSync(manifestPath, { force: true })
      }
    })

    it('lets sendNativeMessage to a missing host finish instead of hanging', async () => {
      const outcome = await Promise.race([
        browser.crx
          .raw({ type: 'send-native-message', application: 'com.crx.host.that.is.not.installed' })
          .then((value: any) => ({ answered: true, value })),
        new Promise((resolve) => setTimeout(resolve, 5000, { answered: false })),
      ])
      expect((outcome as any).answered, 'sendNativeMessage never called back').to.equal(true)
    })
  })

  /*
    An error thrown by a handler in the main process used to vanish in the preload: the promise form
    resolved undefined and the callback ran with lastError unset, so no extension could tell a failed
    call from an empty answer. Chrome rejects the promise with the message and, for a callback, sets
    lastError for the callback's duration and clears it after.
  */
  describe('an error of the main process', () => {
    it('rejects the promise form with the message, and sets lastError for the callback form', async () => {
      const result = await browser.crx.raw({ type: 'main-process-error-shapes' })
      expect(result.promise).to.equal('rejected: No current offscreen document.')
      expect(result.callback.during).to.equal('No current offscreen document.')
      expect(result.callback.argCount, 'the failed callback is called with no result').to.equal(0)
      expect(result.callback.after).to.equal('undefined')
    })
  })
})
