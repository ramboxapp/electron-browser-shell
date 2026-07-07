import { spawn } from 'child_process'
import debug from 'debug'

const d = debug('electron-chrome-extensions:winreg')

export function readRegistryKey(hive: string, path: string, key?: string) {
  if (process.platform !== 'win32') {
    return Promise.reject('Unsupported platform')
  }

  return new Promise<string | null>((resolve, reject) => {
    // '/ve' explicitly queries the default value when no key name is given.
    const args = ['query', `${hive}\\${path}`, ...(key ? ['/v', key] : ['/ve'])]
    d('reg %s', args.join(' '))
    const child = spawn('reg', args)

    let output = ''
    let error = ''

    child.stdout.on('data', (data) => {
      output += data.toString()
    })

    child.stderr.on('data', (data) => {
      error += data.toString()
    })

    child.on('close', (code) => {
      if (code !== 0 || error) {
        return reject(new Error(`Failed to read registry: ${error}`))
      }

      const lines = output.trim().split(/\r?\n/)
      // Match on the value type token; the default value's display name is
      // localized (e.g. "(Predeterminado)" on Spanish Windows) so it can't be
      // matched by name.
      const resultLine = key
        ? lines.find((line) => line.includes(key))
        : lines.find((line) => /\sREG_\w+/.test(line))

      const match = resultLine?.match(/\sREG_\w+\s+(.*)$/)
      resolve(match ? match[1].trim() : null)
    })
  })
}
