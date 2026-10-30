import { expect } from 'chai'

import { useExtensionBrowser, useServer } from './hooks'

/*
  Electron answers getPlatformInfo with `arch` and `os`; Chrome adds `nacl_arch` (Chromium 147 and
  Edge 156 on Windows x64: { arch: 'x86-64', nacl_arch: 'x86-64', os: 'win' }). The rest of what the
  plan listed for runtime — setUninstallURL, restart, restartAfterDelay, onRestartRequired,
  onUpdateAvailable — Electron 44.9.3 already answers as Chromium 147 does, so it is asserted here
  only so that a future Electron that changes it shows up.
*/
describe('chrome.runtime platform and lifecycle', () => {
  const server = useServer()
  const browser = useExtensionBrowser({ url: server.getUrl, extensionName: 'rpc-mv3' })
  const outcome = (method: string, ...args: any[]): Promise<any> =>
    browser.crx.raw({ type: 'outcome', method, args })

  it('answers getPlatformInfo with nacl_arch, in both shapes', async () => {
    const { value } = await outcome('runtime.getPlatformInfo')
    expect(Object.keys(value).sort()).to.deep.equal(['arch', 'nacl_arch', 'os'])
    expect(value.nacl_arch).to.equal(value.arch === 'arm64' ? 'arm' : value.arch)
    const callback = await browser.crx.raw({
      type: 'outcome-callback',
      method: 'runtime.getPlatformInfo',
    })
    expect(callback.lastError).to.equal(null)
    expect(callback.value).to.deep.equal(value)
  })

  it('accepts an uninstall URL and refuses one that is not http(s)', async () => {
    expect(await outcome('runtime.setUninstallURL', 'https://example.com/bye')).to.deep.equal({
      value: '__undefined__',
    })
    expect(await outcome('runtime.setUninstallURL', 'ftp://example.com/')).to.deep.equal({
      error: 'Invalid URL: "ftp://example.com/".',
    })
  })

  it('refuses restartAfterDelay outside ChromeOS kiosk mode, as Chrome does', async () => {
    expect(await outcome('runtime.restartAfterDelay', 5)).to.deep.equal({
      error: 'API available only for ChromeOS kiosk mode.',
    })
  })
})
