import { z } from 'zod'
import {
  RUNTIME_PLUGIN_ID_PATTERN,
  type ArtifactInput,
  type PluginBindings,
  type PluginPin
} from '../../shared/runtime-plugins'

export const providerIdSchema = z.string().regex(RUNTIME_PLUGIN_ID_PATTERN)
const pin = z
  .object({
    pluginId: providerIdSchema,
    revision: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[a-zA-Z0-9._:-]+$/),
    version: z.string().min(1).max(100)
  })
  .strict()
const bindings = z
  .object({
    provider: pin,
    views: z.array(pin).max(64)
  })
  .strict()
  .refine((value) => new Set(value.views.map((view) => view.pluginId)).size === value.views.length)

export const artifactInputSchema = z
  .object({
    title: z.string().min(1).max(200),
    mimeType: z.enum(['text/html', 'text/markdown', 'text/plain', 'application/json']),
    content: z.string().max(128 * 1024),
    fallback: z
      .string()
      .min(1)
      .max(32 * 1024),
    sourceUrl: z
      .string()
      .max(4096)
      .refine((value) => {
        try {
          const url = new URL(value)
          return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
        } catch {
          return false
        }
      })
      .optional()
  })
  .strict()
  .refine((value) => Buffer.byteLength(JSON.stringify(value)) <= 192 * 1024)

export function parsePluginBindings(value: unknown): PluginBindings {
  return bindings.parse(value)
}
export function parsePluginPin(value: unknown): PluginPin {
  return pin.parse(value)
}
export function parseArtifactInput(value: unknown): ArtifactInput {
  return artifactInputSchema.parse(value)
}
