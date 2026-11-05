/*
  Measures the sandboxed FileSystem API (webkitRequestFileSystem) as this browser answers it from a
  chrome-extension:// page: shapes, URLs, writer semantics, errors. `window.__probe()` returns a
  JSON-able record. Every step is isolated so one failure does not hide the next.
*/
;(() => {
  const tag = (v) => Object.prototype.toString.call(v)
  const err = (e) =>
    e == null
      ? null
      : {
          tag: tag(e),
          ctor: e && e.constructor && e.constructor.name,
          name: e && e.name,
          code: e && e.code,
          message: e && e.message,
          isDOMException: typeof DOMException !== 'undefined' && e instanceof DOMException,
        }
  const cb = (fn) =>
    new Promise((resolve, reject) => {
      try {
        fn(resolve, reject)
      } catch (e) {
        reject({ sync: true, ...err(e) })
      }
    })
  const attempt = async (fn) => {
    try {
      return { ok: await fn() }
    } catch (e) {
      return { error: e && e.sync ? e : err(e) }
    }
  }
  const text = (blob) => new Response(blob).text()
  const describeEntry = (e) => ({
    tag: tag(e),
    ctor: e.constructor && e.constructor.name,
    isFile: e.isFile,
    isDirectory: e.isDirectory,
    name: e.name,
    fullPath: e.fullPath,
    url: typeof e.toURL === 'function' ? e.toURL() : undefined,
    filesystemName: e.filesystem && e.filesystem.name,
    keys: Object.keys(e),
    proto: Object.getOwnPropertyNames(Object.getPrototypeOf(e)).sort(),
  })
  const writeAndWait = (writer, blob) =>
    new Promise((resolve, reject) => {
      const events = []
      const seen = (ev) =>
        events.push({
          type: ev.type,
          tag: tag(ev),
          loaded: ev.loaded,
          total: ev.total,
          lengthComputable: ev.lengthComputable,
          targetIsWriter: ev.target === writer,
          readyState: writer.readyState,
        })
      writer.onwritestart = seen
      writer.onprogress = seen
      writer.onwrite = seen
      writer.onabort = seen
      writer.onerror = (ev) => {
        seen(ev)
      }
      writer.onwriteend = (ev) => {
        seen(ev)
        resolve({
          events,
          position: writer.position,
          length: writer.length,
          readyState: writer.readyState,
          error: err(writer.error),
        })
      }
      try {
        const r = writer.write(blob)
        events.push({ sync: 'write returned', value: r, readyStateAfterCall: writer.readyState })
      } catch (e) {
        reject({ sync: true, ...err(e) })
      }
    })
  const truncateAndWait = (writer, size) =>
    new Promise((resolve, reject) => {
      writer.onwriteend = () =>
        resolve({ position: writer.position, length: writer.length, error: err(writer.error) })
      writer.onerror = () => {}
      try {
        writer.truncate(size)
      } catch (e) {
        reject({ sync: true, ...err(e) })
      }
    })

  window.__probe = async () => {
    const out = {}
    out.ua = navigator.userAgent
    out.globals = {
      webkitRequestFileSystem: typeof window.webkitRequestFileSystem,
      requestFileSystem: typeof window.requestFileSystem,
      webkitResolveLocalFileSystemURL: typeof window.webkitResolveLocalFileSystemURL,
      TEMPORARY: window.TEMPORARY,
      PERSISTENT: window.PERSISTENT,
      FileError: typeof window.FileError,
      FileWriter: typeof window.FileWriter,
      DOMFileSystem: typeof window.DOMFileSystem,
      FileSystemFileEntry: typeof window.FileSystemFileEntry,
      FileSystemDirectoryEntry: typeof window.FileSystemDirectoryEntry,
      FileSystemDirectoryReader: typeof window.FileSystemDirectoryReader,
      webkitPersistentStorage: typeof navigator.webkitPersistentStorage,
      webkitTemporaryStorage: typeof navigator.webkitTemporaryStorage,
      storageGetDirectory: typeof (navigator.storage && navigator.storage.getDirectory),
      requestFileSystemOwnProp: Object.getOwnPropertyDescriptor(window, 'webkitRequestFileSystem')
        ? 'own'
        : 'proto',
    }
    out.opfs = await attempt(async () => {
      const root = await navigator.storage.getDirectory()
      const fh = await root.getFileHandle('opfs-probe.txt', { create: true })
      const w = await fh.createWritable()
      await w.write('hello opfs')
      await w.close()
      const f = await fh.getFile()
      const t = await f.text()
      await root.removeEntry('opfs-probe.txt')
      return { kind: root.kind, name: root.name, text: t }
    })
    out.quota = {
      persistentRequest: await attempt(() =>
        cb((ok, bad) => navigator.webkitPersistentStorage.requestQuota(1024 * 1024, ok, bad)),
      ),
      persistentQuery: await attempt(() =>
        cb((ok, bad) =>
          navigator.webkitPersistentStorage.queryUsageAndQuota((u, q) => ok({ u, q }), bad),
        ),
      ),
      temporaryQuery: await attempt(() =>
        cb((ok, bad) =>
          navigator.webkitTemporaryStorage.queryUsageAndQuota((u, q) => ok({ u, q }), bad),
        ),
      ),
      estimate: await attempt(() => navigator.storage.estimate()),
    }
    out.badCalls = {
      noCallback: await attempt(() =>
        cb(() => window.webkitRequestFileSystem(window.PERSISTENT, 1024)),
      ),
      badType: await attempt(() =>
        cb((ok, bad) => window.webkitRequestFileSystem(7, 1024, ok, bad)),
      ),
      negativeSize: await attempt(() =>
        cb((ok, bad) => window.webkitRequestFileSystem(window.TEMPORARY, -1, ok, bad)),
      ),
    }

    for (const [label, type] of [
      ['persistent', window.PERSISTENT],
      ['temporary', window.TEMPORARY],
    ]) {
      const r = (out[label] = {})
      const fsRes = await attempt(() =>
        cb((ok, bad) => window.webkitRequestFileSystem(type, 50 * 1024 * 1024, ok, bad)),
      )
      r.request = fsRes.error ? fsRes : { ok: true }
      if (fsRes.error) continue
      const fs = fsRes.ok
      r.fs = {
        tag: tag(fs),
        ctor: fs.constructor.name,
        name: fs.name,
        keys: Object.keys(fs),
        proto: Object.getOwnPropertyNames(Object.getPrototypeOf(fs)).sort(),
        rootIsSame: fs.root === fs.root,
      }
      r.root = describeEntry(fs.root)
      r.rootFilesystemIsFs = fs.root.filesystem === fs
      // second request: same fs object?
      const fs2 = await cb((ok, bad) => window.webkitRequestFileSystem(type, 1, ok, bad))
      r.secondRequestSameObject = fs2 === fs
      r.secondRootSameObject = fs2.root === fs.root

      // clean slate
      await attempt(() =>
        cb((ok, bad) =>
          fs.root.getDirectory('videos', {}, (d) => d.removeRecursively(ok, bad), ok),
        ),
      )
      await attempt(() =>
        cb((ok, bad) => fs.root.getFile('top.txt', {}, (f) => f.remove(ok, bad), ok)),
      )

      r.missingFile = await attempt(() => cb((ok, bad) => fs.root.getFile('nope.txt', {}, ok, bad)))
      r.missingFileNoOpts = await attempt(() =>
        cb((ok, bad) => fs.root.getFile('nope.txt', undefined, ok, bad)),
      )
      r.missingDir = await attempt(() =>
        cb((ok, bad) => fs.root.getDirectory('nodir', {}, ok, bad)),
      )
      r.emptyName = await attempt(() =>
        cb((ok, bad) => fs.root.getFile('', { create: true }, ok, bad)),
      )
      r.dotName = await attempt(() =>
        cb((ok, bad) => fs.root.getFile('.', {}, (e) => ok(describeEntry(e)), bad)),
      )
      r.getDirDotDot = await attempt(() =>
        cb((ok, bad) => fs.root.getDirectory('..', {}, (e) => ok(describeEntry(e)), bad)),
      )
      r.rootGetParent = await attempt(() =>
        cb((ok, bad) => fs.root.getParent((e) => ok(describeEntry(e)), bad)),
      )
      r.rootRemove = await attempt(() => cb((ok, bad) => fs.root.remove(ok, bad)))
      r.rootMetadata = await attempt(() =>
        cb((ok, bad) =>
          fs.root.getMetadata(
            (m) =>
              ok({
                tag: tag(m),
                size: m.size,
                mtimeIsDate: m.modificationTime instanceof Date,
                mtime: m.modificationTime && m.modificationTime.getTime(),
              }),
            bad,
          ),
        ),
      )

      const dirRes = await attempt(() =>
        cb((ok, bad) => fs.root.getDirectory('videos', { create: true }, ok, bad)),
      )
      r.createDir = dirRes.error ? dirRes : describeEntry(dirRes.ok)
      if (dirRes.error) continue
      const dir = dirRes.ok
      r.dirAgainNoCreate = await attempt(() =>
        cb((ok, bad) => fs.root.getDirectory('videos', {}, (e) => ok(describeEntry(e)), bad)),
      )
      r.dirExclusiveExists = await attempt(() =>
        cb((ok, bad) => fs.root.getDirectory('videos', { create: true, exclusive: true }, ok, bad)),
      )
      r.getFileOnDir = await attempt(() => cb((ok, bad) => fs.root.getFile('videos', {}, ok, bad)))
      r.getFileOnDirCreate = await attempt(() =>
        cb((ok, bad) => fs.root.getFile('videos', { create: true }, ok, bad)),
      )
      r.getDirOnFileLater = null
      r.getFileOnDirTrailingSlash = await attempt(() =>
        cb((ok, bad) => fs.root.getDirectory('videos/', {}, (e) => ok(describeEntry(e)), bad)),
      )

      const fileRes = await attempt(() =>
        cb((ok, bad) => dir.getFile('123', { create: true }, ok, bad)),
      )
      r.createFile = fileRes.error ? fileRes : describeEntry(fileRes.ok)
      if (fileRes.error) continue
      const file = fileRes.ok
      r.fileAgainCreate = await attempt(() =>
        cb((ok, bad) =>
          dir.getFile(
            '123',
            { create: true },
            (e) => ok({ ...describeEntry(e), same: e === file }),
            bad,
          ),
        ),
      )
      r.fileExclusiveExists = await attempt(() =>
        cb((ok, bad) => dir.getFile('123', { create: true, exclusive: true }, ok, bad)),
      )
      r.fileViaRootRelative = await attempt(() =>
        cb((ok, bad) => fs.root.getFile('videos/123', {}, (e) => ok(describeEntry(e)), bad)),
      )
      r.fileViaRootAbsolute = await attempt(() =>
        cb((ok, bad) => fs.root.getFile('/videos/123', {}, (e) => ok(describeEntry(e)), bad)),
      )
      r.fileViaDirAbsolute = await attempt(() =>
        cb((ok, bad) => dir.getFile('/videos/123', {}, (e) => ok(describeEntry(e)), bad)),
      )
      r.fileViaDotDot = await attempt(() =>
        cb((ok, bad) => dir.getFile('../videos/./123', {}, (e) => ok(describeEntry(e)), bad)),
      )
      r.getDirOnFile = await attempt(() => cb((ok, bad) => dir.getDirectory('123', {}, ok, bad)))
      r.resolveURL = await attempt(() =>
        cb((ok, bad) =>
          window.webkitResolveLocalFileSystemURL(file.toURL(), (e) => ok(describeEntry(e)), bad),
        ),
      )
      r.resolveURLMissing = await attempt(() =>
        cb((ok, bad) => window.webkitResolveLocalFileSystemURL(file.toURL() + 'x', ok, bad)),
      )
      r.emptyFile = await attempt(() =>
        cb((ok, bad) =>
          file.file(
            (f) =>
              ok({
                tag: tag(f),
                name: f.name,
                size: f.size,
                type: f.type,
                lastModifiedNear: Math.abs(f.lastModified - Date.now()) < 60000,
                isFile: f instanceof File,
              }),
            bad,
          ),
        ),
      )
      r.fileMetadataEmpty = await attempt(() =>
        cb((ok, bad) =>
          file.getMetadata(
            (m) =>
              ok({ tag: tag(m), size: m.size, mtimeIsDate: m.modificationTime instanceof Date }),
            bad,
          ),
        ),
      )
      r.parent = await attempt(() =>
        cb((ok, bad) => file.getParent((e) => ok(describeEntry(e)), bad)),
      )

      const wRes = await attempt(() => cb((ok, bad) => file.createWriter(ok, bad)))
      r.createWriter = wRes.error
        ? wRes
        : (() => {
            const w = wRes.ok
            return {
              tag: tag(w),
              ctor: w.constructor.name,
              position: w.position,
              length: w.length,
              readyState: w.readyState,
              INIT: w.INIT,
              WRITING: w.WRITING,
              DONE: w.DONE,
              error: err(w.error),
              isEventTarget: w instanceof EventTarget,
              keys: Object.keys(w),
              proto: Object.getOwnPropertyNames(Object.getPrototypeOf(w)).sort(),
              protoProto: Object.getPrototypeOf(Object.getPrototypeOf(w)).constructor.name,
            }
          })()
      if (wRes.error) continue
      const w = wRes.ok
      r.write1 = await attempt(() => writeAndWait(w, new Blob(['hello'])))
      r.write2 = await attempt(() => writeAndWait(w, new Blob([' world'], { type: 'text/plain' })))
      r.afterTwoWrites = await attempt(() =>
        cb((ok, bad) =>
          file.file((f) => text(f).then((t) => ok({ text: t, size: f.size, type: f.type })), bad),
        ),
      )
      // write while writing
      r.writeWhileWriting = await attempt(async () => {
        const p = writeAndWait(w, new Blob(['!']))
        let second
        try {
          w.write(new Blob(['?']))
          second = 'no throw'
        } catch (e) {
          second = err(e)
        }
        const first = await p
        return { second, first }
      })
      r.seekThenWrite = await attempt(async () => {
        w.seek(0)
        const posAfterSeek = w.position
        const res = await writeAndWait(w, new Blob(['J']))
        const t = await cb((ok, bad) => file.file((f) => text(f).then(ok), bad))
        return { posAfterSeek, ...res, text: t }
      })
      r.seekBeyond = await attempt(async () => {
        w.seek(1000)
        return { position: w.position, length: w.length }
      })
      r.seekNegative = await attempt(async () => {
        w.seek(-3)
        return { position: w.position, length: w.length }
      })
      r.seekTooNegative = await attempt(async () => {
        w.seek(-1000)
        return { position: w.position, length: w.length }
      })
      r.truncateShorter = await attempt(async () => {
        w.seek(0)
        w.seek(w.length)
        const res = await truncateAndWait(w, 4)
        const t = await cb((ok, bad) => file.file((f) => text(f).then(ok), bad))
        return { ...res, text: t }
      })
      r.truncateLonger = await attempt(async () => {
        const res = await truncateAndWait(w, 8)
        const buf = await cb((ok, bad) =>
          file.file((f) => new Response(f).arrayBuffer().then(ok), bad),
        )
        return { ...res, bytes: Array.from(new Uint8Array(buf)) }
      })
      r.writeStringInsteadOfBlob = await attempt(() => writeAndWait(w, 'oops'))
      r.writeNothing = await attempt(() =>
        cb((ok, bad) => {
          try {
            ok({ returned: w.write(), readyState: w.readyState })
          } catch (e) {
            ok({ threw: err(e) })
          }
        }),
      )
      r.secondWriterSameFile = await attempt(async () => {
        const w2 = await cb((ok, bad) => file.createWriter(ok, bad))
        return { position: w2.position, length: w2.length, same: w2 === w }
      })
      r.metadataAfterWrites = await attempt(() =>
        cb((ok, bad) =>
          file.getMetadata(
            (m) =>
              ok({
                size: m.size,
                mtimeNear: Math.abs(m.modificationTime.getTime() - Date.now()) < 60000,
              }),
            bad,
          ),
        ),
      )
      r.fileObjectAfterWrites = await attempt(() =>
        cb((ok, bad) => file.file((f) => ok({ name: f.name, size: f.size, type: f.type }), bad)),
      )
      r.abort = await attempt(async () => {
        const p = writeAndWait(w, new Blob([new Uint8Array(4 * 1024 * 1024)]))
        let threw = null
        try {
          w.abort()
        } catch (e) {
          threw = err(e)
        }
        const res = await p
        return { threw, ...res }
      })
      r.abortIdle = await attempt(() =>
        cb((ok) => {
          try {
            w.abort()
            ok({ readyState: w.readyState, error: err(w.error) })
          } catch (e) {
            ok({ threw: err(e) })
          }
        }),
      )

      // a second file, a nested dir, and a listing
      await cb((ok, bad) => dir.getFile('456.webm', { create: true }, ok, bad))
      await cb((ok, bad) => dir.getDirectory('nested', { create: true }, ok, bad))
      await cb((ok, bad) => fs.root.getFile('top.txt', { create: true }, ok, bad))
      r.readEntries = await attempt(async () => {
        const reader = dir.createReader()
        const first = await cb((ok, bad) => reader.readEntries(ok, bad))
        const second = await cb((ok, bad) => reader.readEntries(ok, bad))
        return {
          readerTag: tag(reader),
          readerCtor: reader.constructor.name,
          first: first.map(describeEntry).sort((a, b) => a.name.localeCompare(b.name)),
          firstIsArray: Array.isArray(first),
          second: second.length,
          rootList: (await cb((ok, bad) => fs.root.createReader().readEntries(ok, bad)))
            .map((e) => e.name)
            .sort(),
        }
      })
      r.removeNonEmptyDir = await attempt(() => cb((ok, bad) => dir.remove(ok, bad)))
      r.removeFile = await attempt(() => cb((ok, bad) => file.remove((v) => ok({ value: v }), bad)))
      r.getRemoved = await attempt(() => cb((ok, bad) => dir.getFile('123', {}, ok, bad)))
      r.writerAfterRemove = await attempt(() => writeAndWait(w, new Blob(['zzz'])))
      r.fileAfterRemove = await attempt(() => cb((ok, bad) => file.file(ok, bad)))
      r.staleEntryToURL = file.toURL()
      r.removeRecursively = await attempt(() =>
        cb((ok, bad) => dir.removeRecursively((v) => ok({ value: v }), bad)),
      )
      r.dirAfterRemove = await attempt(() =>
        cb((ok, bad) => fs.root.getDirectory('videos', {}, ok, bad)),
      )
      r.moveTo = await attempt(async () => {
        const top = await cb((ok, bad) => fs.root.getFile('top.txt', {}, ok, bad))
        const moved = await cb((ok, bad) => top.moveTo(fs.root, 'top2.txt', ok, bad))
        const list = (await cb((ok, bad) => fs.root.createReader().readEntries(ok, bad)))
          .map((e) => e.name)
          .sort()
        await cb((ok, bad) => moved.remove(ok, bad))
        return { moved: describeEntry(moved), list }
      })
      r.copyTo = await attempt(async () => {
        const a = await cb((ok, bad) => fs.root.getFile('a.txt', { create: true }, ok, bad))
        const copy = await cb((ok, bad) => a.copyTo(fs.root, 'b.txt', ok, bad))
        const list = (await cb((ok, bad) => fs.root.createReader().readEntries(ok, bad)))
          .map((e) => e.name)
          .sort()
        await cb((ok, bad) => a.remove(ok, bad))
        await cb((ok, bad) => copy.remove(ok, bad))
        return { copy: describeEntry(copy), list }
      })
      r.toURLNested = await attempt(async () => {
        const d = await cb((ok, bad) =>
          fs.root.getDirectory('a b/c', { create: true }, ok, bad).catch?.(bad),
        )
        return describeEntry(d)
      })
      r.toURLNestedStep = await attempt(async () => {
        const d1 = await cb((ok, bad) => fs.root.getDirectory('a b', { create: true }, ok, bad))
        const d2 = await cb((ok, bad) => d1.getDirectory('ü c', { create: true }, ok, bad))
        const f = await cb((ok, bad) => d2.getFile('x y.txt', { create: true }, ok, bad))
        const resolved = await cb((ok, bad) =>
          window.webkitResolveLocalFileSystemURL(f.toURL(), (e) => ok(describeEntry(e)), bad),
        )
        await cb((ok, bad) => d1.removeRecursively(ok, bad))
        return { d2: describeEntry(d2), f: describeEntry(f), resolved }
      })
    }
    // cross-type isolation: temporary file not visible in persistent
    out.isolation = await attempt(async () => {
      const t = await cb((ok, bad) =>
        window.webkitRequestFileSystem(window.TEMPORARY, 1024, ok, bad),
      )
      const p = await cb((ok, bad) =>
        window.webkitRequestFileSystem(window.PERSISTENT, 1024, ok, bad),
      )
      await cb((ok, bad) => t.root.getFile('only-temp.txt', { create: true }, ok, bad))
      const inPersistent = await attempt(() =>
        cb((ok, bad) => p.root.getFile('only-temp.txt', {}, ok, bad)),
      )
      const tf = await cb((ok, bad) => t.root.getFile('only-temp.txt', {}, ok, bad))
      await cb((ok, bad) => tf.remove(ok, bad))
      return { inPersistent }
    })
    // persistence across reload is measured by the runner (write before, read after)
    out.persistMarker = await attempt(async () => {
      const p = await cb((ok, bad) =>
        window.webkitRequestFileSystem(window.PERSISTENT, 1024, ok, bad),
      )
      const f = await cb((ok, bad) => p.root.getFile('marker.txt', {}, ok, bad))
      const t = await cb((ok, bad) => f.file((file) => text(file).then(ok), bad))
      return t
    })
    await attempt(async () => {
      const p = await cb((ok, bad) =>
        window.webkitRequestFileSystem(window.PERSISTENT, 1024, ok, bad),
      )
      const f = await cb((ok, bad) => p.root.getFile('marker.txt', { create: true }, ok, bad))
      const w = await cb((ok, bad) => f.createWriter(ok, bad))
      await writeAndWait(w, new Blob(['survived ' + Date.now()]))
    })
    return out
  }
})()
