/**
 * `@`-token expansion in a `.clave` prompt.
 *
 * This is the half of prompt delivery decidable without a running app. It
 * matters because a token that survives unexpanded reaches the agent verbatim —
 * an agent told to work at `@root_path` does nothing useful, and nothing in the
 * UI shows the difference.
 */

import { describe, expect, it } from 'vitest'
import { substituteTokens } from './prompt-tokens'

const ROOT = '/Users/me/.antasphere'

describe('substituteTokens', () => {
  it('expands @root_path to the workspace root', () => {
    expect(substituteTokens('work at @root_path', ROOT, `${ROOT}/labs/clave`)).toBe(
      `work at ${ROOT}`
    )
  })

  it('expands @project_abs to the project directory', () => {
    expect(substituteTokens('open @project_abs', ROOT, `${ROOT}/labs/clave`)).toBe(
      `open ${ROOT}/labs/clave`
    )
  })

  it('expands @project_path relative to the root', () => {
    expect(substituteTokens('cd @project_path', ROOT, `${ROOT}/labs/clave`)).toBe('cd labs/clave')
  })

  it('gives @project_path as "." when the project IS the root', () => {
    expect(substituteTokens('cd @project_path', ROOT, ROOT)).toBe('cd .')
  })

  it('falls back to the absolute path when the project sits outside the root', () => {
    expect(substituteTokens('@project_path', ROOT, '/elsewhere/thing')).toBe('/elsewhere/thing')
  })

  it('uses the project dir as the root when no workspace root is known', () => {
    expect(substituteTokens('@root_path', null, '/somewhere/proj')).toBe('/somewhere/proj')
  })

  it('tolerates a trailing slash on the root', () => {
    expect(substituteTokens('@root_path/x', `${ROOT}/`, `${ROOT}/p`)).toBe(`${ROOT}/x`)
  })

  it('expands every occurrence, not just the first', () => {
    expect(substituteTokens('@root_path then @root_path', ROOT, ROOT)).toBe(`${ROOT} then ${ROOT}`)
  })

  it('leaves a prompt with no tokens untouched', () => {
    expect(substituteTokens('just do the thing', ROOT, `${ROOT}/p`)).toBe('just do the thing')
  })

  it('leaves no @-token behind in a prompt using all three', () => {
    const out = substituteTokens(
      '@root_path @project_path @project_abs',
      ROOT,
      `${ROOT}/labs/clave`
    )
    expect(out).not.toMatch(/@(root_path|project_path|project_abs)/)
  })
})
