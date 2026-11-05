/*
  The sandboxed FileSystem API (`webkitRequestFileSystem`, TEMPORARY and PERSISTENT) for the pages
  of an extension, over IndexedDB.

  Chromium grants the sandboxed FileSystem — and OPFS, which rides on the same backend — only to
  http(s) and to the schemes the embedder lists in `GetAdditionalAllowedSchemesForFileSystem`.
  Chrome lists `chrome-extension` there; Electron lists only the schemes the app registers as
  standard (and registering `chrome-extension` from the app breaks the extension bindings). So in
  Electron every `chrome-extension://` page gets `SecurityError` ("certain files are unsafe for
  access…") from both APIs, measured on 05/11/2026 in 43 and 44.10.1 without this library, while
  Edge 156 answers all of it. Awesome Screenshot's recorder saves each recording through this API
  and Office Editing dies on it with `file_opened_in_incognito_mode_error`.

  This runs in the main world of the extension's pages (its frames and offscreen documents; a
  worker has no `window`). It probes the native API once per page and steps aside when it works,
  so the day Electron allows the scheme the shim retires on its own; until then it answers with
  Chrome's shapes, measured in Edge 156 on 05/11/2026 with a probe extension: the fs name, the
  entry objects, `toURL()` and `webkitResolveLocalFileSystemURL`, path resolution, the
  `DOMException` of every failure, the `FileWriter` with its position, events and state errors,
  `seek`, `truncate`, `abort`, and the two separate trees. The storage is one IndexedDB per
  extension origin: a record per entry and the bytes as ordered chunks, so a recorder's appends
  cost one chunk each and `file()` is a `File` composed of them without copying.

  A `filesystem:` URL of this tree also works where a page puts one: the `src` of a media, image
  or source element and the `href` of an anchor (Awesome Screenshot's video page plays
  `<video src={entry.toURL()}>`, as Chrome allows). Electron never hands those URLs to anyone
  (`protocol.handle('filesystem')` registers and sees nothing, measured on 44.10.1), so the
  property setters and `setAttribute` of those elements swap in a blob URL of the file and keep
  answering the URL the page set.

  Not covered: OPFS (`navigator.storage.getDirectory`), which no catalog extension uses, and the
  quota API, which Electron already answers. A file written here is not visible to the native
  FileSystem once Electron allows it.

  This function is serialised into the main world (`contextBridge.executeInMainWorld`), so it must
  be self-contained: no reference to module scope, no class fields (esbuild lowers those with a
  module-level helper).
*/
export function installFileSystemShim(extensionId: string): void {
  const w = globalThis as any
  if (typeof w.webkitRequestFileSystem !== 'function') return
  const nativeRequest: Function = w.webkitRequestFileSystem
  const nativeResolve: Function | undefined = w.webkitResolveLocalFileSystemURL
  const TEMPORARY = 0
  const PERSISTENT = 1
  const INIT = 0
  const WRITING = 1
  const DONE = 2
  const DB_NAME = 'electron-chrome-extensions:filesystem'

  const MESSAGES: Record<string, [string, string]> = {
    NotFound: [
      'NotFoundError',
      'A requested file or directory could not be found at the time an operation was processed.',
    ],
    Security: [
      'SecurityError',
      'It was determined that certain files are unsafe for access within a Web application, or that too many calls are being made on file resources.',
    ],
    TypeMismatch: [
      'TypeMismatchError',
      'The path supplied exists, but was not an entry of requested type.',
    ],
    Exists: [
      'InvalidModificationError',
      'An attempt was made to create a file or directory where an element already exists.',
    ],
    Modification: ['InvalidModificationError', 'The object can not be modified in this way.'],
    State: [
      'InvalidStateError',
      'An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.',
    ],
    Abort: ['AbortError', 'An ongoing operation was aborted, typically with a call to abort().'],
    Encoding: [
      'EncodingError',
      'A URI supplied to the API was malformed, or the resulting Data URL has exceeded the URL length limitations for Data URLs.',
    ],
  }
  const fail = (kind: string): DOMException =>
    new DOMException(MESSAGES[kind][1], MESSAGES[kind][0])
  /** Any failure as the DOMException the API hands out; IndexedDB's own (quota, abort) pass through. */
  const asDOMException = (error: unknown): DOMException =>
    error instanceof DOMException ? error : new DOMException(String(error), 'InvalidStateError')
  const callback = (fn: unknown, ...args: unknown[]) => {
    if (typeof fn !== 'function') return
    try {
      fn(...args)
    } catch (error) {
      setTimeout(() => {
        throw error
      })
    }
  }
  const tagged = (proto: object, tag: string) =>
    Object.defineProperty(proto, Symbol.toStringTag, { value: tag, configurable: true })

  /* ---------- the native API: used when it works, which it does not in Electron today ---------- */

  let nativeDecision: Promise<boolean> | undefined
  const nativeWorks = (): Promise<boolean> => {
    if (!nativeDecision) {
      nativeDecision = new Promise<boolean>((resolve) => {
        try {
          nativeRequest.call(
            w,
            TEMPORARY,
            0,
            () => resolve(true),
            // Any failure but the scheme block is the native API answering, so it stays in charge.
            (error: any) => resolve(!(error && error.name === 'SecurityError')),
          )
        } catch {
          resolve(false)
        }
      })
    }
    return nativeDecision
  }

  /* ---------- storage ---------- */

  interface EntryRecord {
    key: string
    type: number
    path: string
    parent: string | null
    name: string
    isFile: boolean
    size: number
    modified: number
    chunks: number
  }
  interface ChunkRecord {
    key: string
    index: number
    offset: number
    size: number
    blob: Blob
  }

  const keyOf = (type: number, path: string) => `${type}:${path}`
  const request = <T>(req: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })

  let dbPromise: Promise<IDBDatabase> | undefined
  const openDb = (): Promise<IDBDatabase> => {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => {
          const db = req.result
          const entries = db.createObjectStore('entries', { keyPath: 'key' })
          entries.createIndex('parent', ['type', 'parent'])
          db.createObjectStore('chunks', { keyPath: ['key', 'index'] })
        }
        req.onsuccess = () => {
          const db = req.result
          db.onversionchange = () => db.close()
          // A database of this name that something else created (an `indexedDB.open` without a
          // version makes an empty one) has no stores: start over, or every call fails from here on.
          if (!db.objectStoreNames.contains('entries') || !db.objectStoreNames.contains('chunks')) {
            db.close()
            const wipe = indexedDB.deleteDatabase(DB_NAME)
            wipe.onsuccess = () => {
              dbPromise = undefined
              openDb().then(resolve, reject)
            }
            wipe.onerror = () => reject(wipe.error)
            return
          }
          resolve(db)
        }
        req.onerror = () => reject(req.error)
      })
      dbPromise.catch(() => {
        dbPromise = undefined
      })
    }
    return dbPromise
  }

  interface Stores {
    entries: IDBObjectStore
    chunks: IDBObjectStore
    tx: IDBTransaction
  }
  /** One transaction over both stores; `run` must keep it busy (no awaits on anything else). */
  const transact = async <T>(
    mode: IDBTransactionMode,
    run: (stores: Stores) => Promise<T>,
    onTransaction?: (tx: IDBTransaction) => void,
  ): Promise<T> => {
    const db = await openDb()
    const tx = db.transaction(['entries', 'chunks'], mode)
    onTransaction?.(tx)
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error || fail('Abort'))
    })
    let result: T
    try {
      result = await run({
        entries: tx.objectStore('entries'),
        chunks: tx.objectStore('chunks'),
        tx,
      })
    } catch (error) {
      completed.catch(() => {})
      try {
        tx.abort()
      } catch {
        // already finished
      }
      throw error
    }
    await completed
    return result
  }

  const rootRecord = (type: number): EntryRecord => ({
    key: keyOf(type, '/'),
    type,
    path: '/',
    parent: null,
    name: '',
    isFile: false,
    size: 0,
    modified: Date.now(),
    chunks: 0,
  })
  const getRecord = async (
    entries: IDBObjectStore,
    type: number,
    path: string,
  ): Promise<EntryRecord | undefined> =>
    path === '/' ? rootRecord(type) : request(entries.get(keyOf(type, path)))
  const chunkRange = (key: string) => IDBKeyRange.bound([key, 0], [key, Infinity])
  const chunksOf = (chunks: IDBObjectStore, key: string): Promise<ChunkRecord[]> =>
    request(chunks.getAll(chunkRange(key)))
  const childrenOf = (
    entries: IDBObjectStore,
    type: number,
    path: string,
  ): Promise<EntryRecord[]> => request(entries.index('parent').getAll([type, path]))
  const replaceBytes = async (stores: Stores, record: EntryRecord, blob: Blob) => {
    await request(stores.chunks.delete(chunkRange(record.key)))
    if (blob.size > 0) {
      await request(
        stores.chunks.put({ key: record.key, index: 0, offset: 0, size: blob.size, blob }),
      )
    }
    record.size = blob.size
    record.chunks = blob.size > 0 ? 1 : 0
    record.modified = Date.now()
    await request(stores.entries.put(record))
  }
  /** Every record under a directory, deepest first, the directory itself last. */
  const subtree = async (entries: IDBObjectStore, record: EntryRecord): Promise<EntryRecord[]> => {
    const out: EntryRecord[] = []
    const walk = async (dir: EntryRecord) => {
      for (const child of await childrenOf(entries, dir.type, dir.path)) {
        if (!child.isFile) await walk(child)
        out.push(child)
      }
    }
    await walk(record)
    out.push(record)
    return out
  }
  const deleteRecord = async (stores: Stores, record: EntryRecord) => {
    await request(stores.chunks.delete(chunkRange(record.key)))
    await request(stores.entries.delete(record.key))
  }

  /* ---------- paths and URLs ---------- */

  const parentOf = (path: string) =>
    path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/'
  const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1)
  /** The absolute path `relative` names from `base`; `null` for a path Chrome refuses. */
  const resolvePath = (base: string, relative: unknown): string | null => {
    const text = String(relative)
    if (text === '') return null
    const segments = text.startsWith('/') ? [] : base.split('/').filter(Boolean)
    for (const segment of text.split('/')) {
      if (segment === '' || segment === '.') continue
      if (segment === '..') {
        segments.pop()
        continue
      }
      segments.push(segment)
    }
    return '/' + segments.join('/')
  }
  const typeName = (type: number) => (type === PERSISTENT ? 'persistent' : 'temporary')
  const urlBase = `filesystem:chrome-extension://${extensionId}/`
  const toURL = (type: number, path: string) =>
    urlBase + typeName(type) + path.split('/').map(encodeURIComponent).join('/')
  const fromURL = (url: unknown): { type: number; path: string } | null => {
    const text = String(url)
    if (!text.startsWith(urlBase)) return null
    const rest = text.slice(urlBase.length)
    const slash = rest.indexOf('/')
    const kind = slash === -1 ? rest : rest.slice(0, slash)
    const type = kind === 'persistent' ? PERSISTENT : kind === 'temporary' ? TEMPORARY : -1
    if (type === -1) return null
    try {
      const path = resolvePath(
        '/',
        (slash === -1 ? '' : rest.slice(slash)).split('/').map(decodeURIComponent).join('/'),
      )
      return { type, path: path ?? '/' }
    } catch {
      return null
    }
  }

  /* ---------- filesystem: URLs where a page puts them ---------- */

  const MIME: Record<string, string> = {
    mp4: 'video/mp4',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    m4a: 'audio/mp4',
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    wav: 'audio/wav',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    json: 'application/json',
    pdf: 'application/pdf',
  }
  const mimeOf = (name: string) => MIME[name.slice(name.lastIndexOf('.') + 1).toLowerCase()] ?? ''
  const isOwnUrl = (value: unknown): value is string =>
    typeof value === 'string' && value.startsWith(urlBase)
  /** Blob URL per filesystem: URL, for this page; dropped when the shim itself changes the file. */
  const blobUrls = new Map<string, Promise<string | null>>()
  const blobUrlFor = (url: string): Promise<string | null> => {
    let pending = blobUrls.get(url)
    if (!pending) {
      const created: Promise<string | null> = (async () => {
        const parsed = fromURL(url)
        if (!parsed) return null
        const file = await transact('readonly', async ({ entries, chunks }) => {
          const record = await getRecord(entries, parsed.type, parsed.path)
          if (!record || !record.isFile) throw fail('NotFound')
          const parts = await chunksOf(chunks, record.key)
          return new File(
            parts.map((chunk) => chunk.blob),
            record.name,
            { lastModified: record.modified, type: mimeOf(record.name) },
          )
        })
        return URL.createObjectURL(file)
      })().catch(() => null)
      created.then((value) => {
        if (value === null && blobUrls.get(url) === created) blobUrls.delete(url)
      })
      blobUrls.set(url, created)
      pending = created
    }
    return pending
  }
  const forgetUrl = (type: number, path: string) => {
    blobUrls.delete(toURL(type, path))
  }
  const takeOwnUrls = () => {
    if (typeof Element === 'undefined') return
    const given = new WeakMap<object, string>()
    const hijack = (proto: any, attr: 'src' | 'href') => {
      const native = Object.getOwnPropertyDescriptor(proto, attr)
      if (!native || !native.get || !native.set) return
      const read = native.get
      const assign = native.set
      Object.defineProperty(proto, attr, {
        configurable: true,
        enumerable: native.enumerable,
        get() {
          const ours = given.get(this)
          return ours !== undefined ? ours : read.call(this)
        },
        set(value) {
          if (!isOwnUrl(value)) {
            given.delete(this)
            assign.call(this, value)
            return
          }
          given.set(this, value)
          blobUrlFor(value).then((blob) => {
            if (given.get(this) !== value) return
            assign.call(this, blob ?? value)
          })
        },
      })
    }
    const sources: Array<[any, 'src' | 'href']> = [
      [w.HTMLMediaElement, 'src'],
      [w.HTMLImageElement, 'src'],
      [w.HTMLSourceElement, 'src'],
      [w.HTMLAnchorElement, 'href'],
    ]
    for (const [ctor, attr] of sources) if (ctor) hijack(ctor.prototype, attr)
    const takes = (element: any, attr: string): boolean =>
      (attr === 'src' &&
        (element instanceof w.HTMLMediaElement ||
          element instanceof w.HTMLImageElement ||
          element instanceof w.HTMLSourceElement)) ||
      (attr === 'href' && element instanceof w.HTMLAnchorElement)
    const setAttribute = Element.prototype.setAttribute
    Element.prototype.setAttribute = function (this: any, name: string, value: string) {
      const attr = String(name).toLowerCase()
      if (takes(this, attr)) {
        if (isOwnUrl(value)) {
          this[attr] = value
          return
        }
        given.delete(this)
      }
      return setAttribute.call(this, name, value)
    }
    const removeAttribute = Element.prototype.removeAttribute
    Element.prototype.removeAttribute = function (this: any, name: string) {
      if (takes(this, String(name).toLowerCase())) given.delete(this)
      return removeAttribute.call(this, name)
    }
  }

  /* ---------- the objects ---------- */

  class DOMFileSystem {
    name!: string
    root!: DirectoryEntry
    _type!: number
    constructor(type: number) {
      this._type = type
      this.name = `chrome-extension_${extensionId}_0:${type === PERSISTENT ? 'Persistent' : 'Temporary'}`
      this.root = new DirectoryEntry(this, '/')
    }
  }
  tagged(DOMFileSystem.prototype, 'DOMFileSystem')

  class Metadata {
    modificationTime!: Date
    size!: number
    constructor(record: EntryRecord) {
      this.modificationTime = new Date(record.modified)
      this.size = record.size
    }
  }
  tagged(Metadata.prototype, 'Metadata')

  class Entry {
    filesystem!: DOMFileSystem
    fullPath!: string
    name!: string
    isFile!: boolean
    isDirectory!: boolean
    constructor(filesystem: DOMFileSystem, path: string, isFile: boolean) {
      this.filesystem = filesystem
      this.fullPath = path
      this.name = nameOf(path)
      this.isFile = isFile
      this.isDirectory = !isFile
    }
    get _type() {
      return this.filesystem._type
    }
    get _key() {
      return keyOf(this._type, this.fullPath)
    }
    _entryFor(record: EntryRecord): Entry {
      return record.isFile
        ? new FileEntry(this.filesystem, record.path)
        : new DirectoryEntry(this.filesystem, record.path)
    }
    _run(ok: unknown, err: unknown, work: () => Promise<unknown>) {
      work().then(
        (value) => callback(ok, value),
        (error) => callback(err, asDOMException(error)),
      )
    }
    toURL(): string {
      return toURL(this._type, this.fullPath)
    }
    getMetadata(ok?: unknown, err?: unknown) {
      this._run(ok, err, () =>
        transact('readonly', async ({ entries }) => {
          const record = await getRecord(entries, this._type, this.fullPath)
          if (!record) throw fail('NotFound')
          return new Metadata(record)
        }),
      )
    }
    getParent(ok?: unknown, err?: unknown) {
      this._run(
        ok,
        err,
        async () => new DirectoryEntry(this.filesystem, parentOf(this.fullPath) ?? '/'),
      )
    }
    remove(ok?: unknown, err?: unknown) {
      this._run(ok, err, () =>
        transact('readwrite', async (stores) => {
          if (this.fullPath === '/') throw fail('Modification')
          const record = await getRecord(stores.entries, this._type, this.fullPath)
          if (!record) throw fail('NotFound')
          if (
            !record.isFile &&
            (await childrenOf(stores.entries, this._type, this.fullPath)).length
          )
            throw fail('Modification')
          await deleteRecord(stores, record)
          forgetUrl(this._type, this.fullPath)
        }),
      )
    }
    /** moveTo / copyTo: the subtree is re-keyed under the destination; chunk blobs are shared references. */
    _transfer(move: boolean, parent: unknown, newName: unknown, ok: unknown, err: unknown) {
      this._run(ok, err, () =>
        transact('readwrite', async (stores) => {
          if (!(parent instanceof DirectoryEntry)) throw fail('TypeMismatch')
          if (this.fullPath === '/') throw fail('Modification')
          const name = newName == null || newName === '' ? this.name : String(newName)
          const target = resolvePath(parent.fullPath, name)
          if (!target || target === '/' || nameOf(target) !== name) throw fail('Modification')
          const source = await getRecord(stores.entries, this._type, this.fullPath)
          if (!source) throw fail('NotFound')
          const destinationParent = await getRecord(stores.entries, parent._type, parent.fullPath)
          if (!destinationParent || destinationParent.isFile) throw fail('NotFound')
          if (target === this.fullPath && parent._type === this._type) {
            if (move) throw fail('Modification')
          }
          if (
            !source.isFile &&
            (target + '/').startsWith(this.fullPath + '/') &&
            parent._type === this._type
          )
            throw fail('Modification')
          const existing = await getRecord(stores.entries, parent._type, target)
          if (existing) {
            if (existing.isFile !== source.isFile) throw fail('Modification')
            if (!existing.isFile && (await childrenOf(stores.entries, parent._type, target)).length)
              throw fail('Modification')
            await deleteRecord(stores, existing)
          }
          const records = await subtree(stores.entries, source)
          for (const record of records) {
            forgetUrl(record.type, record.path)
            const relative = record.path.slice(this.fullPath.length)
            const path = target + relative
            const copy: EntryRecord = {
              ...record,
              key: keyOf(parent._type, path),
              type: parent._type,
              path,
              parent: parentOf(path),
              name: nameOf(path),
              modified: Date.now(),
            }
            const chunks = record.isFile ? await chunksOf(stores.chunks, record.key) : []
            if (move) await deleteRecord(stores, record)
            await request(stores.entries.put(copy))
            forgetUrl(copy.type, copy.path)
            for (const chunk of chunks)
              await request(stores.chunks.put({ ...chunk, key: copy.key }))
          }
          return source.isFile
            ? new FileEntry(parent.filesystem, target)
            : new DirectoryEntry(parent.filesystem, target)
        }),
      )
    }
    moveTo(parent: unknown, newName?: unknown, ok?: unknown, err?: unknown) {
      this._transfer(true, parent, newName, ok, err)
    }
    copyTo(parent: unknown, newName?: unknown, ok?: unknown, err?: unknown) {
      this._transfer(false, parent, newName, ok, err)
    }
  }

  class DirectoryEntry extends Entry {
    constructor(filesystem: DOMFileSystem, path: string) {
      super(filesystem, path, false)
    }
    _lookup(path: unknown, options: any, wantFile: boolean, ok: unknown, err: unknown) {
      this._run(ok, err, () =>
        transact('readwrite', async ({ entries }) => {
          const full = resolvePath(this.fullPath, path)
          if (full === null) throw fail('Security')
          const create = !!(options && options.create)
          const exclusive = !!(options && options.exclusive)
          const record = await getRecord(entries, this._type, full)
          if (record) {
            if (record.isFile !== wantFile) throw fail('TypeMismatch')
            if (create && exclusive) throw fail('Exists')
            return this._entryFor(record)
          }
          if (!create) throw fail('NotFound')
          const parent = await getRecord(entries, this._type, parentOf(full) ?? '/')
          if (!parent) throw fail('NotFound')
          if (parent.isFile) throw fail('TypeMismatch')
          const fresh: EntryRecord = {
            key: keyOf(this._type, full),
            type: this._type,
            path: full,
            parent: parent.path,
            name: nameOf(full),
            isFile: wantFile,
            size: 0,
            modified: Date.now(),
            chunks: 0,
          }
          await request(entries.put(fresh))
          return this._entryFor(fresh)
        }),
      )
    }
    getFile(path: unknown, options?: unknown, ok?: unknown, err?: unknown) {
      this._lookup(path, options, true, ok, err)
    }
    getDirectory(path: unknown, options?: unknown, ok?: unknown, err?: unknown) {
      this._lookup(path, options, false, ok, err)
    }
    createReader(): DirectoryReader {
      return new DirectoryReader(this)
    }
    removeRecursively(ok?: unknown, err?: unknown) {
      this._run(ok, err, () =>
        transact('readwrite', async (stores) => {
          if (this.fullPath === '/') throw fail('Modification')
          const record = await getRecord(stores.entries, this._type, this.fullPath)
          if (!record) throw fail('NotFound')
          for (const each of await subtree(stores.entries, record)) {
            await deleteRecord(stores, each)
            forgetUrl(each.type, each.path)
          }
        }),
      )
    }
  }
  tagged(DirectoryEntry.prototype, 'DirectoryEntry')

  class DirectoryReader {
    _directory!: DirectoryEntry
    _done!: boolean
    constructor(directory: DirectoryEntry) {
      this._directory = directory
      this._done = false
    }
    readEntries(ok?: unknown, err?: unknown) {
      const directory = this._directory
      directory._run(ok, err, () =>
        transact('readonly', async ({ entries }) => {
          if (this._done) return []
          this._done = true
          const record = await getRecord(entries, directory._type, directory.fullPath)
          if (!record) throw fail('NotFound')
          const children = await childrenOf(entries, directory._type, directory.fullPath)
          return children.map((child) => directory._entryFor(child))
        }),
      )
    }
  }
  tagged(DirectoryReader.prototype, 'DirectoryReader')

  class FileEntry extends Entry {
    constructor(filesystem: DOMFileSystem, path: string) {
      super(filesystem, path, true)
    }
    file(ok?: unknown, err?: unknown) {
      this._run(ok, err, () =>
        transact('readonly', async ({ entries, chunks }) => {
          const record = await getRecord(entries, this._type, this.fullPath)
          if (!record) throw fail('NotFound')
          if (!record.isFile) throw fail('TypeMismatch')
          const parts = await chunksOf(chunks, this._key)
          return new File(
            parts.map((chunk) => chunk.blob),
            this.name,
            { lastModified: record.modified },
          )
        }),
      )
    }
    createWriter(ok?: unknown, err?: unknown) {
      this._run(ok, err, () =>
        transact('readonly', async ({ entries }) => {
          const record = await getRecord(entries, this._type, this.fullPath)
          if (!record) throw fail('NotFound')
          if (!record.isFile) throw fail('TypeMismatch')
          return new FileWriter(this, record.size)
        }),
      )
    }
  }
  tagged(FileEntry.prototype, 'FileEntry')

  /*
    The writer. `write` and `truncate` run one transaction each; `position` and `length` are the
    writer's own view, as in Chrome, where two writers on one file do not see each other's moves.
    Events are ProgressEvents: `writestart` synchronously inside the call (Chrome does), the rest
    once the transaction settled, so a handler assigned right after calling `write()` is in place.
  */
  const WRITER_EVENTS = ['writestart', 'progress', 'write', 'abort', 'error', 'writeend']
  class FileWriter extends EventTarget {
    _entry!: FileEntry
    _position!: number
    _length!: number
    _readyState!: number
    _error!: DOMException | null
    _tx!: IDBTransaction | null
    _aborted!: boolean
    constructor(entry: FileEntry, length: number) {
      super()
      this._entry = entry
      this._position = 0
      this._length = length
      this._readyState = INIT
      this._error = null
      this._tx = null
      this._aborted = false
      // The on<event> handlers, as listeners: they run with the event's target set, like Chrome's.
      for (const name of WRITER_EVENTS) {
        this.addEventListener(name, (event) => {
          const handler = (this as any)['on' + name]
          if (typeof handler === 'function') handler.call(this, event)
        })
      }
    }
    get position() {
      return this._position
    }
    get length() {
      return this._length
    }
    get readyState() {
      return this._readyState
    }
    get error() {
      return this._error
    }
    _fire(type: string, loaded: number, total: number) {
      this.dispatchEvent(new ProgressEvent(type, { lengthComputable: true, loaded, total }))
    }
    _begin(method: string, total: number, operation: (stores: Stores) => Promise<void>) {
      if (this._readyState === WRITING) {
        this._error = fail('State')
        throw new DOMException(
          `Failed to execute '${method}' on 'FileWriter': ${MESSAGES.State[1]}`,
          MESSAGES.State[0],
        )
      }
      this._readyState = WRITING
      this._error = null
      this._aborted = false
      this._fire('writestart', 0, total)
      // An abort() before the transaction opened, or while it ran, commits nothing.
      const guarded = async (stores: Stores) => {
        if (this._aborted) throw fail('Abort')
        await operation(stores)
        if (this._aborted) throw fail('Abort')
      }
      transact('readwrite', guarded, (tx) => {
        this._tx = tx
      }).then(
        () => {
          this._tx = null
          this._readyState = DONE
          forgetUrl(this._entry._type, this._entry.fullPath)
          this._fire('progress', total, total)
          this._fire('write', total, total)
          this._fire('writeend', total, total)
        },
        (error) => {
          this._tx = null
          this._readyState = DONE
          this._error = this._aborted ? fail('Abort') : asDOMException(error)
          this._fire(this._aborted ? 'abort' : 'error', 0, total)
          this._fire('writeend', 0, total)
        },
      )
    }
    write(...args: unknown[]) {
      if (args.length === 0)
        throw new TypeError(
          "Failed to execute 'write' on 'FileWriter': 1 argument required, but only 0 present.",
        )
      const blob = args[0]
      if (!(blob instanceof Blob))
        throw new TypeError(
          "Failed to execute 'write' on 'FileWriter': parameter 1 is not of type 'Blob'.",
        )
      const start = this._position
      this._begin('write', blob.size, async (stores) => {
        const record = await getRecord(stores.entries, this._entry._type, this._entry.fullPath)
        if (!record || !record.isFile) throw fail('NotFound')
        if (start === record.size) {
          // The recorder's path: one more chunk at the end.
          await request(
            stores.chunks.put({
              key: record.key,
              index: record.chunks,
              offset: start,
              size: blob.size,
              blob,
            }),
          )
          record.size += blob.size
          record.chunks += 1
          record.modified = Date.now()
          await request(stores.entries.put(record))
        } else {
          const current = new Blob(
            (await chunksOf(stores.chunks, record.key)).map((chunk) => chunk.blob),
          )
          const parts: BlobPart[] = [current.slice(0, Math.min(start, current.size))]
          if (start > current.size) parts.push(new Uint8Array(start - current.size))
          parts.push(blob)
          if (start + blob.size < current.size) parts.push(current.slice(start + blob.size))
          await replaceBytes(stores, record, new Blob(parts))
        }
        this._position = start + blob.size
        this._length = record.size
      })
    }
    truncate(size: unknown) {
      const target = Math.max(0, Math.floor(Number(size)) || 0)
      this._begin('truncate', 0, async (stores) => {
        const record = await getRecord(stores.entries, this._entry._type, this._entry.fullPath)
        if (!record || !record.isFile) throw fail('NotFound')
        if (target !== record.size) {
          const current = new Blob(
            (await chunksOf(stores.chunks, record.key)).map((chunk) => chunk.blob),
          )
          const next =
            target < current.size
              ? current.slice(0, target)
              : new Blob([current, new Uint8Array(target - current.size)])
          await replaceBytes(stores, record, next)
        }
        this._length = target
        if (this._position > target) this._position = target
      })
    }
    seek(offset: unknown) {
      if (this._readyState === WRITING) throw fail('State')
      let position = Math.floor(Number(offset)) || 0
      if (position < 0) position = this._length + position
      this._position = Math.min(Math.max(position, 0), this._length)
    }
    abort() {
      if (this._readyState !== WRITING) {
        this._error = fail('Abort')
        this._readyState = DONE
        return
      }
      this._aborted = true
      try {
        this._tx?.abort()
      } catch {
        // the transaction already settled; the write completes
      }
    }
  }
  for (const name of WRITER_EVENTS) {
    const slot = Symbol(name)
    Object.defineProperty(FileWriter.prototype, 'on' + name, {
      get() {
        return (this as any)[slot] ?? null
      },
      set(value) {
        ;(this as any)[slot] = typeof value === 'function' ? value : null
      },
      configurable: true,
      enumerable: true,
    })
  }
  Object.defineProperties(FileWriter.prototype, {
    INIT: { value: INIT, enumerable: true },
    WRITING: { value: WRITING, enumerable: true },
    DONE: { value: DONE, enumerable: true },
  })
  tagged(FileWriter.prototype, 'FileWriter')

  /* ---------- the entry points ---------- */

  const requestFileSystem = function (this: unknown, ...args: unknown[]) {
    if (args.length < 3)
      throw new TypeError(
        `Failed to execute 'webkitRequestFileSystem' on 'Window': 3 arguments required, but only ${args.length} present.`,
      )
    const [type, size, ok, err] = args
    nativeWorks().then((works) => {
      if (works) return nativeRequest.call(w, type, size, ok, err)
      if (type !== TEMPORARY && type !== PERSISTENT) return callback(err, fail('Modification'))
      callback(ok, new DOMFileSystem(type))
    })
  }
  const resolveLocalFileSystemURL = function (this: unknown, ...args: unknown[]) {
    if (args.length < 2)
      throw new TypeError(
        `Failed to execute 'webkitResolveLocalFileSystemURL' on 'Window': 2 arguments required, but only ${args.length} present.`,
      )
    const [url, ok, err] = args
    nativeWorks().then((works) => {
      if (works && nativeResolve) return nativeResolve.call(w, url, ok, err)
      const parsed = fromURL(url)
      if (!parsed) return callback(err, fail('Encoding'))
      transact('readonly', async ({ entries }) => {
        const record = await getRecord(entries, parsed.type, parsed.path)
        if (!record) throw fail('NotFound')
        return new DOMFileSystem(parsed.type).root._entryFor(record)
      }).then(
        (entry) => callback(ok, entry),
        (error) => callback(err, asDOMException(error)),
      )
    })
  }
  const define = (name: string, value: unknown) =>
    Object.defineProperty(w, name, { value, writable: true, configurable: true, enumerable: true })
  define('webkitRequestFileSystem', requestFileSystem)
  define('webkitResolveLocalFileSystemURL', resolveLocalFileSystemURL)
  // The element layer only when the shim answers: a native tree's URLs load on their own.
  nativeWorks().then((works) => {
    if (!works) takeOwnUrls()
  })
}
