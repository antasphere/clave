import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const workflow = parse(
  readFileSync(new URL('../../.github/workflows/checks.yml', import.meta.url), 'utf8')
)
const jobs = workflow.jobs
const matrix =
  '${{ inputs.baseline && fromJSON(\'["baseline"]\') || fromJSON(\'["1","2","3","4","5"]\') }}'
const expectedGates = new Map([
  ['Gate, actual renderer and native view module audit', 'node scripts/renderer-module-audit.mjs'],
  ['Gate, the packaged app loads what its bundles require', null],
  [
    'Gate, the terminal process from the built bundle',
    'npx vitest run scripts/server-process.test.mjs src/main/terminal-process'
  ],
  ['Gate, the server spec with the server in-process', 'node tests/e2e/run.mjs server-boot'],
  ['Gate, the server spec with the server attached', 'node tests/e2e/run.mjs server-boot'],
  ['Gate, the server spec with the server separate', 'node tests/e2e/run.mjs server-boot'],
  [
    'Gate, the Antasphere sign-in on the three servers',
    'node tests/e2e/run.mjs antasphere-account'
  ],
  [
    "Gate, connected servers follow the app's version",
    'node tests/e2e/run.mjs fleet-server-upgrade'
  ],
  [
    'Gate, full Markdown client, native lifecycle and responsiveness',
    'node tests/e2e/run.mjs markdown-parser-deep-client markdown-full-native renderer-responsiveness'
  ],
  ['Gate, MCP sessions on connected servers', 'node tests/e2e/run.mjs mcp-fleet-sessions']
])
const gatePartitions = new Map([
  ['Gate, actual renderer and native view module audit', '1'],
  ['Gate, the packaged app loads what its bundles require', '3'],
  ['Gate, the terminal process from the built bundle', '2'],
  ['Gate, the server spec with the server in-process', '2'],
  ['Gate, the server spec with the server attached', '4'],
  ['Gate, the server spec with the server separate', '3'],
  ['Gate, the Antasphere sign-in on the three servers', '4'],
  ["Gate, connected servers follow the app's version", '5'],
  ['Gate, full Markdown client, native lifecycle and responsiveness', '1'],
  ['Gate, MCP sessions on connected servers', '5']
])

describe('the required CI check cannot silently lose execution', () => {
  it('keeps both validation paths in every push, pull request and manual comparison', () => {
    expect(workflow.on).toEqual({
      push: { branches: ['dev'] },
      pull_request: null,
      workflow_dispatch: {
        inputs: {
          baseline: {
            description: 'Run the original sequential schedule for a timing comparison',
            type: 'boolean',
            default: false
          }
        }
      }
    })
  })
  it('uses one worker per host on five isolated Macs', () => {
    expect(jobs['e2e-run']['timeout-minutes']).toBe('${{ inputs.baseline && 120 || 35 }}')
    const expression = jobs['e2e-run'].strategy.matrix.task
    const normal = JSON.parse([...expression.matchAll(/fromJSON\('([^']+)'\)/g)][1][1])
    expect(normal).toEqual(['1', '2', '3', '4', '5'])
    for (const host of normal)
      expect([...gatePartitions.values()].filter((task) => task === host)).toHaveLength(2)
  })
  it('schedules every existing gate exactly once in the normal matrix', () => {
    const job = jobs['e2e-run']
    expect(job.if).toBeUndefined()
    expect(job['continue-on-error']).toBeUndefined()
    expect(job.strategy['fail-fast']).toBe(false)
    // No exclude/include can remove the gate partition or duplicate a run.
    expect(Object.keys(job.strategy.matrix)).toEqual(['task'])
    expect(job.strategy.matrix.task).toBe(matrix)
    const partitions = JSON.parse([...matrix.matchAll(/fromJSON\('([^']+)'\)/g)][1][1])
    const gates = job.steps.filter((s) => s.name?.startsWith('Gate,'))
    expect(gates.map((s) => s.name)).toEqual([...expectedGates.keys()])
    for (const gate of gates) {
      const task = gatePartitions.get(gate.name)
      expect(
        partitions.filter((p) => p === task),
        gate.name
      ).toHaveLength(1)
      expect(gate.if, gate.name).toBe(
        `\${{ !cancelled() && steps.build.outcome == 'success' && (matrix.task == '${task}' || matrix.task == 'baseline') }}`
      )
      expect(gate['continue-on-error'], gate.name).toBeUndefined()
      if (expectedGates.get(gate.name)) expect(gate.run).toBe(expectedGates.get(gate.name))
    }
    const mode = (suffix) => gates.find((g) => g.name.endsWith(suffix)).env?.CLAVE_E2E_SERVER
    expect(mode('in-process')).toBeUndefined()
    expect(mode('attached')).toBe('attached')
    expect(mode('separate')).toBe('separate')
  })
  it('runs the aggregate even after failure and never swallows its checks', () => {
    const aggregate = jobs.e2e
    expect(aggregate.needs).toBe('e2e-run')
    expect(aggregate.if).toBe('${{ always() }}')
    expect(aggregate['continue-on-error']).toBeUndefined()
    for (const step of aggregate.steps) {
      expect(step.if, step.name || step.uses).toBeUndefined()
      expect(step['continue-on-error'], step.name || step.uses).toBeUndefined()
    }
    const result = aggregate.steps.find((s) => s.name === 'All required Electron gates passed')
    expect(result.env.RESULT).toBe('${{ needs.e2e-run.result }}')
    expect(result.run).toBe('test "$RESULT" = success')
    const inventory = aggregate.steps.find((s) => s.name === 'Every spec completed exactly once')
    expect(inventory.env.SHARDS).toBe("${{ inputs.baseline && '1' || '5' }}")
    expect(inventory.run.trim().split('\n')).toEqual([
      'node tests/e2e/merge-reports.mjs e2e-reports "$SHARDS" e2e-summary.md',
      'cat e2e-summary.md >> "$GITHUB_STEP_SUMMARY"'
    ])
  })
  it('runs the complete suite without a hidden filename filter', () => {
    const suite = jobs['e2e-run'].steps.find((s) => s.name === 'Report, hosted suite batch')
    expect(suite['continue-on-error']).toBe(true)
    expect(suite.run).toBe('node tests/e2e/ci-batch.mjs "$HOST_BATCH" --report-dir=e2e-reports')
    expect(suite.env).toEqual({ HOST_BATCH: "${{ format('{0}/5', matrix.task) }}" })
    expect(suite.id).toBe('suite')
    expect(suite.if).toBe(
      "${{ !cancelled() && steps.build.outcome == 'success' && matrix.task != 'baseline' }}"
    )
    const steps = jobs['e2e-run'].steps
    expect(steps.indexOf(suite)).toBeLessThan(steps.findIndex((s) => s.name?.startsWith('Gate,')))
    const completion = steps.find((s) => s.name === 'All worker processes completed')
    expect(completion).toBeDefined()
    expect(completion.if).toBe(suite.if)
    expect(completion['continue-on-error']).toBeUndefined()
    expect(completion.env.COMPLETE).toBe('${{ steps.suite.outputs.complete }}')
    expect(completion.run).toBe('test "$COMPLETE" = true')
    expect(steps.indexOf(completion)).toBeGreaterThan(steps.indexOf(suite))
    expect(steps.indexOf(completion)).toBeLessThan(
      steps.findIndex((s) => s.name?.startsWith('Gate,'))
    )
    const baseline = steps.find((s) => s.name === 'Report, sequential baseline suite')
    expect(baseline['continue-on-error']).toBe(true)
    expect(baseline.if).toBe(
      "${{ !cancelled() && steps.build.outcome == 'success' && matrix.task == 'baseline' }}"
    )
    expect(baseline.run).toBe('node tests/e2e/run.mjs --report e2e-reports/shard-1.json')
    expect(steps.indexOf(baseline)).toBeGreaterThan(
      steps.findLastIndex((s) => s.name?.startsWith('Gate,'))
    )
    const upload = steps.find((s) => s.name === 'Preserve shard results')
    expect(upload.if).toBe('${{ always() }}')
    expect(upload['continue-on-error']).toBeUndefined()
    expect(upload.with.name).toBe('e2e-reports-${{ matrix.task }}')
    expect(upload.with.overwrite).toBe(true)
    expect(upload.with['if-no-files-found']).toBe('error')
  })
})
