/**
 * The one queue every BACKGROUND git read goes through, for the whole app
 * (PRDCT-3775).
 *
 * Before it, each caller bounded only itself: a status batch ran six at a time,
 * a fetch batch four, and the panel's timers fired whether or not the last
 * round had finished. On a slow machine a round outlived its interval, the next
 * one arrived with six fresh slots of its own, and the rounds stacked until
 * Clave had about six hundred git processes and the Mac could not fork
 * (22 October 2026). The limit has to belong to the app, not to the call.
 *
 * Three rules:
 *
 * - At most `concurrency` jobs run at once, across every window and caller,
 *   and at most `fetchConcurrency` of them are fetches, so a slow remote can
 *   never take every slot away from the status reads the panel is waiting on.
 * - A status read starts before any queued fetch: the reader is looking at
 *   the one, nobody is looking at the other.
 * - Per key, at most one job runs and one waits. A caller asking for a key
 *   that is already QUEUED shares that job, since it has not started and its
 *   answer will be as fresh as a new one. A caller asking for a key that is
 *   RUNNING gets the queued follow-up (created if needed), never the running
 *   job's answer, which may predate the change the caller came about.
 *
 * User actions (commit, push, stage, pull, the Refresh sweep) do not come
 * through here: they are paced by clicks, and a busy background must never
 * delay one.
 */

export type GitJobKind = 'status' | 'fetch'

interface Job {
  key: string
  kind: GitJobKind
  run: () => Promise<unknown>
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

export interface GitQueueStats {
  running: number
  runningFetches: number
  queued: number
}

export class GitQueue {
  private readonly queued: Job[] = []
  /** Key → the job waiting for that key (at most one). */
  private readonly queuedByKey = new Map<string, Job>()
  /** Keys whose job is running right now. */
  private readonly runningKeys = new Set<string>()
  private running = 0
  private runningFetches = 0

  constructor(
    private readonly concurrency: number,
    private readonly fetchConcurrency: number
  ) {}

  run<T>(key: string, kind: GitJobKind, fn: () => Promise<T>): Promise<T> {
    const waiting = this.queuedByKey.get(key)
    if (waiting) return waiting.promise as Promise<T>

    let resolve!: (value: unknown) => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res
      reject = rej
    })
    const job: Job = { key, kind, run: fn, promise, resolve, reject }
    this.queued.push(job)
    this.queuedByKey.set(key, job)
    this.pump()
    return promise as Promise<T>
  }

  stats(): GitQueueStats {
    return {
      running: this.running,
      runningFetches: this.runningFetches,
      queued: this.queued.length
    }
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      const index = this.nextIndex()
      if (index < 0) return
      const [job] = this.queued.splice(index, 1)
      this.queuedByKey.delete(job.key)
      this.start(job)
    }
  }

  /** The next job allowed to start: the first status read whose key is not
   *  running, else the first such fetch while fetches have a slot. */
  private nextIndex(): number {
    let fetchIndex = -1
    for (let i = 0; i < this.queued.length; i++) {
      const job = this.queued[i]
      if (this.runningKeys.has(job.key)) continue
      if (job.kind === 'status') return i
      if (fetchIndex < 0 && this.runningFetches < this.fetchConcurrency) fetchIndex = i
    }
    return fetchIndex
  }

  private start(job: Job): void {
    this.running++
    if (job.kind === 'fetch') this.runningFetches++
    this.runningKeys.add(job.key)
    let result: Promise<unknown>
    try {
      result = job.run()
    } catch (err) {
      result = Promise.reject(err)
    }
    // The slot is freed before the caller hears back, so a caller that asks
    // again on the answer finds the key free and the count true.
    const release = (): void => {
      this.running--
      if (job.kind === 'fetch') this.runningFetches--
      this.runningKeys.delete(job.key)
      this.pump()
    }
    result.then(
      (value) => {
        release()
        job.resolve(value)
      },
      (err) => {
        release()
        job.reject(err)
      }
    )
  }
}
