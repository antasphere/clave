#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node */
// The simulator check of the native iPhone app against the isolated fixture
// stack (fixture-stack.mjs: a local OpenID Connect provider, the relay and an
// Echo-only server, all on 127.0.0.1). It brings the stack up with every
// pairing approved on sight, boots the simulator when it is not booted, runs
// the UI tests with xcodebuild and tears the stack down. It exits 0 only when
// xcodebuild exited 0 AND the FixtureFlowTests suite's own "Executed …" line
// says 4 tests executed, none skipped, none failed (fixtureVerdict below): the
// tests skip when a fixture variable is missing or empty, so a run where they
// skip, or where fewer of them run, proves nothing and is red, each reading
// with its own sentence, exit xcodebuild's code when it failed, else 1. It
// exits 2 when the recorders were not silent or the run keychain's bracket
// failed (the user's keychain search list moved during the run, or the run
// keychain was not deleted), whatever the tests said.
//
//   node apps/mobile-ios/scripts/fixture-check.mjs --udid <simulator udid>
//        [--only ClaveUITests/FixtureFlowTests] [--derived <DerivedData path>]
//        [--server 47101] [--relay 47102] [--tmpdir /private/tmp/clave-native-a/stack]
//        [--push <payload.json>] [--keep]
//   node apps/mobile-ios/scripts/fixture-check.mjs --prove-verdict
//
// --derived defaults to <tmpdir>-DerivedData, the sibling of the run folder
// named from the caller's own --tmpdir: the stack empties the run folder at
// every start (prepareRunFolder removes every entry but the marker it
// rewrites), so a build folder inside it would never outlive one check.
// --only narrows what xcodebuild runs, never the verdict: a run that leaves out
// any of the four FixtureFlowTests is red. --prove-verdict runs fixtureVerdict
// on canned xcodebuild outputs and prints PASS or FAIL per case, exit 0 only
// when every case gives the expected verdict; it boots nothing and runs no
// xcodebuild.
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
import { REPO, factLines, parseStackArgs, runKeychainFaults, startStack } from './fixture-stack.mjs'

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

/** The test methods of ClaveUITests/FixtureFlowTests.swift: a green check ran every one. */
const FIXTURE_TESTS = 4
/** The FixtureFlowTests suite's end line, after which xcodebuild prints the suite's own count. */
const SUITE_END = /^Test Suite 'FixtureFlowTests' (?:passed|failed) at /
/** "Executed N tests, with F failures (…" or "Executed N tests, with S tests skipped and F failures (…". */
const EXECUTED = /^\s*Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?(\d+) failures? \(/

/**
 * The check's verdict, decided here and nowhere else, from xcodebuild's exit
 * code and its whole output. Green only when xcodebuild exited 0 and the line
 * the FixtureFlowTests suite prints after its own end line (never an
 * enclosing suite's) reads FIXTURE_TESTS executed, 0 skipped, 0 failures.
 * Every other reading is a problem with its own sentence, its kind one of
 * xcodebuild, missing, count, skipped, failures; a red verdict's exit code is
 * xcodebuild's when it failed, else 1. A watch hit or a keychain fault turns
 * any verdict into exit 2 after it (main). Pure: no file, process or clock.
 */
function fixtureVerdict(xcodebuildExit, output) {
  const problems = []
  if (xcodebuildExit !== 0)
    problems.push({ kind: 'xcodebuild', sentence: `xcodebuild exited ${xcodebuildExit}` })
  let counts = null
  const lines = output.split(/\r?\n/)
  const end = lines.findIndex((line) => SUITE_END.test(line))
  for (const line of end < 0 ? [] : lines.slice(end + 1)) {
    const read = EXECUTED.exec(line)
    if (read) {
      counts = {
        executed: Number(read[1]),
        skipped: Number(read[2] ?? 0),
        failures: Number(read[3])
      }
      break
    }
    // The next suite's line came first: the class printed no count of its own.
    if (line.startsWith('Test Suite ')) break
  }
  if (!counts) {
    problems.push({
      kind: 'missing',
      sentence: `xcodebuild printed no "Executed …" line for the FixtureFlowTests suite, so none of its ${FIXTURE_TESTS} tests is known to have run`
    })
  } else {
    const { executed, skipped, failures } = counts
    if (executed !== FIXTURE_TESTS)
      problems.push({
        kind: 'count',
        sentence: `the FixtureFlowTests suite executed ${executed} test${executed === 1 ? '' : 's'}, not ${FIXTURE_TESTS}`
      })
    if (skipped > 0)
      problems.push({
        kind: 'skipped',
        sentence: `${skipped} of the FixtureFlowTests tests skipped (they skip when a fixture variable is missing or empty), and a skipped test proves nothing`
      })
    if (failures > 0)
      problems.push({
        kind: 'failures',
        sentence: `the FixtureFlowTests suite reported ${failures} failure${failures === 1 ? '' : 's'}`
      })
  }
  const exitCode = problems.length === 0 ? 0 : xcodebuildExit !== 0 ? xcodebuildExit : 1
  return { counts, problems, exitCode }
}

/** A canned xcodebuild output for --prove-verdict: the FixtureFlowTests suite
 *  with `executed` tests (`skipped` of them skipped, `failures` failed) inside
 *  the suites xcodebuild prints around it, in the shape of a real run's log;
 *  `ownLine: false` drops the class's own "Executed …" line and keeps the
 *  enclosing suites' lines. */
function cannedOutput({ executed, skipped = 0, failures = 0, ownLine = true }) {
  const at = '2026-11-10 15:45:06.272'
  const names = [
    'testNoRequestWaitsOnTheEchoFixture',
    'testPairsWithTheFixtureMachineOnTheRelay',
    'testReadsTheSeededChatAndIsAnswered',
    'testSignsInAtTheFixtureIssuerThroughTheSystemBrowser'
  ]
  const outcome = failures > 0 ? 'failed' : 'passed'
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
  const count = `\t Executed ${plural(executed, 'test')}, with ${skipped > 0 ? `${plural(skipped, 'test')} skipped and ` : ''}${plural(failures, 'failure')} (0 unexpected) in 72.865 (72.866) seconds`
  const lines = [
    `Test Suite 'Selected tests' started at ${at}.`,
    `Test Suite 'ClaveUITests.xctest' started at ${at}.`,
    `Test Suite 'FixtureFlowTests' started at ${at}.`
  ]
  for (let i = 0; i < executed; i++) {
    const test = `'-[ClaveUITests.FixtureFlowTests ${names[i % names.length]}]'`
    const state = i < skipped ? 'skipped' : i < skipped + failures ? 'failed' : 'passed'
    lines.push(`Test Case ${test} started.`, `Test Case ${test} ${state} (9.283 seconds).`)
  }
  lines.push(`Test Suite 'FixtureFlowTests' ${outcome} at ${at}.`)
  if (ownLine) lines.push(count)
  lines.push(`Test Suite 'ClaveUITests.xctest' ${outcome} at ${at}.`, count)
  lines.push(`Test Suite 'Selected tests' ${outcome} at ${at}.`, count)
  lines.push(failures > 0 ? '** TEST FAILED **' : '** TEST SUCCEEDED **')
  return `${lines.join('\n')}\n`
}

/** The canned cases --prove-verdict judges, each with the problem kinds its
 *  verdict must name (none: green). */
const VERDICT_CASES = [
  {
    name: '4 executed, 0 skipped, 0 failures, xcodebuild exit 0',
    exit: 0,
    output: cannedOutput({ executed: 4 }),
    kinds: []
  },
  {
    name: '4 executed, 1 skipped, xcodebuild exit 0',
    exit: 0,
    output: cannedOutput({ executed: 4, skipped: 1 }),
    kinds: ['skipped']
  },
  {
    name: '3 executed, xcodebuild exit 0',
    exit: 0,
    output: cannedOutput({ executed: 3 }),
    kinds: ['count']
  },
  {
    name: '0 executed, xcodebuild exit 0',
    exit: 0,
    output: cannedOutput({ executed: 0 }),
    kinds: ['count']
  },
  {
    name: "the suite's own line missing, the enclosing suites' lines saying 4/0/0, xcodebuild exit 0",
    exit: 0,
    output: cannedOutput({ executed: 4, ownLine: false }),
    kinds: ['missing']
  },
  {
    name: 'xcodebuild exit 65 with 4 executed, 0 skipped, 0 failures',
    exit: 65,
    output: cannedOutput({ executed: 4 }),
    kinds: ['xcodebuild']
  },
  {
    name: '4 executed, 1 failure, xcodebuild exit 0',
    exit: 0,
    output: cannedOutput({ executed: 4, failures: 1 }),
    kinds: ['failures']
  }
]

/** --prove-verdict: fixtureVerdict on every canned case; true when each gives
 *  the expected colour, the expected problem kinds and the expected exit code. */
function proveVerdict() {
  let ok = true
  for (const c of VERDICT_CASES) {
    const verdict = fixtureVerdict(c.exit, c.output)
    const kinds = verdict.problems.map((problem) => problem.kind)
    const wantExit = c.kinds.length === 0 ? 0 : c.exit !== 0 ? c.exit : 1
    const pass = kinds.join(',') === c.kinds.join(',') && verdict.exitCode === wantExit
    ok &&= pass
    const said = verdict.problems.length
      ? `red: ${verdict.problems.map((problem) => problem.sentence).join('; ')}`
      : 'green'
    log(`${pass ? 'PASS' : 'FAIL'} ${c.name}: exit ${verdict.exitCode}, ${said}`)
  }
  log(
    ok
      ? `PASS prove-verdict: all ${VERDICT_CASES.length} canned outputs give the expected verdict`
      : 'FAIL prove-verdict: a canned output did not give the expected verdict'
  )
  return ok
}

/** Runs xcodebuild, its output to the log file and the shown lines to stdout;
 *  resolves its exit code and its whole output, line by line, once its streams
 *  have closed. */
function runXcodebuild(args, env, logFile) {
  return new Promise((resolve) => {
    const file = createWriteStream(logFile, { flags: 'a' })
    const child = spawn('xcodebuild', args, {
      cwd: REPO,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const lines = []
    const take = (line) => {
      lines.push(line)
      if (SHOWN.test(line)) process.stdout.write(`${line}\n`)
    }
    // One line buffer per stream: a stderr chunk landing in the middle of a
    // stdout line would otherwise splice into the line the verdict reads.
    const flushes = []
    const reader = () => {
      let pending = ''
      flushes.push(() => {
        if (pending) take(pending)
        pending = ''
      })
      return (d) => {
        const text = String(d)
        file.write(text)
        pending += text
        let nl
        while ((nl = pending.indexOf('\n')) >= 0) {
          take(pending.slice(0, nl))
          pending = pending.slice(nl + 1)
        }
      }
    }
    child.stdout.on('data', reader())
    child.stderr.on('data', reader())
    const forward = (signal) => child.kill(signal)
    process.on('SIGINT', forward)
    process.on('SIGTERM', forward)
    // 'close', not 'exit': the verdict reads the output's last lines, which may
    // still be in the pipes when the process has exited.
    child.once('close', (code, signal) => {
      process.off('SIGINT', forward)
      process.off('SIGTERM', forward)
      for (const flush of flushes) flush()
      file.end(() => resolve({ code: code ?? (signal ? 1 : 0), output: lines.join('\n') }))
    })
  })
}

async function main() {
  if (process.argv.includes('--prove-verdict')) process.exit(proveVerdict() ? 0 : 1)
  const udid = arg('udid')
  if (!udid) {
    process.stderr.write('fixture-check: --udid <simulator udid> is required\n')
    process.exit(2)
  }
  const options = parseStackArgs(process.argv.slice(2))
  // Beside the run folder, never inside it: the stack empties the run folder at
  // every start, so a build folder there would be wiped before every check.
  const derived = path.resolve(arg('derived', `${options.tmpdir}-DerivedData`))
  const only = arg('only', 'ClaveUITests/FixtureFlowTests')
  const push = arg('push')
  const keep = process.argv.includes('--keep')
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
    const faults = runKeychainFaults()
    if (faults.length) log(`the run keychain's bracket failed: ${faults.join(' | ')}`)
    process.exit(faults.length ? 2 : (err.exitCode ?? 1))
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
      TEST_RUNNER_CLAVE_FIXTURE_WORKSPACE_ID: stack.workspaceId,
      TEST_RUNNER_CLAVE_FIXTURE_SESSION_ID: stack.sessionId,
      TEST_RUNNER_CLAVE_FIXTURE_NONCE: stack.nonce
    }
    log(
      `xcodebuild test -only-testing:${only} (full output in ${stack.tmpdir}/logs/xcodebuild.log)`
    )
    const run = await runXcodebuild(
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
    log(`xcodebuild exited ${run.code}`)
    const verdict = fixtureVerdict(run.code, run.output)
    if (verdict.problems.length === 0)
      log(
        `green: the FixtureFlowTests suite executed ${FIXTURE_TESTS} tests, none skipped, none failed`
      )
    for (const problem of verdict.problems) log(`red: ${problem.sentence}`)
    exitCode = verdict.exitCode

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
    const left = await stack.stop()
    if (left.length) {
      // The recorder watch saw a call, or a file landed in a credential folder:
      // the run is red whatever xcodebuild said.
      log(`the recorders or the credential folders were not silent: ${left.join(' | ')}`)
      exitCode = 2
    }
    const faults = runKeychainFaults()
    if (faults.length) {
      // The user's keychain search list moved, or the run keychain stayed: red
      // whatever xcodebuild said.
      log(`the run keychain's bracket failed: ${faults.join(' | ')}`)
      exitCode = 2
    }
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
