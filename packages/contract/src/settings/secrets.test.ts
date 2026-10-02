import { describe, expect, it } from 'vitest'
import { Schema, SchemaAST } from 'effect'
import * as Settings from './index'

/**
 * The rule at the top of accounts.ts, checked mechanically: no schema a
 * client reads (a query's answer, a command's answer, an event) carries a
 * token or an API key, and the two payloads that carry one in carry it
 * redacted. A schema that broke the rule would render a perfect Accounts
 * page and put the token on the push channel.
 */
const SECRET_FIELDS = new Set(['token', 'apiKey', 'oauthToken', 'credential', 'password'])

function propertyNames(ast: SchemaAST.AST, seen = new Set<SchemaAST.AST>()): string[] {
  if (seen.has(ast)) return []
  seen.add(ast)
  switch (ast._tag) {
    case 'TypeLiteral':
      return ast.propertySignatures.flatMap((p) => [String(p.name), ...propertyNames(p.type, seen)])
    case 'Union':
      return ast.types.flatMap((t) => propertyNames(t, seen))
    case 'TupleType':
      return [...ast.elements, ...ast.rest].flatMap((e) => propertyNames(e.type, seen))
    case 'Refinement':
    case 'Suspend':
      return propertyNames(ast._tag === 'Suspend' ? ast.f() : ast.from, seen)
    case 'Transformation':
      return [...propertyNames(ast.from, seen), ...propertyNames(ast.to, seen)]
    default:
      return []
  }
}

type Definition = {
  _kind: 'command' | 'query'
  tag: string
  payload: Schema.Schema.Any
  success: Schema.Schema.Any
}
function isDefinition(value: unknown): value is Definition {
  return (
    typeof value === 'object' &&
    value !== null &&
    '_kind' in value &&
    'payload' in value &&
    'success' in value
  )
}

const definitions: Definition[] = (Object.values(Settings) as unknown[]).filter(isDefinition)

describe('the settings contract keeps secrets off every surface a client reads', () => {
  it('defines the messages of the four domains', () => {
    expect(definitions.length).toBeGreaterThanOrEqual(30)
    expect(definitions.map((d) => d.tag)).toContain('SetClaudeAccountToken')
  })

  it('no command or query answers with a secret field', () => {
    for (const definition of definitions) {
      const names = propertyNames(definition.success.ast)
      const leaked = names.filter((n) => SECRET_FIELDS.has(n))
      expect(leaked, `${definition.tag} answers with ${leaked.join(', ')}`).toEqual([])
    }
  })

  it('no event carries a secret field', () => {
    const leaked = propertyNames(Settings.SettingsEvent.ast).filter((n) => SECRET_FIELDS.has(n))
    expect(leaked).toEqual([])
  })

  it('only two payloads carry a secret in, and both carry it redacted', () => {
    const carrying = definitions.filter((d) =>
      propertyNames(d.payload.ast).some((n) => SECRET_FIELDS.has(n))
    )
    expect(carrying.map((d) => d.tag).sort()).toEqual([
      'SetClaudeAccountToken',
      'StartCodexApiKeyLogin'
    ])
    const token = Schema.decodeUnknownSync(Settings.SetClaudeAccountToken.payload)({
      id: 'a',
      token: 'sk-ant-oat01-x'
    })
    expect(String(token.token)).toBe('<redacted>')
    expect(JSON.stringify(token)).not.toContain('sk-ant')
  })

  it('every settings event is tagged under its domain, the way the server union is read', () => {
    const tags = (Settings.SettingsEvent.ast as SchemaAST.Union).types.map(
      (m) => (m as SchemaAST.TypeLiteral).propertySignatures.find((p) => p.name === '_tag')!
    )
    for (const tag of tags) {
      const literal = (tag.type as SchemaAST.Literal).literal
      expect(String(literal)).toMatch(/^(accounts|usage|workspaces)\.[a-z_]+$/)
    }
    expect(tags).toHaveLength(6)
  })
})
