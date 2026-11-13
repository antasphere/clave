import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compileSchema, compileSchemaFile } from './validate'

const CHECKS = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  required: ['checks'],
  additionalProperties: false,
  properties: {
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'verdict'],
        properties: {
          name: { type: 'string', minLength: 1 },
          verdict: { enum: ['ok', 'fixed', 'attention', 'failed'] },
          fixed: { type: 'array', items: { type: 'string' } },
          proposed: { type: 'array', items: { type: 'string' } },
          detail: { type: 'string' }
        }
      }
    },
    checkedAt: { type: 'string', format: 'date-time' }
  }
}

describe('compileSchema', () => {
  it('accepts matching data and names every error of refused data, in words', () => {
    const check = compileSchema(CHECKS)
    expect(check.ok).toBe(true)
    if (!check.ok) return
    expect(
      check.validate({ checks: [{ name: 'steward status', verdict: 'ok', fixed: [] }] })
    ).toEqual({ ok: true })
    const refused = check.validate({
      checks: [{ name: '', verdict: 'maybe' }],
      extra: 1,
      checkedAt: 'yesterday'
    })
    expect(refused.ok).toBe(false)
    if (refused.ok) return
    expect(refused.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('data/checks/0/name'),
        expect.stringContaining('one of ok, fixed, attention, failed'),
        expect.stringContaining('additional properties (extra)'),
        expect.stringContaining('data/checkedAt')
      ])
    )
  })

  it('reads draft-07 too, and refuses what is not a schema', () => {
    expect(
      compileSchema({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'number' }).ok
    ).toBe(true)
    expect(compileSchema('nope')).toMatchObject({ ok: false })
    expect(compileSchema({ type: 'not-a-type' })).toMatchObject({ ok: false })
  })

  it('reads a schema file and says why one cannot be read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clave-schema-'))
    const file = join(dir, 'schema.json')
    writeFileSync(file, JSON.stringify(CHECKS))
    expect(compileSchemaFile(file).ok).toBe(true)
    writeFileSync(file, '{ not json')
    expect(compileSchemaFile(file)).toMatchObject({
      ok: false,
      reason: expect.stringContaining('not JSON')
    })
    expect(compileSchemaFile(join(dir, 'missing.json'))).toMatchObject({
      ok: false,
      reason: expect.stringContaining('cannot be read')
    })
  })
})
