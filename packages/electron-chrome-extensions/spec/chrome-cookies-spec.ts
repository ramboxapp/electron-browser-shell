import { expect } from 'chai'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { useExtensionBrowser, useServer } from './hooks'

/*
  chrome.cookies only shows an extension the cookies of hosts its host permissions cover. Measured
  in Chromium 147 with an extension holding `*://example.com/*`: a cookie set by an example.org page
  fires no cookies.onChanged there and is not in getAll, while one set by example.com is both — and
  with `https://example.com/*` alone even example.com's non-secure cookie is invisible, because
  Chrome checks a cookie against http:// unless it is secure. This library broadcast every cookie
  change to every extension with the cookies permission, and getAll returned every cookie.

  The fixture is the MV3 RPC extension with the cookies permission and a host permission for the
  test server's host only.
*/
describe('chrome.cookies and host permissions', () => {
  const server = useServer()
  let extensionDir: string

  before(() => {
    extensionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crx-cookies-'))
    fs.cpSync(path.join(__dirname, 'fixtures', 'rpc-mv3'), extensionDir, { recursive: true })
    const manifestPath = path.join(extensionDir, 'manifest.json')
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
    manifest.permissions = [...manifest.permissions, 'cookies']
    manifest.host_permissions = ['http://127.0.0.1/*']
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
  })

  after(() => {
    fs.rmSync(extensionDir, { recursive: true, force: true })
  })

  const browser = useExtensionBrowser({ url: server.getUrl, extensionPath: () => extensionDir })

  it("fires onChanged only for a host the extension may access, with Chrome's cause", async () => {
    await browser.crx.raw({ type: 'record-events', names: ['cookies.onChanged'] })
    await browser.session.cookies.set({
      url: 'http://uncovered.invalid/',
      name: 'other',
      value: '1',
    })
    await browser.session.cookies.set({ url: 'http://127.0.0.1/', name: 'covered', value: '1' })
    await new Promise((resolve) => setTimeout(resolve, 500))
    const events = await browser.crx.raw({ type: 'recorded', name: 'cookies.onChanged' })
    expect(
      events.map(([info]: any[]) => [info.cookie.name, info.cause, info.removed]),
    ).to.deep.equal([['covered', 'explicit', false]])
  })

  it('lists only the cookies of hosts the extension may access', async () => {
    await browser.session.cookies.set({
      url: 'http://uncovered.invalid/',
      name: 'other',
      value: '1',
    })
    await browser.session.cookies.set({ url: 'http://127.0.0.1/', name: 'covered', value: '1' })
    const { value } = await browser.crx.raw({
      type: 'outcome',
      method: 'cookies.getAll',
      args: [{}],
    })
    expect(value.map((cookie: any) => cookie.name)).to.deep.equal(['covered'])
  })
})
