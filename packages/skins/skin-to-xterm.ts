import valueParser from 'postcss-value-parser'
import type { ITheme } from '@xterm/xterm'

/** The single mapping used by local, remote and toolbar terminals. */
export const XTERM_TOKEN_MAP = {
  background: '--surface-0',
  foreground: '--terminal-foreground',
  cursor: '--terminal-cursor',
  cursorAccent: '--surface-0',
  selectionBackground: '--terminal-selection-background',
  selectionForeground: '--terminal-selection-foreground',
  black: '--terminal-black',
  red: '--terminal-red',
  green: '--terminal-green',
  yellow: '--terminal-yellow',
  blue: '--terminal-blue',
  magenta: '--terminal-magenta',
  cyan: '--terminal-cyan',
  white: '--terminal-white',
  brightBlack: '--terminal-bright-black',
  brightRed: '--terminal-bright-red',
  brightGreen: '--terminal-bright-green',
  brightYellow: '--terminal-bright-yellow',
  brightBlue: '--terminal-bright-blue',
  brightMagenta: '--terminal-bright-magenta',
  brightCyan: '--terminal-bright-cyan',
  brightWhite: '--terminal-bright-white'
} as const satisfies Partial<Record<keyof ITheme, string>>

export type SkinTerminalTheme = Record<keyof typeof XTERM_TOKEN_MAP, string | undefined> & {
  background: string
}

export function resolveToken(
  tokens: Record<string, string>,
  name: string,
  seen = new Set<string>()
): string {
  if (seen.has(name)) throw new Error(`Circular skin token: ${name}`)
  const value = tokens[name]
  if (value === undefined) throw new Error(`Missing skin token: ${name}`)
  const parsed = valueParser(value)
  parsed.walk((node) => {
    if (node.type !== 'function' || node.value !== 'var') return
    const reference = node.nodes.find((part) => part.type === 'word')
    if (!reference) throw new Error(`Invalid token reference in ${name}`)
    const resolved = resolveToken(tokens, reference.value, new Set([...seen, name]))
    Object.assign(node, { type: 'word', value: resolved })
    return false
  })
  return parsed.toString()
}

export function skinToXterm(
  tokens: Record<string, string>,
  color: (value: string) => string = (value) => value
): SkinTerminalTheme {
  return Object.fromEntries(
    Object.entries(XTERM_TOKEN_MAP).map(([key, name]) => {
      const value = resolveToken(tokens, name)
      return [key, value === 'none' ? undefined : color(value)]
    })
  ) as SkinTerminalTheme
}

/** An installed skin's UI accent also paints its terminal cursor unless the
 * author explicitly supplies a terminal accent/cursor. Bundled skins retain
 * their original cursor colors. Keep this in tokens, never in xterm wiring. */
export function inheritSkinTokens(
  base: Record<string, string>,
  overrides: Record<string, string>
): Record<string, string> {
  return {
    ...base,
    ...(overrides['--color-accent'] !== undefined &&
    overrides['--terminal-accent'] === undefined &&
    overrides['--terminal-cursor'] === undefined
      ? { '--terminal-accent': 'var(--color-accent)' }
      : {}),
    ...overrides
  }
}
