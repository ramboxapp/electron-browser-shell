import { expect } from 'chai'
import * as http from 'http'
import { AddressInfo } from 'net'

import { useExtensionBrowser } from './hooks'

/**
 * The extension preload is registered on the session as a `service-worker` preload, and Electron
 * runs those in EVERY service worker of the session — an extension's background worker and a web
 * page's own service worker alike. The preload used to enter on `process.type === 'service-worker'`
 * without looking at the origin, so a site loaded in a partition with extensions (WhatsApp Web,
 * measured on 28/10/2026: "failed to inject chrome.runtime" with `ID: web.whatsapp.com` in the host
 * app's log) got the extension `chrome.*` surface bolted onto its worker. Chrome never injects
 * extension APIs into a page's worker.
 */
describe('extension preload in a web page service worker', () => {
  let server: http.Server
  let url: string

  before(async () => {
    server = http.createServer((req, res) => {
      if (req.url?.startsWith('/sw.js')) {
        res.writeHead(200, { 'Content-Type': 'text/javascript' })
        res.end(`
          self.addEventListener('install', () => self.skipWaiting())
          self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
          self.addEventListener('message', (event) => {
            const c = typeof chrome === 'undefined' ? undefined : chrome
            event.source.postMessage({
              hasChrome: !!c,
              hasBridge: typeof electron !== 'undefined',
              keys: c ? Object.keys(c).sort() : [],
              tabs: !!(c && c.tabs),
              runtimeSendMessage: !!(c && c.runtime && c.runtime.sendMessage),
            })
          })
        `)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<!DOCTYPE html><html><body>page</body></html>')
    })
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
        resolve()
      }),
    )
  })
  after(() => server.close())

  const browser = useExtensionBrowser({ url: () => url, extensionName: 'rpc-mv3' })

  it('does not give a page service worker the extension chrome.* surface', async () => {
    // Electron reports the preload's own console lines with an empty sourceUrl, so a line is
    // attributed to the page worker by its version id, not by where it says it came from.
    const messages: { versionId: number; message: string }[] = []
    const onConsole = (_e: any, details: any) => {
      messages.push({ versionId: details.versionId, message: details.message })
    }
    browser.session.serviceWorkers.on('console-message', onConsole)

    try {
      const seen: any = await browser.webContents.executeJavaScript(`(async () => {
        const reg = await navigator.serviceWorker.register('/sw.js')
        await navigator.serviceWorker.ready
        const worker = reg.active || reg.waiting || reg.installing
        return await new Promise((resolve) => {
          navigator.serviceWorker.addEventListener('message', (e) => resolve(e.data), { once: true })
          worker.postMessage('report')
        })
      })()`)

      // Neither the namespaces the preload adds nor its errors trying to add them.
      expect(seen.tabs, `page worker saw chrome keys: ${seen.keys.join(',')}`).to.be.false
      expect(seen.runtimeSendMessage).to.be.false
      // The preload's IPC bridge to the main process, which a site has no business holding.
      expect(seen.hasBridge, 'page worker got the extension IPC bridge').to.be.false
      const running = browser.session.serviceWorkers.getAllRunning()
      const pageWorkers = Object.entries(running)
        .filter(([, info]) => info.scope.startsWith('http'))
        .map(([versionId]) => Number(versionId))
      expect(pageWorkers, 'the page worker is not running').to.not.be.empty
      const ours = messages
        .filter((m) => pageWorkers.includes(m.versionId))
        .filter((m) => m.message.includes('electron-chrome-extensions'))
        .map((m) => m.message)
      expect(ours, ours.join('\n')).to.be.empty
    } finally {
      browser.session.serviceWorkers.removeListener('console-message', onConsole)
    }
  })

  it('still gives the extension its own service worker APIs', async () => {
    const result = await browser.crx.exec('tabs.query', {})
    expect(result).to.be.an('array')
  })
})
