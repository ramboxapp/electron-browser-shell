import { expect } from 'chai'
import * as http from 'node:http'
import { AddressInfo } from 'node:net'

import { useExtensionBrowser } from './hooks'

/**
 * `chrome.tabs.detectLanguage`.
 *
 * The method did not exist, so calling it threw `chrome.tabs.detectLanguage is not a function` —
 * measured in Rambox's catalog, where Dashlane calls it from 3 places and Google Translate from 1.
 *
 * Chrome runs CLD over the page text, which Electron cannot do. This reads what the page DECLARES
 * and answers `'und'` otherwise, which is Chrome's own value for "could not determine". The tests
 * below are mostly about that boundary: a declared language is reported, and anything else is
 * undetermined rather than guessed.
 */
describe('chrome.tabs.detectLanguage', () => {
  let server: http.Server
  let url: string

  // One route per thing a real page does with its language.
  const pages: Record<string, string> = {
    '/es': '<!doctype html><html lang="es"><title>es</title><body>hola',
    '/en-us': '<!doctype html><html lang="en-us"><title>en-us</title><body>hello',
    '/messy': '<!doctype html><html lang="  EN_gb "><title>messy</title><body>hello',
    '/list': '<!doctype html><html lang="en, fr"><title>list</title><body>hello',
    '/meta':
      '<!doctype html><html><head><meta http-equiv="Content-Language" content="pt-BR"></head><body>ola',
    '/none': '<!doctype html><html><title>none</title><body>text with no declared language',
    '/garbage': '<!doctype html><html lang="!!!"><title>garbage</title><body>text',
  }

  before(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(pages[(req.url || '').split('?')[0]] ?? pages['/none'])
    })
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        resolve()
      }),
    )
  })

  after(() => {
    server.close()
  })

  const browser = useExtensionBrowser({
    url: () => `${url}/none`,
    extensionName: 'rpc-mv3',
  })

  const detectAt = async (route: string) => {
    await browser.window.webContents.loadURL(`${url}${route}`)
    return browser.crx.exec('tabs.detectLanguage')
  }

  it('reports a language the page declares', async () => {
    expect(await detectAt('/es')).to.equal('es')
  })

  it('reports region the way Chrome does, lowercase language and uppercase region', async () => {
    expect(await detectAt('/en-us')).to.equal('en-US')
    // Whitespace and an underscore are both things real pages ship.
    expect(await detectAt('/messy')).to.equal('en-GB')
  })

  it('takes the first entry of a list', async () => {
    expect(await detectAt('/list')).to.equal('en')
  })

  it('falls back to the content-language meta', async () => {
    expect(await detectAt('/meta')).to.equal('pt-BR')
  })

  it("answers 'und' when the page declares nothing", async () => {
    // Chrome would read the text with CLD and say 'en'. This cannot, and says so in Chrome's own
    // vocabulary instead of guessing — the whole point of the method is that the caller can tell.
    expect(await detectAt('/none')).to.equal('und')
  })

  it("answers 'und' rather than passing through something that is not a language", async () => {
    expect(await detectAt('/garbage')).to.equal('und')
  })

  it('accepts an explicit tabId', async () => {
    await browser.window.webContents.loadURL(`${url}/es`)
    const tabId = browser.window.webContents.id
    expect(await browser.crx.exec('tabs.detectLanguage', tabId)).to.equal('es')
  })

  it("answers 'und' for a tab that does not exist", async () => {
    expect(await browser.crx.exec('tabs.detectLanguage', 999999)).to.equal('und')
  })
})
