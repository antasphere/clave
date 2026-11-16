import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CLAVE_TAB_CREDENTIAL_ENV_VARS,
  connectionHandover,
  connectionVariableNames
} from './connection-handover'

/**
 * A stored connection's values past a login profile (PRDCT-4496): a profile
 * that exports the connection's own variable must never replace the stored
 * key. Made-up values only.
 */
const STORED = 'made-up-stored-kimi-0001'
const PROFILE = 'made-up-profile-kimi-0002'

describe('connectionHandover', () => {
  it('carries each value under a private name, the command naming names only', () => {
    const handover = connectionHandover(['OPENCODE_CONFIG_CONTENT', 'KIMI_API_KEY'], {
      KIMI_API_KEY: STORED,
      OPENCODE_CONFIG_CONTENT: '{"made":"up"}'
    })
    expect(handover.env).toEqual({
      CLAVE_TAB_CREDENTIAL_1: STORED,
      CLAVE_TAB_CREDENTIAL_2: '{"made":"up"}'
    })
    expect(handover.command).toBe(
      'KIMI_API_KEY="$CLAVE_TAB_CREDENTIAL_1"; export KIMI_API_KEY; unset CLAVE_TAB_CREDENTIAL_1; ' +
        'OPENCODE_CONFIG_CONTENT="$CLAVE_TAB_CREDENTIAL_2"; export OPENCODE_CONFIG_CONTENT; unset CLAVE_TAB_CREDENTIAL_2; '
    )
    expect(handover.command).not.toContain(STORED)
    expect(handover.command).not.toContain('made')
  })

  it('carries nothing for a name with no value, and refuses a bad name or too many', () => {
    expect(connectionHandover(['KIMI_API_KEY'], {})).toEqual({ env: {}, command: '' })
    expect(() => connectionHandover(['A;B'], { 'A;B': 'x' })).toThrow(
      'The connection names an invalid variable.'
    )
    const many = Object.fromEntries(
      Array.from({ length: CLAVE_TAB_CREDENTIAL_ENV_VARS.length + 1 }, (_, i) => [`V${i}`, 'x'])
    )
    expect(() => connectionHandover(Object.keys(many), many)).toThrow(
      'The connection sets more variables than a tab can carry.'
    )
  })

  it('names every connection variable but the Pi directory, which rides on the command line', () => {
    expect(
      connectionVariableNames({ KIMI_API_KEY: 'x', PI_CODING_AGENT_DIR: '/d' }).sort()
    ).toEqual(['KIMI_API_KEY'])
  })

  describe('through a real login zsh whose profile exports the same variable', () => {
    let zdot: string
    afterEach(() => fs.rmSync(zdot, { recursive: true, force: true }))

    it.skipIf(!fs.existsSync('/bin/zsh'))(
      'the program sees the stored value, and the private name is gone before it starts',
      () => {
        zdot = fs.mkdtempSync(path.join(os.tmpdir(), 'clave-handover-'))
        fs.writeFileSync(path.join(zdot, '.zshenv'), `export KIMI_API_KEY='${PROFILE}'\n`)
        const handover = connectionHandover(['KIMI_API_KEY'], { KIMI_API_KEY: STORED })
        // The program prints whether it has each, never a value.
        const program = `${shellQuote(process.execPath)} -e ${shellQuote(
          `process.stdout.write(JSON.stringify({ stored: process.env.KIMI_API_KEY === ${JSON.stringify(STORED)}, profile: process.env.KIMI_API_KEY === ${JSON.stringify(PROFILE)}, privateLeft: Object.keys(process.env).some((n) => n.startsWith('CLAVE_TAB_CREDENTIAL_')) }))`
        )}`
        const run = (command: string): Record<string, boolean> =>
          JSON.parse(
            execFileSync('/bin/zsh', ['-l', '-c', command], {
              env: {
                PATH: process.env.PATH ?? '/usr/bin:/bin',
                HOME: zdot,
                ZDOTDIR: zdot,
                KIMI_API_KEY: STORED,
                ...handover.env
              },
              encoding: 'utf8',
              timeout: 20_000
            })
          )
        // Without the handover, the profile's value wins: the road it closes.
        expect(run(program)).toMatchObject({ stored: false, profile: true })
        expect(run(`${handover.command}${program}`)).toEqual({
          stored: true,
          profile: false,
          privateLeft: false
        })
      }
    )
  })
})

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
