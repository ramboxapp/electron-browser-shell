import { expect } from 'chai'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { useExtensionBrowser, useServer } from './hooks'

const FIXTURES = path.join(__dirname, 'fixtures')

/**
 * What a real blocker's static rulesets need, and which part of it Electron's DNR actually honors.
 *
 * uBlock 25.5.0 ships 29 static rulesets with 1,223,636 rules between them, every one declared
 * `"enabled": false`, and enables three of them itself at startup (~90,000 rules) using `urlFilter`,
 * `regexFilter`, `modifyHeaders`, `redirect` and `allowAllRequests`. In Rambox it reports those three
 * as enabled and then blocks **nothing at all** — `getMatchedRules()` stays empty and known ad hosts
 * load. The window-level and tab-level specs next door prove a small static ruleset does block, so
 * these isolate what is different about a real one: how many rules the engine accepts, and what one
 * unsupported rule does to the ruleset holding it.
 */
describe('declarativeNetRequest static ruleset limits', () => {
  const server = useServer()
  let dir: string

  /** A ruleset file plus the manifest entry that declares it, disabled like uBlock declares its own. */
  const RULESETS = {
    plain: [
      {
        id: 1,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: 'limits-plain', resourceTypes: ['xmlhttprequest'] },
      },
    ],
    // A plain rule and a regexFilter rule in ONE ruleset: the question is whether the regex rule
    // takes the plain one down with it.
    mixed: [
      {
        id: 1,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: 'limits-mixed-plain', resourceTypes: ['xmlhttprequest'] },
      },
      {
        id: 2,
        priority: 1,
        action: { type: 'block' },
        condition: { regexFilter: 'limits-mixed-regex.*', resourceTypes: ['xmlhttprequest'] },
      },
    ],
    // modifyHeaders and allowAllRequests, the other two action types a real blocker uses.
    actions: [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'x-crx-test', operation: 'set', value: '1' }],
        },
        condition: { urlFilter: 'limits-actions-header', resourceTypes: ['xmlhttprequest'] },
      },
      {
        id: 2,
        priority: 1,
        action: { type: 'block' },
        condition: { urlFilter: 'limits-actions-plain', resourceTypes: ['xmlhttprequest'] },
      },
    ],
    /*
			The dimension a real blocker's rules are actually made of: who ASKED for the request. uBlock's
			generated rules lean on `initiatorDomains`, `excludedInitiatorDomains` and
			`domainType: 'thirdParty'`, none of which a urlFilter-only rule exercises — and in an embedder
			the requesting document is a <webview> guest, so the initiator the engine computes for it is
			the open question.
		*/
    initiator: [
      {
        id: 1,
        priority: 1,
        action: { type: 'block' },
        condition: {
          urlFilter: 'limits-initiator',
          initiatorDomains: ['127.0.0.1'],
          resourceTypes: ['xmlhttprequest'],
        },
      },
    ],
    thirdparty: [
      {
        id: 1,
        priority: 1,
        action: { type: 'block' },
        condition: {
          urlFilter: 'limits-thirdparty',
          domainType: 'thirdParty',
          resourceTypes: ['xmlhttprequest'],
        },
      },
    ],
    /*
      uBlock's exact shape: three rulesets declared disabled, enabled together in one call, 44k + 44k +
      772 rules. Measured in the app, that charges the budget exactly 30,000 — the guaranteed minimum —
      instead of the ~89,651 it asks for, and nothing gets blocked. These three reproduce it in
      isolation.
    */
    big1: Array.from({ length: 44000 }, (_unused, i) => ({
      id: i + 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: `limits-big1-${i}`, resourceTypes: ['xmlhttprequest'] },
    })),
    big2: Array.from({ length: 44000 }, (_unused, i) => ({
      id: i + 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: `limits-big2-${i}`, resourceTypes: ['xmlhttprequest'] },
    })),
    small: Array.from({ length: 772 }, (_unused, i) => ({
      id: i + 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: `limits-small-${i}`, resourceTypes: ['xmlhttprequest'] },
    })),
    // 40,000 trivial rules: more than Chrome's guaranteed 30,000 minimum, far less than uBlock's 90,000.
    bulk: Array.from({ length: 40000 }, (_unused, i) => ({
      id: i + 1,
      priority: 1,
      action: { type: 'block' },
      condition: { urlFilter: `limits-bulk-${i}`, resourceTypes: ['xmlhttprequest'] },
    })),
  }

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'crx-dnr-limits-'))
    // The dnr fixture already carries the rpc plumbing the specs drive; only its rulesets change.
    await fs.cp(path.join(FIXTURES, 'dnr'), dir, { recursive: true })
    const manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8'))
    manifest.declarative_net_request = {
      rule_resources: Object.keys(RULESETS).map((id) => ({
        id,
        enabled: false,
        path: `${id}.json`,
      })),
    }
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
    for (const [id, rules] of Object.entries(RULESETS)) {
      await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(rules))
    }
  })

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  const browser = useExtensionBrowser({ url: server.getUrl, extensionPath: () => dir })

  const api = (method: string, ...args: any[]) => browser.crx.raw({ type: 'api', method, args })
  const enable = (ids: string[]) =>
    api('declarativeNetRequest.updateEnabledRulesets', { enableRulesetIds: ids })
  const enabled = () => api('declarativeNetRequest.getEnabledRulesets') as Promise<string[]>
  const availableCount = () =>
    api('declarativeNetRequest.getAvailableStaticRuleCount') as Promise<number>
  const fetchResult = (marker: string) =>
    browser.webContents.executeJavaScript(
      `fetch('${server.getUrl()}${marker}').then(() => 'fetched', () => 'blocked')`,
    ) as Promise<'fetched' | 'blocked'>

  it('reports a static rule budget at all', async () => {
    const count = await availableCount()
    // Chrome reports what is left of its static rule budget. Whatever the number, it tells us how
    // much of uBlock's 90,000 the engine was ever going to accept.
    console.log(`[dnr] getAvailableStaticRuleCount() = ${JSON.stringify(count)}`)
    expect(count).to.be.a('number')
  })

  it('enables and enforces a plain static ruleset at runtime', async () => {
    await enable(['plain'])
    expect(await enabled()).to.include('plain')
    expect(await fetchResult('limits-plain')).to.equal('blocked')
  })

  it('does not let one regexFilter rule take down its whole ruleset', async () => {
    await enable(['mixed'])
    const list = await enabled()
    console.log(`[dnr] after enabling 'mixed': ${JSON.stringify(list)}`)
    expect(list, 'the ruleset with a regexFilter rule did not enable at all').to.include('mixed')
    // The plain rule in the same file is what matters: if it stops blocking, one unsupported rule
    // poisons the ruleset — which is exactly what a real blocker's rulesets are full of.
    expect(
      await fetchResult('limits-mixed-plain'),
      'the plain rule in a ruleset that also has a regex rule',
    ).to.equal('blocked')
  })

  it('does not let modifyHeaders take down its whole ruleset', async () => {
    await enable(['actions'])
    expect(await enabled()).to.include('actions')
    expect(
      await fetchResult('limits-actions-plain'),
      'the plain rule in a ruleset that also has a modifyHeaders rule',
    ).to.equal('blocked')
  })

  it('matches a rule keyed on the initiator domain', async () => {
    await enable(['initiator'])
    expect(await enabled()).to.include('initiator')
    // The page is served from 127.0.0.1, which is what the rule names as the initiator.
    expect(
      await fetchResult('limits-initiator'),
      'initiatorDomains rule, request from the window',
    ).to.equal('blocked')
  })

  it('matches a thirdParty rule', async () => {
    await enable(['thirdparty'])
    expect(await enabled()).to.include('thirdparty')
    // Same server, different host string: a page on 127.0.0.1 asking localhost is third-party.
    const url = server.getUrl().replace('127.0.0.1', 'localhost')
    const result = (await browser.webContents.executeJavaScript(
      `fetch('${url}limits-thirdparty').then(() => 'fetched', () => 'blocked')`,
    )) as 'fetched' | 'blocked'
    expect(result, 'domainType thirdParty rule, request from the window').to.equal('blocked')
  })

  it('enables three big rulesets at once the way a real blocker does', async () => {
    const before = await availableCount()
    await enable(['big1', 'big2', 'small'])
    const list = await enabled()
    const after = await availableCount()
    const asked = 44000 + 44000 + 772
    console.log(
      `[dnr] three rulesets: enabled ${JSON.stringify(list)}, budget ${before} -> ${after} (charged ${before - after} for ${asked} rules)`,
    )

    expect(list, 'not all three rulesets enabled').to.include.members(['big1', 'big2', 'small'])
    // The budget has to reflect what was asked for. Charging the guaranteed minimum and silently
    // dropping the rest is how uBlock ends up enabled and inert.
    expect(
      before - after,
      'the engine charged a different number of rules than the rulesets hold',
    ).to.equal(asked)
    expect(await fetchResult('limits-big1-0'), 'first rule of the first big ruleset').to.equal(
      'blocked',
    )
    expect(await fetchResult('limits-big2-43999'), 'last rule of the second big ruleset').to.equal(
      'blocked',
    )
    expect(await fetchResult('limits-small-0'), 'first rule of the small ruleset').to.equal(
      'blocked',
    )
  })

  it('accepts a ruleset bigger than Chrome’s guaranteed minimum', async () => {
    await enable(['bulk'])
    const list = await enabled()
    console.log(
      `[dnr] after enabling 'bulk' (40k rules): ${JSON.stringify(list)}, budget left ${JSON.stringify(await availableCount())}`,
    )
    expect(list, '40,000 static rules did not enable').to.include('bulk')
    expect(await fetchResult('limits-bulk-0'), 'the first rule of a 40,000-rule ruleset').to.equal(
      'blocked',
    )
    expect(
      await fetchResult('limits-bulk-39999'),
      'the last rule of a 40,000-rule ruleset',
    ).to.equal('blocked')
  })
})
