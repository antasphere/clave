/**
 * How the agent tools find and reach a tab, the one rule for both surfaces
 * (PRDCT-4192): the desktop's served tools (`served-session-tools.ts`, over
 * the server's commands) and the standalone server's own MCP
 * (`standalone-mcp.ts`, over its host). Until this module the daemon's copy
 * was thinner: `"mine"` typed the message into the caller's own input (a
 * lane on a Clave server received its own checkpoint as its next
 * instruction, twice on 7 November 2026), `"parent"` and a tab's name were
 * not understood, no reach rule applied and a plain terminal took text as a
 * command. The host's own facts come in through `TargetHost`, so the module
 * imports no Electron, no server client and no host, and is tested on fakes.
 *
 * What is decided here: the target of a reference (`"parent"`, an id, an
 * exact name, the routed window's tabs first, a shared name preferring the
 * tab related to the caller); that the call carries a tab identity (any tab
 * may be reached, PRDCT-4236);
 * the self-addressed send as a checkpoint that is never typed; the refusals
 * (a plain terminal, a `claude agents` menu, a tab that has ended, with the
 * way to bring it back); the provenance header on a delivery; and the
 * shapes the tools answer. What stays the host's: how a message is typed,
 * how a tab is restarted, how a screen is read, how the capture records it.
 */
import type { Session } from '@clave/contract/sessions'
import type { SidebarGroup } from '@clave/contract/sidebar'
import { LOCAL_SERVER_ID, parseSessionKey } from '@clave/contract/fleet'
import { shareAGroup } from '../../shared/group-reach'
import { sanitizeForPaste } from '../../shared/paste-sanitize'
import { buildCheckpointProvenance, buildProvenanceHeader } from '../../shared/exchange-provenance'

/** The host's facts a target needs. */
export interface TargetHost {
  /** The calling tab's id, undefined for a caller with no tab identity. */
  readonly caller: string | undefined
  /** A session by id, null when the host knows none (a stopped record the
   *  host keeps counts as known, in state `ended`). */
  get(id: string): Promise<Session | null>
  /** Every session the host knows, the stopped records it keeps included. */
  list(): Promise<readonly Session[]>
  /** The name a tab shows: its record's display name, else its folder, else its title. */
  nameOf(session: Session): string
  /** The tab's mode as the renderer spells it: claude, codex, pi, terminal, claude-agents… */
  modeOf(session: Session): string
  /** The tab that opened this one: the host's memory, else its record. */
  parentOf(id: string): string | null
  /** The groups the name tie-break reads: every window's on the desktop, the daemon's one sidebar. */
  groups(): Promise<readonly SidebarGroup[]>
  /** The window a name is resolved in first, when the host has windows. */
  readonly routedKey?: string
}

export type ReachVerb = 'message' | 'read' | 'resume'

const TOOL_OF: Record<ReachVerb, string> = {
  message: 'clave_send_to_session',
  read: 'clave_read_session',
  resume: 'clave_resume_session'
}

/** A tab of another Clave server, by the key `clave_open_session` returned
 *  for it (`clave-owner:session:<serverId>:<id>`): the process serving the
 *  tool holds no connection to that server, so such a tab is the window's
 *  to reach (PRDCT-4166, PRDCT-4193). A bare id, or anything that is not a
 *  resource key, is a tab of this host. */
export function isServerTabRef(ref: unknown): boolean {
  if (typeof ref !== 'string' || !ref.startsWith('clave-owner:')) return false
  try {
    return parseSessionKey(ref).serverId !== LOCAL_SERVER_ID
  } catch {
    return false
  }
}

/** The tab a reference names among this host's, or null: an id, then an
 *  exact name, the routed window's tabs first. */
export async function findTarget(host: TargetHost, ref: string): Promise<Session | null> {
  const byId = await host.get(ref)
  if (byId) return byId
  const all = await host.list()
  const named = all.filter((s) => host.nameOf(s) === ref)
  if (named.length <= 1) return named[0] ?? null
  // Several tabs share the name: the routed window's first, and among those
  // the one the caller can reach (round 3, C4: a Mac tab and a server tab
  // both called "Lane A" refused the caller its own related tab).
  const routed = named.filter((s) => host.routedKey !== undefined && s.windowKey === host.routedKey)
  const candidates = routed.length ? routed : named
  if (host.caller && candidates.length > 1) {
    const groups = await host.groups()
    const caller = host.caller
    const reachable = candidates.find((s) => isRelated(host, groups, caller, s.id))
    if (reachable) return reachable
  }
  return candidates[0]
}

/** The renderer's `resolveTargetSession`: "parent", an id, then an exact
 *  name, the routed window's tabs first. */
export async function resolveTarget(host: TargetHost, ref: string): Promise<Session> {
  if (ref === 'parent') {
    if (!host.caller) {
      throw new Error('Target "parent" requires the call to come from inside a Clave session')
    }
    const parentId = host.parentOf(host.caller)
    const parent = parentId ? await host.get(parentId) : null
    if (!parent) {
      throw new Error(
        'This session has no live parent — only tabs opened via clave_open_session know their opener, and that tab is no longer open. Use clave_list and target a session id or name instead.'
      )
    }
    return parent
  }
  const found = await findTarget(host, ref)
  if (!found) throw new Error(`No session with id or name "${ref}"`)
  return found
}

/** Whether two tabs are related: the same tab, one opened the other, or
 *  they share a group (its terminals included). Only the tie-break between
 *  tabs sharing a name reads it; it no longer limits what may be reached. */
export function isRelated(
  host: Pick<TargetHost, 'parentOf'>,
  groups: readonly SidebarGroup[],
  caller: string,
  targetId: string
): boolean {
  return (
    caller === targetId ||
    host.parentOf(targetId) === caller ||
    host.parentOf(caller) === targetId ||
    shareAGroup(groups, caller, targetId)
  )
}

/** The one condition on reaching another tab: the call carries a tab
 *  identity (the token-derived caller). Any tab of the host may be read,
 *  messaged, resumed or assigned (PRDCT-4236, decided 9 November 2026);
 *  `isRelated` only breaks a tie between tabs sharing a name. */
export function requireCaller(host: Pick<TargetHost, 'caller'>, verb: ReachVerb): void {
  if (!host.caller) {
    throw new Error(
      `${TOOL_OF[verb]} must be called from inside a Clave agent tab — this request has no tab identity.`
    )
  }
}

/** The tabs a message must never be typed into. */
export function refuseUntypable(mode: string): void {
  if (mode === 'terminal') {
    throw new Error(
      'Refusing to send to a plain terminal — text typed there would run as a shell command. Target an agent tab (claude/antigravity/codex).'
    )
  }
  if (mode === 'claude-agents') {
    throw new Error('Refusing to send to a `claude agents` tab — it is a menu UI, not a chat input')
  }
}

/** What a send to a stopped tab answers when it was not asked to resume it. */
export const endedMessage = (name: string): string =>
  `Session "${name}" has ended; resume it with clave_resume_session, or pass resume: true to resume it and deliver.`

const agentStateOf = (session: Session): string | null =>
  session.state === 'ended' ? null : session.state

/** The checkpoint's answer: the self-addressed send, logged where the host
 *  keeps a record and typed nowhere. `logged` false says the host keeps no
 *  exchange record (the standalone server), with the note saying so. */
export function checkpointAnswer(self: Session, name: string, logged: boolean): unknown {
  return {
    checkpoint: true,
    logged,
    delivered: false,
    sessionId: self.id,
    name,
    note: logged
      ? 'Checkpoint logged to the transport record; nothing was typed into any tab.'
      : 'Checkpoint taken; this server keeps no transport record, and nothing was typed into any tab.'
  }
}

/** What the capture of a checkpoint is given: the text as sanitized and the
 *  provenance the parser matches. */
export function checkpointCapture(
  self: Session,
  name: string,
  message: string
): { text: string; provenance: string } {
  return {
    text: sanitizeForPaste(message),
    provenance: buildCheckpointProvenance({ id: self.id, name })
  }
}

export interface SendIo {
  /** Logs the checkpoint where the host keeps one; answers whether it did. */
  checkpoint: (self: Session, name: string, message: string) => Promise<boolean> | boolean
  /** Types the text into the target as one turn and submits it. */
  type: (
    target: Session,
    text: string,
    senderName: string | undefined
  ) => Promise<{ submitted: boolean; draftHandling: string }>
  /** Brings a stopped target back under its id (the Resume), when asked to. */
  resume: (target: Session) => Promise<void>
  /** Records the delivery on the host's exchange capture, when it keeps one. */
  capture?: (delivery: {
    sender: Session
    target: Session
    text: string
    provenance: string
    delivered: boolean
  }) => void
}

/**
 * `clave_send_to_session`, the whole of it but the typing: the checkpoint for
 * a self-addressed send, the target, the caller identity, the stopped tab (refused with
 * the way back, or resumed first when `resume` is true), the untypable
 * tabs, the provenance header, the delivery and its capture.
 */
export async function sendToTarget(
  host: TargetHost,
  p: { ref: string; message: string; resume?: boolean },
  io: SendIo
): Promise<unknown> {
  const caller = host.caller
  const checkpoint = async (self: Session): Promise<unknown> => {
    const name = host.nameOf(self)
    return checkpointAnswer(self, name, await io.checkpoint(self, name, p.message))
  }
  // "mine", the caller's own id, or the caller's own name all mean the
  // checkpoint, resolved BEFORE the identity gate, which has nothing to gate on
  // a message that never leaves the session.
  if (caller && p.ref === 'mine') {
    const self = await host.get(caller)
    if (!self) throw new Error('Calling session not found')
    return checkpoint(self)
  }
  let target = await resolveTarget(host, p.ref)
  if (caller && target.id === caller) return checkpoint(target)
  requireCaller(host, 'message')
  const targetName = host.nameOf(target)
  // The tabs a message can never be typed into are refused BEFORE any
  // resume: a stopped terminal asked to resume and deliver would otherwise
  // come back as a bare shell while the call fails (round 1, C1).
  const mode = host.modeOf(target)
  refuseUntypable(mode)
  if (target.state === 'ended') {
    // Never a silent restart: a message meant for a live tab must not bring
    // back a process the person stopped on purpose (PRDCT-4193).
    if (p.resume !== true) throw new Error(endedMessage(targetName))
    await io.resume(target)
    target = (await host.get(target.id)) ?? target
  }
  const sender = caller ? await host.get(caller) : null
  const senderName = sender ? host.nameOf(sender) : undefined
  // The provenance header: the receiving agent must be able to tell this
  // text came from a sibling tab, not from the person, and know how to
  // answer it. Header and message are filtered apart, so the record holds
  // exactly what was delivered under which provenance.
  const cleanHeader = sanitizeForPaste(
    buildProvenanceHeader(sender && senderName ? { id: sender.id, name: senderName } : undefined)
  )
  const cleanMessage = sanitizeForPaste(p.message)
  const outcome = await io.type(target, `${cleanHeader}\n${cleanMessage}`, senderName)
  const after = await host.get(target.id)
  const stillAlive = after !== null && after.state !== 'ended'
  // Transport capture (observability): once the submit landed, with the
  // delivery as it stood; a Pi or OpenCode tab on either side is not captured.
  const uncaptured = (m: string): boolean => m === 'pi' || m === 'opencode'
  if (
    io.capture &&
    sender &&
    outcome.submitted &&
    !uncaptured(host.modeOf(sender)) &&
    !uncaptured(mode)
  ) {
    io.capture({
      sender,
      target,
      text: cleanMessage,
      provenance: cleanHeader,
      delivered: stillAlive
    })
  }
  return {
    delivered: stillAlive,
    sessionId: target.id,
    name: targetName,
    mode,
    agentState: agentStateOf(target),
    draftHandling: outcome.draftHandling
  }
}

/**
 * `clave_resume_session`: the target, the caller identity, and the restart of a tab
 * that is not running; a running tab is refused, since there is nothing to
 * resume and a restart would cut its turn.
 */
export async function resumeTarget(
  host: TargetHost,
  ref: string,
  resume: (target: Session) => Promise<{ resumed: boolean }>
): Promise<unknown> {
  const target = await resolveTarget(host, ref === 'mine' && host.caller ? host.caller : ref)
  requireCaller(host, 'resume')
  const name = host.nameOf(target)
  if (target.state !== 'ended')
    throw new Error(`Session "${name}" is running; there is nothing to resume.`)
  const result = await resume(target)
  const after = await host.get(target.id)
  return {
    resumed: true,
    sessionId: target.id,
    name,
    mode: host.modeOf(target),
    alive: after !== null && after.state !== 'ended',
    // Whether the conversation came along; false means the tab started fresh.
    conversation: result.resumed
  }
}

/** The answer of `clave_read_session`, over the lines the host read. */
export function readAnswer(host: TargetHost, target: Session, lines: readonly string[]): unknown {
  const kept = [...lines]
  // The TUI viewport is mostly blank padding — drop trailing empty rows.
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop()
  return {
    sessionId: target.id,
    name: host.nameOf(target),
    mode: host.modeOf(target),
    alive: target.state !== 'ended',
    agentState: agentStateOf(target),
    lines: kept.length,
    text: kept.join('\n')
  }
}
