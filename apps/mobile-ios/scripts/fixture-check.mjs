#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node */
// The simulator check of the native iPhone app against the isolated fixture
// stack (fixture-stack.mjs: a local OpenID Connect provider, the relay and an
// Echo-only server, all on 127.0.0.1). It brings the stack up with every
// pairing approved on sight, boots the simulator when it is not booted, runs
// the UI tests with xcodebuild, tears the stack down and exits with
// xcodebuild's code.
//
//   node apps/mobile-ios/scripts/fixture-check.mjs --udid <simulator udid>
//        [--only ClaveUITests/FixtureFlowTests] [--derived <DerivedData path>]
//        [--server 47101] [--relay 47102] [--tmpdir /private/tmp/clave-native-a/stack]
//        [--push <payload.json>] [--keep]
//
// The tests read the stack through TEST_RUNNER_CLAVE_FIXTURE_* variables
// (xcodebuild hands TEST_RUNNER_-prefixed variables to the test runner,
// without the prefix). The owner's token is never passed. xcodebuild's full
// output goes to <tmpdir>/logs/xcodebuild.log; stdout carries only the test,
// error and build lines. --push sends <payload.json> to the app on the
// simulator after the tests (xcrun simctl push). --keep leaves the stack up
// until Ctrl-C. The run's summary is written to <tmpdir>/check.json.
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { REPO, factLines, parseStackArgs, startStack } from './fixture-stack.mjs'

const BUNDLE_ID = 'com.clave.ios.dev'
// The test lines, the errors and the "** TEST SUCCEEDED **" / "** BUILD FAILED **" verdicts;
// a bare TEST or BUILD would also match build-setting names in the compile lines.
const SHOWN = /Test Case|Test Suite|error:|\*\* (TEST|BUILD)/

function arg(name, fallback) {
  const argv = process.argv
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback
}

const log = (line) => process.stdout.write(`fixture-check: ${line}\n`)

function simulatorState(udid) {
  const list = JSON.parse(
    execFileSync('xcrun', ['simctl', 'list', 'devices', '-j'], { encoding: 'utf8' })
  )
  for (const devices of Object.values(list.devices))
    for (const device of devices) if (device.udid === udid) return device.state
  return null
}

/** Runs xcodebuild, its output to the log file and the shown lines to stdout. */
function runXcodebuild(args, env, logFile) {
  return new Promise((resolve) => {
    const file = createWriteStream(logFile, { flags: 'a' })
    const child = spawn('xcodebuild', args, {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let pending = ''
    const onData = (d) => {
      const text = String(d)
      file.write(text)
      pending += text
      let nl
      while ((nl = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, nl)
        pending = pending.slice(nl + 1)
        if (SHOWN.test(line)) process.stdout.write(`${line}\n`)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    const forward = (signal) => child.kill(signal)
    process.on('SIGINT', forward)
    process.on('SIGTERM', forward)
    child.once('exit', (code, signal) => {
      process.off('SIGINT', forward)
      process.off('SIGTERM', forward)
      if (pending && SHOWN.test(pending)) process.stdout.write(`${pending}\n`)
      file.end(() => resolve(code ?? (signal ? 1 : 0)))
    })
  })
}

async function main() {
  const udid = arg('udid')
  if (!udid) {
    process.stderr.write('fixture-check: --udid <simulator udid> is required\n')
    process.exit(2)
  }
  const derived = path.resolve(arg('derived', '/private/tmp/clave-native-a/DerivedData-check'))
  const only = arg('only', 'ClaveUITests/FixtureFlowTests')
  const push = arg('push')
  const keep = process.argv.includes('--keep')
  const options = parseStackArgs(process.argv.slice(2))
  const startedAt = new Date().toISOString()

  const state = simulatorState(udid)
  if (state === null) {
    process.stderr.write(`fixture-check: no simulator ${udid} (xcrun simctl list devices)\n`)
    process.exit(2)
  }

  let stack
  try {
    stack = await startStack({ ...options, approve: true })
  } catch (err) {
    process.stderr.write(`fixture-check: ${err.message}\n`)
    process.exit(1)
  }
  for (const line of factLines(stack)) log(line)

  let booted = false
  let exitCode = 1
  const resultBundle = path.join(
    stack.tmpdir,
    'results',
    `${startedAt.replace(/[:.]/g, '-')}.xcresult`
  )
  try {
    if (state !== 'Booted') {
      log(`booting simulator ${udid} (was ${state})`)
      execFileSync('xcrun', ['simctl', 'boot', udid], { stdio: 'ignore' })
      booted = true
    } else log(`simulator ${udid} already booted`)

    mkdirSync(path.dirname(resultBundle), { recursive: true })
    const env = {
      TEST_RUNNER_CLAVE_FIXTURE_ISSUER_URL: stack.issuer,
      TEST_RUNNER_CLAVE_FIXTURE_RELAY_URL: stack.relay,
      TEST_RUNNER_CLAVE_FIXTURE_SERVER_URL: stack.server,
      TEST_RUNNER_CLAVE_FIXTURE_MACHINE_ID: stack.machineId,
      TEST_RUNNER_CLAVE_FIXTURE_SESSION_ID: stack.sessionId,
      TEST_RUNNER_CLAVE_FIXTURE_NONCE: stack.nonce
    }
    log(
      `xcodebuild test -only-testing:${only} (full output in ${stack.tmpdir}/logs/xcodebuild.log)`
    )
    exitCode = await runXcodebuild(
      [
        '-project',
        'apps/mobile-ios/Clave.xcodeproj',
        '-scheme',
        'Clave',
        '-destination',
        `platform=iOS Simulator,id=${udid}`,
        '-derivedDataPath',
        derived,
        '-resultBundlePath',
        resultBundle,
        'test',
        `-only-testing:${only}`
      ],
      env,
      path.join(stack.tmpdir, 'logs', 'xcodebuild.log')
    )
    log(`xcodebuild exited ${exitCode}`)

    if (push) {
      log(`pushing ${push} to ${BUNDLE_ID}`)
      execFileSync('xcrun', ['simctl', 'push', udid, BUNDLE_ID, path.resolve(push)], {
        stdio: 'inherit'
      })
    }

    if (keep) {
      log('--keep: the stack stays up; Ctrl-C stops it')
      await new Promise((resolve) => {
        process.once('SIGINT', resolve)
        process.once('SIGTERM', resolve)
      })
    }
  } catch (err) {
    process.stderr.write(`fixture-check: ${err.message}\n`)
    if (exitCode === 0) exitCode = 1
  } finally {
    await stack.stop()
    log('stack stopped')
    if (booted) {
      log(`shutting down simulator ${udid} (this check booted it)`)
      try {
        execFileSync('xcrun', ['simctl', 'shutdown', udid], { stdio: 'ignore' })
      } catch (err) {
        process.stderr.write(`fixture-check: shutdown failed: ${err.message}\n`)
      }
    }
    writeFileSync(
      path.join(stack.tmpdir, 'check.json'),
      JSON.stringify(
        { startedAt, finishedAt: new Date().toISOString(), udid, only, exitCode, resultBundle },
        null,
        2
      ) + '\n'
    )
  }
  process.exit(exitCode)
}

await main()
