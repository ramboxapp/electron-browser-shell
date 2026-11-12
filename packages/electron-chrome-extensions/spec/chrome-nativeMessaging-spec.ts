/// <reference path="../src/browser/deps.d.ts" />
import { expect } from 'chai'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import * as cp from 'node:child_process'
import * as path from 'node:path'
const exec = promisify(cp.exec)

import { WebContentsView } from 'electron'

import { useExtensionBrowser, useServer } from './hooks'
import { getExtensionId } from './crx-helpers'
import {
  WINDOWS_HOST_LOOKUP_ORDER,
  windowsManifestPaths,
} from '../src/browser/api/lib/native-messaging-host'
import { readRegistryKey } from '../src/browser/api/lib/winreg'

/*
  Where the host's manifest is looked up on Windows, against a fake registry: no desktop app of the
  catalog is installed on a test machine, and HKLM cannot be written without elevation. Chrome
  (native_process_launcher_win.cc) asks HKCU before HKLM, and the 32-bit view before the 64-bit one;
  a 64-bit app that does not ask for the 32-bit view never sees HKLM\Software\WOW6432Node.
*/
describe('nativeMessaging host lookup on Windows', () => {
  const key = (application: string) =>
    `Software\\Google\\Chrome\\NativeMessagingHosts\\${application}`
  const fakeRegistry =
    (entries: Record<string, string>) =>
    async (hive: string, path: string, _value?: string, view?: 32 | 64) =>
      entries[`${hive}/${view}/${path}`] ?? null

  it("asks Chrome's order: HKCU then HKLM, the 32-bit view first", () => {
    expect(WINDOWS_HOST_LOOKUP_ORDER).to.deep.equal([
      { hive: 'HKCU', view: 32 },
      { hive: 'HKCU', view: 64 },
      { hive: 'HKLM', view: 32 },
      { hive: 'HKLM', view: 64 },
    ])
  })

  it('finds a host a 32-bit installer registered under WOW6432Node', async () => {
    const read = fakeRegistry({ [`HKLM/32/${key('com.vendor.host')}`]: 'C:\\x86\\host.json' })
    expect(await windowsManifestPaths('com.vendor.host', read)).to.deep.equal([
      'C:\\x86\\host.json',
    ])
  })

  it('prefers the user-level registration and drops repeats', async () => {
    const read = fakeRegistry({
      [`HKCU/32/${key('com.vendor.host')}`]: 'C:\\user\\host.json',
      [`HKCU/64/${key('com.vendor.host')}`]: 'C:\\user\\host.json',
      [`HKLM/64/${key('com.vendor.host')}`]: 'C:\\machine\\host.json',
    })
    expect(await windowsManifestPaths('com.vendor.host', read)).to.deep.equal([
      'C:\\user\\host.json',
      'C:\\machine\\host.json',
    ])
  })

  it('answers nothing for a host no view has, and survives a failing read', async () => {
    const read = async () => {
      throw new Error('ERROR: The system was unable to find the specified registry key or value.')
    }
    expect(await windowsManifestPaths('com.vendor.missing', read)).to.deep.equal([])
  })
})

/** How many test host processes are running right now. */
const countHostProcesses = async (): Promise<number> => {
  if (process.platform === 'win32') {
    const { stdout } = await exec('tasklist /FI "IMAGENAME eq crxtesthost.exe" /NH /FO CSV')
    return stdout.split(/\r?\n/).filter((line) => line.includes('crxtesthost.exe')).length
  }
  try {
    const { stdout } = await exec('pgrep -x crxtesthost')
    return stdout.split('\n').filter(Boolean).length
  } catch {
    return 0 // pgrep exits 1 when nothing matches
  }
}

/** Polls until the host count settles at `expected`, or answers the last count it saw. */
const waitForHostCount = async (expected: number, timeoutMs = 5000): Promise<number> => {
  const end = Date.now() + timeoutMs
  let count = await countHostProcesses()
  while (count !== expected && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 200))
    count = await countHostProcesses()
  }
  return count
}

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

    if (process.platform === 'win32') {
      // The real registry: the build script registers the test host under HKCU, which both views see.
      it('finds the registered test host through the real reg, once', async () => {
        const paths = await windowsManifestPaths(hostApplication)
        expect(paths).to.have.lengthOf(1)
        expect(paths[0]).to.match(/com\.crx\.test\.json$/)
        const hostKey = `Software\\Google\\Chrome\\NativeMessagingHosts\\${hostApplication}`
        expect(await readRegistryKey('HKCU', hostKey, undefined, 32)).to.equal(paths[0])
        expect(await readRegistryKey('HKCU', hostKey, undefined, 64)).to.equal(paths[0])
      })
    }

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

      /*
        The host answered and the process stayed, one more per call, for the life of the app: a
        host that does not exit on its own (any real desktop app) piled up behind every
        sendNativeMessage. Chrome closes it after the response.
      */
      it('ends the host process after the response', async function () {
        this.timeout(20e3)
        const before = await countHostProcesses()
        const value = { __stayOpen: true, id: randomUUID() }
        const result = await browser.crx.exec('runtime.sendNativeMessage', hostApplication, value)
        expect(result).to.deep.equal(value)
        expect(await waitForHostCount(before)).to.equal(before)
      })
    })

    describe('connectNative()', () => {
      /*
        A port belongs to the context that opened it: Chrome closes it, and the host, when the page
        goes away. Nothing watched the page here, so the process outlived it and a later event sent
        to the dead WebContents threw in the main process.
      */
      it('ends the host process when the page that opened the port closes', async function () {
        this.timeout(20e3)
        const before = await countHostProcesses()
        const view = new WebContentsView({ webPreferences: { session: browser.session } })
        try {
          await view.webContents.loadURL(`chrome-extension://${browser.extension.id}/popup.html`)
          const echoed = await view.webContents.executeJavaScript(`new Promise((resolve) => {
            const port = chrome.runtime.connectNative('${hostApplication}')
            window.__port = port
            port.onMessage.addListener((message) => resolve(message))
            port.postMessage({ __stayOpen: true, hello: 'port' })
          })`)
          expect(echoed).to.deep.equal({ __stayOpen: true, hello: 'port' })
          expect(await countHostProcesses()).to.equal(before + 1)
        } finally {
          view.webContents.close()
        }
        expect(await waitForHostCount(before)).to.equal(before)
      })

      it('ends the host process on disconnect()', async function () {
        this.timeout(20e3)
        const before = await countHostProcesses()
        const view = new WebContentsView({ webPreferences: { session: browser.session } })
        try {
          await view.webContents.loadURL(`chrome-extension://${browser.extension.id}/popup.html`)
          await view.webContents.executeJavaScript(`new Promise((resolve) => {
            const port = chrome.runtime.connectNative('${hostApplication}')
            port.onMessage.addListener(() => { port.disconnect(); resolve() })
            port.postMessage({ __stayOpen: true })
          })`)
          expect(await waitForHostCount(before)).to.equal(before)
        } finally {
          view.webContents.close()
        }
      })
    })
  })
}
