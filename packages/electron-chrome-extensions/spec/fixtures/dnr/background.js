/* global chrome */

// Minimal RPC background for the chrome.declarativeNetRequest spec. Only the
// 'api' dispatcher is needed (updateDynamicRules, getDynamicRules,
// updateSessionRules, getEnabledRulesets, ...).

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  switch (message.type) {
    case 'api': {
      const { method, args } = message
      const [apiName, subMethod] = method.split('.')
      if (chrome[apiName] && typeof chrome[apiName][subMethod] === 'function') {
        const ret = chrome[apiName][subMethod](...args, reply)
        if (ret && typeof ret.then === 'function') {
          ret.then(
            (value) => {
              if (value !== undefined) reply(value)
            },
            (err) => reply({ __error__: String((err && err.message) || err) }),
          )
        }
      } else {
        reply({ __error__: `missing method: ${method} (typeof ${apiName}=${typeof chrome[apiName]})` })
      }
      break
    }
  }

  return true
})

console.log('background-script-evaluated')
