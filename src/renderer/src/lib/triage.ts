import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { LaunchProfile } from '../../../shared/agent-launch'
import type { TriagePrepareResult, TriageSnapshot } from '../../../shared/triage'
import type { LaunchRequest } from './launch-session'

export type TriageProvider = 'claude' | 'codex'
export interface TriageSelection {
  provider: TriageProvider
  profileId: string
  accountId: string
  dangerousMode: boolean
}
export interface TriageChoices {
  profiles: LaunchProfile[]
  accounts: Record<TriageProvider, { id: string; label: string; usable: boolean }[]>
}
export interface TriageDependencies {
  prepare: () => Promise<TriagePrepareResult>
  snapshot: () => Promise<TriageSnapshot>
  choices: () => Promise<TriageChoices>
  selection: (provider?: TriageProvider) => TriageSelection
  workspace: () => string | null
  launch: (request: LaunchRequest) => Promise<string | null>
  writeText: (text: string) => Promise<void>
}

type CopyKind = 'context' | 'prompt' | 'external'
interface TriageState {
  open: boolean
  preparing: boolean
  prepared: TriagePrepareResult | null
  choices: TriageChoices | null
  selection: TriageSelection
  problem: string
  error: string | null
  choicesError: string | null
  copyStatus: string | null
  launchState: 'ready' | 'launching' | 'started' | 'uncertain'
  supportSessionId: string | null
  openDialog: () => Promise<void>
  closeDialog: () => void
  refresh: () => Promise<void>
  select: (patch: Partial<TriageSelection>) => void
  setProblem: (problem: string) => void
  start: () => Promise<void>
  copy: (kind: CopyKind) => Promise<void>
}

function deadline<T>(promise: Promise<T>, milliseconds = 15_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), milliseconds)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

export function triagePrompt(prepared: TriagePrepareResult, problem: string): string {
  const prompt = prepared.launchPrompt ?? prepared.contextMarkdown
  return problem.trim() ? `${prompt}\n\nUser's problem:\n${problem.trim()}` : prompt
}

/** Per-window state, retained across closing the dialog. A lost spawn reply is
 * not permission to repeat a non-idempotent launch. Only a fresh app window
 * resets that uncertainty; inspect the tabs or use the copy fallback first. */
export function createTriageStore(deps: TriageDependencies): UseBoundStore<StoreApi<TriageState>> {
  let captureWorkspace: string | null = null
  return create<TriageState>((set, get) => ({
    open: false,
    preparing: false,
    prepared: null,
    choices: null,
    selection: deps.selection(),
    problem: '',
    error: null,
    choicesError: null,
    copyStatus: null,
    launchState: 'ready',
    supportSessionId: null,
    openDialog: async () => {
      set({ open: true })
      if (!get().prepared && !get().preparing) await get().refresh()
    },
    closeDialog: () => set({ open: false }),
    refresh: async () => {
      if (get().preparing || get().launchState !== 'ready') return
      captureWorkspace = deps.workspace()
      set({ preparing: true, prepared: null, error: null, copyStatus: null })
      // A failed profile read must not discard an otherwise useful capture.
      await Promise.all([
        deadline(deps.prepare()).then(
          (prepared) => set({ prepared }),
          () => set({ error: 'Context could not be prepared. Try capturing again.' })
        ),
        deadline(deps.choices()).then(
          (choices) => set({ choices, choicesError: null, selection: deps.selection() }),
          () =>
            set({
              choices: null,
              choicesError: 'Launch choices could not be read. Copy the context instead.'
            })
        )
      ])
      set({ preparing: false })
    },
    select: (patch) => {
      if (get().launchState !== 'ready') return
      const selection =
        patch.provider && patch.provider !== get().selection.provider
          ? deps.selection(patch.provider)
          : get().selection
      set({ selection: { ...selection, ...patch }, error: null, copyStatus: null })
    },
    setProblem: (problem) => set({ problem: problem.slice(0, 2_000), copyStatus: null }),
    start: async () => {
      const { prepared, selection, problem, preparing, launchState } = get()
      if (preparing || launchState !== 'ready' || !prepared) return
      if (prepared.agentLaunch !== 'in-app' || !prepared.bundle || !prepared.launchPrompt) {
        set({
          error: 'Use the copied context or a same-machine external command for this capture.'
        })
        return
      }
      // Set the guard before any asynchronous preflight, including a second click.
      set({ launchState: 'launching', error: null })
      try {
        const [choices, snapshot] = await Promise.all([
          deadline(deps.choices()),
          deadline(deps.snapshot())
        ])
        set({ choices })
        if (
          !choices.profiles.some(
            (p) => p.id === selection.profileId && p.family === selection.provider
          )
        )
          throw new Error(
            'The selected launch profile is no longer available. Choose another profile.'
          )
        const account = choices.accounts[selection.provider].find(
          (a) => a.id === selection.accountId
        )
        if (!account?.usable)
          throw new Error(
            'The selected account is missing or needs a login. Choose an available account.'
          )
        if (
          deps.workspace() !== captureWorkspace ||
          snapshot.origin.instanceId !== prepared.origin.instanceId ||
          snapshot.origin.windowId !== prepared.origin.windowId ||
          snapshot.origin.windowKey !== prepared.origin.windowKey
        )
          throw new Error('The window, workspace or app instance changed. Capture context again.')
      } catch (error) {
        // Only our own validation messages reach the dialog, never provider output.
        const message =
          error instanceof Error && error.message.startsWith('The ')
            ? error.message
            : 'Launch choices or app identity could not be checked. Copy the context instead.'
        set({ launchState: 'ready', error: message })
        return
      }
      try {
        const id = await deadline(
          deps.launch({
            setup: {
              kind: selection.provider,
              dangerousMode: selection.dangerousMode,
              launchProfileId: selection.profileId,
              ...(selection.provider === 'claude'
                ? { claudeProfileId: selection.accountId }
                : { codexAccountId: selection.accountId })
            },
            cwd: { kind: 'path', path: prepared.bundle.dir },
            initialPrompt: triagePrompt(prepared, problem),
            remember: false,
            throwOnError: true,
            onCreated: (id) =>
              set({
                supportSessionId: id,
                ...(get().launchState === 'uncertain' ? { launchState: 'started' as const } : {})
              })
          })
        )
        if (!id) throw new Error('No session acknowledgement')
        set({ supportSessionId: id, launchState: 'started' })
      } catch {
        set({
          launchState: get().supportSessionId ? 'started' : 'uncertain',
          error: get().supportSessionId
            ? 'A support tab was created, but startup could not be confirmed. Check that tab or copy the context.'
            : 'Startup could not be confirmed. Check the tabs before starting another agent. Copy and external commands remain available.'
        })
      }
    },
    copy: async (kind) => {
      const { prepared, problem, selection } = get()
      if (!prepared) return
      const text =
        kind === 'context'
          ? prepared.contextMarkdown
          : kind === 'prompt'
            ? triagePrompt(prepared, problem)
            : prepared.externalCommands?.[selection.provider]
      if (!text) return
      set({ copyStatus: null })
      try {
        await deps.writeText(text)
        set({ copyStatus: 'Copied' })
      } catch {
        set({ copyStatus: 'Copy failed. Select and copy the preview text.' })
      }
    }
  }))
}
