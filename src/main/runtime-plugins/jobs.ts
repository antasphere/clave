import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { PluginJob, PluginPin } from '../../shared/runtime-plugins'
import { JOB_SUPERVISOR_SOURCE } from './jobs-supervisor'

export interface PluginJobScope {
  sessionId: string
  plugin: PluginPin
}
export interface ExecutePluginJob extends PluginJobScope {
  cwd: string
  argv: string[]
  requestId: string
  env: NodeJS.ProcessEnv
}
interface Record {
  key: string
  job: PluginJob
}

/** Owned by the daemon. Accepted requests are durable before a child can start. */
export class RuntimePluginJobs {
  private records = new Map<string, Record>()
  private children = new Map<string, ChildProcess>()
  private stopped = new WeakSet<ChildProcess>()
  private disposed = false

  constructor(
    private directory: string,
    private limits = { concurrent: 4, timeoutMs: 60_000, outputBytes: 65_536, records: 10_000 }
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const files = readdirSync(directory).filter((f) => f.endsWith('.json'))
    if (files.length > limits.records) throw new Error('Job ledger limit reached')
    for (const file of files) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file) || statSync(join(directory, file)).size > 2_097_152) {
        throw new Error('Invalid job ledger')
      }
      const record = JSON.parse(readFileSync(join(directory, file), 'utf8')) as Record
      if (`${record.job?.id}.json` !== file || !/^[a-f0-9]{64}$/.test(record.key))
        throw new Error('Invalid job ledger')
      if (record.job.status === 'running') {
        record.job.status = 'interrupted'
        record.job.finishedAt = new Date().toISOString()
        this.persist(record)
      }
      this.records.set(record.job.id, record)
    }
  }

  private persist(record: Record): void {
    const file = join(this.directory, `${record.job.id}.json`)
    writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600, flush: true })
    renameSync(`${file}.tmp`, file)
    // Make acceptance survive a crash after rename but before spawning the child.
    if (process.platform !== 'win32') {
      const directory = openSync(this.directory, 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
    }
  }

  execute(input: ExecutePluginJob): PluginJob {
    if (this.disposed) throw new Error('Job executor closed')
    if (
      !input.requestId ||
      input.requestId.length > 300 ||
      !input.argv.length ||
      input.argv.length > 128 ||
      input.argv.some((s) => typeof s !== 'string' || s.includes('\0') || s.length > 8192)
    ) {
      throw new Error('Invalid job request')
    }
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          input.sessionId,
          input.plugin.pluginId,
          input.plugin.revision,
          input.requestId
        ])
      )
      .digest('hex')
    const prior = [...this.records.values()].find((r) => r.key === key)
    if (prior) return structuredClone(prior.job)
    if (this.children.size >= this.limits.concurrent || this.records.size >= this.limits.records) {
      throw new Error('Job limit reached')
    }
    const job: PluginJob = {
      id: randomUUID(),
      sessionId: input.sessionId,
      plugin: structuredClone(input.plugin),
      argv: [...input.argv],
      status: 'running',
      output: '',
      truncated: false,
      createdAt: new Date().toISOString()
    }
    const record = { key, job }
    this.persist(record)
    this.records.set(job.id, record)
    let child: ChildProcess
    try {
      child = spawn(process.execPath, ['-e', JOB_SUPERVISOR_SOURCE], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: undefined },
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      })
    } catch {
      job.status = 'failed'
      job.finishedAt = new Date().toISOString()
      this.persist(record)
      return structuredClone(job)
    }
    this.children.set(job.id, child)
    const append = (text: string): void => {
      const available = this.limits.outputBytes - Buffer.byteLength(job.output)
      if (Buffer.byteLength(text) <= available) job.output += text
      else {
        let prefix = Buffer.from(text).subarray(0, Math.max(0, available)).toString('utf8')
        while (Buffer.byteLength(prefix) > available) prefix = prefix.slice(0, -1)
        job.output += prefix
        job.truncated = true
      }
    }
    for (const stream of [child.stdout, child.stderr]) {
      const decoder = new StringDecoder('utf8')
      stream?.on('data', (chunk: Buffer) => append(decoder.write(chunk)))
      stream?.on('end', () => append(decoder.end()))
    }
    let result: { code: number | null; interrupted: boolean } | undefined
    let finished = false
    child.on('message', (message) => {
      result = message as typeof result
    })
    const finish = (): void => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      this.children.delete(job.id)
      if (job.status === 'running') {
        job.status = result?.interrupted
          ? 'interrupted'
          : result?.code === 0
            ? 'completed'
            : 'failed'
      }
      if (result?.code != null) job.exitCode = result.code
      job.finishedAt = new Date().toISOString()
      this.persist(record)
    }
    const timer = setTimeout(() => {
      if (job.status === 'running') job.status = 'interrupted'
      this.stop(child)
    }, this.limits.timeoutMs)
    timer.unref()
    // close follows error too, and drains output before releasing the slot.
    child.once('error', () => this.stop(child))
    child.once('close', finish)
    child.send(
      {
        argv: input.argv,
        cwd: input.cwd,
        env: input.env,
        timeoutMs: this.limits.timeoutMs
      },
      (error) => {
        if (error) this.stop(child)
      }
    )
    return structuredClone(job)
  }

  private owned(scope: PluginJobScope, id: string): Record {
    const record = this.records.get(id)
    if (
      !record ||
      record.job.sessionId !== scope.sessionId ||
      record.job.plugin.pluginId !== scope.plugin.pluginId ||
      record.job.plugin.revision !== scope.plugin.revision
    )
      throw new Error('Job unavailable')
    return record
  }

  read(scope: PluginJobScope, id: string): PluginJob {
    return structuredClone(this.owned(scope, id).job)
  }

  cancel(scope: PluginJobScope, id: string): PluginJob {
    const record = this.owned(scope, id)
    const child = this.children.get(id)
    if (child) {
      record.job.status = 'cancelled'
      record.job.finishedAt = new Date().toISOString()
      this.persist(record)
      this.stop(child)
    }
    return structuredClone(record.job)
  }

  private stop(child: ChildProcess): void {
    if (this.stopped.has(child)) return
    this.stopped.add(child)
    // Never kill the supervisor alone. Explicit cancellation uses a message;
    // only owner death closes IPC. Node can lose its close event accounting
    // when disconnect() is called while the initial send is still in flight.
    if (child.connected) child.send({ cancel: true }, () => {})
  }

  cancelSession(sessionId: string): void {
    for (const [id] of this.children) {
      const record = this.records.get(id)!
      if (record.job.sessionId === sessionId) this.cancel(record.job, id)
    }
  }

  dispose(): void {
    this.disposed = true
    for (const [id, child] of this.children) {
      const record = this.records.get(id)!
      if (record.job.status === 'running') record.job.status = 'interrupted'
      record.job.finishedAt = new Date().toISOString()
      this.persist(record)
      this.stop(child)
    }
  }
}
