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
