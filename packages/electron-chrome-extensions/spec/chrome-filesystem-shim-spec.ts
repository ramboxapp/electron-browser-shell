import { expect } from 'chai'
import { BrowserWindow } from 'electron'
import * as path from 'node:path'

import { ElectronChromeExtensions } from '../'
import { addCrxPreload, createCrxSession, waitForBackgroundScriptEvaluated } from './crx-helpers'

/*
  The sandboxed FileSystem API (`webkitRequestFileSystem`, TEMPORARY and PERSISTENT) in the pages
  of an extension, as Edge 156 (Chromium 147) answers it: measured on 05/11/2026 with the fixture's
  own probe page (`fs.js`, the same code ran in Edge). Electron 43 and 44.10.1 answer every call
  with `SecurityError`, because the embedder does not list `chrome-extension` among the schemes
  allowed to use the sandboxed FileSystem (OPFS included); the preload answers it over IndexedDB
  instead, with Chrome's shapes. Awesome Screenshot saves each recording through this API.

  The first case checks that Electron still blocks the scheme (through OPFS, which the shim does not
  touch): the day it passes, the shim steps aside on its own and can be retired.
*/

const NOT_FOUND =
  'A requested file or directory could not be found at the time an operation was processed.'
const TYPE_MISMATCH = 'The path supplied exists, but was not an entry of requested type.'
const EXISTS = 'An attempt was made to create a file or directory where an element already exists.'
const NOT_MODIFIABLE = 'The object can not be modified in this way.'
const STATE =
  'An operation that depends on state cached in an interface object was made but the state had changed since it was read from disk.'

describe('sandboxed FileSystem in the pages of an extension', () => {
  let ses: Electron.Session
  let extensions: ElectronChromeExtensions
  let extension: Electron.Extension
  const windows: BrowserWindow[] = []
  /** The probe's record: one run of `window.__probe()` in fs.html, read by every case below. */
  let probe: any

  const openPage = async () => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { session: ses, nodeIntegration: false, contextIsolation: true },
    })
    windows.push(win)
    await win.loadURL(`chrome-extension://${extension.id}/fs.html`)
    return win.webContents
  }
  const inPage = (page: Electron.WebContents, js: string): Promise<any> =>
    page.executeJavaScript(js, true)

  before(async function () {
    this.timeout(60000)
    const details = createCrxSession()
    ses = details.session
    addCrxPreload(ses)
    extensions = new ElectronChromeExtensions({
      license: 'internal-license-do-not-use' as any,
      session: ses,
      async createTab() {
        throw new Error('not used by this spec')
      },
    })
    extension = await ses.loadExtension(path.join(__dirname, 'fixtures', 'filesystem-mv3'))
    await waitForBackgroundScriptEvaluated(extension, ses)
    const page = await openPage()
    probe = await inPage(page, 'window.__probe()')
  })

  after(() => {
    for (const win of windows.splice(0)) if (!win.isDestroyed()) win.destroy()
    void extensions
  })

  const expectError = (outcome: any, name: string, code: number, message?: string) => {
    expect(outcome.error, JSON.stringify(outcome)).to.be.an('object')
    expect(outcome.error.isDOMException, 'a DOMException').to.equal(true)
    expect(outcome.error.name).to.equal(name)
    expect(outcome.error.code).to.equal(code)
    if (message) expect(outcome.error.message).to.equal(message)
  }
  const eventTypes = (outcome: any): string[] =>
    outcome.ok.events
      .filter((e: any) => e.type)
      .map((e: any) => e.type)
      .filter((t: string, i: number, all: string[]) => all.indexOf(t) === i)

  it('is needed: Electron still refuses the scheme natively (OPFS, which the shim leaves alone)', () => {
    expectError(probe.opfs, 'SecurityError', 18)
  })

  it('answers both trees with Chrome names, roots and URLs, and no global constructors', () => {
    const id = extension.id
    expect(probe.globals.webkitRequestFileSystem).to.equal('function')
    expect(probe.globals.webkitResolveLocalFileSystemURL).to.equal('function')
    expect(probe.globals.requestFileSystem).to.equal('undefined')
    expect(probe.globals.FileError).to.equal('undefined')
    expect(probe.globals.FileWriter).to.equal('undefined')
    expect(probe.globals.TEMPORARY).to.equal(0)
    expect(probe.globals.PERSISTENT).to.equal(1)
    for (const [tree, suffix] of [
      ['persistent', 'Persistent'],
      ['temporary', 'Temporary'],
    ]) {
      const r = probe[tree]
      expect(r.request, tree).to.deep.equal({ ok: true })
      expect(r.fs.tag).to.equal('[object DOMFileSystem]')
      expect(r.fs.name).to.equal(`chrome-extension_${id}_0:${suffix}`)
      expect(r.root.tag).to.equal('[object DirectoryEntry]')
      expect(r.root).to.include({ isFile: false, isDirectory: true, name: '', fullPath: '/' })
      expect(r.root.url).to.equal(`filesystem:chrome-extension://${id}/${tree}/`)
      expect(r.rootFilesystemIsFs).to.equal(true)
      expect(r.secondRequestSameObject, 'a new object per request, as Chrome').to.equal(false)
      expect(r.createFile.url).to.equal(`filesystem:chrome-extension://${id}/${tree}/videos/123`)
    }
    expect(probe.quota.persistentRequest.ok, 'the quota API is native and stays').to.equal(1048576)
  })

  it('refuses a bad request the way Chrome does', () => {
    expect(probe.badCalls.noCallback.error).to.include({
      name: 'TypeError',
      message:
        "Failed to execute 'webkitRequestFileSystem' on 'Window': 3 arguments required, but only 2 present.",
    })
    expectError(probe.badCalls.badType, 'InvalidModificationError', 13, NOT_MODIFIABLE)
    expect(probe.badCalls.negativeSize.ok, 'a negative size is accepted').to.be.an('object')
  })

  it('creates directories and files and resolves paths like Chrome', () => {
    const r = probe.persistent
    const id = extension.id
    expect(r.createDir).to.include({
      tag: '[object DirectoryEntry]',
      name: 'videos',
      fullPath: '/videos',
    })
    expect(r.createDir.url).to.equal(`filesystem:chrome-extension://${id}/persistent/videos`)
    expect(r.createDir.proto).to.include.members([
      'createReader',
      'getDirectory',
      'getFile',
      'removeRecursively',
    ])
    expect(r.createFile).to.include({
      tag: '[object FileEntry]',
      isFile: true,
      isDirectory: false,
      name: '123',
      fullPath: '/videos/123',
    })
    expect(r.createFile.proto, 'own prototype: the rest is on the Entry one').to.include.members([
      'createWriter',
      'file',
    ])
    expect(r.fileAgainCreate.ok, 'create on an existing file without exclusive').to.include({
      fullPath: '/videos/123',
      same: false,
    })
    for (const way of [
      'fileViaRootRelative',
      'fileViaRootAbsolute',
      'fileViaDirAbsolute',
      'fileViaDotDot',
    ])
      expect(r[way].ok, way).to.include({ fullPath: '/videos/123', name: '123' })
    expect(r.getFileOnDirTrailingSlash.ok).to.include({ fullPath: '/videos' })
    expect(r.getDirDotDot.ok, '.. above the root is the root').to.include({ fullPath: '/' })
    expect(r.rootGetParent.ok).to.include({ fullPath: '/' })
    expect(r.parent.ok).to.include({ fullPath: '/videos', isDirectory: true })
    expect(r.resolveURL.ok, 'webkitResolveLocalFileSystemURL').to.include({
      fullPath: '/videos/123',
      isFile: true,
    })
    expect(r.toURLNestedStep.ok.d2).to.include({
      fullPath: '/a b/ü c',
      url: `filesystem:chrome-extension://${id}/persistent/a%20b/%C3%BC%20c`,
    })
    expect(r.toURLNestedStep.ok.f).to.include({
      fullPath: '/a b/ü c/x y.txt',
      url: `filesystem:chrome-extension://${id}/persistent/a%20b/%C3%BC%20c/x%20y.txt`,
    })
    expect(r.toURLNestedStep.ok.resolved).to.include({ fullPath: '/a b/ü c/x y.txt' })
    expect(r.emptyFile.ok).to.include({
      tag: '[object File]',
      name: '123',
      size: 0,
      type: '',
      lastModifiedNear: true,
      isFile: true,
    })
    expect(r.fileMetadataEmpty.ok).to.include({
      tag: '[object Metadata]',
      size: 0,
      mtimeIsDate: true,
    })
    expect(r.rootMetadata.ok).to.include({ tag: '[object Metadata]', size: 0, mtimeIsDate: true })
  })

  it('fails with the DOMExceptions Chrome hands out', () => {
    const r = probe.persistent
    expectError(r.missingFile, 'NotFoundError', 8, NOT_FOUND)
    expectError(r.missingFileNoOpts, 'NotFoundError', 8, NOT_FOUND)
    expectError(r.missingDir, 'NotFoundError', 8, NOT_FOUND)
    expectError(r.resolveURLMissing, 'NotFoundError', 8, NOT_FOUND)
    expectError(r.emptyName, 'SecurityError', 18)
    expectError(r.dotName, 'TypeMismatchError', 17, TYPE_MISMATCH)
    expectError(r.getFileOnDir, 'TypeMismatchError', 17, TYPE_MISMATCH)
    expectError(r.getFileOnDirCreate, 'TypeMismatchError', 17, TYPE_MISMATCH)
    expectError(r.getDirOnFile, 'TypeMismatchError', 17, TYPE_MISMATCH)
    expectError(r.dirExclusiveExists, 'InvalidModificationError', 13, EXISTS)
    expectError(r.fileExclusiveExists, 'InvalidModificationError', 13, EXISTS)
    expectError(r.rootRemove, 'InvalidModificationError', 13, NOT_MODIFIABLE)
    expectError(r.removeNonEmptyDir, 'InvalidModificationError', 13, NOT_MODIFIABLE)
  })

  it('writes through a FileWriter the way Chrome does: position 0, async events, append', () => {
    const r = probe.persistent
    expect(r.createWriter).to.include({
      tag: '[object FileWriter]',
      position: 0,
      length: 0,
      readyState: 0,
      INIT: 0,
      WRITING: 1,
      DONE: 2,
      error: null,
      isEventTarget: true,
    })
    expect(r.createWriter.proto).to.include.members([
      'abort',
      'seek',
      'truncate',
      'write',
      'onwriteend',
      'onerror',
      'onprogress',
      'onwritestart',
      'onwrite',
      'onabort',
    ])
    expect(r.write1.ok.events[0].type, 'writestart fires inside write()').to.equal('writestart')
    expect(r.write1.ok.events[0]).to.include({
      loaded: 0,
      total: 5,
      lengthComputable: true,
      targetIsWriter: true,
      readyState: 1,
    })
    expect(r.write1.ok.events[1].sync, 'and everything else after write() returned').to.equal(
      'write returned',
    )
    expect(r.write1.ok.events[1].readyStateAfterCall).to.equal(1)
    expect(eventTypes(r.write1)).to.deep.equal(['writestart', 'progress', 'write', 'writeend'])
    const last = r.write1.ok.events[r.write1.ok.events.length - 1]
    expect(last).to.include({
      type: 'writeend',
      tag: '[object ProgressEvent]',
      loaded: 5,
      total: 5,
      readyState: 2,
    })
    expect(r.write1.ok).to.include({ position: 5, length: 5, readyState: 2, error: null })
    expect(r.write2.ok).to.include({ position: 11, length: 11 })
    expect(r.afterTwoWrites.ok, 'the File does not take the Blob type').to.deep.equal({
      text: 'hello world',
      size: 11,
      type: '',
    })
  })

  it('guards the writer state and its arguments', () => {
    const r = probe.persistent
    expect(r.writeWhileWriting.ok.second).to.include({
      name: 'InvalidStateError',
      code: 11,
      isDOMException: true,
      message: `Failed to execute 'write' on 'FileWriter': ${STATE}`,
    })
    expect(r.writeWhileWriting.ok.first, 'the write in flight completes').to.include({
      position: 12,
      length: 12,
      readyState: 2,
    })
    expect(
      r.writeWhileWriting.ok.first.error,
      'and the rejected call leaves its error on the writer',
    ).to.include({ name: 'InvalidStateError' })
    expect(r.writeStringInsteadOfBlob.error).to.include({
      name: 'TypeError',
      message: "Failed to execute 'write' on 'FileWriter': parameter 1 is not of type 'Blob'.",
    })
    expect(r.writeNothing.ok.threw).to.include({
      name: 'TypeError',
      message:
        "Failed to execute 'write' on 'FileWriter': 1 argument required, but only 0 present.",
    })
  })

  it('seeks, overwrites and truncates', () => {
    const r = probe.persistent
    expect(r.seekThenWrite.ok).to.include({
      posAfterSeek: 0,
      position: 1,
      length: 12,
      text: 'Jello world!',
    })
    expect(r.seekBeyond.ok, 'clamped to the length').to.deep.equal({ position: 12, length: 12 })
    expect(r.seekNegative.ok, 'from the end').to.deep.equal({ position: 9, length: 12 })
    expect(r.seekTooNegative.ok).to.deep.equal({ position: 0, length: 12 })
    expect(r.truncateShorter.ok).to.include({ position: 4, length: 4, text: 'Jell' })
    expect(r.truncateLonger.ok, 'extended with zeros, position kept').to.include({
      position: 4,
      length: 8,
    })
    expect(r.truncateLonger.ok.bytes).to.deep.equal([74, 101, 108, 108, 0, 0, 0, 0])
    expect(
      r.secondWriterSameFile.ok,
      'a new writer starts at 0 with the current length',
    ).to.deep.equal({ position: 0, length: 8, same: false })
    expect(r.metadataAfterWrites.ok).to.deep.equal({ size: 8, mtimeNear: true })
    expect(r.fileObjectAfterWrites.ok).to.deep.equal({ name: '123', size: 8, type: '' })
  })

  it('aborts a write in flight without writing, and marks an idle writer aborted', () => {
    const r = probe.persistent
    expect(r.abort.ok.threw).to.equal(null)
    expect(eventTypes(r.abort)).to.deep.equal(['writestart', 'abort', 'writeend'])
    expect(r.abort.ok).to.include({ position: 4, length: 8, readyState: 2 })
    expect(r.abort.ok.error).to.include({ name: 'AbortError', code: 20 })
    expect(r.abortIdle.ok.readyState).to.equal(2)
    expect(r.abortIdle.ok.error).to.include({ name: 'AbortError', code: 20 })
  })

  it('lists a directory once per reader', () => {
    const r = probe.persistent.readEntries.ok
    expect(r.readerTag).to.equal('[object DirectoryReader]')
    expect(r.firstIsArray).to.equal(true)
    expect(r.first.map((e: any) => [e.name, e.isFile, e.fullPath])).to.deep.equal([
      ['123', true, '/videos/123'],
      ['456.webm', true, '/videos/456.webm'],
      ['nested', false, '/videos/nested'],
    ])
    expect(r.first[2].tag).to.equal('[object DirectoryEntry]')
    expect(r.second, 'the second readEntries is empty').to.equal(0)
    expect(r.rootList).to.deep.equal(['top.txt', 'videos'])
  })

  it('removes, recursively too, and moves and copies', () => {
    const r = probe.persistent
    expect(r.removeFile.ok, 'remove calls back with nothing').to.have.property('value', undefined)
    expectError(r.getRemoved, 'NotFoundError', 8, NOT_FOUND)
    expectError(r.fileAfterRemove, 'NotFoundError', 8, NOT_FOUND)
    expect(eventTypes(r.writerAfterRemove), 'a writer on a removed file').to.deep.equal([
      'writestart',
      'error',
      'writeend',
    ])
    expect(r.writerAfterRemove.ok.error).to.include({ name: 'NotFoundError', code: 8 })
    expect(r.staleEntryToURL, 'toURL still answers on a stale entry').to.equal(
      `filesystem:chrome-extension://${extension.id}/persistent/videos/123`,
    )
    expect(r.removeRecursively.ok).to.have.property('value', undefined)
    expectError(r.dirAfterRemove, 'NotFoundError', 8, NOT_FOUND)
    expect(r.moveTo.ok.moved).to.include({ name: 'top2.txt', fullPath: '/top2.txt', isFile: true })
    expect(r.moveTo.ok.list).to.deep.equal(['top2.txt'])
    expect(r.copyTo.ok.copy).to.include({ name: 'b.txt', fullPath: '/b.txt' })
    expect(r.copyTo.ok.list).to.deep.equal(['a.txt', 'b.txt'])
  })

  it('keeps TEMPORARY and PERSISTENT apart', () => {
    expectError(probe.isolation.ok.inPersistent, 'NotFoundError', 8, NOT_FOUND)
  })

  it('hands a file written in one page to another page of the extension, after the first is gone', async function () {
    this.timeout(20000)
    // The probe wrote marker.txt at its end, from the first page; that page is destroyed first.
    for (const win of windows.splice(0)) if (!win.isDestroyed()) win.destroy()
    const page = await openPage()
    const text = await inPage(
      page,
      `new Promise((ok, bad) => webkitRequestFileSystem(PERSISTENT, 1024, fs =>
        fs.root.getFile('marker.txt', {}, e => e.file(f => f.text().then(ok, bad), bad), bad), bad))`,
    )
    expect(text).to.match(/^survived \d+$/)
  })

  it('loads its own filesystem: URLs where a page puts them: media, image and source src, anchor href', async function () {
    this.timeout(20000)
    const page = await openPage()
    const result = await inPage(
      page,
      `(async () => {
        const cb = (fn) => new Promise((ok, bad) => fn(ok, bad))
        const fs = await cb((ok, bad) => webkitRequestFileSystem(PERSISTENT, 1024, ok, bad))
        const dir = await cb((ok, bad) => fs.root.getDirectory('pics', { create: true }, ok, bad))
        const entry = await cb((ok, bad) => dir.getFile('one.png', { create: true }, ok, bad))
        const writer = await cb((ok, bad) => entry.createWriter(ok, bad))
        const png = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))
        await new Promise((ok, bad) => { writer.write(new Blob([png])); writer.onerror = () => bad(writer.error); writer.onwriteend = ok })
        const url = entry.toURL()
        const viaProperty = await new Promise((ok) => { const img = new Image(); img.onload = () => ok({ loaded: true, w: img.naturalWidth, src: img.src, attr: img.getAttribute('src').slice(0, 5) }); img.onerror = () => ok({ loaded: false }); img.src = url })
        const viaAttribute = await new Promise((ok) => { const img = document.createElement('img'); img.onload = () => ok({ loaded: true, w: img.naturalWidth, src: img.src }); img.onerror = () => ok({ loaded: false }); img.setAttribute('src', url) })
        const video = await new Promise((ok) => { const v = document.createElement('video'); const done = () => ok({ src: v.src, currentSrc: v.currentSrc.slice(0, 5) }); v.onerror = done; v.onloadedmetadata = done; v.src = url; setTimeout(done, 3000) })
        const a = document.createElement('a'); a.href = url
        await new Promise((r) => setTimeout(r, 200))
        const missing = await new Promise((ok) => { const img = new Image(); img.onload = () => ok('loaded'); img.onerror = () => ok('error'); img.src = url.replace('one.png', 'none.png') })
        const other = document.createElement('img'); other.src = 'data:,x'
        return { viaProperty, viaAttribute, video, anchor: { href: a.href, attr: a.getAttribute('href').slice(0, 5) }, missing, other: other.src }
      })()`,
    )
    const url = `filesystem:chrome-extension://${extension.id}/persistent/pics/one.png`
    expect(result.viaProperty, 'img.src = url').to.deep.equal({
      loaded: true,
      w: 1,
      src: url,
      attr: 'blob:',
    })
    expect(result.viaAttribute, "setAttribute('src', url), React's way").to.deep.equal({
      loaded: true,
      w: 1,
      src: url,
    })
    expect(result.video, 'video.src = url plays a blob and still says the url').to.deep.equal({
      src: url,
      currentSrc: 'blob:',
    })
    expect(result.anchor).to.deep.equal({ href: url, attr: 'blob:' })
    expect(result.missing, 'a missing file fails as an unloadable URL').to.equal('error')
    expect(result.other, 'other URLs are untouched').to.equal('data:,x')
  })

  it("plays a recorder's appends back as one File, through a blob URL as a <video> would", async function () {
    this.timeout(30000)
    const page = await openPage()
    const result = await inPage(
      page,
      `(async () => {
        const cb = (fn) => new Promise((ok, bad) => fn(ok, bad))
        const fs = await cb((ok, bad) => webkitRequestFileSystem(PERSISTENT, 50 * 1024 * 1024, ok, bad))
        const dir = await cb((ok, bad) => fs.root.getDirectory('videos', { create: true }, ok, bad))
        const entry = await cb((ok, bad) => dir.getFile('rec', { create: true }, ok, bad))
        const writer = await cb((ok, bad) => entry.createWriter(ok, bad))
        const CHUNK = 64 * 1024, COUNT = 40
        for (let i = 0; i < COUNT; i++) {
          const bytes = new Uint8Array(CHUNK).fill(i)
          await new Promise((ok, bad) => {
            writer.write(new Blob([bytes], { type: 'video/webm' }))
            writer.onerror = () => bad(writer.error)
            writer.onwriteend = () => ok()
          })
        }
        const file = await cb((ok, bad) => entry.file(ok, bad))
        const url = URL.createObjectURL(file)
        const buffer = await (await fetch(url)).arrayBuffer()
        const view = new Uint8Array(buffer)
        const samples = []
        for (let i = 0; i < COUNT; i++) samples.push(view[i * CHUNK + 17])
        const meta = await cb((ok, bad) => entry.getMetadata(ok, bad))
        return { position: writer.position, length: writer.length, fileSize: file.size, bufferSize: buffer.byteLength, samples, metaSize: meta.size, url: entry.toURL() }
      })()`,
    )
    const total = 40 * 64 * 1024
    expect(result).to.include({
      position: total,
      length: total,
      fileSize: total,
      bufferSize: total,
      metaSize: total,
    })
    expect(result.samples).to.deep.equal(Array.from({ length: 40 }, (_, i) => i))
    expect(result.url).to.equal(
      `filesystem:chrome-extension://${extension.id}/persistent/videos/rec`,
    )
  })
})
