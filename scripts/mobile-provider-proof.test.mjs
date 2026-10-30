import { describe, expect, it } from 'vitest'
import { parseOpenFiles, proveCodexProcess } from './mobile-provider-proof.mjs'

const input = {
  serverPid: 100,
  scratch: '/scratch',
  expected: { executable: '/installed/codex', sha256: 'installed-bytes' },
  session: {
    id: 'phone-session',
    provider: 'codex',
    adapterId: 'codex-chat',
    transport: 'events',
    cwd: '/scratch'
  },
  history: {
    items: [
      {
        event: { type: 'session_meta', model: 'gpt-6.1-sol', providerSessionId: 'provider-thread' }
      }
    ]
  }
}
const deps = {
  parents: () => [
    { pid: 100, ppid: 1 },
    { pid: 101, ppid: 100 },
    { pid: 102, ppid: 101 }
  ],
  files: (pid) => ({
    cwd: '/scratch',
    executables: [pid === 102 ? '/retained/codex' : '/bin/zsh']
  }),
  digest: () => 'installed-bytes',
  canonical: (value) => value
}

describe('native acceptance requires a real isolated Codex process', () => {
  it('binds the adapter and provider thread to the isolated server descendant and executable bytes', () => {
    expect(proveCodexProcess(input, deps)).toMatchObject({
      provider: 'codex',
      sessionId: 'phone-session',
      threadId: 'provider-thread',
      serverPid: 100,
      pid: 102,
      ppid: 101,
      executableSha256: 'installed-bytes'
    })
  })
  it('fails when the provider is disabled even if a fixture supplies the expected model and thread', () => {
    expect(() => proveCodexProcess(input, { ...deps, parents: () => [] })).toThrow(
      'matching Codex executable'
    )
  })
  it('fails when Echo replaces the provider even if it spoofs the expected model and replies', () => {
    expect(() =>
      proveCodexProcess(
        { ...input, session: { ...input.session, provider: 'echo', adapterId: 'echo' } },
        deps
      )
    ).toThrow('must use Codex')
    expect(() =>
      proveCodexProcess(input, {
        ...deps,
        files: () => ({ cwd: '/scratch', executables: ['/fixtures/echo'] })
      })
    ).toThrow('matching Codex executable')
  })
  it('rejects an unrelated Codex, wrong working directory and replacement executable', () => {
    expect(() =>
      proveCodexProcess(input, { ...deps, parents: () => [{ pid: 102, ppid: 1 }] })
    ).toThrow('matching Codex executable')
    expect(() =>
      proveCodexProcess(input, {
        ...deps,
        files: () => ({ cwd: '/live-user-project', executables: ['/retained/codex'] })
      })
    ).toThrow('matching Codex executable')
    expect(() => proveCodexProcess(input, { ...deps, digest: () => 'fixture-bytes' })).toThrow(
      'matching Codex executable'
    )
  })
  it('rejects a label alone and multiple provider threads', () => {
    expect(() =>
      proveCodexProcess(
        {
          ...input,
          history: {
            items: [
              { event: { type: 'session_meta', model: 'gpt-6.1-sol', providerSessionId: null } }
            ]
          }
        },
        deps
      )
    ).toThrow('real provider thread')
    expect(() =>
      proveCodexProcess(
        {
          ...input,
          history: {
            items: [
              ...input.history.items,
              {
                event: {
                  type: 'session_meta',
                  model: 'gpt-6.1-sol',
                  providerSessionId: 'other-thread'
                }
              }
            ]
          }
        },
        deps
      )
    ).toThrow('one provider thread')
  })
  it('reads only cwd and text-file paths from lsof, retaining no arguments or environment', () => {
    expect(
      parseOpenFiles('p102\nfcwd\nn/scratch\nftxt\nn/retained/codex\nftxt\nn/usr/lib/dyld\n')
    ).toEqual({ cwd: '/scratch', executables: ['/retained/codex', '/usr/lib/dyld'] })
    const receipt = proveCodexProcess(input, deps)
    for (const key of ['authorization', 'access_token', 'refresh_token', 'argv', 'env'])
      expect(receipt).not.toHaveProperty(key)
  })
})
