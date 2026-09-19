import { z } from 'zod'
import {
  PLUGIN_CAPABILITIES,
  RUNTIME_PLUGIN_ID_PATTERN,
  type RuntimePluginManifest
} from '../../shared/runtime-plugins'

export const builtinProviderIds = ['claude', 'codex', 'opencode', 'pi']
export const identifier = z.string().regex(RUNTIME_PLUGIN_ID_PATTERN)
export const capabilitiesSchema = z.strictObject({
  permissions: z.boolean(),
  questions: z.boolean(),
  resume: z.boolean(),
  notice: z.string().max(2000).optional()
})
const label = z.string().trim().min(1).max(160)
const entry = z.string().min(1).max(240).refine(isSafeRelativePath, 'Unsafe plugin entry path')
const unique = <T>(items: T[]): boolean => new Set(items).size === items.length
const manifestSchema = z
  .strictObject({
    apiVersion: z.literal(1),
    id: identifier.refine(
      (id) => !id.startsWith('builtin.') && !builtinProviderIds.includes(id),
      'Reserved plugin ID'
    ),
    name: label,
    version: z
      .string()
      .max(80)
      .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/),
    provider: z
      .strictObject({
        id: identifier.refine(
          (id) => !builtinProviderIds.includes(id) && !id.startsWith('builtin.'),
          'Reserved provider ID'
        ),
        name: label,
        entry: entry.refine(
          (path) => path.endsWith('.cjs'),
          'Provider must be built CommonJS (.cjs)'
        ),
        command: z
          .array(
            z
              .string()
              .min(1)
              .max(4096)
              .refine((value) => !value.includes('\0'))
          )
          .min(1)
          .max(32),
        capabilities: capabilitiesSchema
      })
      .optional(),
    views: z
      .array(
        z.strictObject({
          id: identifier,
          name: label,
          entry: entry.refine((path) => path.endsWith('.html'), 'View must be self-contained HTML'),
          mimeTypes: z
            .array(
              z
                .string()
                .max(128)
                .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/)
            )
            .max(32)
            .refine(unique)
            .optional(),
          toolNames: z.array(label).max(64).refine(unique).optional(),
          capabilities: z
            .array(z.enum(PLUGIN_CAPABILITIES))
            .max(PLUGIN_CAPABILITIES.length)
            .refine(unique)
        })
      )
      .max(32)
  })
  .refine((value) => !!value.provider || value.views.length > 0, 'Plugin has no contributions')
  .refine((value) => unique(value.views.map((view) => view.id)), 'Duplicate view ID')

export function isSafeRelativePath(path: string): boolean {
  return (
    !path.includes('\\') &&
    !path.includes(':') &&
    !path.includes('\0') &&
    path
      .split('/')
      .every(
        (part) =>
          !!part &&
          part !== '.' &&
          part !== '..' &&
          !part.startsWith('.') &&
          part !== 'node_modules'
      )
  )
}

export function validateManifest(value: unknown): RuntimePluginManifest {
  return manifestSchema.parse(value)
}
