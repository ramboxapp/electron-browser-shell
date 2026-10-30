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

  /*
    get, set and remove check the URL the extension passes, with its own scheme (measured in
    Chromium 147 on 30/10/2026): without a host permission for it they fail with "No host permissions
    for cookies at url", the promise rejects and a callback gets nothing with that `lastError`. An
    unparseable URL fails first with "Invalid url". These three were not filtered at all.
  */
  describe('get, set and remove without a host permission', () => {
    const noPermission = 'No host permissions for cookies at url: "http://uncovered.invalid/".'

    for (const [method, details] of [
      ['cookies.get', { url: 'http://uncovered.invalid/', name: 'other' }],
      ['cookies.set', { url: 'http://uncovered.invalid/', name: 'other', value: '2' }],
      ['cookies.remove', { url: 'http://uncovered.invalid/', name: 'other' }],
    ] as const) {
      it(`${method} rejects, and its callback gets nothing with lastError`, async () => {
        await browser.session.cookies.set({
          url: 'http://uncovered.invalid/',
          name: 'other',
          value: '1',
        })
        const promised = await browser.crx.raw({ type: 'outcome', method, args: [details] })
        expect(promised).to.deep.equal({ error: noPermission })
        const called = await browser.crx.raw({
          type: 'outcome-callback',
          method,
          args: [details],
        })
        expect(called).to.deep.equal({ value: '__undefined__', lastError: noPermission })
        // And the cookie the extension could not touch is untouched.
        const [cookie] = await browser.session.cookies.get({
          url: 'http://uncovered.invalid/',
          name: 'other',
        })
        expect(cookie.value).to.equal('1')
      })
    }

    it('checks the scheme of the URL passed, not the cookie', async () => {
      const { error } = await browser.crx.raw({
        type: 'outcome',
        method: 'cookies.get',
        args: [{ url: 'https://127.0.0.1/', name: 'covered' }],
      })
      expect(error).to.equal('No host permissions for cookies at url: "https://127.0.0.1/".')
    })

    it('fails an unparseable URL with "Invalid url"', async () => {
      const { error } = await browser.crx.raw({
        type: 'outcome',
        method: 'cookies.remove',
        args: [{ url: 'not a url', name: 'covered' }],
      })
      expect(error).to.equal('Invalid url: "not a url".')
    })

    it('answers a covered host as before, on any port, and remove with {name, storeId, url}', async () => {
      await browser.session.cookies.set({ url: 'http://127.0.0.1/', name: 'covered', value: '1' })
      const got = await browser.crx.raw({
        type: 'outcome',
        method: 'cookies.get',
        args: [{ url: 'http://127.0.0.1:8123/', name: 'covered' }],
      })
      expect(got.value.name).to.equal('covered')
      const removed = await browser.crx.raw({
        type: 'outcome',
        method: 'cookies.remove',
        args: [{ url: 'http://127.0.0.1/', name: 'covered' }],
      })
      expect(removed.value).to.deep.equal({
        name: 'covered',
        storeId: '0',
        url: 'http://127.0.0.1/',
      })
    })
  })
})
