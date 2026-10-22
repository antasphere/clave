import { bringForward } from './window-routing'
import { randomUUID } from 'crypto'
import { app, Notification } from 'electron'
import { getLoginShellEnv, getUserShell } from './pty-manager'
import { broadcastToAllWindows } from './window-routing'
import { windowRegistry } from './window-registry'
import { executeSecretAction, redactSecret as redact } from './secret-actions'

/**
 * Lifecycle for agent-initiated secret requests. An MCP tool creates a
 * request; the user reviews it in the toolbar popover and pastes the secret;
 * the command runs here in main with the secret as a subprocess-scoped env
 * var (or as a native .env upsert). The secret value is never stored on the
 * request record, never logged, and every captured output is redacted before
 * it can reach the agent or the renderer.
 */

export type SecretAction =
  | { type: 'run'; command: string; cwd: string; envVar: string }
  | { type: 'env-file'; file: string; key: string }

export type SecretRequestStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'dismissed'
  | 'expired'

export interface SecretOutcome {
  ok: boolean
  exitCode?: number | null
  stdout?: string
  stderr?: string
  error?: string
  envFile?: { file: string; key: string; created: boolean }
}

export interface SecretRequest {
  id: string
  callerSessionId?: string
  description: string
  action: SecretAction
  status: SecretRequestStatus
  createdAt: number
  expiresAt: number
  outcome?: SecretOutcome
}

const PENDING_TTL_MS = 10 * 60_000
const OUTCOME_TTL_MS = 10 * 60_000

const requests = new Map<string, SecretRequest>()
const waiters = new Map<string, Set<(req: SecretRequest) => void>>()

function isTerminal(status: SecretRequestStatus): boolean {
  return status !== 'pending' && status !== 'running'
}

export function listRequests(): SecretRequest[] {
  return Array.from(requests.values()).sort((a, b) => a.createdAt - b.createdAt)
}

export function getRequest(id: string): SecretRequest | null {
  return requests.get(id) ?? null
}

function pushToRenderer(): void {
  // The list drives the toolbar popover in every window; broadcast it. The
  // notification and its click-to-focus (createRequest) go to the ONE window
  // hosting the requesting session.
  broadcastToAllWindows('secret:requests-changed', listRequests())
}

/** The window hosting the request's caller session (else focused/primary). */
function windowForRequest(callerSessionId: string | undefined): Electron.BrowserWindow | null {
  return windowRegistry.resolveTargetWindow({ sessionId: callerSessionId })
}

function resolveWaiters(req: SecretRequest): void {
  const set = waiters.get(req.id)
  if (!set) return
  waiters.delete(req.id)
  for (const resolve of set) resolve(req)
}

export function createRequest(input: {
  description: string
  action: SecretAction
  callerSessionId?: string
}): SecretRequest {
  const now = Date.now()
  const request: SecretRequest = {
    id: randomUUID(),
    callerSessionId: input.callerSessionId,
    description: input.description,
    action: input.action,
    status: 'pending',
    createdAt: now,
    expiresAt: now + PENDING_TTL_MS
  }
  requests.set(request.id, request)
  pushToRenderer()

  // Description only — never command output or values.
  const win = windowForRequest(input.callerSessionId)
  if (Notification.isSupported() && !win?.isFocused()) {
    const notification = new Notification({
      title: 'Clave — secret requested',
      body: input.description,
      silent: false
    })
    notification.on('click', () => {
      bringForward(windowForRequest(input.callerSessionId))
    })
    notification.show()
    if (process.platform === 'darwin') app.dock?.bounce('informational')
  }
  return request
}

/**
 * Resolve when the request reaches a terminal status, or return the current
 * (still pending/running) snapshot after timeoutMs. Never rejects.
 */
export function waitForOutcome(id: string, timeoutMs: number): Promise<SecretRequest> {
  const request = requests.get(id)
  if (!request) return Promise.reject(new Error(`No secret request "${id}"`))
  if (isTerminal(request.status)) return Promise.resolve(request)
  return new Promise((resolve) => {
    const set = waiters.get(id) ?? new Set()
    waiters.set(id, set)
    const timer = setTimeout(() => {
      set.delete(entry)
      const current = requests.get(id)
      resolve(current ?? request)
    }, timeoutMs)
    const entry = (req: SecretRequest): void => {
      clearTimeout(timer)
      resolve(req)
    }
    set.add(entry)
  })
}

export function dismissRequest(id: string): SecretRequest {
  const request = requests.get(id)
  if (!request) throw new Error(`No secret request "${id}"`)
  if (isTerminal(request.status)) return request
  request.status = 'dismissed'
  request.expiresAt = Date.now() + OUTCOME_TTL_MS
  resolveWaiters(request)
  pushToRenderer()
  return request
}

/**
 * Execute the action with the user-supplied secret. The secret stays a
 * function parameter: into the child env or the file content, then gone.
 */
export async function submitSecret(id: string, secret: string): Promise<SecretRequest> {
  const request = requests.get(id)
  if (!request) throw new Error(`No secret request "${id}"`)
  if (request.status !== 'pending') {
    throw new Error(`Secret request is ${request.status}, not pending`)
  }
  if (!secret) throw new Error('Empty secret value')

  request.status = 'running'
  pushToRenderer()

  let outcome: SecretOutcome
  try {
    outcome = await executeSecretAction(
      request.action,
      secret,
      request.action.type === 'run' ? { shell: getUserShell(), env: getLoginShellEnv() } : undefined
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    outcome = { ok: false, error: redact(message, secret) }
  }

  request.outcome = outcome
  request.status = outcome.ok ? 'completed' : 'failed'
  request.expiresAt = Date.now() + OUTCOME_TTL_MS
  resolveWaiters(request)
  pushToRenderer()
  return request
}

// Expire stale pending prompts; drop terminal records once their grace
// window for late polling has passed.
setInterval(() => {
  const now = Date.now()
  let changed = false
  for (const request of requests.values()) {
    if (now < request.expiresAt) continue
    if (isTerminal(request.status)) {
      requests.delete(request.id)
      changed = true
    } else {
      request.status = 'expired'
      request.expiresAt = now + OUTCOME_TTL_MS
      resolveWaiters(request)
      changed = true
    }
  }
  if (changed) pushToRenderer()
}, 60_000).unref()
