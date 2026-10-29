import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { app } from 'electron'
import debug from 'debug'
import { ExtensionSender, IpcEvent } from '../../router'
import { readRegistryKey } from './winreg'

const d = debug('electron-chrome-extensions:nativeMessaging')

interface NativeConfig {
  name: string
  description: string
  path: string
  type: 'stdio'
  allowed_origins: string[]
}

function isValidConfig(config: any): config is NativeConfig {
  return (
    typeof config === 'object' &&
    config !== null &&
    typeof config.name === 'string' &&
    typeof config.description === 'string' &&
    typeof config.path === 'string' &&
    config.type === 'stdio' &&
    Array.isArray(config.allowed_origins)
  )
}

async function getConfigSearchPaths(application: string) {
  const appJson = `${application}.json`
  let searchPaths: string[]
  switch (process.platform) {
    case 'darwin':
      searchPaths = [
        path.join('/Library/Google/Chrome/NativeMessagingHosts', appJson),
        // Also look under Chrome's directory since some apps only install their
        // config there
        path.join(
          os.homedir(),
          'Library',
          'Application Support',
          'Google/Chrome/NativeMessagingHosts',
          appJson,
        ),
        path.join(app.getPath('userData'), 'NativeMessagingHosts', appJson),
      ]
      break
    case 'linux':
      searchPaths = [
        path.join('/etc/opt/chrome/native-messaging-hosts/', appJson),
        path.join(os.homedir(), '.config/google-chrome/NativeMessagingHosts/', appJson),
        path.join(app.getPath('userData'), 'NativeMessagingHosts', appJson),
      ]
      break
    case 'win32': {
      searchPaths = (
        await Promise.allSettled([
          readRegistryKey('HKLM', `Software\\Google\\Chrome\\NativeMessagingHosts\\${application}`),
          readRegistryKey('HKCU', `Software\\Google\\Chrome\\NativeMessagingHosts\\${application}`),
        ])
      )
        .map((result) => (result.status === 'fulfilled' ? result.value : undefined))
        .filter(Boolean) as string[]
      break
    }
    default:
      throw new Error('Unsupported platform')
  }
  return searchPaths
}

async function readNativeMessagingHostConfig(
  application: string,
): Promise<NativeConfig | undefined> {
  const searchPaths = await getConfigSearchPaths(application)
  d('searching', searchPaths)
  for (const filePath of searchPaths) {
    try {
      const data = await fs.readFile(filePath)
      const config = JSON.parse(data.toString())
      if (isValidConfig(config)) {
        d('read config in %s', filePath, config)
        // Chrome reads a relative `path` against the manifest's own folder (on Windows; elsewhere it
        // must be absolute). Windows' Microsoft Single Sign On host ships "path": "BrowserCore.exe"
        // next to its manifest; resolved against the app's working directory it failed to start.
        if (!path.isAbsolute(config.path)) {
          config.path = path.resolve(path.dirname(filePath), config.path)
        }
        return config
      } else {
        d('%s contained invalid config', filePath, config)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        d('unable to read %s', filePath)
      } else {
        d('unknown error', error)
      }
      continue
    }
  }
}
export class NativeMessagingHost {
  // Chromium's own wording for each way a native host connection ends (native_message_process_host
  // and the messaging service); extensions match on these strings.
  static readonly NOT_FOUND = 'Specified native messaging host not found.'
  static readonly FORBIDDEN = 'Access to the specified native messaging host is forbidden.'
  static readonly FAILED_TO_START = 'Failed to start native messaging host.'
  static readonly EXITED = 'Native host has exited.'

  private process?: ReturnType<typeof spawn>
  private sender?: ExtensionSender
  private connectionId: string
  private connected: boolean = false
  private pending?: any[]
  private keepAlive: boolean
  private resolveResponse?: (message: any) => void
  private rejectResponse?: (error: Error) => void

  /** Why the host is gone, in Chrome's words, once it is. */
  failure?: string

  ready?: Promise<void>

  constructor(
    extensionId: string,
    sender: ExtensionSender,
    connectionId: string,
    application: string,
    keepAlive: boolean = true,
  ) {
    this.keepAlive = keepAlive
    this.sender = sender
    if (keepAlive) {
      this.sender.ipc.on(`crx-native-msg-${connectionId}`, this.receiveExtensionMessage)
    }
    this.connectionId = connectionId
    this.ready = this.launch(application, extensionId)
  }

  /**
   * Ends the connection. `reason` is the `chrome.runtime.lastError` message Chrome gives the port
   * for that end — the extension tells a missing desktop app from a forbidden one or from one that
   * quit by it. None when the extension itself disconnected: Chrome fires nothing then.
   */
  destroy(reason?: string) {
    if (reason && !this.failure) this.failure = reason
    this.connected = false
    if (reason && this.rejectResponse) {
      this.rejectResponse(new Error(reason))
      this.rejectResponse = undefined
      this.resolveResponse = undefined
    }
    if (this.process) {
      this.process.kill()
      this.process = undefined
    }
    if (this.keepAlive && this.sender) {
      this.sender.ipc.off(`crx-native-msg-${this.connectionId}`, this.receiveExtensionMessage)
      this.sender.send(`crx-native-msg-${this.connectionId}-disconnect`, reason)
    }
    this.sender = undefined
  }

  private async launch(application: string, extensionId: string) {
    const config = await readNativeMessagingHostConfig(application)
    if (!config) {
      d('launch: unable to find %s for %s', application, extensionId)
      this.destroy(NativeMessagingHost.NOT_FOUND)
      return
    }

    const extensionUrl = `chrome-extension://${extensionId}/`
    if (!config.allowed_origins?.includes(extensionUrl)) {
      d('launch: %s not in allowed origins', extensionId)
      this.destroy(NativeMessagingHost.FORBIDDEN)
      return
    }

    let isFile = false
    try {
      const stat = await fs.stat(config.path)
      isFile = stat.isFile()
    } catch (error) {
      d('launch: unable to find %s', config.path, error)
    }

    if (!isFile) {
      this.destroy(NativeMessagingHost.FAILED_TO_START)
      return
    }

    d('launch: spawning %s for %s', config.path, extensionId)
    this.process = spawn(config.path, [extensionUrl], {
      shell: false,
    })

    this.process.stdout!.on('data', this.receive)
    this.process.stderr!.on('data', (data) => {
      d('stderr: %s', data.toString())
    })
    this.process.on('error', (err) => {
      d('error: %s', err)
      this.destroy(NativeMessagingHost.FAILED_TO_START)
    })
    this.process.on('exit', (code) => {
      d('exited %d', code)
      this.destroy(NativeMessagingHost.EXITED)
    })

    this.connected = true

    if (this.pending && this.pending.length > 0) {
      d('sending %d pending messages', this.pending.length)
      this.pending.forEach((msg) => this.send(msg))
      this.pending = []
    }
  }

  private receiveExtensionMessage = (_event: IpcEvent, message: any) => {
    this.send(message)
  }

  /**
   * Chrome refuses to send a host more than 1 MB, and to accept more than 64 MB from one
   * (native_message_process_host.cc). The outbound limit is enforced below; the inbound one bounds
   * the buffer so a host that writes garbage cannot grow it without end.
   */
  static readonly MAX_MESSAGE_TO_HOST = 1024 * 1024
  static readonly MAX_MESSAGE_FROM_HOST = 64 * 1024 * 1024

  private send(json: any) {
    d('send', json)

    if (!this.connected) {
      const pending = this.pending || (this.pending = [])
      pending.push(json)
      d('send: pending')
      return
    }

    const message = JSON.stringify(json)
    /*
      The length prefix counts BYTES of UTF-8, which is what the host reads. This used `message.length`
      — UTF-16 code units — so a message with any character outside ASCII (a password manager's vault
      item in Spanish, say) went out with a prefix smaller than its body and a body cut short: the host
      parsed truncated JSON, or desynchronised on the leftover bytes.
    */
    const byteLength = Buffer.byteLength(message, 'utf8')
    if (byteLength > NativeMessagingHost.MAX_MESSAGE_TO_HOST) {
      d('send: message of %d bytes exceeds the 1 MB limit, dropping it', byteLength)
      return
    }
    const buffer = Buffer.alloc(4 + byteLength)
    buffer.writeUInt32LE(byteLength, 0)
    buffer.write(message, 4, 'utf8')
    this.process!.stdin!.write(buffer)
  }

  /** What stdout has delivered and no complete message has consumed yet. */
  private inbound: Buffer = Buffer.alloc(0)

  /*
    stdout is a stream, not a sequence of messages. A 'data' chunk can hold part of a message (a pipe
    hands over 64 KB at a time, and 1Password answers with far more than that when it lists a vault),
    or several messages at once when the host writes quickly. This used to parse each chunk as exactly
    one whole message, so the first case threw inside the 'data' handler and the second lost every
    message after the first. Everything is buffered and as many complete messages as the buffer
    holds are dispatched, which is how Chrome reads a host.
  */
  private receive = (data: Buffer) => {
    this.inbound = this.inbound.length ? Buffer.concat([this.inbound, data]) : data
    while (this.inbound.length >= 4) {
      const length = this.inbound.readUInt32LE(0)
      if (length > NativeMessagingHost.MAX_MESSAGE_FROM_HOST) {
        d('receive: host announced a %d byte message, closing', length)
        this.destroy(NativeMessagingHost.EXITED)
        return
      }
      if (this.inbound.length < 4 + length) return
      const body = this.inbound.subarray(4, 4 + length).toString('utf8')
      this.inbound = this.inbound.subarray(4 + length)
      let message: any
      try {
        message = JSON.parse(body)
      } catch (error) {
        d('receive: host sent invalid JSON, closing: %o', error)
        this.destroy(NativeMessagingHost.EXITED)
        return
      }
      this.dispatch(message)
    }
  }

  private dispatch(message: any) {
    d('receive: %s', message)
    if (this.keepAlive && this.sender) {
      this.sender.send(`crx-native-msg-${this.connectionId}`, message)
    } else {
      this.resolveResponse?.(message)
      this.resolveResponse = undefined
      this.rejectResponse = undefined
    }
  }

  sendAndReceive(message: any) {
    // A host that never started answers nothing: fail now instead of waiting forever, which is what
    // sendNativeMessage to a host that is not installed used to do.
    if (this.failure) return Promise.reject(new Error(this.failure))
    this.send(message)
    return new Promise((resolve, reject) => {
      this.resolveResponse = resolve
      this.rejectResponse = reject
    })
  }
}
