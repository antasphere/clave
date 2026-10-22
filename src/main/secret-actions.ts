/** Secret actions have no Electron dependency. Values remain subprocess/file
 * inputs; callers choose whether any redacted output is appropriate to expose. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { SecretAction, SecretOutcome } from './secret-request-manager'

const RUN_TIMEOUT_MS = 60_000
const OUTPUT_CAP = 4096
export interface SecretExecutionOptions {
  readonly shell: string
  readonly env: NodeJS.ProcessEnv
}
export function redactSecret(text: string, secret: string): string {
  const clean = secret ? text.split(secret).join('[REDACTED]') : text
  return clean.length > OUTPUT_CAP ? `${clean.slice(0, OUTPUT_CAP)}…[truncated]` : clean
}
const redact = redactSecret
export async function executeSecretAction(
  action: SecretAction,
  secret: string,
  options?: SecretExecutionOptions
): Promise<SecretOutcome> {
  if (action.type === 'env-file') return upsertEnvFile(action, secret)
  if (!options) throw new Error('Secret command execution needs an explicit shell environment.')
  return runWithSecret(action, secret, options)
}

function runWithSecret(
  action: Extract<SecretAction, { type: 'run' }>,
  secret: string,
  options: SecretExecutionOptions
): Promise<SecretOutcome> {
  return new Promise((resolve) => {
    const child = execFile(
      options.shell,
      ['-lc', action.command],
      {
        cwd: action.cwd,
        env: { ...options.env, [action.envVar]: secret },
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
        timeout: RUN_TIMEOUT_MS
      },
      (err, stdout, stderr) => {
        const base = {
          stdout: redact(stdout ?? '', secret),
          stderr: redact(stderr ?? '', secret)
        }
        if (err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          resolve({
            ok: false,
            ...base,
            error: `Command timed out after ${RUN_TIMEOUT_MS / 1000}s`
          })
          return
        }
        const exitCode = err ? ((err as { code?: number | string }).code ?? 1) : 0
        const numericExit = typeof exitCode === 'number' ? exitCode : 1
        resolve({
          ok: numericExit === 0,
          exitCode: numericExit,
          ...base,
          ...(err && typeof exitCode !== 'number' ? { error: redact(err.message, secret) } : {})
        })
      }
    )
    // Commands reading stdin must not hang; EPIPE if the child already exited.
    child.stdin?.on('error', () => {})
    child.stdin?.end()
  })
}

/** Quote for .env files only when the value needs it. */
function serializeEnvValue(value: string): string {
  if (!/[\s#"'$\\]/.test(value)) return value
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function upsertEnvFile(
  action: Extract<SecretAction, { type: 'env-file' }>,
  secret: string
): SecretOutcome {
  const { file, key } = action
  const exists = fs.existsSync(file)
  const original = exists ? fs.readFileSync(file, 'utf-8') : ''
  const lines = original.length > 0 ? original.split(/\r?\n/) : []

  const lineRe = new RegExp(`^\\s*(export\\s+)?${key}=`)
  let replaced = false
  const next = lines.map((line) => {
    if (replaced || !lineRe.test(line)) return line
    replaced = true
    const exportPrefix = /^\s*export\s+/.test(line) ? 'export ' : ''
    return `${exportPrefix}${key}=${serializeEnvValue(secret)}`
  })
  if (!replaced) {
    // Drop a single trailing empty line so the new entry doesn't leave a gap.
    if (next.length > 0 && next[next.length - 1] === '') next.pop()
    next.push(`${key}=${serializeEnvValue(secret)}`)
  }
  const content = `${next.join('\n')}\n`

  const mode = exists ? fs.statSync(file).mode & 0o777 : 0o600
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.clave-tmp-${randomUUID().slice(0, 8)}`
  try {
    fs.writeFileSync(tmp, content, { encoding: 'utf-8', mode })
    fs.renameSync(tmp, file)
  } catch (err) {
    try {
      fs.unlinkSync(tmp)
    } catch {
      /* already gone */
    }
    throw err
  }
  return { ok: true, envFile: { file, key, created: !exists } }
}
