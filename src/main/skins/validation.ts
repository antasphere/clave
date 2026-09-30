import { skinManifestSchema } from '@clave/plugin-sdk'
import postcss from 'postcss'
import valueParser from 'postcss-value-parser'
import { valid, validRange, satisfies } from 'semver'
import tokenNames from '@clave/skins/token-names.json'
import type { SkinManifest } from '@clave/skins/types'

const allowed = new Set(tokenNames)

export function validateTokens(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('skin.json must be a flat token map')
  const tokens: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) throw new Error(`Unknown skin token: ${key}`)
    if (typeof value !== 'string' || !value.trim() || /[;{}\\@!]|\/\*/.test(value))
      throw new Error(`Invalid value for ${key}`)
    valueParser(value).walk((node) => {
      if (
        node.type === 'function' &&
        ![
          'var',
          'rgb',
          'rgba',
          'hsl',
          'hsla',
          'oklch',
          'oklab',
          'color-mix',
          'calc',
          'min',
          'max',
          'clamp',
          'cubic-bezier'
        ].includes(node.value.toLowerCase())
      )
        throw new Error(`Forbidden function in ${key}`)
      if (node.type === 'function' && node.value === 'var') {
        const reference = node.nodes[0]
        if (!reference || reference.type !== 'word' || !allowed.has(reference.value))
          throw new Error(`Unknown token reference in ${key}`)
      }
    })
    tokens[key] = value
  }
  return tokens
}

export function parseSkinCss(css: string): Record<string, string> {
  const tokens: Record<string, string> = {}
  const root = postcss.parse(css)
  for (const rule of root.nodes) {
    if (rule.type !== 'rule' || rule.selector !== ':root')
      throw new Error('Skin CSS permits only :root declarations')
    for (const node of rule.nodes) {
      if (node.type !== 'decl' || node.important)
        throw new Error('Skin CSS permits only token declarations')
      Object.assign(tokens, validateTokens({ [node.prop]: node.value }))
    }
  }
  return tokens
}

export function validateManifest(input: unknown, appVersion: string): SkinManifest {
  const m = input as SkinManifest
  if (
    !m ||
    m.kind !== 'skin' ||
    typeof m.id !== 'string' ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(m.id) ||
    typeof m.name !== 'string' ||
    !m.name.trim()
  )
    throw new Error('Invalid skin manifest')
  if (typeof m.version !== 'string' || valid(m.version) !== m.version)
    throw new Error('Invalid skin version')
  if (
    typeof m.engines?.clave !== 'string' ||
    !validRange(m.engines.clave) ||
    !satisfies(appVersion, m.engines.clave)
  )
    throw new Error('Incompatible Clave engine version')
  const skin = skinManifestSchema.parse(m.skin)
  return {
    kind: 'skin',
    id: m.id,
    name: m.name,
    version: m.version,
    engines: { clave: m.engines.clave },
    skin
  }
}
