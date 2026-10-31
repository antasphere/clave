// Nonshipping, synchronous diagnostics for the one legacy 120-append test.
// These intervals include whole render helpers, not isolated parser work.
const phases = [
  'fullRender',
  'reusedRender',
  'treeExpectation',
  'htmlExpectation',
  'urlExpectation'
] as const
type Phase = (typeof phases)[number]
type Cpu = { user: number; system: number }
type Stamp = { wall: number; user: number; system: number }
const metrics = (): Metrics => ({
  attempted: 0,
  completed: 0,
  observed: 0,
  wallMsTotal: 0,
  wallMsMax: 0,
  cpuUserUsTotal: 0,
  cpuUserUsMax: 0,
  cpuSystemUsTotal: 0,
  cpuSystemUsMax: 0
})
interface Metrics {
  attempted: number
  completed: number
  observed: number
  wallMsTotal: number
  wallMsMax: number
  cpuUserUsTotal: number
  cpuUserUsMax: number
  cpuSystemUsTotal: number
  cpuSystemUsMax: number
}
interface Dependencies {
  now: () => number
  cpu: () => Cpu
  report: (value: CounterReport) => void
}
export interface CounterReport {
  proof: 'legacy-case-counters'
  scope: 'inclusive render helpers and original expectations; outer body before reporting'
  callbackState: 'notRun' | 'callbackReturned' | 'callbackThrew'
  diagnosticsAvailable: boolean
  diagnosticFailures: number
  reporterFailures: number
  iteration: number
  currentPhase: string
  outer: Metrics
  phases: Record<Phase, Metrics>
  tailAccounting: { attempted: number; completed: number }
  unattributed: { wallMs: number; cpuUserUs: number; cpuSystemUs: number } | null
}

export class MarkdownCaseCounters {
  private readonly rows = Object.fromEntries(phases.map((p) => [p, metrics()])) as Record<
    Phase,
    Metrics
  >
  private readonly outer = metrics()
  private readonly tail = { attempted: 0, completed: 0 }
  private readonly dependencies: Dependencies
  private unavailable = false
  private diagnosticFailures = 0
  private reporterFailures = 0
  private iteration = -1
  private currentPhase = 'unattributed'
  private callbackState: CounterReport['callbackState'] = 'notRun'

  constructor(dependencies: Partial<Dependencies> = {}) {
    this.dependencies = {
      now: () => performance.now(),
      cpu: () => process.cpuUsage(),
      report: (value) => console.info(JSON.stringify(value)),
      ...dependencies
    }
  }

  private unavailableDiagnostic(): void {
    this.unavailable = true
    this.diagnosticFailures++
  }

  private stamp(): Stamp | undefined {
    try {
      const wall = this.dependencies.now()
      const cpu = this.dependencies.cpu()
      const user = cpu.user,
        system = cpu.system
      if (![wall, user, system].every((n) => Number.isFinite(n) && n >= 0)) {
        this.unavailableDiagnostic()
        return undefined
      }
      return { wall, user, system }
    } catch {
      this.unavailableDiagnostic()
      return undefined
    }
  }

  private observe(row: Metrics, start: Stamp | undefined): void {
    const end = this.stamp()
    if (!start || !end) return
    const wall = end.wall - start.wall,
      user = end.user - start.user,
      system = end.system - start.system
    if ([wall, user, system].some((n) => n < 0)) {
      this.unavailableDiagnostic()
      return
    }
    row.observed++
    row.wallMsTotal += wall
    row.wallMsMax = Math.max(row.wallMsMax, wall)
    row.cpuUserUsTotal += user
    row.cpuUserUsMax = Math.max(row.cpuUserUsMax, user)
    row.cpuSystemUsTotal += system
    row.cpuSystemUsMax = Math.max(row.cpuSystemUsMax, system)
  }

  setIteration(iteration: number): void {
    this.iteration = iteration
    this.currentPhase = 'unattributed'
  }

  tailAttempted(): void {
    this.currentPhase = 'tailAccountingUnmeasured'
    this.tail.attempted++
  }

  tailCompleted(): void {
    this.tail.completed++
    this.currentPhase = 'unattributed'
  }

  measure<T>(phase: Phase, operation: () => T): T {
    const row = this.rows[phase]
    this.currentPhase = phase
    row.attempted++
    const start = this.stamp()
    let completed = false
    try {
      const value = operation()
      completed = true
      return value
    } finally {
      // No result/error inspection; secondary diagnostics cannot mask either.
      try {
        if (completed) row.completed++
        this.observe(row, start)
        if (completed) this.currentPhase = 'unattributed'
      } catch {
        this.unavailableDiagnostic()
      }
    }
  }

  snapshot(): CounterReport {
    const remainder = {
      wallMs: this.outer.wallMsTotal - phases.reduce((n, p) => n + this.rows[p].wallMsTotal, 0),
      cpuUserUs:
        this.outer.cpuUserUsTotal - phases.reduce((n, p) => n + this.rows[p].cpuUserUsTotal, 0),
      cpuSystemUs:
        this.outer.cpuSystemUsTotal - phases.reduce((n, p) => n + this.rows[p].cpuSystemUsTotal, 0)
    }
    return {
      proof: 'legacy-case-counters',
      scope: 'inclusive render helpers and original expectations; outer body before reporting',
      callbackState: this.callbackState,
      diagnosticsAvailable: !this.unavailable,
      diagnosticFailures: this.diagnosticFailures,
      reporterFailures: this.reporterFailures,
      iteration: this.iteration,
      currentPhase: this.currentPhase,
      outer: { ...this.outer },
      phases: Object.fromEntries(phases.map((p) => [p, { ...this.rows[p] }])) as Record<
        Phase,
        Metrics
      >,
      tailAccounting: { ...this.tail },
      unattributed: this.unavailable ? null : remainder
    }
  }

  run<T>(operation: () => T): T {
    this.outer.attempted++
    const start = this.stamp()
    let returned = false
    try {
      const value = operation()
      returned = true
      return value
    } finally {
      try {
        this.callbackState = returned ? 'callbackReturned' : 'callbackThrew'
        if (returned) this.outer.completed++
        this.observe(this.outer, start)
        this.dependencies.report(this.snapshot())
      } catch {
        this.reporterFailures++
        this.unavailableDiagnostic()
      }
    }
  }
}
