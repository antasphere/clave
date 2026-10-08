/**
 * The `.clave` TRUST BOUNDARY (place 2 of the six-place mirror rule in the
 * app's CLAUDE.md; it lived in `src/main/ipc-handlers/clave-trust.ts` until
 * the workspace files moved to the server, wave 3).
 *
 * A `.clave` file can act the moment it is opened: run commands without
 * asking, launch agents with permissions disabled, auto-submit a prompt that
 * sets an agent working, and put a page inside Clave. For a file nobody
 * trusted, the client shows a review dialog listing exactly what would run,
 * and "Open safely" strips those powers.
 *
 * `describeElevated` decides what that dialog discloses; `sanitizeElevated`
 * decides what survives "Open safely". Both enumerate fields by hand, so
 * EVERY new `.clave` field that can drive an agent must be added to both or
 * it silently bypasses the gate, a failure with no symptom, which is why this
 * module imports nothing but the contract's types and is covered by
 * `trust.test.ts` rather than only by the running app.
 */
import type { ClaveFileReadResult, ClaveGroup } from '@clave/contract/workspace-files'

export type { ClaveFileReadResult, ClaveGroup }

/** What acts on launch without the person's input: auto-run commands,
 *  auto-submitted prompts (the group's and the sessions'), dangerousMode. */
export function describeElevated(result: ClaveFileReadResult): {
  autoCommands: string[]
  prompts: string[]
  dangerous: boolean
} {
  const groups = result.type === 'multi' ? result.groups : [result]
  const autoCommands: string[] = []
  const prompts: string[] = []
  let dangerous = false
  for (const g of groups) {
    for (const t of g.terminals) {
      if (t.commandMode === 'auto' && t.command.trim()) autoCommands.push(t.command)
    }
    // A group-level prompt is auto-submitted to every session the group's `+`
    // launches, so it is elevated for exactly the same reason a session prompt is.
    if (g.prompt && g.prompt.trim()) prompts.push(g.prompt)
    for (const s of g.sessions) {
      if (s.dangerousMode) dangerous = true
      if (s.prompt && s.prompt.trim()) prompts.push(s.prompt)
    }
  }
  return { autoCommands, prompts, dangerous }
}

/** Strip elevated behavior: downgrade auto to prefill, disable dangerousMode,
 *  drop auto-submitted prompts (an untrusted file must not drive the agent),
 *  and drop both view declarations, `groupView` and the group's own `view`,
 *  since each renders a page inside Clave on the first group click, which an
 *  untrusted file must not arrange; the terminal itself stays. */
export function sanitizeElevated(result: ClaveFileReadResult): ClaveFileReadResult {
  const sanitizeGroup = (g: ClaveGroup): ClaveGroup => ({
    ...g,
    prompt: undefined,
    view: undefined,
    sessions: g.sessions.map((s) => ({ ...s, dangerousMode: false, prompt: undefined })),
    terminals: g.terminals.map((t) => ({
      ...t,
      ...(t.commandMode === 'auto' ? { commandMode: 'prefill' as const } : {}),
      ...(t.groupView ? { groupView: undefined } : {})
    }))
  })
  if (result.type === 'multi') {
    return { type: 'multi', groups: result.groups.map(sanitizeGroup) }
  }
  return { type: 'single', ...sanitizeGroup(result) }
}
