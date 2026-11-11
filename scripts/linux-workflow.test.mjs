import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'

const workflow = parse(
  readFileSync(new URL('../.github/workflows/checks.yml', import.meta.url), 'utf8')
)
const jobs = workflow.jobs

describe('the required Linux check cannot silently lose execution', () => {
  it('waits for every Linux job even after failure or cancellation', () => {
    const aggregate = jobs.checks
    expect(aggregate.name).toBe('Lint, typecheck, unit tests')
    expect(aggregate.needs).toBe('linux')
    expect(aggregate.if).toBe('${{ always() }}')
    expect(aggregate['continue-on-error']).toBeUndefined()
    for (const step of aggregate.steps) {
      expect(step.if).toBeUndefined()
      expect(step['continue-on-error']).toBeUndefined()
    }
    const result = aggregate.steps.find((step) => step.name === 'All Linux validations passed')
    expect(result.env.RESULT).toBe('${{ needs.linux.result }}')
    expect(result.run).toBe('test "$RESULT" = success')
  })

  it('covers every shard and audits reports against the complete unfiltered inventory', () => {
    const linux = jobs.linux
    expect(linux.if).toBeUndefined()
    expect(linux['continue-on-error']).toBeUndefined()
    expect(linux.strategy['fail-fast']).toBe(false)
    expect(Object.keys(linux.strategy.matrix)).toEqual(['task'])
    const tasks = linux.strategy.matrix.task
    expect(tasks.filter((task) => !task.startsWith('unit-'))).toEqual(['lint', 'typecheck'])
    const units = tasks.filter((task) => task.startsWith('unit-'))
    expect(units).toEqual(Array.from({ length: units.length }, (_, i) => `unit-${i + 1}`))
    expect(units.length).toBeGreaterThan(0)
    const run = linux.steps.find((step) => step.name === 'Unit tests').run
    expect(run.split('\n').map((line) => line.trim())).toContain(
      'npx --no-install vitest list --filesOnly --json > unit-reports/inventory.json'
    )
    expect(run).toContain(`--shard="\${TASK#unit-}/${units.length}"`)
    expect(run).toContain('--config vitest.ci.config.mjs')
    expect(
      jobs.checks.steps.find((step) => step.name === 'Every unit test file completed exactly once')
        .run
    ).toBe(`node scripts/merge-unit-reports.mjs unit-reports ${units.length}`)
  })

  it('keeps lint, all typechecks, generated-code validation and native setup as required work', () => {
    const steps = jobs.linux.steps
    for (const step of steps) expect(step['continue-on-error']).toBeUndefined()
    for (const [name, condition] of [
      ['Lint', "matrix.task == 'lint'"],
      ['Typecheck', "matrix.task == 'typecheck'"],
      ['Generated code is current', "matrix.task == 'typecheck'"],
      ['Build secure filesystem helper', "startsWith(matrix.task, 'unit-')"],
      ['Unit tests', "startsWith(matrix.task, 'unit-')"]
    ])
      expect(steps.find((step) => step.name === name).if).toBe(condition)
    expect(steps.find((step) => step.name === 'Lint').run).toBe(
      'npm run lint -- --concurrency 4 --cache-strategy content'
    )
    expect(steps.find((step) => step.name === 'Typecheck').run).toBe('npm run typecheck')
    expect(steps.find((step) => step.name === 'Generated code is current').run).toBe(
      'npm run proto:gen && git diff --exit-code -- packages/server/src/terminals/proto'
    )
    expect(steps.find((step) => step.name === 'Build secure filesystem helper').run).toBe(
      'npm run native:build'
    )
  })

  it('invalidates dependency reuse when any install input changes', () => {
    const setup = parse(
      readFileSync(new URL('../.github/actions/setup-checks/action.yml', import.meta.url), 'utf8')
    )
    const cache = setup.runs.steps.find((step) => step.id === 'dependencies')
    expect(cache.with.key).toBe(
      "linux-checks-v1-${{ runner.os }}-${{ runner.arch }}-node22-${{ hashFiles('package-lock.json', '**/package.json', 'scripts/postinstall.cjs', 'electron-builder.yml', '.npmrc', '.github/actions/setup-checks/action.yml') }}"
    )
    expect(cache.with['restore-keys']).toBeUndefined()
    expect(setup.runs.steps.find((step) => step.name === 'Install dependencies').if).toBe(
      "steps.dependencies.outputs.cache-hit != 'true'"
    )
  })

  it('replaces only the rerun worker report without allowing absent results', () => {
    const upload = jobs.linux.steps.find((step) => step.name === 'Preserve unit reports')
    expect(upload.with.name).toBe('unit-reports-${{ matrix.task }}')
    expect(upload.with.overwrite).toBe(true)
    expect(upload.with['if-no-files-found']).toBe('error')
    expect(upload['continue-on-error']).toBeUndefined()
  })
})
