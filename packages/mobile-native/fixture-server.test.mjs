/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by vitest */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  DAEMON_FLAGS,
  MANIFEST_NAME,
  MUTATIONS,
  OWNER,
  REDIRECTS,
  parseArgs,
  proveFixture,
  proveNoProvider,
  recorderLines,
  startFixture
} from './scripts/fixture-server.mjs'

/* The fixture server both native phones are tested against, booted here on
   free ports in a folder of this run's own: the provider on the port the test
   named, the relay and this checkout's daemon under Bun with the three flags
   that keep it off every provider, the three boot checks passed, the daemon
   signed in as the fixture owner and listed by the relay, the Echo chat
   seeded. Then the same proof `--check` runs: nothing reached a provider for
   the seeded chat (the recorders silent, no transcript, no usage event), the
   explicit usage reads kept off (Claude) and caught (Codex), a fixture-issued
   token pairs and reaches the sessions directly and through the relay, five
   tampered tokens are refused by the check's name, both redirect schemes
   register. The manifest and the printed lines carry the token's path and
   never the token. Three more boots, one per mutation, prove the proof goes
   red: without the title opt-out the recorder catches the one-shot; with the
   usage clock started the recorder and the push channel catch the reads; with
   a PATH without the recorders the third check aborts before any chat. */

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })

describe('parseArgs', () => {
  it('reads the band, the folder and the flags, and refuses what it does not know', () => {
    expect(
      parseArgs([
        '--server',
        '47301',
        '--relay=47302',
        '--issuer',
        '47303',
        '--tmpdir',
        '/tmp/x',
        '--approve',
        '--check',
        '--json'
      ])
    ).toEqual({
      ports: { server: 47301, relay: 47302, issuer: 47303 },
      tmpdir: '/tmp/x',
      timeoutMs: 90_000,
      approve: true,
      check: true,
      json: true,
      mutate: null
    })
    expect(parseArgs([]).ports).toEqual({ server: 0, relay: 0, issuer: 0 })
    expect(parseArgs(['--mutate', 'drop-recorders']).mutate).toBe('drop-recorders')
    expect(() => parseArgs(['--mutate', 'everything'])).toThrow(/--mutate takes one of/)
    expect(() => parseArgs(['--server', '70000'])).toThrow(/--server must be 0..65535/)
    expect(() => parseArgs(['--port', '1'])).toThrow(/unknown option --port/)
    expect(() => parseArgs(['--tmpdir'])).toThrow(/--tmpdir needs a value/)
  })

  it('names the three flags and the three mutations', () => {
    expect(DAEMON_FLAGS).toEqual(['--no-titles', '--test-no-activate', '--test-no-machine-usage'])
    expect(MUTATIONS).toEqual(['drop-title-opt-out', 'start-usage-clock', 'drop-recorders'])
  })
})

describe('the fixture server', () => {
  const folders = []
  const fixtures = []
  const tmp = (name) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), `clave-native-fixture-${name}-`))
    folders.push(dir)
    return dir
  }
  afterAll(async () => {
    for (const fixture of fixtures) await fixture.stop()
    for (const dir of folders) rmSync(dir, { recursive: true, force: true })
  })

  it('boots the provider on the named port, passes its three checks, signs the daemon in, lists it on the relay, seeds the chat, and the whole proof passes', async () => {
    const lines = []
    const tmpdir = tmp('test')
    const issuerPort = await freePort()
    const fixture = await startFixture({
      ports: { server: 0, relay: 0, issuer: issuerPort },
      tmpdir,
      log: (line) => lines.push(line)
    })
    fixtures.push(fixture)
    expect(fixture.provider.port).toBe(issuerPort)
    expect(fixture.provider.issuer).toBe(`http://127.0.0.1:${issuerPort}`)
    expect(fixture.machine.online).toBe(true)
    expect(fixture.seed.text).toMatch(/^seeded-[0-9a-f]{8}$/)
    expect(fixture.checks.map((c) => [c.kind, c.ok])).toEqual([
      ['announced', true],
      ['announced', true],
      ['observed', true]
    ])
    expect(fixture.server.discovery).toMatchObject({
      titles: 'off',
      testFixtures: true,
      machineUsage: false
    })

    const printed = fixture.lines()
    expect(Object.keys(printed)).toEqual([
      'CLAVE_FIXTURE_SERVER_URL',
      'CLAVE_FIXTURE_TOKEN_FILE',
      'CLAVE_FIXTURE_RELAY_URL',
      'CLAVE_FIXTURE_ISSUER_URL',
      'CLAVE_FIXTURE_MACHINE_ID',
      'CLAVE_FIXTURE_WORKSPACE_ID',
      'CLAVE_FIXTURE_SESSION_ID',
      'CLAVE_FIXTURE_NONCE',
      'CLAVE_FIXTURE_RECORDER_LOG',
      'CLAVE_FIXTURE_FILE'
    ])
    const token = readFileSync(printed.CLAVE_FIXTURE_TOKEN_FILE, 'utf8').trim()
    expect(token).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(printed)).not.toContain(token)
    const manifest = readFileSync(path.join(tmpdir, MANIFEST_NAME), 'utf8')
    expect(manifest).not.toContain(token)
    expect(JSON.parse(manifest)).toMatchObject({
      v: 1,
      machineId: fixture.machine.id,
      issuer: { owner: { sub: OWNER.sub }, redirects: REDIRECTS },
      session: { id: fixture.seed.id, nonce: fixture.seed.nonce },
      server: {
        flags: DAEMON_FLAGS,
        announces: { titles: 'off', testFixtures: true, machineUsage: false }
      },
      mutation: null
    })
    expect(lines.join('\n')).not.toContain(token)

    const results = await proveFixture(fixture, { log: (line) => lines.push(line) })
    const failed = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)
    expect(failed).toEqual([])
    expect(results.length).toBe(24)
    expect(results.slice(0, 6).map((r) => r.kind)).toEqual([
      'recorder',
      'wire',
      'transcripts',
      'wire',
      'wire',
      'recorder'
    ])
    expect(results.map((r) => r.name)).toEqual(
      expect.arrayContaining([
        'the recorders saw no claude and no codex since the boot, the seeded chat included',
        'an explicit Codex usage read reaches the codex recorder, exactly one line, and answers an error',
        'a token tampered on the audience is refused by the check named audience',
        'a token tampered on the signature is refused by the check named signature',
        'a token tampered on the issuer is refused by the check named issuer',
        'a token tampered on the subject is refused by the check named subject',
        'a token tampered on the expired is refused by the check named expired'
      ])
    )
    // After the proof the recorder holds the one explicit Codex read and nothing else.
    const recorded = recorderLines(fixture.stubs)
    expect(recorded.length).toBe(1)
    expect(recorded[0]).toMatch(/ codex app-server /)
  }, 240_000)

  it('goes red without the title opt-out: the first check fails and the recorder catches the one-shot', async () => {
    const fixture = await startFixture({
      ports: { server: 0, relay: 0, issuer: 0 },
      tmpdir: tmp('no-opt-out'),
      mutate: 'drop-title-opt-out',
      log: () => {}
    })
    fixtures.push(fixture)
    expect(fixture.checks[0]).toMatchObject({ ok: false, kind: 'announced' })
    expect(fixture.checks[0].detail).toMatch(/titles "on"/)
    expect(fixture.server.discovery.titles).toBe('on')
    const results = await proveNoProvider(fixture, { log: () => {} })
    const recorder = results.find((r) => r.name.startsWith('the recorders saw no claude'))
    expect(recorder.ok).toBe(false)
    expect(recorder.detail).toMatch(/ claude -p /)
    const named = results.find((r) => r.name === 'the seeded chat was not named by a one-shot')
    expect(named.ok).toBe(false)
    expect(named.detail).toMatch(/named the chat "fixture chat"/)
  }, 240_000)

  it('goes red with the usage clock running: the codex recorder and the push channel catch the reads, every flag kept', async () => {
    const fixture = await startFixture({
      ports: { server: 0, relay: 0, issuer: 0 },
      tmpdir: tmp('clock'),
      mutate: 'start-usage-clock',
      log: () => {}
    })
    fixtures.push(fixture)
    expect(fixture.checks.every((c) => c.ok)).toBe(true)
    expect(fixture.server.flags).toEqual(DAEMON_FLAGS)
    const results = await proveNoProvider(fixture, { log: () => {} })
    const clock = results.find((r) => r.name.startsWith('the usage clock did not run'))
    expect(clock.ok).toBe(false)
    expect(clock.detail).toMatch(/codex app-server|usage\./)
    // The Claude side stays off the machine login even with the clock running: no claude line.
    expect(recorderLines(fixture.stubs).some((l) => l.includes(' claude '))).toBe(false)
  }, 240_000)

  it('refuses to boot with a PATH without the recorders: the third check aborts before any chat', async () => {
    let error = null
    try {
      await startFixture({
        ports: { server: 0, relay: 0, issuer: 0 },
        tmpdir: tmp('no-recorders'),
        mutate: 'drop-recorders',
        log: () => {}
      })
    } catch (e) {
      error = e
    }
    expect(error).not.toBeNull()
    expect(error.message).toMatch(/refuses to boot, before any chat/)
    expect(error.bootChecks[2]).toMatchObject({ ok: false, kind: 'observed' })
    expect(error.bootChecks[2].detail).toMatch(/claude resolves to/)
  }, 240_000)
})
