import { z } from 'zod'
import { valid, validRange, satisfies } from 'semver'

export const pluginPermissionSchema = z.enum([
  'sessions.read',
  'sessions.write',
  'fs.read',
  'fs.write',
  'net',
  'secrets',
  'shell'
])
export type PluginPermission = z.infer<typeof pluginPermissionSchema>

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/)
const title = z.string().trim().min(1)
const relativePath = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !value.startsWith('/') &&
      !value.includes('\\') &&
      !value.includes(':') &&
      value.split('/').every((part) => part !== '..' && part !== '.' && part.length > 0),
    'Expected a relative path without traversal'
  )
const contributions = z
  .strictObject({
    panels: z
      .array(
        z.strictObject({
          id: identifier,
          title,
          icon: z.string().regex(/^[A-Z][A-Za-z0-9]*Icon$/),
          placement: z.enum(['side', 'main'])
        })
      )
      .default([]),
    commands: z
      .array(z.strictObject({ id: identifier, title, keybinding: title.optional() }))
      .default([]),
    sidebarSections: z.array(z.strictObject({ id: identifier, title })).default([]),
    views: z
      .array(z.strictObject({ id: identifier, renders: z.array(z.enum(['pty', 'events'])).min(1) }))
      .default([]),
    adapters: z.array(z.strictObject({ id: identifier, provider: title })).default([])
  })
  .superRefine((value, context) => {
    for (const [key, entries] of Object.entries(value)) {
      const ids = new Set<string>()
      entries.forEach((entry, index) => {
        if (ids.has(entry.id))
          context.addIssue({
            code: 'custom',
            path: [key, index, 'id'],
            message: 'Duplicate contribution id'
          })
        ids.add(entry.id)
      })
    }
  })

export const pluginManifestSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/),
    name: title,
    version: z.string().refine((value) => valid(value) === value, 'Expected a semver version'),
    kind: z.enum(['plugin', 'skin']),
    engines: z.strictObject({
      clave: z
        .string()
        .min(1)
        .refine((value) => validRange(value) !== null, 'Expected a semver range')
    }),
    ui: z.enum(['native', 'surface', 'none']).optional(),
    skin: z
      .strictObject({
        tokens: relativePath,
        css: relativePath.optional(),
        base: z.enum(['dark', 'light'])
      })
      .optional(),
    main: relativePath.optional(),
    uiEntry: relativePath.optional(),
    contributes: contributions.prefault({}),
    permissions: z.array(pluginPermissionSchema).default([])
  })
  .superRefine((value, context) => {
    if (value.kind === 'plugin' && !value.ui)
      context.addIssue({ code: 'custom', path: ['ui'], message: 'Plugins must declare ui' })
    if (value.kind === 'plugin' && value.skin)
      context.addIssue({ code: 'custom', path: ['skin'], message: 'skin requires kind: skin' })
    if (
      value.kind === 'skin' &&
      (value.main ||
        value.uiEntry ||
        (value.ui && value.ui !== 'none') ||
        value.permissions.length ||
        Object.values(value.contributes).some((items) => items.length))
    )
      context.addIssue({
        code: 'custom',
        message: 'Skins cannot execute code or contribute capabilities'
      })
    if (value.uiEntry && value.ui !== 'surface')
      context.addIssue({
        code: 'custom',
        path: ['uiEntry'],
        message: 'uiEntry requires ui: surface'
      })
    if (new Set(value.permissions).size !== value.permissions.length)
      context.addIssue({ code: 'custom', path: ['permissions'], message: 'Duplicate permission' })
  })
  .transform((value) => ({
    ...value,
    ui: value.ui ?? ('none' as const),
    uiEntry: value.ui === 'surface' ? (value.uiEntry ?? 'ui/index.html') : undefined
  }))

export type PluginManifest = z.infer<typeof pluginManifestSchema>
export type PluginManifestInput = z.input<typeof pluginManifestSchema>
export function isEngineCompatible(manifest: PluginManifest, version: string): boolean {
  return valid(version) !== null && satisfies(version, manifest.engines.clave)
}
