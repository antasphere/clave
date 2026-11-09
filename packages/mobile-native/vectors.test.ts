/**
 * The pin that holds the committed fixture vectors to the contract: the
 * exporter runs again in memory and every committed file must be byte for
 * byte what it writes today, so a schema changed on one side (a field
 * added, renamed or retyped in packages/contract, or a vector edited by
 * hand) fails here, named. Then every committed sample is decoded once more
 * through the schema it was exported from: a valid one must decode, an
 * invalid one must be refused, whatever the file says. shapes.json carries
 * every schema as a JSON Schema, so a field added, dropped or made optional
 * changes a committed file even when every sample still decodes.
 */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Either, Schema } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  FIXTURES_DIR,
  INDEX_FILE,
  SHAPES_FILE,
  buildVectors,
  timelinePageOrdered,
  type CommandVectors,
  type ShapeVectors
} from './scripts/export-vectors'

const here = path.dirname(new URL(import.meta.url).pathname)
const dir = path.resolve(here, '..', '..', FIXTURES_DIR)
const committedNames = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
const committed = (name: string): string => readFileSync(path.join(dir, name), 'utf8')
const { files, schemas } = buildVectors()

const accepts = (schema: Schema.Schema.AnyNoContext, wire: unknown): boolean =>
  Either.isRight(Schema.decodeUnknownEither(schema)(wire))

describe('the fixture vectors', () => {
  it('are exactly the files the contract exports today, no file missing, none extra', () => {
    expect(committedNames).toEqual([...files.keys()].sort())
    for (const [name, text] of files) expect(committed(name), name).toBe(text)
  })

  it('name every file in the index with its hash and size', () => {
    const index = JSON.parse(committed(INDEX_FILE)) as {
      contract: number
      files: Record<string, { sha256: string; bytes: number }>
    }
    expect(Object.keys(index.files).sort()).toEqual(
      committedNames.filter((n) => n !== INDEX_FILE).sort()
    )
    for (const [name, entry] of Object.entries(index.files)) {
      const text = committed(name)
      expect(entry.bytes, name).toBe(Buffer.byteLength(text))
      expect(entry.sha256, name).toMatch(/^[0-9a-f]{64}$/)
    }
  })

  it('carry a valid sample the contract decodes and an invalid one it refuses, in every file', () => {
    let valid = 0
    let invalid = 0
    for (const name of committedNames) {
      if (name === INDEX_FILE || name === SHAPES_FILE || name === 'routes.json') continue
      const data = JSON.parse(committed(name)) as {
        family: string
        shapes?: Record<string, ShapeVectors>
        commands?: Record<string, CommandVectors>
        owner?: Record<string, CommandVectors>
        machine?: Record<string, ShapeVectors>
        events?: ShapeVectors
      }
      const family = schemas[data.family]
      expect(family, `${name}: a schema registry for ${data.family}`).toBeDefined()
      const shapes = {
        ...data.shapes,
        ...data.machine,
        ...(data.events ? { DevicesEvent: data.events } : {})
      }
      for (const [shapeName, vectors] of Object.entries(shapes)) {
        const schema = family[shapeName]
        expect(schema, `${name}: ${shapeName} is a schema the exporter knows`).toBeDefined()
        for (const sample of vectors.valid) {
          expect(accepts(schema, sample.wire), `${name} ${shapeName} valid: ${sample.name}`).toBe(
            true
          )
          valid++
        }
        for (const sample of vectors.invalid ?? []) {
          expect(accepts(schema, sample.wire), `${name} ${shapeName} invalid: ${sample.name}`).toBe(
            false
          )
          invalid++
        }
      }
      for (const [commandName, vectors] of Object.entries({ ...data.commands, ...data.owner })) {
        const payload = family[`${commandName}.payload`]
        expect(
          payload,
          `${name}: ${commandName}.payload is a schema the exporter knows`
        ).toBeDefined()
        for (const sample of vectors.payload) {
          expect(
            accepts(payload, sample.wire),
            `${name} ${commandName} payload: ${sample.name}`
          ).toBe(true)
          valid++
        }
        for (const sample of vectors.invalidPayload ?? []) {
          expect(
            accepts(payload, sample.wire),
            `${name} ${commandName} invalid payload: ${sample.name}`
          ).toBe(false)
          invalid++
        }
        if (vectors.success) {
          const success = family[`${commandName}.success`]
          expect(
            success,
            `${name}: ${commandName}.success is a schema the exporter knows`
          ).toBeDefined()
          for (const sample of vectors.success) {
            expect(
              accepts(success, sample.wire),
              `${name} ${commandName} success: ${sample.name}`
            ).toBe(true)
            valid++
          }
        }
      }
    }
    expect(valid).toBeGreaterThan(150)
    expect(invalid).toBeGreaterThan(50)
  })

  it('describe every shape and command the exporter knows as a JSON Schema, required and optional told apart', () => {
    const data = JSON.parse(committed(SHAPES_FILE)) as {
      schemas: Record<
        string,
        Record<string, { required?: string[]; properties?: Record<string, unknown> }>
      >
    }
    expect(Object.keys(data.schemas).sort()).toEqual(Object.keys(schemas).sort())
    for (const [family, registry] of Object.entries(schemas))
      expect(Object.keys(data.schemas[family]).sort(), family).toEqual(Object.keys(registry).sort())
    // A shape with optional fields lists more properties than it requires;
    // an optional field added to the contract lands among the properties
    // and nowhere else, which is the change no sample-only file showed.
    const session = data.schemas.sessions.Session
    expect(session.required).toContain('id')
    expect(Object.keys(session.properties ?? {}).length).toBeGreaterThan(
      (session.required ?? []).length
    )
  })

  it('keep the ordering rule of a timeline page apart from the contract, and true to the docs', () => {
    const data = JSON.parse(committed('timeline.json')) as {
      ordering: {
        accepted: Array<{ name: string; wire: unknown }>
        refused: Array<{ name: string; wire: unknown }>
      }
    }
    const page = schemas.timeline.TimelinePage
    for (const sample of data.ordering.accepted) {
      expect(accepts(page, sample.wire), sample.name).toBe(true)
      expect(timelinePageOrdered(sample.wire), sample.name).toBe(true)
    }
    expect(data.ordering.refused.map((s) => s.name)).toEqual([
      'a page mixing generations',
      'reversed positions',
      'a repeated position',
      'a position above the cursor'
    ])
    for (const sample of data.ordering.refused) {
      expect(accepts(page, sample.wire), `${sample.name} is accepted by the contract`).toBe(true)
      expect(timelinePageOrdered(sample.wire), `${sample.name} breaks the phone's rule`).toBe(false)
    }
  })

  it('read the device scope off the server: the phone routes allowed, the rest refused', () => {
    const data = JSON.parse(committed('routes.json')) as {
      routes: Array<{ method: string; path: string; device: boolean }>
      scope: { forbiddenMessage: string; GET: string[]; POST: string[] }
      events: { heard: string[]; notHeard: string[]; heardPrefixes: string[] }
    }
    expect(data.scope.forbiddenMessage).toBe('A phone may not do this.')
    expect(data.scope.GET).toContain('/sessions/timeline')
    expect(data.scope.GET).toContain('/devices/me')
    expect(data.scope.GET).toContain('/files/*')
    expect(data.scope.POST).toContain('/sessions/write')
    expect(data.scope.POST).toContain('/files/attachments/prepare')
    expect(data.scope.POST).not.toContain('/devices/approve')
    expect(
      data.routes.find((r) => r.path === '/accounts/antasphere' && r.method === 'GET')?.device
    ).toBe(false)
    expect(data.routes.find((r) => r.path === '/e2e/evaluate')).toBeUndefined()
    expect(data.events.heard).toContain('devices.changed')
    expect(data.events.notHeard).toContain('accounts.antasphere_changed')
    expect(data.events.heardPrefixes).toEqual(['session.', 'usage.'])
  })
})
