/**
 * What a routine run is told (ADR 0004): the first message, the contract
 * skill's invocation followed by the run's facts and the job; the one line
 * appended to Claude's system prompt; and where the contract skill lives,
 * the Claude Code plugin folder the app ships (`resources/claude-plugins/
 * clave-routine`). For an agent with no plugin mechanism the skill's text
 * travels in the first message instead.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { RoutineDeclaration, RoutineRun } from '@clave/contract/routines'

export const SKILL_INVOCATION = '/clave-routine:run'

export const SYSTEM_PROMPT_LINE =
  'This is an unattended Clave routine run: nobody reads this session while it runs. The clave-routine:run skill is the contract; end by calling clave_routine_report with data matching the routine schema, or the run counts as failed.'

/** The plugin folder beside the app's resources; unpacked from the asar in a packaged app. */
export function contractPluginDir(resourcesDir: string): string {
  return path
    .join(resourcesDir, 'claude-plugins', 'clave-routine')
    .replace('app.asar', 'app.asar.unpacked')
}

/** The skill's own text, for an agent that loads no plugin. */
export function contractSkillText(pluginDir: string): string {
  try {
    const text = fs.readFileSync(path.join(pluginDir, 'skills', 'run', 'SKILL.md'), 'utf8')
    // The frontmatter is the plugin loader's; the body is the contract.
    return text.replace(/^---[\s\S]*?---\s*/, '')
  } catch {
    return 'You are an unattended Clave routine run. Do the job below, then call clave_routine_report with status, headline, summary and data matching the schema at the path given. A run without a valid report counts as failed.'
  }
}

export interface FirstMessageInput {
  routine: RoutineDeclaration
  run: Pick<RoutineRun, 'id' | 'agent'>
  /** The plugin folder, read for the skill text when the agent loads no plugin. */
  pluginDir: string
}

/** The run's facts, one per line, as the skill reads them. */
function facts(input: FirstMessageInput): string {
  const { routine, run } = input
  return [
    `Routine: ${routine.name}`,
    `Run: ${run.id}`,
    `Schema: ${routine.report.schema}`,
    ...(routine.skill ? [`Skill: ${routine.skill}`] : []),
    `Working directory: ${routine.cwd}`
  ].join('\n')
}

/** The first message: the skill invoked with the facts and the job (Claude),
 *  or the contract's text itself, the facts and the job (the others). */
export function firstMessage(input: FirstMessageInput): string {
  const body = `${facts(input)}\n\nJob:\n${input.routine.prompt}`
  if (input.run.agent === 'claude') return `${SKILL_INVOCATION} ${body}`
  return `${contractSkillText(input.pluginDir).trim()}\n\n---\n\n${body}`
}
