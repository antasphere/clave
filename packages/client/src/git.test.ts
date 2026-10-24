import { describe, expect, it } from 'vitest'
import type { Call } from './call'
import { gitClient } from './git'

/**
 * Which deadline each git call travels under (wave wcs1023, lane C, #242):
 * the reads under the ordinary one, and what git or the server's `claude`
 * may take minutes over under the patient one. A fake client records which
 * `Call` carried each method.
 */
describe('the git client’s deadlines', () => {
  it('sends the network, batch and model calls on the patient deadline and the reads on the ordinary one', async () => {
    const carried: Record<string, 'ordinary' | 'patient'> = {}
    const fake = (kind: 'ordinary' | 'patient'): Call =>
      (async (run: (c: unknown) => unknown) => {
        const endpoint = new Proxy(
          {},
          {
            get: (_target, method: string) => async () => {
              carried[method] = kind
              return method === 'commit' ? { hash: 'h', branch: 'b' } : []
            }
          }
        )
        return run({ git: endpoint })
      }) as unknown as Call
    const git = gitClient(fake('ordinary'), fake('patient'))
    await git.status('/repo')
    await git.statusBatch(['/repo'])
    await git.discover('/repo', true)
    await git.log('/repo', 5)
    await git.stage('/repo', ['a'])
    await git.commit('/repo', 'm')
    await git.fetch('/repo')
    await git.fetchBatch(['/repo'])
    await git.refreshRemotes(['/repo'])
    await git.push('/repo')
    await git.publishBranch('/repo')
    await git.pull('/repo', 'auto')
    await git.generateCommitMessage('/repo')
    await git.summarizePush('/repo', ['m'], 's')
    await git.magicSync(['/repo'])
    await git.magicPull(['/repo'])
    expect(carried).toEqual({
      status: 'ordinary',
      statusBatch: 'ordinary',
      discover: 'ordinary',
      log: 'ordinary',
      stage: 'ordinary',
      commit: 'ordinary',
      fetch: 'patient',
      fetchBatch: 'patient',
      refreshRemotes: 'patient',
      push: 'patient',
      publishBranch: 'patient',
      pull: 'patient',
      generateCommitMessage: 'patient',
      summarizePush: 'patient',
      magicSync: 'patient',
      magicPull: 'patient'
    })
  })
  it('runs every call on the one deadline given when no patient one is', async () => {
    const methods: string[] = []
    const only: Call = (async (run: (c: unknown) => unknown) =>
      run({
        git: new Proxy(
          {},
          { get: (_t, method: string) => async () => (methods.push(method), undefined) }
        )
      })) as unknown as Call
    const git = gitClient(only)
    await git.push('/repo')
    await git.status('/repo')
    expect(methods).toEqual(['push', 'status'])
  })
})
