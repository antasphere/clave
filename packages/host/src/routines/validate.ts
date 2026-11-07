/**
 * The report's data against the routine's schema (ADR 0004): JSON Schema,
 * draft 2020-12 or draft-07 (ajv reads both), the formats of `ajv-formats`
 * known. A schema is compiled once per run from its file; a schema that
 * does not compile fails the run with its error, and data the schema refuses
 * is answered to the agent with every error in words it can act on.
 */
import * as fs from 'node:fs'
import Ajv2020 from 'ajv/dist/2020'
import Ajv from 'ajv'
import addFormats from 'ajv-formats'

export type SchemaCheck =
  | { ok: true; validate: (data: unknown) => { ok: true } | { ok: false; errors: string[] } }
  | { ok: false; reason: string }

const MAX_SCHEMA_BYTES = 512 * 1024

/** Read and compile the schema at `file`. */
export function compileSchemaFile(file: string): SchemaCheck {
  let text: string
  try {
    const stat = fs.statSync(file)
    if (stat.size > MAX_SCHEMA_BYTES)
      return { ok: false, reason: `the schema at ${file} is larger than 512 KiB` }
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return {
      ok: false,
      reason: `the schema at ${file} cannot be read: ${(error as Error).message}`
    }
  }
  let schema: unknown
  try {
    schema = JSON.parse(text)
  } catch (error) {
    return { ok: false, reason: `the schema at ${file} is not JSON: ${(error as Error).message}` }
  }
  return compileSchema(schema, file)
}

export function compileSchema(schema: unknown, name = 'the schema'): SchemaCheck {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    return { ok: false, reason: `${name} is not a JSON Schema object` }
  const draft = (schema as { $schema?: unknown }).$schema
  const is2020 = typeof draft !== 'string' || draft.includes('2020-12') || draft.includes('2019-09')
  try {
    const ajv = is2020
      ? new Ajv2020({ allErrors: true, strict: false, allowUnionTypes: true })
      : new Ajv({ allErrors: true, strict: false, allowUnionTypes: true })
    addFormats(ajv)
    const fn = ajv.compile(schema as object)
    return {
      ok: true,
      validate: (data) => {
        const valid = fn(data)
        if (valid) return { ok: true }
        const errors = (fn.errors ?? []).map((e) => {
          const where = e.instancePath ? `data${e.instancePath}` : 'data'
          const extra =
            e.keyword === 'additionalProperties' && typeof e.params?.additionalProperty === 'string'
              ? ` (${e.params.additionalProperty})`
              : e.keyword === 'enum' && Array.isArray(e.params?.allowedValues)
                ? ` (one of ${(e.params.allowedValues as unknown[]).map(String).join(', ')})`
                : ''
          return `${where} ${e.message ?? 'is invalid'}${extra}`
        })
        return {
          ok: false,
          errors: errors.length ? errors : ['the data does not match the schema']
        }
      }
    }
  } catch (error) {
    return { ok: false, reason: `${name} does not compile: ${(error as Error).message}` }
  }
}
