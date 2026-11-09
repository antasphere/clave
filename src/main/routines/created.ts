/**
 * The routines a server keeps in its own store (PRDCT-4242): created over
 * the API or by an agent tool, beside the ones its `.clave` files declare.
 * A created routine lives in one workspace of this server and runs on this
 * server alone, so it carries no `runsOn`; its declaration says the server's
 * own name there. The store is `routines-created.json` under the server's
 * data directory, written whole and atomically through the storage port,
 * the same way the runs store is. Nothing here schedules: the service reads
 * the declarations off this store at every refresh and treats them as it
 * treats a file's.
 */
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type {
  RoutineCreateInput,
  RoutineDeclaration,
  RoutineLaunch,
  RoutinePatch
} from '@clave/contract/routines'
import type { StoragePort } from '../ports/storage'
import { substituteTokens } from '../../shared/prompt-tokens'
import { parseCron } from './cron'
import { checkTemplate } from './deck'
import {
  DEFAULT_PANEL,
  DEFAULT_TIMEOUT_MINUTES,
  MAX_TIMEOUT_MINUTES,
  type RegistryWorkspace,
  type ServerIdentity
} from './resolve'

export const CREATED_FILE = 'routines-created.json'
/** The key a created routine's history is kept under: never a file's shape. */
export const CREATED_KEY_PREFIX = 'created::'
/** The toolbar group every created routine of a server sits in. */
export const CREATED_GROUP = 'Created routines'

export interface CreatedRoutine {
  readonly id: string
  readonly workspaceId: string
  readonly name: string
  readonly schedule: string
  readonly prompt: string
  readonly skill?: string
  /** Absolute; the workspace root when the input named none. */
  readonly cwd?: string
  readonly launch: RoutineLaunch
  readonly icon?: string
  readonly color?: string
  readonly catchUp?: boolean
  readonly timeoutMinutes?: number
  readonly report?: RoutineCreateInput['report']
  readonly paused: boolean
  readonly createdAt: number
  readonly updatedAt: number
}

interface CreatedDocument {
  version: 1
  routines: CreatedRoutine[]
}

export const createdKey = (id: string): string => `${CREATED_KEY_PREFIX}${id}`
export const isCreatedKey = (key: string): boolean => key.startsWith(CREATED_KEY_PREFIX)

export class CreatedRoutinesStore {
  private cache: CreatedDocument | null = null
  constructor(
    private readonly storage: Pick<StoragePort, 'read' | 'write'>,
    private readonly now: () => number = () => Date.now()
  ) {}

  private load(): CreatedDocument {
    if (this.cache) return this.cache
    let parsed: unknown = null
    try {
      const raw = this.storage.read(CREATED_FILE)
      parsed = raw ? JSON.parse(raw) : null
    } catch {
      parsed = null
    }
    const doc = parsed as Partial<CreatedDocument> | null
    this.cache = {
      version: 1,
      routines:
        doc && doc.version === 1 && Array.isArray(doc.routines)
          ? doc.routines.filter((r): r is CreatedRoutine => !!r && typeof r.id === 'string')
          : []
    }
    return this.cache
  }

  private save(): void {
    this.storage.write(CREATED_FILE, JSON.stringify(this.load(), null, 2))
  }

  all(): ReadonlyArray<CreatedRoutine> {
    return this.load().routines
  }

  get(id: string): CreatedRoutine | undefined {
    return this.load().routines.find((r) => r.id === id)
  }

  byKey(key: string): CreatedRoutine | undefined {
    return isCreatedKey(key) ? this.get(key.slice(CREATED_KEY_PREFIX.length)) : undefined
  }

  add(input: Omit<CreatedRoutine, 'id' | 'paused' | 'createdAt' | 'updatedAt'>): CreatedRoutine {
    const at = this.now()
    const routine: CreatedRoutine = {
      ...input,
      id: randomUUID(),
      paused: false,
      createdAt: at,
      updatedAt: at
    }
    this.load().routines.push(routine)
    this.save()
    return routine
  }

  replace(next: CreatedRoutine): CreatedRoutine {
    const doc = this.load()
    const at = doc.routines.findIndex((r) => r.id === next.id)
    if (at < 0) throw new Error(`No created routine "${next.id}"`)
    const updated = { ...next, updatedAt: this.now() }
    doc.routines[at] = updated
    this.save()
    return updated
  }

  remove(id: string): boolean {
    const doc = this.load()
    const before = doc.routines.length
    doc.routines = doc.routines.filter((r) => r.id !== id)
    if (doc.routines.length === before) return false
    this.save()
    return true
  }
}

/** The fields a patch may change, applied to a stored routine; the paths
 *  resolved against the workspace root the way a create resolves them. */
export function applyPatch(
  current: CreatedRoutine,
  patch: RoutinePatch,
  rootDir: string
): CreatedRoutine {
  const next: CreatedRoutine = { ...current }
  const out = next as { -readonly [K in keyof CreatedRoutine]: CreatedRoutine[K] }
  if (patch.name !== undefined) out.name = patch.name.trim()
  if (patch.schedule !== undefined) out.schedule = patch.schedule.trim()
  if (patch.prompt !== undefined) out.prompt = patch.prompt
  if (patch.skill !== undefined) out.skill = patch.skill.trim() || undefined
  if (patch.cwd !== undefined) out.cwd = path.resolve(rootDir, patch.cwd)
  if (patch.launch !== undefined) out.launch = patch.launch
  if (patch.icon !== undefined) out.icon = patch.icon || undefined
  if (patch.color !== undefined) out.color = patch.color || undefined
  if (patch.catchUp !== undefined) out.catchUp = patch.catchUp
  if (patch.timeoutMinutes !== undefined) out.timeoutMinutes = patch.timeoutMinutes
  if (patch.report !== undefined) out.report = patch.report
  return next
}

/** Why a created routine's folder, schedule or template can never run, in
 *  the words the refusal and the badge show; null when every one holds. */
export function createdProblem(
  routine: Pick<CreatedRoutine, 'name' | 'schedule' | 'cwd' | 'report' | 'timeoutMinutes'>,
  rootDir: string,
  defaultTemplate: string,
  exists: (dir: string) => boolean = isDirectory
): string | null {
  if (!routine.name.trim()) return 'a routine needs a name'
  try {
    parseCron(routine.schedule)
  } catch (error) {
    return `the schedule does not parse: ${(error as Error).message}`
  }
  const cwd = routine.cwd ?? rootDir
  if (!exists(cwd)) return `the folder ${cwd} is not on this machine`
  if (routine.timeoutMinutes !== undefined && !(routine.timeoutMinutes > 0))
    return 'timeoutMinutes must be above zero'
  const template = routine.report?.template
  if (template) {
    const resolved = path.resolve(rootDir, template)
    const checked = checkTemplate(resolved, rootDir)
    if (!checked.ok) return checked.reason
  } else {
    const checked = checkTemplate(defaultTemplate, defaultTemplate)
    if (!checked.ok) return `the built-in report page is missing: ${checked.reason}`
  }
  return null
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/** A created routine as the scheduler sees it: the same shape as a file's,
 *  its key never a file's, its placement this server's own name. */
export function declareCreated(
  routine: CreatedRoutine,
  context: {
    /** The file the key is attributed to in listings: the store's own path. */
    file: string
    workspace: RegistryWorkspace | undefined
    identity: ServerIdentity
    defaultTemplate: string
  }
): RoutineDeclaration {
  const { workspace, identity } = context
  const rootDir = workspace?.rootDir ?? ''
  const cwd = routine.cwd ?? rootDir
  const reasons: string[] = []
  if (!workspace)
    reasons.push(`its workspace ${routine.workspaceId} is no longer registered on this server`)
  else {
    const problem = createdProblem(routine, rootDir, context.defaultTemplate)
    if (problem) reasons.push(problem)
  }
  const template = routine.report?.template
    ? path.resolve(rootDir, routine.report.template)
    : context.defaultTemplate
  const schema = routine.report?.schema
    ? path.resolve(rootDir, routine.report.schema)
    : path.join(template, 'schema.json')
  return {
    key: createdKey(routine.id),
    name: routine.name,
    file: context.file,
    rootDir,
    group: CREATED_GROUP,
    workspaceId: routine.workspaceId,
    workspaceName: workspace?.name ?? routine.workspaceId,
    schedule: routine.schedule,
    prompt: workspace ? substituteTokens(routine.prompt, workspace.rootDir, cwd) : routine.prompt,
    skill: routine.skill ?? null,
    cwd,
    launch: routine.launch,
    icon: routine.icon ?? null,
    color: routine.color ?? null,
    catchUp: routine.catchUp ?? true,
    timeoutMinutes: Math.min(
      routine.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES,
      MAX_TIMEOUT_MINUTES
    ),
    scope: 'machine',
    runsOn: identity.name,
    runsHere: !!workspace,
    origin: 'created',
    paused: routine.paused,
    report: {
      template,
      schema,
      width: routine.report?.width ?? DEFAULT_PANEL.width,
      height: routine.report?.height ?? DEFAULT_PANEL.height,
      publish: routine.report?.publish ?? false
    },
    invalid: reasons.length ? reasons.join('; ') : null
  }
}
