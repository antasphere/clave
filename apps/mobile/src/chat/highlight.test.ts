import { describe, expect, it } from 'vitest'
import { highlightCode } from './highlight'

describe('desktop syntax colors on native text', () => {
  const code = 'const ready: boolean = true\nconsole.log("Ready")\n'
  it('colors a fence while preserving all source and line endings', async () => {
    const tokens = await highlightCode(code, 'typescript', 'dark')
    expect(tokens).not.toBeNull()
    expect(tokens!.map((line) => line.map((t) => t.content).join('')).join('\n')).toBe(code)
    expect(new Set(tokens!.flat().map((t) => t.color)).size).toBeGreaterThan(2)
  })
  it('uses the same two code palettes as desktop across the four themes', async () => {
    const light = await highlightCode(code, 'ts', 'light')
    const dark = await highlightCode(code, 'ts', 'dark')
    expect(await highlightCode(code, 'ts', 'coffee')).toEqual(light)
    expect(await highlightCode(code, 'ts', 'charcoal')).toEqual(dark)
    expect(light).not.toEqual(dark)
  })
  it('leaves unknown and unlabelled code plain', async () => {
    expect(await highlightCode(code, undefined, 'light')).toBeNull()
    expect(await highlightCode(code, 'not-a-language', 'dark')).toBeNull()
    expect(await highlightCode(code, 'constructor', 'dark')).toBeNull()
  })
})
