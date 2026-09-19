import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { build } from 'esbuild'
import { RuntimePluginJobs } from './jobs'

const scope = {
  sessionId: 'session',
  plugin: { pluginId: 'test', revision: 'r1', version: '1.0.0' }
}
const directories: string[] = []
const executors: RuntimePluginJobs[] = []
const owners: ChildProcess[] = []
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function setup(timeoutMs = 5000): Promise<{ dir: string; jobs: RuntimePluginJobs }> {
  const dir = await mkdtemp(join(process.cwd(), '.job-lifecycle-'))
  directories.push(dir)
  const jobs = new RuntimePluginJobs(join(dir, 'ledger'), {
    concurrent: 1,
    timeoutMs,
    outputBytes: 64,
    records: 20
  })
  executors.push(jobs)
  return { dir, jobs }
}

afterEach(async () => {
  for (const owner of owners.splice(0)) {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL')
  }
  for (const jobs of executors.splice(0)) jobs.dispose()
  // All fixtures also self-expire. Wait beyond their marker deadline even on
  // assertion failure, so a failing cleanup test cannot write after removal.
  await delay(1100)
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('job process ownership', () => {
  it.skipIf(process.platform === 'win32')(
    'cleans redirected background children on successful leader exit',
    async () => {
      // This checks leader-exit cleanup, not the deadline. A 100 ms deadline
      // could interrupt the shell before exit under full-suite CPU contention.
      const { dir, jobs } = await setup(5000)
      const input = {
        ...scope,
        cwd: dir,
        env: {},
        requestId: 'background',
        argv: ['/bin/sh', '-c', '(sleep 0.4; printf escaped > marker) >/dev/null 2>&1 &']
      }
      const job = jobs.execute(input)
      await vi.waitFor(() => expect(jobs.read(scope, job.id).status).toBe('completed'))
      expect(jobs.read(scope, job.id).exitCode).toBe(0)
      expect(jobs.cancel(scope, job.id).status).toBe('completed')
      jobs.dispose()
      await delay(600)
      expect(existsSync(join(dir, 'marker'))).toBe(false)
    }
  )

  it.skipIf(process.platform === 'win32')(
    'cleans descendants that retain stdout without waiting for pipe close',
    async () => {
      const { dir, jobs } = await setup(3000)
      const job = jobs.execute({
        ...scope,
        cwd: dir,
        env: {},
        requestId: 'pipes',
        argv: ['/bin/sh', '-c', '(sleep 0.4; printf escaped > marker) & printf leader']
      })
      await vi.waitFor(() => expect(jobs.read(scope, job.id).status).toBe('completed'))
      expect(jobs.read(scope, job.id).output).toBe('leader')
      await delay(600)
      expect(existsSync(join(dir, 'marker'))).toBe(false)
    }
  )

  it.each(['cancel', 'dispose', 'timeout'] as const)(
    'cleans an ordinary Node child on %s',
    async (action) => {
      const { dir, jobs } = await setup(action === 'timeout' ? 350 : 5000)
      const descendant = `
      require('node:fs').writeFileSync('ready', 'ready');
      setTimeout(() => require('node:fs').writeFileSync('marker', 'escaped'), 800);
    `
      const job = jobs.execute({
        ...scope,
        cwd: dir,
        env: {},
        requestId: action,
        argv: [
          process.execPath,
          '-e',
          `
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'});
        setTimeout(() => {}, 1000);
      `
        ]
      })
      await vi.waitFor(() => expect(existsSync(join(dir, 'ready'))).toBe(true))
      if (action === 'cancel') expect(jobs.cancel(scope, job.id).status).toBe('cancelled')
      if (action === 'dispose') jobs.dispose()
      await vi.waitFor(() =>
        expect(jobs.read(scope, job.id).status).toBe(
          action === 'cancel' ? 'cancelled' : 'interrupted'
        )
      )
      await delay(1000)
      expect(existsSync(join(dir, 'marker'))).toBe(false)
    }
  )

  it('cleans jobs after abrupt owner death without signalling persisted PIDs on restart', async () => {
    const { dir } = await setup()
    const ownerFile = join(dir, 'owner.cjs')
    const descendant = `
      require('node:fs').writeFileSync('ready', 'ready');
      setTimeout(() => require('node:fs').writeFileSync('alive', 'alive'), 150);
      setTimeout(() => require('node:fs').writeFileSync('marker', 'escaped'), 800);
    `
    const input = {
      ...scope,
      cwd: dir,
      env: {},
      requestId: 'crash',
      argv: [
        process.execPath,
        '-e',
        `
        require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'});
        setTimeout(() => {}, 1000);
      `
      ]
    }
    await build({
      stdin: {
        contents: `
          import { RuntimePluginJobs } from './src/main/runtime-plugins/jobs';
          const jobs = new RuntimePluginJobs(${JSON.stringify(join(dir, 'crash-ledger'))});
          const job = jobs.execute(${JSON.stringify(input)});
          process.send(job);
        `,
        resolveDir: process.cwd(),
        loader: 'ts'
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile: ownerFile
    })
    const owner = spawn(process.execPath, [ownerFile], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    owners.push(owner)
    const accepted = new Promise<{ id: string }>((resolve, reject) => {
      owner.once('message', (job) => resolve(job as { id: string }))
      owner.once('error', reject)
      owner.once('exit', () => reject(new Error('Owner exited before acceptance')))
    })
    const job = await accepted
    await vi.waitFor(() => expect(existsSync(join(dir, 'ready'))).toBe(true))
    // The client's channel to the owner is not the owner's private job channel.
    owner.disconnect()
    await vi.waitFor(() => expect(existsSync(join(dir, 'alive'))).toBe(true))
    expect(owner.exitCode).toBeNull()
    const exited = new Promise<void>((resolve) => owner.once('exit', () => resolve()))
    owner.kill('SIGKILL')
    await exited
    const recovered = new RuntimePluginJobs(join(dir, 'crash-ledger'))
    executors.push(recovered)
    expect(recovered.read(scope, job.id).status).toBe('interrupted')
    expect(recovered.execute(input).id).toBe(job.id)
    const ledger = JSON.parse(await readFile(join(dir, 'crash-ledger', `${job.id}.json`), 'utf8'))
    expect(ledger.job).not.toHaveProperty('pid')
    await delay(1000)
    expect(existsSync(join(dir, 'marker'))).toBe(false)
  })
})
