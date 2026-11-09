/**
 * The routine tools an agent calls (PRDCT-4243): create a routine on a
 * machine in one call, list what runs where, change, pause, delete or run a
 * created routine, and move a created routine into a `.clave` file once it
 * should be shared. The same tools are registered by the desktop's MCP
 * server (this Mac and every connected server as machines) and by the
 * standalone server's (its own machine alone); the work is done here over
 * `RoutineMachine`, one object per machine, so the rules have tests on
 * fakes and the two registrars only build the machines.
 *
 * A machine is named the way the Mac names it: `local` (or `mine`, `this`)
 * for the machine the caller runs on, else a saved connection's id, its
 * label, or the server's own name as its listing reports it. A routine is
 * named by its key; the machine is asked for only when the same key exists
 * on two machines (a file both read).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type {
  RoutineCreateInput,
  RoutineDeclaration,
  RoutineMoveInput,
  RoutineMoved,
  RoutinePatch,
  RoutineRun,
  RoutineView,
  RoutinesListing
} from '@clave/contract/routines'
import { RUNS_EVERYWHERE } from '@clave/contract/server-name'

export interface RoutineMachineWorkspace {
  readonly id: string
  readonly name: string
  readonly rootDir: string
  readonly profileFile?: string | null
}

/** What the tools need of one machine's server. */
export interface RoutineMachine {
  /** `local` for the machine the caller runs on, else the saved connection's id. */
  readonly id: string
  /** The Mac's label for it: `This Mac`, or the connection's name. */
  readonly label: string
  readonly routines: {
    list(): Promise<RoutinesListing>
    create(input: RoutineCreateInput): Promise<RoutineView>
    update(key: string, patch: RoutinePatch): Promise<RoutineView>
    delete(key: string): Promise<void>
    pause(key: string, paused: boolean): Promise<RoutineView>
    runNow(key: string): Promise<RoutineRun>
    moveToFile(key: string, input: RoutineMoveInput): Promise<RoutineMoved>
  }
  readonly workspaces: () => Promise<ReadonlyArray<RoutineMachineWorkspace>>
}

export interface RoutineToolDeps {
  /** Every machine reachable from here, the caller's own first. */
  machines(): Promise<ReadonlyArray<RoutineMachine>>
  /** The workspace the caller's tab belongs to, the default for a create. */
  callerWorkspaceId?: () => string | undefined
  /** Disposes what `machines()` opened, once a tool is done. */
  release?(machines: ReadonlyArray<RoutineMachine>): Promise<void>
}

const LOCAL_REFS = new Set(['local', 'mine', 'this', 'here'])
const lower = (s: string): string => s.trim().toLowerCase()

type Listed = { machine: RoutineMachine; listing: RoutinesListing | null; error: string | null }

async function listAll(machines: ReadonlyArray<RoutineMachine>): Promise<Listed[]> {
  return Promise.all(
    machines.map(async (machine) => {
      try {
        return { machine, listing: await machine.routines.list(), error: null }
      } catch (error) {
        return {
          machine,
          listing: null,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    })
  )
}

/** The machine a reference names; the listings tell the servers' own names. */
export function machineOf(ref: string | undefined, listed: ReadonlyArray<Listed>): Listed {
  if (!ref || LOCAL_REFS.has(lower(ref))) {
    const local = listed.find((l) => l.machine.id === 'local') ?? listed[0]
    if (!local) throw new Error('No machine is reachable from here.')
    return local
  }
  const wanted = lower(ref)
  const found = listed.find(
    (l) =>
      l.machine.id === ref.trim() ||
      lower(l.machine.label) === wanted ||
      (l.listing?.server &&
        (l.listing.server.id === ref.trim() || lower(l.listing.server.name) === wanted))
  )
  if (!found) {
    const names = listed.map((l) => machineWords(l)).join(', ')
    throw new Error(`No machine "${ref}". Reachable: ${names || 'none'}.`)
  }
  if (!found.listing)
    throw new Error(
      `${found.machine.label} is not reachable right now: ${found.error ?? 'no answer'}`
    )
  return found
}

const machineWords = (l: Listed): string =>
  l.listing?.server?.name && lower(l.listing.server.name) !== lower(l.machine.label)
    ? `${l.machine.label} (own name ${l.listing.server.name})`
    : l.machine.label

async function workspaceOf(
  machine: RoutineMachine,
  ref: string | undefined,
  fallback: string | undefined
): Promise<RoutineMachineWorkspace> {
  const workspaces = await machine.workspaces()
  const wanted = ref?.trim() || fallback
  if (!wanted)
    throw new Error(
      `Say which workspace, on ${machine.label}: ${workspaces.map((w) => `"${w.name}"`).join(', ') || 'none is registered there'}`
    )
  const found =
    workspaces.find((w) => w.id === wanted) ??
    workspaces.find((w) => lower(w.name) === lower(wanted)) ??
    workspaces.find((w) => w.rootDir === wanted)
  if (!found)
    throw new Error(
      `No workspace "${wanted}" on ${machine.label}. There: ${workspaces.map((w) => `"${w.name}"`).join(', ') || 'none'}`
    )
  return found
}

/** One routine as an agent reads it: where it lives, where it runs, what is wrong. */
export interface RoutineRow {
  key: string
  name: string
  workspace: { id: string; name: string }
  machine: { id: string; label: string; ownName: string | null }
  origin: 'file' | 'created'
  file: string | null
  paused: boolean
  schedule: string
  runsOn: string | null
  nextRunAt: number | null
  lastRun: { state: RoutineRun['state']; headline: string | null; at: number } | null
  problems: string[]
}

const rowOf = (view: RoutineView, l: Listed, problems: string[]): RoutineRow => {
  const d = view.routine
  const last = view.runs[0]
  return {
    key: d.key,
    name: d.name,
    workspace: { id: d.workspaceId, name: d.workspaceName },
    machine: { id: l.machine.id, label: l.machine.label, ownName: l.listing?.server?.name ?? null },
    origin: d.origin ?? 'file',
    file: (d.origin ?? 'file') === 'file' ? d.file : null,
    paused: d.paused === true,
    schedule: d.schedule,
    runsOn: d.runsOn ?? null,
    nextRunAt: view.nextRunAt,
    lastRun: last ? { state: last.state, headline: last.headline, at: last.startedAt } : null,
    problems
  }
}

/** Whether some reached machine answers to a placement's name or id. */
const knownMachine = (runsOn: string, listed: ReadonlyArray<Listed>): boolean =>
  listed.some(
    (l) =>
      l.listing?.server &&
      (l.listing.server.id === runsOn.trim() || lower(l.listing.server.name) === lower(runsOn))
  )

/** Whether the machine a routine is placed on lists that routine itself
 *  (the same name in the same workspace, run there): then the owner's row
 *  stands and this machine's twin is dropped. */
/** A routine's identity across machines, as the toolbar's merge reads it:
 *  its file under its root, and its name (verifier round 1, F4). */
const relId = (d: Pick<RoutineDeclaration, 'file' | 'rootDir' | 'name'>): string => {
  const root = d.rootDir.replace(/\/+$/, '')
  const file = root && d.file.startsWith(`${root}/`) ? d.file.slice(root.length + 1) : d.file
  return `${file}::${d.name}`
}

const ownerLists = (d: RoutineDeclaration, listed: ReadonlyArray<Listed>): boolean =>
  listed.some(
    (l) =>
      l.listing?.server &&
      d.runsOn &&
      (l.listing.server.id === d.runsOn.trim() ||
        lower(l.listing.server.name) === lower(d.runsOn)) &&
      l.listing.routines.some((v) => v.routine.runsHere !== false && relId(v.routine) === relId(d))
  )

export interface RoutineListAnswer {
  routines: RoutineRow[]
  machines: Array<{
    id: string
    label: string
    ownName: string | null
    reachable: boolean
    error?: string
  }>
}

/** Every routine every reached machine runs, once each: a file routine
 *  placed on a machine that lists it is that machine's row; its twin on
 *  another machine (listed there, never run) is dropped when the owner
 *  answered, kept with the problem when it did not. */
export function rowsOf(
  listed: ReadonlyArray<Listed>,
  filter: { workspace?: string; machine?: string } = {}
): RoutineListAnswer {
  const rows: RoutineRow[] = []
  for (const l of listed) {
    if (!l.listing) continue
    if (filter.machine && machineOf(filter.machine, listed).machine.id !== l.machine.id) continue
    for (const view of l.listing.routines) {
      const d = view.routine
      if (
        filter.workspace &&
        d.workspaceId !== filter.workspace &&
        lower(d.workspaceName) !== lower(filter.workspace)
      )
        continue
      const problems: string[] = []
      if (d.invalid) problems.push(d.invalid)
      if (d.runsHere === false && d.runsOn && lower(d.runsOn) !== RUNS_EVERYWHERE) {
        if (ownerLists(d, listed)) continue
        problems.push(
          knownMachine(d.runsOn, listed)
            ? `runs on "${d.runsOn}", which does not list it: that machine does not read this file`
            : `runs on "${d.runsOn}", a machine none of the reachable servers answers to`
        )
      }
      rows.push(rowOf(view, l, problems))
    }
  }
  return {
    routines: rows,
    machines: listed.map((l) => ({
      id: l.machine.id,
      label: l.machine.label,
      ownName: l.listing?.server?.name ?? null,
      reachable: !!l.listing,
      ...(l.error ? { error: l.error } : {})
    }))
  }
}

/** The one machine that lists a key; the machine is asked for when two do. */
function whereIs(
  key: string,
  machineRef: string | undefined,
  listed: ReadonlyArray<Listed>
): { listed: Listed; view: RoutineView } {
  if (machineRef) {
    const l = machineOf(machineRef, listed)
    const view = l.listing!.routines.find((v) => v.routine.key === key)
    if (!view) throw new Error(`No routine "${key}" on ${l.machine.label}.`)
    return { listed: l, view }
  }
  const hits = listed
    .filter((l): l is Listed & { listing: RoutinesListing } => !!l.listing)
    .flatMap((l) =>
      l.listing.routines.filter((v) => v.routine.key === key).map((view) => ({ listed: l, view }))
    )
    // A file both machines read: the one that runs it is the one meant.
    .sort(
      (a, b) =>
        Number(b.view.routine.runsHere !== false) - Number(a.view.routine.runsHere !== false)
    )
  if (hits.length === 0) throw new Error(`No routine "${key}" on any reachable machine.`)
  const runners = hits.filter((h) => h.view.routine.runsHere !== false)
  if (runners.length > 1)
    throw new Error(
      `"${hits[0].view.routine.name}" exists on ${runners.map((h) => h.listed.machine.label).join(' and ')}: say which machine.`
    )
  return hits[0]
}

const machineAnswer = (l: Listed): { id: string; label: string; ownName: string | null } => ({
  id: l.machine.id,
  label: l.machine.label,
  ownName: l.listing?.server?.name ?? null
})

const createdAnswer = (view: RoutineView, l: Listed): Record<string, unknown> => ({
  ok: true,
  key: view.routine.key,
  name: view.routine.name,
  machine: machineAnswer(l),
  workspace: { id: view.routine.workspaceId, name: view.routine.workspaceName },
  schedule: view.routine.schedule,
  runsOn: view.routine.runsOn ?? null,
  paused: view.routine.paused === true,
  nextRunAt: view.nextRunAt,
  ...(view.routine.invalid ? { problem: view.routine.invalid } : {})
})

export interface CreateArgs {
  machine?: string
  workspace?: string
  name: string
  schedule: string
  prompt: string
  cwd?: string
  skill?: string
  model?: string
  account?: string
  agent?: 'claude' | 'codex'
  effort?: string
  dangerous?: boolean
  icon?: string
  color?: string
  catchUp?: boolean
  timeoutMinutes?: number
  template?: string
  publish?: boolean
}

export async function createRoutineTool(deps: RoutineToolDeps, args: CreateArgs): Promise<unknown> {
  const machines = await deps.machines()
  try {
    const listed = await listAll(machines)
    const l = machineOf(args.machine, listed)
    const workspace = await workspaceOf(
      l.machine,
      args.workspace,
      l.machine.id === 'local' ? deps.callerWorkspaceId?.() : undefined
    )
    const launch = {
      ...(args.agent ? { agent: args.agent } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.account ? { account: args.account } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(args.dangerous !== undefined ? { dangerousMode: args.dangerous } : {})
    }
    const view = await l.machine.routines.create({
      workspaceId: workspace.id,
      name: args.name,
      schedule: args.schedule,
      prompt: args.prompt,
      ...(args.cwd ? { cwd: args.cwd } : {}),
      ...(args.skill ? { skill: args.skill } : {}),
      ...(Object.keys(launch).length ? { launch } : {}),
      ...(args.icon ? { icon: args.icon } : {}),
      ...(args.color ? { color: args.color } : {}),
      ...(args.catchUp !== undefined ? { catchUp: args.catchUp } : {}),
      ...(args.timeoutMinutes !== undefined ? { timeoutMinutes: args.timeoutMinutes } : {}),
      ...(args.template !== undefined || args.publish !== undefined
        ? {
            report: {
              ...(args.template ? { template: args.template } : {}),
              ...(args.publish !== undefined ? { publish: args.publish } : {})
            }
          }
        : {})
    })
    return createdAnswer(view, l)
  } finally {
    await deps.release?.(machines)
  }
}

export async function listRoutinesTool(
  deps: RoutineToolDeps,
  args: { workspace?: string; machine?: string }
): Promise<RoutineListAnswer> {
  const machines = await deps.machines()
  try {
    return rowsOf(await listAll(machines), args)
  } finally {
    await deps.release?.(machines)
  }
}

export interface UpdateArgs extends Partial<Omit<CreateArgs, 'machine' | 'workspace'>> {
  key: string
  machine?: string
}

export async function updateRoutineTool(deps: RoutineToolDeps, args: UpdateArgs): Promise<unknown> {
  const machines = await deps.machines()
  try {
    const listed = await listAll(machines)
    const { listed: l } = whereIs(args.key, args.machine, listed)
    const launch = {
      ...(args.agent ? { agent: args.agent } : {}),
      ...(args.model ? { model: args.model } : {}),
      ...(args.account ? { account: args.account } : {}),
      ...(args.effort ? { effort: args.effort } : {}),
      ...(args.dangerous !== undefined ? { dangerousMode: args.dangerous } : {})
    }
    const patch: RoutinePatch = {
      ...(args.name !== undefined ? { name: args.name } : {}),
      ...(args.schedule !== undefined ? { schedule: args.schedule } : {}),
      ...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
      ...(args.cwd !== undefined ? { cwd: args.cwd } : {}),
      ...(args.skill !== undefined ? { skill: args.skill } : {}),
      ...(Object.keys(launch).length ? { launch } : {}),
      ...(args.icon !== undefined ? { icon: args.icon } : {}),
      ...(args.color !== undefined ? { color: args.color } : {}),
      ...(args.catchUp !== undefined ? { catchUp: args.catchUp } : {}),
      ...(args.timeoutMinutes !== undefined ? { timeoutMinutes: args.timeoutMinutes } : {}),
      ...(args.template !== undefined || args.publish !== undefined
        ? {
            report: {
              ...(args.template ? { template: args.template } : {}),
              ...(args.publish !== undefined ? { publish: args.publish } : {})
            }
          }
        : {})
    }
    const view = await l.machine.routines.update(args.key, patch)
    return createdAnswer(view, l)
  } finally {
    await deps.release?.(machines)
  }
}

export async function deleteRoutineTool(
  deps: RoutineToolDeps,
  args: { key: string; machine?: string }
): Promise<unknown> {
  const machines = await deps.machines()
  try {
    const listed = await listAll(machines)
    const { listed: l, view } = whereIs(args.key, args.machine, listed)
    await l.machine.routines.delete(args.key)
    return { ok: true, deleted: view.routine.name, machine: machineAnswer(l) }
  } finally {
    await deps.release?.(machines)
  }
}

export async function pauseRoutineTool(
  deps: RoutineToolDeps,
  args: { key: string; paused: boolean; machine?: string }
): Promise<unknown> {
  const machines = await deps.machines()
  try {
    const listed = await listAll(machines)
    const { listed: l } = whereIs(args.key, args.machine, listed)
    const view = await l.machine.routines.pause(args.key, args.paused)
    return createdAnswer(view, l)
  } finally {
    await deps.release?.(machines)
  }
}

export async function runRoutineTool(
  deps: RoutineToolDeps,
  args: { key: string; machine?: string }
): Promise<unknown> {
  const machines = await deps.machines()
  try {
    const listed = await listAll(machines)
    const { listed: l, view } = whereIs(args.key, args.machine, listed)
    const run = await l.machine.routines.runNow(args.key)
    return {
      ok: true,
      name: view.routine.name,
      machine: machineAnswer(l),
      run: { id: run.id, state: run.state, startedAt: run.startedAt }
    }
  } finally {
    await deps.release?.(machines)
  }
}

export interface MoveArgs {
  key: string
  machine?: string
  /** The `.clave` file, absolute or relative to the workspace root; the workspace's profile file by default. */
  file?: string
  /** The group the routine joins; a group named `Routines` is made when none is named and none exists. */
  group?: string
}

/** A created routine written into a `.clave` file of its workspace with its
 *  machine as `runsOn`, and removed from the store, in one step on that
 *  machine (`MoveRoutineToFile`), so it never exists twice and a refusal
 *  changes nothing. */
export async function moveRoutineToFileTool(
  deps: RoutineToolDeps,
  args: MoveArgs
): Promise<unknown> {
  const machines = await deps.machines()
  try {
    const listed = await listAll(machines)
    const { listed: l, view } = whereIs(args.key, args.machine, listed)
    const d = view.routine
    if ((d.origin ?? 'file') !== 'created')
      throw new Error(`"${d.name}" already comes from ${d.file}: nothing to move.`)
    const moved = await l.machine.routines.moveToFile(d.key, {
      ...(args.file ? { file: args.file } : {}),
      ...(args.group ? { group: args.group } : {})
    })
    return {
      ok: true,
      ...moved,
      machine: machineAnswer(l),
      note: 'The file is the routine’s home now; every machine that reads it lists it, and the one named runs it.'
    }
  } finally {
    await deps.release?.(machines)
  }
}

// ── The registrations, shared by both MCP servers ──

type ToolText = { content: { type: 'text'; text: string }[]; isError?: boolean }
const answer = (value: unknown): ToolText => ({
  content: [{ type: 'text', text: JSON.stringify(value) }]
})
const refused = (error: unknown): ToolText => ({
  content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
  isError: true
})

const machineArg = z
  .string()
  .max(200)
  .optional()
  .describe(
    'The machine: "local" (the default, where your tab runs), or a connected server by its id, its label or its own name (clave_list shows them).'
  )
const launchArgs = {
  agent: z.enum(['claude', 'codex']).optional().describe('The agent; claude by default'),
  model: z.string().max(200).optional().describe('The model, as the agent CLI takes it'),
  account: z
    .string()
    .max(128)
    .optional()
    .describe('An account id or label, or "any" for the pool; the workspace default otherwise'),
  effort: z.string().max(32).optional().describe("Claude's reasoning effort"),
  dangerous: z
    .boolean()
    .optional()
    .describe('Run with permissions off (the usual for an unattended job)'),
  icon: z
    .string()
    .max(40)
    .optional()
    .describe("The toolbar icon, a terminal icon's name; clock by default"),
  color: z.string().max(40).optional().describe("The icon's colour, a terminal colour's name"),
  catchUp: z
    .boolean()
    .optional()
    .describe(
      'Run once at the next start for an occurrence missed while the server was down (default true)'
    ),
  timeoutMinutes: z
    .number()
    .int()
    .min(1)
    .max(10080)
    .optional()
    .describe('A run still going is ended as failed (default 30)'),
  template: z
    .string()
    .max(1000)
    .optional()
    .describe(
      'A report template folder under the workspace root (index.html + schema.json); the built-in report page when absent'
    ),
  publish: z
    .boolean()
    .optional()
    .describe("Push every run's report to the workspace's Slideless (default false)")
}

export function registerRoutineTools(server: McpServer, deps: RoutineToolDeps): void {
  server.registerTool(
    'clave_routine_create',
    {
      description:
        'Create a routine: a prompt a Clave server runs by itself on a cron schedule in a hidden agent session, reported in the toolbar and kept by that server (no file to edit, no cron, no launchd). Say the machine when it is not the one your tab runs on. The routine lives in one workspace of that machine and runs there alone. Refused at once when it could never run: an unknown workspace, a folder that is not there, an account or a profile the machine does not have, a schedule that does not parse. Returns the routine key (what every other clave_routine_* tool takes) and its next run.',
      inputSchema: {
        machine: machineArg,
        workspace: z
          .string()
          .max(500)
          .optional()
          .describe(
            "The workspace, by id, name or root folder; your tab's workspace by default (local only)"
          ),
        name: z.string().min(1).max(120).describe('Unique in its workspace on that machine'),
        schedule: z
          .string()
          .min(9)
          .max(100)
          .describe(
            'Five cron fields in the machine\'s local time, e.g. "30 8 * * 1-5"; no @daily'
          ),
        prompt: z
          .string()
          .min(1)
          .max(20000)
          .describe(
            'The job. The run ends by reporting through clave_routine_report; say what to report.'
          ),
        cwd: z
          .string()
          .max(1000)
          .optional()
          .describe(
            'The folder the agent starts in, absolute or under the workspace root; the root by default'
          ),
        skill: z
          .string()
          .max(200)
          .optional()
          .describe('A skill to load first, e.g. steward:workspace-health'),
        ...launchArgs
      }
    },
    async (args) => {
      try {
        return answer(await createRoutineTool(deps, args))
      } catch (error) {
        return refused(error)
      }
    }
  )
  server.registerTool(
    'clave_routine_list',
    {
      description:
        'List every routine the reachable machines run, once each: its key, name, workspace, the machine that runs it (and its own name, what a .clave runsOn names it by), where it comes from (a .clave file, or created on the machine), its schedule, next run, last run, whether it is paused, and its problems (cannot run, placed on a machine nobody answers to). Check it before creating a duplicate.',
      inputSchema: {
        workspace: z.string().max(500).optional().describe('Only this workspace, by id or name'),
        machine: machineArg
      }
    },
    async (args) => {
      try {
        return answer(await listRoutinesTool(deps, args))
      } catch (error) {
        return refused(error)
      }
    }
  )
  server.registerTool(
    'clave_routine_update',
    {
      description:
        'Change a created routine: any of its fields. A routine a .clave file declares is refused with the file to edit. The machine is needed only when the same key exists on two machines.',
      inputSchema: {
        key: z
          .string()
          .min(1)
          .max(500)
          .describe('The routine key, from clave_routine_create or clave_routine_list'),
        machine: machineArg,
        name: z.string().min(1).max(120).optional(),
        schedule: z.string().min(9).max(100).optional(),
        prompt: z.string().min(1).max(20000).optional(),
        cwd: z.string().max(1000).optional(),
        skill: z.string().max(200).optional(),
        ...launchArgs
      }
    },
    async (args) => {
      try {
        return answer(await updateRoutineTool(deps, args))
      } catch (error) {
        return refused(error)
      }
    }
  )
  server.registerTool(
    'clave_routine_delete',
    {
      description:
        'Remove a created routine with its run history. A routine a .clave file declares is refused with the file to edit.',
      inputSchema: {
        key: z.string().min(1).max(500),
        machine: machineArg
      }
    },
    async (args) => {
      try {
        return answer(await deleteRoutineTool(deps, args))
      } catch (error) {
        return refused(error)
      }
    }
  )
  server.registerTool(
    'clave_routine_pause',
    {
      description:
        'Put a created routine on hold (listed, never run) or take it off hold. A routine a .clave file declares is refused: pause it by editing the file.',
      inputSchema: {
        key: z.string().min(1).max(500),
        paused: z.boolean().describe('true to hold, false to resume'),
        machine: machineArg
      }
    },
    async (args) => {
      try {
        return answer(await pauseRoutineTool(deps, args))
      } catch (error) {
        return refused(error)
      }
    }
  )
  server.registerTool(
    'clave_routine_run',
    {
      description:
        "Run a routine now, on the machine that runs it, outside its schedule (the toolbar's Run now). Refused while a run is in flight, on a paused routine, or on a machine that is not the one the routine names.",
      inputSchema: {
        key: z.string().min(1).max(500),
        machine: machineArg
      }
    },
    async (args) => {
      try {
        return answer(await runRoutineTool(deps, args))
      } catch (error) {
        return refused(error)
      }
    }
  )
  server.registerTool(
    'clave_routine_move_to_file',
    {
      description:
        "Make a created routine a shared one: write it into a .clave file of its workspace with runsOn set to its machine's own name, then remove it from the machine's store, so it exists once. The built-in report page is copied under the workspace first. Use it when a routine you made for yourself should be reviewed and versioned with the team's files.",
      inputSchema: {
        key: z.string().min(1).max(500),
        machine: machineArg,
        file: z
          .string()
          .max(1000)
          .optional()
          .describe(
            "The .clave file, absolute or under the workspace root; the workspace's profile file by default"
          ),
        group: z
          .string()
          .max(120)
          .optional()
          .describe(
            "The group it joins; the file's first group by default, a group named Routines when the file is empty"
          )
      }
    },
    async (args) => {
      try {
        return answer(await moveRoutineToFileTool(deps, args))
      } catch (error) {
        return refused(error)
      }
    }
  )
}

/** The one instructions line the MCP servers add for these tools. */
export const ROUTINE_TOOLS_INSTRUCTION =
  '- a job on a schedule -> clave_routine_create (never cron or launchd); clave_routine_list shows what runs where.'

export type { RoutineDeclaration }
