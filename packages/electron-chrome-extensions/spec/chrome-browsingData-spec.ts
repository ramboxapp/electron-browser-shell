import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

/*
  chrome.browsingData on the session's own storage — real, and refusing what Electron cannot do
  without deleting more than the extension asked for (see browser/api/browsing-data.ts). The case the
  catalog has: Keeper removes its web vault's caches by origin when the vault updates.
*/
describe('chrome.browsingData', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'floor-mv3' })

  const exec = (method: string, ...args: any[]) => browser.crx.raw({ type: 'api', method, args })
  const origin = () => new URL(server.getUrl()).origin
  const cookieNames = async () =>
    (await browser.session.cookies.get({ url: server.getUrl() })).map((cookie) => cookie.name)

  it('settings() answers with Chrome’s three objects', async () => {
    const result: any = await exec('browsingData.settings')
    expect(result.ok).to.equal(true)
    expect(result.value).to.have.keys('options', 'dataToRemove', 'dataRemovalPermitted')
    expect(result.value.dataRemovalPermitted.cookies).to.equal(true)
  })

  it('removeCookies() removes the session’s cookies', async () => {
    await browser.session.cookies.set({ url: server.getUrl(), name: 'gone', value: '1' })
    expect(await cookieNames()).to.include('gone')
    expect(await exec('browsingData.removeCookies', {})).to.deep.equal({ ok: true })
    expect(await cookieNames()).to.not.include('gone')
  })

  it('remove() with origins clears that origin’s local storage', async () => {
    await browser.webContents.executeJavaScript(`localStorage.setItem('kept', 'yes')`)
    const result = await exec(
      'browsingData.remove',
      { origins: [origin()] },
      { localStorage: true },
    )
    expect(result).to.deep.equal({ ok: true })
    await browser.webContents.loadURL(server.getUrl())
    expect(await browser.webContents.executeJavaScript(`localStorage.getItem('kept')`)).to.equal(
      null,
    )
  })

  it('refuses a time range over site data, and removes nothing', async () => {
    await browser.session.cookies.set({ url: server.getUrl(), name: 'stays', value: '1' })
    const result: any = await exec(
      'browsingData.remove',
      { since: Date.now() - 3600_000 },
      { cookies: true },
    )
    expect(result.ok).to.equal(false)
    expect(result.error).to.match(/time range/)
    expect(await cookieNames()).to.include('stays')
  })

  it('refuses local storage for every origin, which would take every extension’s with it', async () => {
    const result: any = await exec('browsingData.removeLocalStorage', {})
    expect(result.ok).to.equal(false)
    expect(result.error).to.match(/pass origins/)
  })

  it('succeeds with nothing to do for data this host does not keep', async () => {
    expect(await exec('browsingData.removeHistory', {})).to.deep.equal({ ok: true })
    expect(await exec('browsingData.removePasswords', {})).to.deep.equal({ ok: true })
  })
})
