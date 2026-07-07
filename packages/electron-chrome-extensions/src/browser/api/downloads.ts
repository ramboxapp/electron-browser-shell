import { app, shell } from 'electron'
import * as path from 'node:path'
import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'
import debug from 'debug'

const d = debug('electron-chrome-extensions:downloads')

type DownloadState = chrome.downloads.DownloadItem['state']

interface TrackedDownload {
  details: chrome.downloads.DownloadItem
  item?: Electron.DownloadItem
}

interface DownloadOptions {
  url: string
  filename?: string
  saveAs?: boolean
  conflictAction?: string
}

const stateMap: Record<string, DownloadState> = {
  progressing: 'in_progress',
  completed: 'complete',
  cancelled: 'interrupted',
  interrupted: 'interrupted',
}

let nextDownloadId = 1

/**
 * Implementation of the chrome.downloads API backed by Electron's
 * DownloadItem. Downloads are tracked in memory only, so the history is
 * cleared when the app restarts.
 */
export class DownloadsAPI {
  private downloads = new Map</* downloadId */ number, TrackedDownload>()

  /** Download requests awaiting their 'will-download' event. */
  private pendingRequests: {
    url: string
    options: DownloadOptions
    resolve: (downloadId: number) => void
  }[] = []

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    handle('downloads.download', this.download.bind(this), { permission: 'downloads' })
    handle('downloads.search', this.search.bind(this), { permission: 'downloads' })
    handle('downloads.pause', this.pause.bind(this), { permission: 'downloads' })
    handle('downloads.resume', this.resume.bind(this), { permission: 'downloads' })
    handle('downloads.cancel', this.cancel.bind(this), { permission: 'downloads' })
    handle('downloads.erase', this.erase.bind(this), { permission: 'downloads' })
    handle('downloads.open', this.open.bind(this), { permission: 'downloads' })
    handle('downloads.show', this.show.bind(this), { permission: 'downloads' })
    handle('downloads.showDefaultFolder', this.showDefaultFolder.bind(this), {
      permission: 'downloads',
    })

    ctx.session.on('will-download', this.onWillDownload)
  }

  private onWillDownload = (event: Electron.Event, item: Electron.DownloadItem) => {
    const id = nextDownloadId++

    // 'will-download' doesn't identify which downloadURL() call triggered it,
    // so pending API requests are matched in FIFO order. Downloads initiated
    // by the page itself simply won't have a matching request.
    const request = this.pendingRequests.shift()

    if (request?.options.filename) {
      const savePath = path.join(app.getPath('downloads'), request.options.filename)
      item.setSavePath(savePath)
    }

    const details: chrome.downloads.DownloadItem = {
      id,
      url: item.getURL(),
      finalUrl: item.getURL(),
      filename: item.getSavePath(),
      referrer: '',
      incognito: false,
      danger: 'safe',
      mime: item.getMimeType(),
      startTime: new Date(item.getStartTime() * 1000).toISOString(),
      state: 'in_progress',
      paused: false,
      canResume: item.canResume(),
      bytesReceived: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      fileSize: item.getTotalBytes(),
      exists: true,
      byExtensionId: undefined,
      byExtensionName: undefined,
    } as chrome.downloads.DownloadItem

    const tracked: TrackedDownload = { details, item }
    this.downloads.set(id, tracked)

    d(`download created [id:${id}, url:${details.url}]`)

    request?.resolve(id)
    this.ctx.router.broadcastEvent('downloads.onCreated', { ...details })

    item.on('updated', () => {
      this.updateDetails(tracked)
    })

    item.once('done', (_event, state) => {
      this.updateDetails(tracked, state)
      // The DownloadItem gets destroyed after completion; only the snapshot
      // in `details` remains valid.
      tracked.item = undefined
    })
  }

  private updateDetails(tracked: TrackedDownload, doneState?: string) {
    const { details, item } = tracked
    if (!item) return

    const state = stateMap[doneState || item.getState()] || 'in_progress'
    const paused = item.isPaused()

    const delta: chrome.downloads.DownloadDelta = { id: details.id }
    if (state !== details.state) {
      delta.state = { previous: details.state, current: state }
    }
    if (paused !== details.paused) {
      delta.paused = { previous: details.paused, current: paused }
    }

    details.filename = item.getSavePath() || details.filename
    details.state = state
    details.paused = paused
    details.canResume = item.canResume()
    details.bytesReceived = item.getReceivedBytes()
    details.totalBytes = item.getTotalBytes()
    details.fileSize = item.getTotalBytes()

    if (delta.state || delta.paused) {
      this.ctx.router.broadcastEvent('downloads.onChanged', delta)
    }
  }

  private getDownload(downloadId: number) {
    const tracked = this.downloads.get(downloadId)
    if (!tracked) {
      throw new Error(`Invalid download id ${downloadId}`)
    }
    return tracked
  }

  private download(event: ExtensionEvent, options: DownloadOptions): Promise<number> {
    if (!options?.url) {
      throw new Error('Invalid URL')
    }

    // Resolved with the download ID from onWillDownload once Electron emits
    // 'will-download' for this request.
    return new Promise<number>((resolve) => {
      this.pendingRequests.push({ url: options.url, options, resolve })
      this.ctx.session.downloadURL(options.url)
    })
  }

  // Supports a subset of DownloadQuery filters: id, url, state, filenameRegex
  // and limit. Other filters are ignored.
  private search(
    event: ExtensionEvent,
    query: chrome.downloads.DownloadQuery = {},
  ): chrome.downloads.DownloadItem[] {
    let results = Array.from(this.downloads.values()).map((tracked) => ({ ...tracked.details }))

    if (typeof query.id === 'number') {
      results = results.filter((details) => details.id === query.id)
    }
    if (query.url) {
      results = results.filter((details) => details.url === query.url)
    }
    if (query.state) {
      results = results.filter((details) => details.state === query.state)
    }
    if (query.filenameRegex) {
      const regex = new RegExp(query.filenameRegex)
      results = results.filter((details) => regex.test(details.filename))
    }
    if (typeof query.limit === 'number' && query.limit > 0) {
      results = results.slice(0, query.limit)
    }

    return results
  }

  private pause(event: ExtensionEvent, downloadId: number) {
    this.getDownload(downloadId).item?.pause()
  }

  private resume(event: ExtensionEvent, downloadId: number) {
    this.getDownload(downloadId).item?.resume()
  }

  private cancel(event: ExtensionEvent, downloadId: number) {
    this.getDownload(downloadId).item?.cancel()
  }

  private erase(event: ExtensionEvent, query: chrome.downloads.DownloadQuery = {}): number[] {
    const matches = this.search(event, query)
    const erasedIds: number[] = []

    for (const details of matches) {
      const tracked = this.downloads.get(details.id)
      tracked?.item?.cancel()
      this.downloads.delete(details.id)
      erasedIds.push(details.id)
      this.ctx.router.broadcastEvent('downloads.onErased', details.id)
    }

    return erasedIds
  }

  private open(event: ExtensionEvent, downloadId: number) {
    const { details } = this.getDownload(downloadId)
    if (details.state !== 'complete') {
      throw new Error('Download must be complete')
    }
    shell.openPath(details.filename)
  }

  private show(event: ExtensionEvent, downloadId: number) {
    const { details } = this.getDownload(downloadId)
    shell.showItemInFolder(details.filename)
  }

  private showDefaultFolder() {
    shell.openPath(app.getPath('downloads'))
  }
}
