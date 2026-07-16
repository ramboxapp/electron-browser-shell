#!/usr/bin/env node

const childProcess = require('child_process')
const path = require('path')
const unknownFlags = []

require('colors')
const pass = '✓'.green
const fail = '✗'.red

const args = require('minimist')(process.argv, {
  string: ['target'],
  unknown: (arg) => unknownFlags.push(arg),
})

const unknownArgs = []
for (const flag of unknownFlags) {
  unknownArgs.push(flag)
  const onlyFlag = flag.replace(/^-+/, '')
  if (args[onlyFlag]) {
    unknownArgs.push(args[onlyFlag])
  }
}

async function main() {
  await runElectronTests()
}

async function runElectronTests() {
  const errors = []

  const testResultsDir = process.env.ELECTRON_TEST_RESULTS_DIR

  try {
    console.info('\nRunning:')
    if (testResultsDir) {
      process.env.MOCHA_FILE = path.join(testResultsDir, `test-results.xml`)
    }
    await runMainProcessElectronTests()
  } catch (err) {
    errors.push([err])
  }

  if (errors.length !== 0) {
    for (const err of errors) {
      console.error('\n\nRunner Failed:', err[0])
      console.error(err[1])
    }
    console.log(`${fail} Electron test runners have failed`)
    process.exit(1)
  }
}

async function runMainProcessElectronTests() {
  let exe = require('electron')
  const runnerArgs = ['spec', ...unknownArgs.slice(2)]

  // Chromium hard-refuses to run as root without --no-sandbox, so keep the
  // flag for root-only environments (e.g. docker/WSL as root). Everywhere
  // else the sandbox must stay ON: Electron skips service worker preload
  // scripts under --no-sandbox (see README), which silently breaks every spec
  // relying on injected chrome.* APIs in MV3 service workers. CI runners get
  // a working sandbox via the apparmor_restrict_unprivileged_userns sysctl in
  // the workflow.
  if (
    process.platform === 'linux' &&
    typeof process.getuid === 'function' &&
    process.getuid() === 0
  ) {
    console.warn('Running as root: disabling sandbox. MV3 service worker specs will fail.')
    runnerArgs.push('--no-sandbox')
  }

  const { status, signal } = childProcess.spawnSync(exe, runnerArgs, {
    cwd: path.resolve(__dirname, '..'),
    env: process.env,
    stdio: 'inherit',
  })
  if (status !== 0) {
    if (status) {
      const textStatus =
        process.platform === 'win32' ? `0x${status.toString(16)}` : status.toString()
      console.log(`${fail} Electron tests failed with code ${textStatus}.`)
    } else {
      console.log(`${fail} Electron tests failed with kill signal ${signal}.`)
    }
    process.exit(1)
  }
  console.log(`${pass} Electron main process tests passed.`)
}

main().catch((error) => {
  console.error('An error occurred inside the spec runner:', error)
  process.exit(1)
})
