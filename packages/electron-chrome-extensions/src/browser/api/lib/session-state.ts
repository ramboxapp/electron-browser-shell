import * as fs from 'node:fs'
import * as path from 'node:path'

/**
 * A small JSON file in the session's own storage folder, for state Chrome keeps in its profile and
 * Electron keeps nowhere: which version of each extension this session has seen (what
 * `runtime.onInstalled` is computed from) and the context menu items of lazy backgrounds.
 *
 * In-memory sessions (no `storagePath`) keep it in memory only, which is what Chrome does for a
 * profile that is not written to disk.
 *
 * Writes are debounced and synchronous when they land: the files are a few KB, and an extension that
 * rebuilds its menu on every tab switch (Bitwarden does) would otherwise queue a write per switch.
 */
export class SessionStateFile<T extends object> {
  private value: T | undefined
  private timer: NodeJS.Timeout | undefined
  private readonly filePath: string | undefined

  constructor(
    session: Electron.Session,
    name: string,
    private readonly fallback: () => T,
    private readonly delayMs = 250,
  ) {
    const storagePath = session.storagePath
    this.filePath = storagePath
      ? path.join(storagePath, 'electron-chrome-extensions', `${name}.json`)
      : undefined
  }

  /** Whether the file existed on disk when it was first read — false on a session's first run. */
  existedOnDisk = false

  get(): T {
    if (this.value) return this.value
    this.value = this.fallback()
    if (!this.filePath) return this.value
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      this.value = { ...this.value, ...JSON.parse(raw) }
      this.existedOnDisk = true
    } catch {
      // Missing or unreadable: start from the fallback. A corrupt file is not worth failing a load over.
    }
    return this.value!
  }

  set(value: T) {
    this.value = value
    this.schedule()
  }

  /** Writes now instead of after the debounce. */
  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    if (!this.filePath || !this.value) return
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.value))
    } catch (error) {
      console.error(`electron-chrome-extensions: could not write ${this.filePath}`, error)
    }
  }

  private schedule() {
    if (!this.filePath) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.flush(), this.delayMs)
    // A pending write must not keep the process alive on quit.
    this.timer.unref?.()
  }
}
