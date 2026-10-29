import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

/*
  chrome.instanceID: the local half is real (a stable id per extension, kept in the session), the
  token half fails as gcm.register does, since tokens need Google's servers.
*/
describe('chrome.instanceID', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'floor-mv3' })

  const exec = (method: string, ...args: any[]) => browser.crx.raw({ type: 'api', method, args })

  it('getID() is stable until deleteID(), and getCreationTime() is when it was made', async () => {
    const before = Date.now()
    const first: any = await exec('instanceID.getID')
    expect(first.value).to.be.a('string').with.length(11)
    expect((await exec('instanceID.getID')).value).to.equal(first.value)

    const created: any = await exec('instanceID.getCreationTime')
    expect(created.value).to.be.within(before - 1000, Date.now())

    expect(await exec('instanceID.deleteID')).to.deep.equal({ ok: true })
    expect((await exec('instanceID.getID')).value).to.not.equal(first.value)
  })

  it('getToken() fails the way gcm.register does', async () => {
    expect(
      await exec('instanceID.getToken', { authorizedEntity: '1', scope: 'GCM' }),
    ).to.deep.equal({
      ok: false,
      error: 'UNKNOWN_ERROR',
    })
  })
})
