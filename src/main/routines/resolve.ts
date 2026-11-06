/**
 * The routines a server schedules, read off its own workspace files (ADR
 * 0004): for each workspace of the registry, the profile file (else the
 * discovered `default`, else the sole file, the renderer's rule), and with
 * `autoDiscover` on, the project files the recursive walk finds, preferring
 * a same-named profile inside each project. Every file is read with no
 * reviewer: an elevated file nobody trusted answers null and contributes
 * nothing, which is the trust boundary applied to a scheduler that cannot
 * ask. Each group's routines become declarations: the identity key, the
 * paths made absolute, the prompt substituted, the report spec defaulted
 * and checked, and `invalid` set for what can never run as declared.
 */
import * as path from 'node:path'
import type { ClaveGroup, ClaveRoutine } from '@clave/contract/workspace-files'
import type { RoutineDeclaration } from '@clave/contract/routines'
import type { WorkspaceFiles } from '@clave/server/workspace-files'
import { substituteTokens } from '../../shared/prompt-tokens'
import { parseCron } from './cron'
import { checkTemplate } from './deck'

export const DEFAULT_TIMEOUT_MINUTES = 30
/** A week: above it a JavaScript timer overflows and fires at once (round 1, F5). */
export const MAX_TIMEOUT_MINUTES = 7 * 24 * 60
export const DEFAULT_PANEL = { width: 560, height: 640 }

export interface RegistryWorkspace {
  readonly id: string
  readonly name: string
  readonly rootDir: string
  readonly profileFile: string | null
}

export interface ResolvedRoutines {
  readonly declarations: RoutineDeclaration[]
  /** Every file read, for the watch; the profile files whether they exist or not. */
  readonly files: string[]
}

/** `{{name}}` from the params; an unknown `{{x}}` stays as written. */
export function substituteParams(
  prompt: string,
  params: Record<string, string> | undefined
): string {
  if (!params) return prompt
  return prompt.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? params[name] : whole
  )
}

export function routineKey(file: string, name: string): string {
  return `${file}::${name}`
}

/** One routine of one group, as the scheduler sees it. Pure. */
export function declare(
  routine: ClaveRoutine,
  context: {
    file: string
    rootDir: string
    group: ClaveGroup
    workspace: RegistryWorkspace
    /** Whether the template folder is usable; checked on disk by the caller. */
    template: (template: string, root: string) => { ok: true } | { ok: false; reason: string }
  }
): RoutineDeclaration {
  const { file, rootDir, group, workspace } = context
  const cwd = routine.cwd ?? group.cwd
  const prompt = substituteTokens(
    substituteParams(routine.prompt, routine.params),
    workspace.rootDir,
    cwd
  )
  const reasons: string[] = []
  try {
    parseCron(routine.schedule)
  } catch (error) {
    reasons.push(`the schedule does not parse: ${(error as Error).message}`)
  }
  const scope = routine.scope ?? 'machine'
  if (scope === 'team') reasons.push('team scope is not built yet')
  else if (scope !== 'machine') reasons.push(`scope "${scope}" is not machine or team`)
  const template = routine.report?.template
  const report = template
    ? {
        template,
        schema: routine.report?.schema ?? path.join(template, 'schema.json'),
        width: routine.report?.width ?? DEFAULT_PANEL.width,
        height: routine.report?.height ?? DEFAULT_PANEL.height
      }
    : { template: '', schema: '', width: DEFAULT_PANEL.width, height: DEFAULT_PANEL.height }
  if (!template) reasons.push('no report template is declared (report.template)')
  else {
    const checked = context.template(template, rootDir)
    if (!checked.ok) reasons.push(checked.reason)
    // The schema is read by the server: it stays inside the file's folder too.
    const rel = path.relative(path.resolve(rootDir), path.resolve(report.schema))
    if (rel.startsWith('..') || path.isAbsolute(rel))
      reasons.push(`the report schema ${report.schema} is outside the .clave file's folder`)
  }
  const launch = {
    ...(routine.agent !== undefined ? { agent: routine.agent as 'claude' } : {}),
    ...(routine.form !== undefined ? { form: routine.form as 'chat' } : {}),
    ...(routine.model !== undefined ? { model: routine.model } : {}),
    ...(routine.effort !== undefined ? { effort: routine.effort } : {}),
    ...(routine.thinking !== undefined ? { thinking: routine.thinking } : {}),
    ...(routine.provider !== undefined ? { provider: routine.provider } : {}),
    ...(routine.profile !== undefined ? { profile: routine.profile } : {}),
    ...(routine.account !== undefined ? { account: routine.account } : {}),
    ...(routine.dangerousMode !== undefined ? { dangerousMode: routine.dangerousMode } : {}),
    ...(routine.permissionMode !== undefined
      ? { permissionMode: routine.permissionMode as 'default' }
      : {})
  }
  return {
    key: routineKey(file, routine.name),
    name: routine.name,
    file,
    rootDir,
    group: group.name,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    schedule: routine.schedule,
    prompt,
    skill: routine.skill ?? null,
    cwd,
    launch,
    icon: routine.icon ?? null,
    color: routine.color ?? null,
    catchUp: routine.catchUp ?? true,
    timeoutMinutes: Math.min(
      routine.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
      MAX_TIMEOUT_MINUTES
    ),
    scope: scope === 'team' ? 'team' : 'machine',
    report,
    invalid: reasons.length ? reasons.join('; ') : null
  }
}

/** The files a workspace resolves to: the profile file with its root, and
 *  the auto-discovered project files. The renderer's rule, read-only. */
export async function workspaceFilesOf(
  files: WorkspaceFiles,
  workspace: RegistryWorkspace
): Promise<Array<{ path: string; rootDir: string }>> {
  let profile = workspace.profileFile
  if (!profile) {
    const discovered = files.discover(workspace.rootDir)
    profile =
      discovered.find((f) => f.name === 'default')?.path ??
      (discovered.length === 1 ? discovered[0].path : null)
  }
  if (!profile || !files.exists(profile)) return []
  const out = [{ path: profile, rootDir: workspace.rootDir }]
  const auto = files.readAutoDiscover(profile)
  if (auto?.enabled) {
    const profileName = path.basename(profile, '.clave')
    const found = await files.discoverRecursive(workspace.rootDir, {
      ...(auto.patterns !== undefined && { patterns: auto.patterns }),
      ...(auto.exclude !== undefined && { exclude: auto.exclude }),
      ...(auto.maxDepth !== undefined && { maxDepth: auto.maxDepth }),
      ...(profileName !== 'default' ? { workspaceId: profileName } : {})
    })
    for (const f of found) if (f.path !== profile) out.push({ path: f.path, rootDir: f.rootDir })
  }
  return out
}

/** Every routine of every workspace, trusted-or-nothing. */
export async function resolveRoutines(
  files: WorkspaceFiles,
  workspaces: ReadonlyArray<RegistryWorkspace>,
  template: (template: string, root: string) => { ok: true } | { ok: false; reason: string } = (
    t,
    r
  ) => checkTemplate(t, r)
): Promise<ResolvedRoutines> {
  const declarations: RoutineDeclaration[] = []
  const read = new Set<string>()
  for (const workspace of workspaces) {
    let entries: Array<{ path: string; rootDir: string }>
    try {
      entries = await workspaceFilesOf(files, workspace)
    } catch (error) {
      console.error('[routines] could not list the workspace files of', workspace.rootDir, error)
      continue
    }
    for (const entry of entries) {
      read.add(entry.path)
      // No reviewer: an elevated file nobody trusted answers null.
      const result = await files.read(entry.path, { rootDir: entry.rootDir })
      if (!result) continue
      const groups = result.type === 'multi' ? result.groups : [result]
      const seen = new Map<string, number>()
      for (const group of groups) {
        for (const routine of group.routines ?? []) {
          const declaration = declare(routine, {
            file: entry.path,
            rootDir: entry.rootDir,
            group,
            workspace,
            template
          })
          // Two routines of one file with one name are one identity: the
          // second is recorded as invalid rather than overwriting the first.
          const times = seen.get(declaration.key) ?? 0
          seen.set(declaration.key, times + 1)
          if (times > 0) {
            declarations.push({
              ...declaration,
              key: `${declaration.key}#${times + 1}`,
              invalid: `another routine of this file is also named "${routine.name}"`
            })
            continue
          }
          declarations.push(declaration)
        }
      }
    }
  }
  return { declarations, files: [...read] }
}
