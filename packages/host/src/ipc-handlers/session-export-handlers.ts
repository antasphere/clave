import { ipcMain, dialog, BrowserWindow } from 'electron'
import { existsSync, readFileSync, copyFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { sshManager } from '../ssh-manager'

const CLAUDE_PROJECTS_ROOT = join(homedir(), '.claude', 'projects')

type ExportExtras = { sessionType?: string | null; locationId?: string | null }

function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

/** POSIX single-quote a value for safe embedding in a remote shell command. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Session ids are UUIDs; reject anything that could traverse paths or inject shell syntax. */
function isValidSessionId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id)
}

function firstLineSessionId(filePath: string): string | null {
  try {
    // Read just enough to parse the first line — JSONL header lines are small.
    const head = readFileSync(filePath, 'utf-8').slice(0, 4096)
    const firstLine = head.split('\n').find((l) => l.trim().length > 0)
    if (!firstLine) return null
    const parsed = JSON.parse(firstLine) as { sessionId?: unknown }
    return typeof parsed.sessionId === 'string' ? parsed.sessionId : null
  } catch {
    return null
  }
}

function listJsonlsInDir(dirPath: string): string[] {
  try {
    return readdirSync(dirPath)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(dirPath, f))
  } catch {
    return []
  }
}

function newestByMtime(paths: string[]): string | null {
  let best: { path: string; mtime: number } | null = null
  for (const p of paths) {
    try {
      const stat = statSync(p)
      if (!best || stat.mtimeMs > best.mtime) best = { path: p, mtime: stat.mtimeMs }
    } catch {
      // skip
    }
  }
  return best?.path ?? null
}

/**
 * Resolve the local JSONL path for a Claude session using a cascade of strategies.
 * Claude Code rotates the session UUID on /clear, /compact, and /resume, so the
 * id Clave stored at spawn may no longer name the active transcript file.
 *
 *   1. Direct filename match in the encoded project dir.
 *   2. Scan every project dir for a file named {sessionId}.jsonl (handles cwd
 *      encoding mismatches from symlink or non-ASCII paths).
 *   3. In the encoded project dir, find the JSONL whose first line carries
 *      sessionId == claudeSessionId (id stable, filename rotated).
 *   4. Fall back to the most recently modified JSONL in the encoded project dir —
 *      for an interactive "Save discussion" click this is almost always the
 *      session the user just interacted with.
 */
function findLocalJsonl(cwd: string, claudeSessionId: string): string | null {
  // Guard against a poisoned id traversing out of the projects dir via `../`.
  if (!isValidSessionId(claudeSessionId)) return null
  const projectDir = join(CLAUDE_PROJECTS_ROOT, encodeProjectDir(cwd))

  const direct = join(projectDir, `${claudeSessionId}.jsonl`)
  if (existsSync(direct)) return direct

  try {
    for (const entry of readdirSync(CLAUDE_PROJECTS_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(CLAUDE_PROJECTS_ROOT, entry.name, `${claudeSessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    // projects root missing or unreadable
  }

  const candidates = listJsonlsInDir(projectDir)
  if (candidates.length === 0) return null

  for (const p of candidates) {
    if (firstLineSessionId(p) === claudeSessionId) return p
  }

  return newestByMtime(candidates)
}

async function readRemoteJsonl(
  locationId: string,
  cwd: string,
  claudeSessionId: string
): Promise<string | null> {
  if (!sshManager.isConnected(locationId)) return null
  // The session id and cwd flow into remote shell commands below; reject any id
  // that could inject shell syntax before it reaches the remote host.
  if (!isValidSessionId(claudeSessionId)) return null
  const encDir = encodeProjectDir(cwd)
  const remoteDir = `~/.claude/projects/${encDir}` // SFTP path (no shell expansion)
  // Shell-safe expression for exec: $HOME expands, the encoded dir is quoted.
  const remoteDirExpr = `"$HOME/.claude/projects/"${shellQuote(encDir)}`

  const tryRead = async (path: string): Promise<string | null> => {
    const sftp = await sshManager.getSftp(locationId)
    return new Promise<string | null>((resolve) => {
      let data = ''
      const stream = sftp.createReadStream(path, { encoding: 'utf-8' })
      stream.on('data', (chunk: string) => {
        data += chunk
      })
      stream.on('end', () => resolve(data))
      stream.on('error', () => resolve(null))
    })
  }

  // 1. Direct filename match
  const direct = await tryRead(`${remoteDir}/${claudeSessionId}.jsonl`)
  if (direct !== null) return direct

  // 2. Scan all project dirs for the filename
  const located = await sshManager.exec(
    locationId,
    `find "$HOME/.claude/projects" -maxdepth 2 -name ${shellQuote(`${claudeSessionId}.jsonl`)} -print -quit 2>/dev/null`
  )
  const hit = located.stdout.trim().split('\n')[0]
  if (located.code === 0 && hit) {
    const content = await tryRead(hit)
    if (content !== null) return content
  }

  // 3. In the cwd's project dir, match by internal sessionId or fall back to newest.
  const listed = await sshManager.exec(locationId, `ls -t ${remoteDirExpr}/*.jsonl 2>/dev/null`)
  const candidates = listed.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (candidates.length === 0) return null

  for (const p of candidates) {
    const head = await sshManager.exec(locationId, `head -c 4096 ${shellQuote(p)} 2>/dev/null`)
    const firstLine = head.stdout.split('\n').find((l) => l.trim().length > 0) || ''
    try {
      const parsed = JSON.parse(firstLine) as { sessionId?: unknown }
      if (typeof parsed.sessionId === 'string' && parsed.sessionId === claudeSessionId) {
        return tryRead(p)
      }
    } catch {
      // skip malformed
    }
  }

  // Newest by ls -t ordering
  return tryRead(candidates[0])
}

function findPlanFilePath(jsonlContents: string): string | null {
  const lines = jsonlContents.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line || !line.includes('planFilePath')) continue
    try {
      const entry = JSON.parse(line)
      const planPath =
        entry.planFilePath ||
        entry.message?.content?.find?.(
          (b: { type: string; name?: string }) => b.type === 'tool_use' && b.name === 'ExitPlanMode'
        )?.input?.planFilePath
      if (typeof planPath === 'string' && planPath.length > 0) return planPath
    } catch {
      // skip malformed lines
    }
  }
  return null
}

async function showNotFoundError(
  win: BrowserWindow | null,
  kind: 'discussion' | 'plan'
): Promise<void> {
  const title = kind === 'discussion' ? 'Discussion not found' : 'Plan not found'
  const message =
    kind === 'discussion'
      ? "Couldn't find the Claude session transcript for this terminal."
      : 'This session has no plan to save yet. Plans appear after ExitPlanMode runs in the conversation.'
  if (win) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      title,
      message,
      buttons: ['OK'],
      defaultId: 0
    })
  } else {
    dialog.showErrorBox(title, message)
  }
}

export function registerSessionExportHandlers(): void {
  ipcMain.handle(
    'session:save-discussion',
    async (
      _event,
      cwd: string,
      claudeSessionId: string,
      sessionName: string,
      extras?: ExportExtras
    ) => {
      const win = BrowserWindow.fromWebContents(_event.sender)
      const isRemote = extras?.sessionType === 'remote-claude'

      let localPath: string | null = null
      let remoteContents: string | null = null

      if (isRemote) {
        if (!extras?.locationId) {
          await showNotFoundError(win, 'discussion')
          return { success: false, error: 'Missing locationId for remote session' }
        }
        remoteContents = await readRemoteJsonl(extras.locationId, cwd, claudeSessionId)
        if (remoteContents === null) {
          await showNotFoundError(win, 'discussion')
          return { success: false, error: 'Discussion file not found on remote host' }
        }
      } else {
        localPath = findLocalJsonl(cwd, claudeSessionId)
        if (!localPath) {
          await showNotFoundError(win, 'discussion')
          return { success: false, error: 'Discussion file not found' }
        }
      }

      const saveOptions = {
        defaultPath: `${sessionName}.jsonl`,
        filters: [
          { name: 'JSONL', extensions: ['jsonl'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      }
      const result = win
        ? await dialog.showSaveDialog(win, saveOptions)
        : await dialog.showSaveDialog(saveOptions)

      if (result.canceled || !result.filePath) return { success: false, error: 'cancelled' }

      try {
        if (remoteContents !== null) {
          writeFileSync(result.filePath, remoteContents, 'utf-8')
        } else if (localPath) {
          copyFileSync(localPath, result.filePath)
        }
        return { success: true }
      } catch (err) {
        const message = String(err)
        if (win) {
          await dialog.showMessageBox(win, {
            type: 'error',
            title: 'Save failed',
            message: 'Could not write the discussion file.',
            detail: message,
            buttons: ['OK']
          })
        } else {
          dialog.showErrorBox('Save failed', message)
        }
        return { success: false, error: message }
      }
    }
  )

  ipcMain.handle(
    'session:save-plan',
    async (
      _event,
      cwd: string,
      claudeSessionId: string,
      sessionName: string,
      extras?: ExportExtras
    ) => {
      const win = BrowserWindow.fromWebContents(_event.sender)
      const isRemote = extras?.sessionType === 'remote-claude'

      let jsonlContents: string | null = null

      if (isRemote) {
        if (!extras?.locationId) {
          await showNotFoundError(win, 'plan')
          return { success: false, error: 'Missing locationId for remote session' }
        }
        jsonlContents = await readRemoteJsonl(extras.locationId, cwd, claudeSessionId)
      } else {
        const localPath = findLocalJsonl(cwd, claudeSessionId)
        if (localPath) {
          try {
            jsonlContents = readFileSync(localPath, 'utf-8')
          } catch {
            jsonlContents = null
          }
        }
      }

      if (jsonlContents === null) {
        await showNotFoundError(win, 'plan')
        return { success: false, error: 'Discussion file not found' }
      }

      const planPath = findPlanFilePath(jsonlContents)
      if (!planPath) {
        await showNotFoundError(win, 'plan')
        return { success: false, error: 'No plan found in this session' }
      }

      let planContents: string | null = null
      if (isRemote) {
        const sftp = await sshManager.getSftp(extras!.locationId!)
        planContents = await new Promise<string | null>((resolve) => {
          let data = ''
          const stream = sftp.createReadStream(planPath, { encoding: 'utf-8' })
          stream.on('data', (chunk: string) => {
            data += chunk
          })
          stream.on('end', () => resolve(data))
          stream.on('error', () => resolve(null))
        })
      } else if (existsSync(planPath)) {
        try {
          planContents = readFileSync(planPath, 'utf-8')
        } catch {
          planContents = null
        }
      }

      if (planContents === null) {
        await showNotFoundError(win, 'plan')
        return { success: false, error: 'Plan file unreadable' }
      }

      const saveOptions = {
        defaultPath: `${sessionName}-plan.md`,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      }
      const result = win
        ? await dialog.showSaveDialog(win, saveOptions)
        : await dialog.showSaveDialog(saveOptions)

      if (result.canceled || !result.filePath) return { success: false, error: 'cancelled' }

      try {
        writeFileSync(result.filePath, planContents, 'utf-8')
        return { success: true }
      } catch (err) {
        const message = String(err)
        if (win) {
          await dialog.showMessageBox(win, {
            type: 'error',
            title: 'Save failed',
            message: 'Could not write the plan file.',
            detail: message,
            buttons: ['OK']
          })
        } else {
          dialog.showErrorBox('Save failed', message)
        }
        return { success: false, error: message }
      }
    }
  )
}
