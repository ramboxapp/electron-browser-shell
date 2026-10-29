import { expect } from 'chai'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import * as cp from 'node:child_process'
import * as path from 'node:path'
const exec = promisify(cp.exec)

import { useExtensionBrowser, useServer } from './hooks'
import { getExtensionId } from './crx-helpers'

// TODO: build crxtesthost on Linux (see script/native-messaging-host/build.js)
if (process.platform !== 'linux') {
  describe('nativeMessaging', () => {
    const server = useServer()
    const browser = useExtensionBrowser({
      url: server.getUrl,
      extensionName: 'rpc',
    })
    const hostApplication = 'com.crx.test'

    before(async function () {
      this.timeout(60e3)
      const extensionId = await getExtensionId('rpc')
      const nativeMessagingPath = path.join(__dirname, '..', 'script', 'native-messaging-host')
      const buildScript = path.join(nativeMessagingPath, 'build.js')
      await exec(`node ${buildScript} ${extensionId}`)
    })

    describe('sendNativeMessage()', () => {
      it('sends and receives primitive value', async () => {
        const value = randomUUID()
        const result = await browser.crx.exec('runtime.sendNativeMessage', hostApplication, value)
        expect(result).to.equal(value)
      })

      it('sends and receives object', async () => {
        const value = { json: randomUUID(), wow: 'nice' }
        const result = await browser.crx.exec('runtime.sendNativeMessage', hostApplication, value)
        expect(result).to.deep.equal(value)
      })

      /*
        The length prefix of the protocol counts bytes. Framing by `string.length` — UTF-16 code
        units — truncated every message with a character outside ASCII, which is any vault entry
        with an accent in it, and the host parsed a cut JSON or desynchronised on the leftover.
      */
      it('round-trips a message with multi-byte characters', async () => {
        const value = { nombre: 'contraseña única — ñandú 🦜', items: ['café', '日本語'] }
        const result = await browser.crx.exec('runtime.sendNativeMessage', hostApplication, value)
        expect(result).to.deep.equal(value)
      })

      /*
        A host answers through a pipe, which hands over 64 KB at a time: a reply larger than that
        arrives in several 'data' chunks, and reading each chunk as a whole message threw on the
        first one. A vault listing is far larger than 64 KB.
      */
      it('round-trips a message larger than a pipe chunk', async function () {
        this.timeout(20e3)
        const value = { blob: 'x'.repeat(300 * 1024), tail: randomUUID() }
        const result = await browser.crx.exec('runtime.sendNativeMessage', hostApplication, value)
        expect(result).to.deep.equal(value)
      })
    })
  })
}
