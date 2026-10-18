const esbuild = require('esbuild')

function createConfig(opts = {}) {
  const prod = process.env.NODE_ENV === 'production'
  // esbuild substitutes process.env.NODE_ENV on its own for platform:'browser' bundles: "production"
  // when minify is on, "development" otherwise. minify is always false here, so every dev-only branch
  // in the preload shipped LIVE — including the `console.log(fnName, args)` and
  // `console.log(fnName, '(result)', result)` in src/renderer/index.ts, which logged every single
  // chrome.* call with its arguments and its result in released builds. Defining it explicitly makes
  // those branches dead code in a production build, and leaves them intact in a development one.
  const nodeEnv = { 'process.env.NODE_ENV': JSON.stringify(prod ? 'production' : 'development') }
  const define =
    opts.format === 'esm'
      ? {
          ...nodeEnv,
          ...opts.define,
          __dirname: 'import.meta.dirname',
        }
      : {
          ...nodeEnv,
          ...opts.define,
        }
  return {
    bundle: true,
    platform: opts.platform || 'node',
    target: 'es2020',
    sourcemap: !prod,
    minify: false,
    external: [],
    loader: {
      '.ts': 'ts',
      '.tsx': 'tsx',
      '.css': 'css',
    },
    ...opts,
    define,
  }
}

function build(config) {
  esbuild.build(config).catch(() => process.exit(1))
}

const EXTERNAL_BASE = [
  'node:crypto',
  'node:events',
  'node:fs',
  'node:module',
  'node:os',
  'node:path',
  'node:stream',
  'node:stream/promises',
  'electron',
  'debug',
]

module.exports = { createConfig, build, EXTERNAL_BASE }
