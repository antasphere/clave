import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const workflow = parse(
  readFileSync(new URL('../../.github/workflows/checks.yml', import.meta.url), 'utf8')
)
const jobs = workflow.jobs
const matrix =
  '${{ inputs.baseline && fromJSON(\'["baseline"]\') || fromJSON(\'["1","2","3","4","gates"]\') }}'
const gateCondition =
  "${{ !cancelled() && steps.build.outcome == 'success' && (matrix.task == 'gates' || matrix.task == 'baseline') }}"
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

describe('the required CI check cannot silently lose execution', () => {
  it('schedules every existing gate exactly once in the normal matrix', () => {
    const job = jobs['e2e-run']
    expect(job.if).toBeUndefined()
    expect(job['continue-on-error']).toBeUndefined()
    expect(job.strategy['fail-fast']).toBe(false)
    // No exclude/include can remove the gate partition or duplicate a run.
    expect(Object.keys(job.strategy.matrix)).toEqual(['task'])
    expect(job.strategy.matrix.task).toBe(matrix)
    const partitions = JSON.parse([...matrix.matchAll(/fromJSON\('([^']+)'\)/g)][1][1])
    expect(partitions.filter((p) => p === 'gates')).toHaveLength(1)
    const gates = job.steps.filter((s) => s.name?.startsWith('Gate,'))
    expect(gates.map((s) => s.name)).toEqual([...expectedGates.keys()])
    for (const gate of gates) {
      expect(gate.if, gate.name).toBe(gateCondition)
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
    expect(inventory.env.SHARDS).toBe("${{ inputs.baseline && '1' || '4' }}")
    expect(inventory.run.trim().split('\n')).toEqual([
      'node tests/e2e/merge-reports.mjs e2e-reports "$SHARDS" e2e-summary.md',
      'cat e2e-summary.md >> "$GITHUB_STEP_SUMMARY"'
    ])
  })
  it('runs the complete suite without a hidden filename filter', () => {
    const suite = jobs['e2e-run'].steps.find(
      (s) => s.name === 'Report, the whole suite with isolated workers'
    )
    expect(suite.run).toBe(
      'node tests/e2e/run.mjs --shard "$SHARD" --report "e2e-reports/shard-$INDEX.json"'
    )
    expect(suite.env.SHARD).toBe(
      "${{ matrix.task == 'baseline' && '1/1' || format('{0}/4', matrix.task) }}"
    )
    expect(suite.env.INDEX).toBe("${{ matrix.task == 'baseline' && '1' || matrix.task }}")
  })
})
