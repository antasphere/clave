/**
 * The app's data carried into its separate server's, once (ADR 0003, wave 5,
 * PRDCT-3434, the second pull request). The server reads only its own data
 * directory, `<userData>/server`, and a server starting on an empty one would
 * show an updated install no workspaces, no accounts and no profiles. So, at
 * the first boot on the separate server, the shell copies what the server
 * needs out of its own folder, BEFORE the child starts:
 *
 * - the plain documents (`MIGRATED_DOCUMENTS`): the workspace registry and
 *   pins, the trusted roots and contents, the preferences, the launch
 *   profiles, the account lists, the `.clave` preferences;
 * - the sealed ones, RE-SEALED: the Claude tokens and the Antasphere session
 *   are opened with the app's adapter (Electron's `safeStorage`) and sealed
 *   again with the server's (the macOS Keychain), in this process's memory
 *   and never in clear on disk, because an opaque string of one adapter
 *   opens to nothing on the other by design (`ports/secrets.ts`); a value
 *   that cannot be opened here is left out and named, and that account
 *   asks for a login again;
 * - the Codex homes (`codex-homes/<id>`, a real `auth.json` beside symlinks
 *   to the machine home's entries), copied with the symlinks as they are.
 *
 * - the session records (`session-records/`, version 2 of the migration,
 *   PRDCT-3526): a record the server does not have is copied; a record it
 *   has gets only the tab's name (`displayName`, `userRenamed`) when the
 *   server's copy carries none, because 3.0.0-beta.1 carried no record over
 *   and every tab it restored was written on the server without its name.
 *
 * Nothing in the app's folder is removed or changed: the in-process server
 * (`--server=in-process`) still finds everything where it was. Nothing in
 * the server's folder is overwritten: a document already there is kept, a
 * record already there gains a name it lacks and nothing else. The marker
 * `migrated-from-app.json` in the server's folder says which version ran
 * (`v`), and a later boot runs only the steps of a later version: an
 * install migrated by beta.1 (`v: 1`) gets the records once at its next
 * boot. A boot where a step failed writes no new marker and the next boot
 * resumes, every step being idempotent.
 *
 * Pure apart from the file system: the two secret adapters come in as
 * arguments, so the unit test drives it with fakes.
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

export const MIGRATION_MARKER = 'migrated-from-app.json'
/** The marker's version: 1 carried the settings, the accounts and the Codex
 *  homes (3.0.0-beta.1); 2 adds the session records. */
export const MIGRATION_VERSION = 2
export const SESSION_RECORDS_DIR = 'session-records'

/** The documents copied as they are. */
export const MIGRATED_DOCUMENTS: readonly string[] = [
  'workspace-state.json',
  'clave-trusted-roots.json',
  'clave-trusted.json',
  'preferences.json',
  'clave-preferences.json',
  'agent-launch-profiles.json',
  'claude-accounts.json',
  'codex-accounts.json',
  'antasphere-account-client.json'
]
export const CLAUDE_CREDENTIALS_FILE = 'claude-accounts-credentials.json'
export const ANTASPHERE_SESSION_FILE = 'antasphere-account-session.json'
export const CODEX_HOMES_DIR = 'codex-homes'

/** What the migration asks of a secret adapter: the app's opens, the server's seals. */
export interface OpensSecrets {
  open(sealed: string): string | undefined
}
export interface SealsSecrets {
  available(): boolean
  seal(plain: string): string
  /** Forget an item this run filed, when the step it belongs to fails. */
  discard?(sealed: string): void
}

/** Seal every value of a step or none: a seal that throws discards the
 *  items the step filed before it and rethrows, so a step retried at the
 *  next boot leaves no orphan Keychain item behind (round 4's finding). An
 *  adapter that cannot seal at all fails the step rather than dropping the
 *  secret: the marker is then not written and nothing is lost. */
function sealAll(to: SealsSecrets): { seal: (plain: string) => string; rollback: () => void } {
  if (!to.available()) throw new Error('the server cannot seal a secret on this machine')
  const filed: string[] = []
  return {
    seal: (plain) => {
      const sealed = to.seal(plain)
      filed.push(sealed)
      return sealed
    },
    rollback: () => {
      for (const sealed of filed) {
        try {
          to.discard?.(sealed)
        } catch {
          /* an item that cannot be discarded is left; the next run files anew */
        }
      }
    }
  }
}

export interface MigrationOptions {
  readonly appDir: string
  readonly serverDir: string
  /** The app's adapter, which opens what the app sealed. */
  readonly from: OpensSecrets
  /** The server's adapter, which seals for the server. */
  readonly to: SealsSecrets
  readonly log?: (line: string) => void
  readonly now?: () => Date
}

export interface MigrationReport {
  /** `migrated` this time, `already` done before, or `nothing` to migrate. */
  readonly outcome: 'migrated' | 'already' | 'nothing'
  /** The documents copied this run. */
  readonly copied: string[]
  /** The documents the server already had, left as they were. */
  readonly kept: string[]
  /** The Claude tokens re-sealed, and whether the Antasphere session was. */
  readonly resealed: { claude: number; antasphere: boolean }
  /** The secrets that could not be opened here, by name (`claude:<id>`, `antasphere`). */
  readonly unopened: string[]
  /** The Codex homes copied. */
  codexHomes: number
  /** The session records copied, and those that only got their tab's name back. */
  readonly records: { copied: number; named: number }
  /** The steps that failed, with the reason; the marker is not written when any did. */
  readonly failed: string[]
}

const exists = (file: string): boolean => fs.existsSync(file)

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch {
    return null
  }
}

const writeJson = (file: string, value: unknown, mode: number): void => {
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode })
  fs.renameSync(tmp, file)
  fs.chmodSync(file, mode)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export function migrateAppDataToServer(options: MigrationOptions): MigrationReport {
  const log = options.log ?? (() => {})
  const { appDir, serverDir } = options
  const report: MigrationReport = {
    outcome: 'migrated',
    copied: [],
    kept: [],
    resealed: { claude: 0, antasphere: false },
    unopened: [],
    codexHomes: 0,
    records: { copied: 0, named: 0 },
    failed: []
  }
  const marker = path.join(serverDir, MIGRATION_MARKER)
  const previous = exists(marker) ? readJson(marker) : null
  // A marker that cannot be read is a done migration of an unknown version:
  // version 1, the only one written before a version was compared.
  const ran = !exists(marker)
    ? 0
    : isRecord(previous) && typeof previous.v === 'number'
      ? previous.v
      : 1
  if (ran >= MIGRATION_VERSION) return { ...report, outcome: 'already' }
  fs.mkdirSync(serverDir, { recursive: true })

  const hasAnything =
    MIGRATED_DOCUMENTS.some((name) => exists(path.join(appDir, name))) ||
    exists(path.join(appDir, CLAUDE_CREDENTIALS_FILE)) ||
    exists(path.join(appDir, ANTASPHERE_SESSION_FILE)) ||
    exists(path.join(appDir, CODEX_HOMES_DIR)) ||
    exists(path.join(appDir, SESSION_RECORDS_DIR))
  if (ran === 0 && !hasAnything) {
    writeMarker(marker, appDir, { ...report, outcome: 'nothing' }, options.now)
    log('nothing to migrate: the app has no data of its own')
    return { ...report, outcome: 'nothing' }
  }

  const step = (name: string, run: () => void): void => {
    try {
      run()
    } catch (err) {
      const reason = `${name}: ${(err as Error).message}`
      report.failed.push(reason)
      log(`failed, will be tried again at the next start: ${reason}`)
    }
  }

  if (ran < 1) carryVersion1(options, report, step)
  if (ran < 2) step(SESSION_RECORDS_DIR, () => carryRecords(appDir, serverDir, report))

  if (report.failed.length === 0) writeMarker(marker, appDir, report, options.now, previous)
  log(
    `${report.copied.length} document(s) copied, ${report.kept.length} kept, ` +
      `${report.resealed.claude} Claude token(s) re-sealed` +
      (report.resealed.antasphere ? ', the Antasphere session re-sealed' : '') +
      (report.unopened.length ? `, not opened here: ${report.unopened.join(', ')}` : '') +
      (report.codexHomes ? `, ${report.codexHomes} Codex home(s)` : '') +
      (report.records.copied || report.records.named
        ? `, ${report.records.copied} session record(s) copied, ${report.records.named} named`
        : '') +
      (report.failed.length ? `; ${report.failed.length} step(s) failed` : '')
  )
  return report
}

/** Version 1: the settings documents, the sealed secrets, the Codex homes. */
function carryVersion1(
  options: MigrationOptions,
  report: MigrationReport,
  step: (name: string, run: () => void) => void
): void {
  const { appDir, serverDir } = options
  // The plain documents, as they are, with their mode.
  for (const name of MIGRATED_DOCUMENTS) {
    const source = path.join(appDir, name)
    const target = path.join(serverDir, name)
    if (!exists(source)) continue
    if (exists(target)) {
      report.kept.push(name)
      continue
    }
    step(name, () => {
      const mode = fs.statSync(source).mode & 0o777
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(target, mode)
      report.copied.push(name)
    })
  }

  // The Claude tokens: `{ [id]: { token: sealed, setAt, invalidAt? } }`.
  step(CLAUDE_CREDENTIALS_FILE, () => {
    const source = path.join(appDir, CLAUDE_CREDENTIALS_FILE)
    const target = path.join(serverDir, CLAUDE_CREDENTIALS_FILE)
    if (!exists(source)) return
    if (exists(target)) {
      report.kept.push(CLAUDE_CREDENTIALS_FILE)
      return
    }
    const parsed = readJson(source)
    if (!isRecord(parsed)) return
    const out: Record<string, unknown> = {}
    const sealer = sealAll(options.to)
    const unopened: string[] = []
    let resealed = 0
    try {
      for (const [id, credential] of Object.entries(parsed)) {
        if (!isRecord(credential) || typeof credential.token !== 'string') continue
        const plain = options.from.open(credential.token)
        if (plain === undefined) {
          unopened.push(`claude:${id}`)
          continue
        }
        out[id] = { ...credential, token: sealer.seal(plain) }
        resealed += 1
      }
      writeJson(target, out, 0o600)
    } catch (err) {
      sealer.rollback()
      throw err
    }
    report.unopened.push(...unopened)
    report.resealed.claude += resealed
    report.copied.push(CLAUDE_CREDENTIALS_FILE)
  })

  // The Antasphere session: `{ v: 1, issuer, clientId, sealed, savedAt }`,
  // or `{ v: 1, revoked: true }`, which is copied as it is.
  step(ANTASPHERE_SESSION_FILE, () => {
    const source = path.join(appDir, ANTASPHERE_SESSION_FILE)
    const target = path.join(serverDir, ANTASPHERE_SESSION_FILE)
    if (!exists(source)) return
    if (exists(target)) {
      report.kept.push(ANTASPHERE_SESSION_FILE)
      return
    }
    const parsed = readJson(source)
    if (!isRecord(parsed)) return
    if (typeof parsed.sealed !== 'string') {
      writeJson(target, parsed, 0o600)
      report.copied.push(ANTASPHERE_SESSION_FILE)
      return
    }
    const plain = options.from.open(parsed.sealed)
    if (plain === undefined) {
      report.unopened.push('antasphere')
      return
    }
    const sealer = sealAll(options.to)
    try {
      writeJson(target, { ...parsed, sealed: sealer.seal(plain) }, 0o600)
    } catch (err) {
      sealer.rollback()
      throw err
    }
    report.resealed.antasphere = true
    report.copied.push(ANTASPHERE_SESSION_FILE)
  })

  // The Codex homes, symlinks kept as symlinks.
  step(CODEX_HOMES_DIR, () => {
    const source = path.join(appDir, CODEX_HOMES_DIR)
    const target = path.join(serverDir, CODEX_HOMES_DIR)
    if (!exists(source)) return
    if (exists(target)) {
      report.kept.push(CODEX_HOMES_DIR)
      return
    }
    // Copied beside the target and renamed into place only once whole: a
    // copy that fails half way leaves no target, so the next boot copies
    // again instead of keeping a partial folder (round 4's finding).
    const partial = `${target}.partial`
    fs.rmSync(partial, { recursive: true, force: true })
    fs.cpSync(source, partial, { recursive: true, verbatimSymlinks: true, errorOnExist: false })
    fs.renameSync(partial, target)
    report.codexHomes = fs
      .readdirSync(target, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).length
    report.copied.push(CODEX_HOMES_DIR)
  })
}

/** The name fields a record carries over onto the server's copy, and no other. */
const NAME_FIELDS = ['displayName', 'userRenamed'] as const

/**
 * Version 2: the session records. One file per tab (`<id or tmux name>.json`).
 * A record the server lacks is copied with its mode; a record it has is read
 * and, when it carries no `displayName`, given the app's name fields (written
 * to a temporary file and renamed, so a reader never sees half a record). A
 * record either side cannot parse is left as it is.
 */
function carryRecords(appDir: string, serverDir: string, report: MigrationReport): void {
  const source = path.join(appDir, SESSION_RECORDS_DIR)
  if (!exists(source)) return
  const target = path.join(serverDir, SESSION_RECORDS_DIR)
  fs.mkdirSync(target, { recursive: true })
  for (const name of fs.readdirSync(source)) {
    if (!name.endsWith('.json')) continue
    const from = path.join(source, name)
    const to = path.join(target, name)
    if (!fs.statSync(from).isFile()) continue
    if (!exists(to)) {
      const mode = fs.statSync(from).mode & 0o777
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(to, mode)
      report.records.copied += 1
      continue
    }
    const theirs = readJson(from)
    const ours = readJson(to)
    if (!isRecord(theirs) || !isRecord(ours)) continue
    if (typeof ours.displayName === 'string' || typeof theirs.displayName !== 'string') continue
    const named: Record<string, unknown> = { ...ours }
    for (const field of NAME_FIELDS) if (theirs[field] !== undefined) named[field] = theirs[field]
    const mode = fs.statSync(to).mode & 0o777
    const tmp = `${to}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(named), { encoding: 'utf-8', mode })
    fs.renameSync(tmp, to)
    report.records.named += 1
  }
}

function writeMarker(
  marker: string,
  appDir: string,
  report: MigrationReport,
  now: (() => Date) | undefined,
  previous: unknown = null
): void {
  // A later version keeps what the earlier one recorded, and adds its own.
  const earlier = isRecord(previous) ? previous : {}
  const merged = (key: 'copied' | 'kept' | 'unopened'): string[] => [
    ...(Array.isArray(earlier[key]) ? (earlier[key] as string[]) : []),
    ...report[key]
  ]
  writeJson(
    marker,
    {
      ...earlier,
      v: MIGRATION_VERSION,
      at: (now ?? (() => new Date()))().toISOString(),
      ...(earlier.at !== undefined && { firstAt: earlier.firstAt ?? earlier.at }),
      from: appDir,
      outcome: report.outcome,
      copied: merged('copied'),
      kept: merged('kept'),
      resealed: isRecord(earlier.resealed) ? earlier.resealed : report.resealed,
      unopened: merged('unopened'),
      codexHomes: typeof earlier.codexHomes === 'number' ? earlier.codexHomes : report.codexHomes,
      records: report.records
    },
    0o600
  )
}
