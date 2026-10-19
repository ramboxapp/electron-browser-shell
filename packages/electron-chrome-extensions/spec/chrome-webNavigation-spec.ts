import { expect } from 'chai'
import { ipcMain } from 'electron'

import { useExtensionBrowser, useServer } from './hooks'

describe('chrome.webNavigation', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'chrome-webNavigation' })

  it('does not crash when frames are disposed during rapid navigations', async () => {
    const wc = browser.window.webContents

    // Overlapping navigations abort each other, disposing frames while the
    // navigation events referencing them may still be in flight — the
    // scenario behind "Render frame was disposed" crashes seen on fast
    // redirect chains (e.g. OAuth consent flows). Aborted loads reject,
    // which is expected. An uncaught main-process exception would kill the
    // spec runner, so completing the final load is the assertion.
    for (let i = 0; i < 5; i++) {
      wc.loadURL(`${server.getUrl()}?nav=${i}`).catch(() => {})
    }

    await wc.loadURL(`${server.getUrl()}?final=1`)
    expect(wc.getURL()).to.include('final=1')
  })

  // TODO: for some reason 'onCommitted' will sometimes not arrive
  it.skip('emits events in the correct order', async () => {
    const expectedEventLog = [
      'onBeforeNavigate',
      'onCommitted',
      'onDOMContentLoaded',
      'onCompleted',
    ]

    const eventsPromise = new Promise((resolve) => {
      const eventLog: string[] = []
      ipcMain.on('logEvent', (e, eventName) => {
        if (eventLog.length === 0 && eventName !== 'onBeforeNavigate') {
          // ignore events that come in late from initial load
          return
        }

        eventLog.push(eventName)

        if (eventLog.length === expectedEventLog.length) {
          resolve(eventLog)
        }
      })
    })

    await browser.window.webContents.loadURL(`${server.getUrl()}`)

    const eventLog = await eventsPromise
    expect(eventLog).to.deep.equal(expectedEventLog)
  })
})

/*
  A placeholder documentId is worse than none.

  `tabs.sendMessage` is Chromium's own, so `{ documentId: 'not-implemented' }` addresses a document
  that cannot exist and the message goes nowhere, silently. Extensions pick between the addressing
  modes the way the API invites — Keeper 18.2.0 does
  `sendMessage(tabId, msg, documentId !== undefined ? { documentId } : { frameId })` — so what is
  reported here decides whether every one of those messages is deliverable. Measured against a stock
  Chromium with the same extension: there its in-field prompt opens and stays.

  This lives on the rpc fixture rather than the webNavigation one because only that fixture answers
  arbitrary API calls.
*/
describe('chrome.webNavigation frame details', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })

  it('reports no documentId rather than a placeholder', async () => {
    const tabs: any[] = await browser.crx.exec('tabs.query', {})
    expect(tabs, 'the extension saw no tabs').to.be.an('array').that.is.not.empty
    const frames: any[] = await browser.crx.exec('webNavigation.getAllFrames', {
      tabId: tabs[0].id,
    })
    expect(frames, 'getAllFrames answered nothing').to.be.an('array').that.is.not.empty
    for (const frame of frames) {
      expect(frame.documentId, `documentId was ${JSON.stringify(frame.documentId)}`).to.be.oneOf([
        undefined,
        null,
      ])
    }
  })
})
