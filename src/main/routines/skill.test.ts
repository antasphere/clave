import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { RoutineDeclaration } from '@clave/contract/routines'
import { SKILL_INVOCATION, contractPluginDir, contractSkillText, firstMessage } from './skill'

const routine: RoutineDeclaration = {
  key: '/w/.clave/workspaces/default.clave::Workspace health',
  name: 'Workspace health',
  file: '/w/.clave/workspaces/default.clave',
  rootDir: '/w',
  group: 'Antasphere',
  workspaceId: 'ws',
  workspaceName: 'Antasphere',
  schedule: '30 8 * * 1-5',
  prompt: 'Check this machine and fix what is safe.',
  skill: 'steward:workspace-health',
  cwd: '/w',
  launch: {},
  icon: 'shield',
  color: 'teal',
  catchUp: true,
  timeoutMinutes: 30,
  scope: 'machine',
  runsOn: 'every',
  runsHere: true,
  report: {
    template: '/w/.clave/routines/workspace-health',
    schema: '/w/.clave/routines/workspace-health/schema.json',
    width: 560,
    height: 640,
    publish: false
  },
  invalid: null
}

describe('the first message', () => {
  it('invokes the contract skill with the run facts and the job, for Claude', () => {
    const text = firstMessage({
      routine,
      run: { id: 'run-1', agent: 'claude' },
      pluginDir: '/nowhere'
    })
    expect(text.startsWith(`${SKILL_INVOCATION} Routine: Workspace health\nRun: run-1\n`)).toBe(
      true
    )
    expect(text).toContain('Schema: /w/.clave/routines/workspace-health/schema.json')
    expect(text).toContain('Skill: steward:workspace-health')
    expect(text).toContain('Working directory: /w')
    expect(text.endsWith('\n\nJob:\nCheck this machine and fix what is safe.')).toBe(true)
  })

  it('carries the contract text itself for an agent with no plugin mechanism', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clave-skill-'))
    mkdirSync(join(dir, 'skills', 'run'), { recursive: true })
    writeFileSync(
      join(dir, 'skills', 'run', 'SKILL.md'),
      '---\nname: run\n---\n\n# Contract\nReport at the end.\n'
    )
    const text = firstMessage({
      routine: { ...routine, skill: null },
      run: { id: 'r', agent: 'codex' },
      pluginDir: dir
    })
    expect(text.startsWith('# Contract\nReport at the end.')).toBe(true)
    expect(text).not.toContain('name: run')
    expect(text).not.toContain('Skill:')
    expect(text).toContain('\n\n---\n\nRoutine: Workspace health')
    // Without the folder, a short contract still travels.
    expect(contractSkillText('/nowhere')).toContain('clave_routine_report')
  })

  it('names the plugin folder under the resources, unpacked from the asar', () => {
    expect(contractPluginDir('/Applications/Clave.app/Contents/Resources/app.asar/resources')).toBe(
      '/Applications/Clave.app/Contents/Resources/app.asar.unpacked/resources/claude-plugins/clave-routine'
    )
  })
})
