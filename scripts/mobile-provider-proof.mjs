/* eslint-disable @typescript-eslint/explicit-function-return-type -- Node acceptance tooling */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync } from 'node:fs'

const hash = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const command = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 })

export function installedCodex() {
  const found = command('/bin/zsh', ['-lic', 'command -v codex']).trim().split('\n').at(-1)
  assert.ok(found.startsWith('/'), 'Codex must resolve to an installed executable')
  const executable = realpathSync(found)
  return { executable, sha256: hash(executable) }
}

// Deliberately read no argv, environment, provider frames or authentication files.
function processParents() {
  return command('/bin/ps', ['-axo', 'pid=,ppid='])
    .trim()
    .split('\n')
    .map((line) => {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number)
      return { pid, ppid }
    })
}

export function parseOpenFiles(text) {
  const result = { cwd: null, executables: [] }
  let descriptor
  for (const line of text.split('\n')) {
    if (line.startsWith('f')) descriptor = line.slice(1)
    if (!line.startsWith('n')) continue
    if (descriptor === 'cwd') result.cwd = line.slice(1)
    if (descriptor === 'txt') result.executables.push(line.slice(1))
  }
  return result
}

function processFiles(pid) {
  return parseOpenFiles(
    command('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd,txt', '-Ffn'])
  )
}

/** The isolated daemon has one session. Its adapter, provider thread and live
 * executable in the scratch directory must agree; a model label cannot prove this. */
export function proveCodexProcess(
  { serverPid, scratch, expected, session, history },
  { parents = processParents, files = processFiles, digest = hash, canonical = realpathSync } = {}
) {
  assert.equal(session.provider, 'codex', 'Phone session must use Codex')
  assert.equal(session.adapterId, 'codex-chat', 'Phone session must use the Codex chat adapter')
  assert.equal(session.transport, 'events')
  assert.equal(canonical(session.cwd), canonical(scratch))
  const metadata = history.items.map(({ event }) => event).filter((e) => e.type === 'session_meta')
  assert.ok(metadata.length > 0 && metadata.every((e) => e.model === 'gpt-6.1-sol'))
  const threads = new Set(metadata.map((e) => e.providerSessionId))
  assert.equal(threads.size, 1, 'All turns must retain one provider thread')
  const [threadId] = threads
  assert.ok(
    typeof threadId === 'string' && threadId.length > 0,
    'A real provider thread is required'
  )
  const rows = parents()
  const owned = new Set([serverPid])
  for (let changed = true; changed; ) {
    changed = false
    for (const { pid, ppid } of rows)
      if (owned.has(ppid) && !owned.has(pid)) {
        owned.add(pid)
        changed = true
      }
  }
  const matches = []
  for (const { pid, ppid } of rows) {
    if (pid === serverPid || !owned.has(pid)) continue
    let opened
    try {
      opened = files(pid)
    } catch {
      continue /* An owned short-lived helper may have exited. */
    }
    if (!opened.cwd || canonical(opened.cwd) !== canonical(scratch)) continue
    for (const executable of new Set(opened.executables)) {
      if (!executable.endsWith('/codex')) continue
      if (digest(executable) === expected.sha256) matches.push({ pid, ppid, executable })
    }
  }
  assert.equal(
    matches.length,
    1,
    'Exactly one matching Codex executable must belong to this server'
  )
  const process = matches[0]
  return {
    provider: 'codex',
    adapter: session.adapterId,
    sessionId: session.id,
    threadId,
    serverPid,
    ...process,
    executableSha256: expected.sha256,
    installedExecutable: expected.executable,
    evidence:
      'live server descendant, scratch cwd and installed Codex executable bytes; no argv or credentials collected'
  }
}
