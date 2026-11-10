/**
 * How much a permission request can touch, from RULES alone (PRDCT-4331): a
 * pure reading of the tool's name and its input, with no model and nothing
 * read from disk, so the card can show what the rules know the instant the
 * request arrives.
 *
 * Four levels, no percentage:
 *   reads         reads only, changes nothing
 *   project       changes files of the project (the session's working folder)
 *   outside       reaches outside the project, the machine, a secret, or the network
 *   irreversible  hard to undo: deletes, overwrites history or a remote, runs
 *                 downloaded code, acts as the administrator, sends or publishes,
 *                 rewrites what governs permissions or startup
 *
 * The rules answer one of three things (fix round 3, a CLOSED WORLD):
 *   - PROVEN reads: the request sits entirely inside a small world the rules
 *     know end to end (`provenReads`): a strict tokenizer, a short list of
 *     programs each with an ALLOWLIST of options, operands inside the project
 *     and on no secret. Whatever is not explicitly allowed is not proven; no
 *     denylist of bad options is ever consulted to say "reads only".
 *   - DETECTED: an upper level found lexically (`detect`), on purpose
 *     over-approximate: every word, every quoted string, every here-document
 *     body and every `name=value` value is scanned as possible command text,
 *     so a wrapper the rules have never heard of still shows the `rm` it runs.
 *     A false alarm upward is a choice (see KNOWN OVER-WARNINGS below); a miss
 *     is a defect.
 *   - UNKNOWN: nothing proven, nothing detected. Not a level, never shown as
 *     one; the explainer's model may give it one of the three upper levels,
 *     never "reads only" (`shownLevel`).
 * A proof wins over a detection: a proof is exact, a detection is a guess
 * upward, so `grep "rm -rf" README.md` (proven) reads, while
 * `git commit -m "rm the old file"` (not proven) is "Hard to undo".
 *
 * KNOWN OVER-WARNINGS (chosen, pinned by tests): a destructive program's name
 * anywhere in a command that is not proven, quoted text included, rates it
 * "Hard to undo" (`git commit -m "kill the flaky test"`); a network program's
 * name or a secret's name anywhere rates it "Reaches outside"
 * (`git commit -m "use curl, not .env"`); a governing file named by a program
 * the rules do not know as a reader rates it "Hard to undo"
 * (`node print.js ~/.zshrc`); any `-o`/`--output` value is taken for a file
 * written (`ls -o x`).
 *
 * Pure, and free of Node and Electron: the renderer's card and the session
 * host both read it.
 */

export const RISK_LEVELS = ['reads', 'project', 'outside', 'irreversible'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]
/** What the rules answer: a level, or that they cannot tell. */
export type RuleLevel = RiskLevel | 'unknown'

/** What a person reads beside the level, in plain words. */
export const RISK_LABELS: Record<RiskLevel, string> = {
  reads: 'Reads only',
  project: 'Changes files of the project',
  outside: 'Reaches outside the project',
  irreversible: 'Hard to undo'
}

export const isRiskLevel = (value: unknown): value is RiskLevel =>
  typeof value === 'string' && (RISK_LEVELS as readonly string[]).includes(value)

const rank = (level: RiskLevel): number => RISK_LEVELS.indexOf(level)

/** The higher of the levels: a reading may raise a level, never lower it.
 *  An unknown value raises nothing. */
export function raiseLevel(floor: RiskLevel, ...others: readonly unknown[]): RiskLevel {
  let level = floor
  for (const other of others) if (isRiskLevel(other) && rank(other) > rank(level)) level = other
  return level
}

/** Two parts of one request together: `unknown` sits above a proven read and
 *  below every detected level that changes something. */
const ORDER: readonly RuleLevel[] = ['reads', 'unknown', 'project', 'outside', 'irreversible']
export function combine(a: RuleLevel, b: RuleLevel): RuleLevel {
  return ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a
}

/**
 * The level a request SHOWS, from what the rules said and what the model
 * read (D2): the model raises a level the rules detected or proved, and may
 * give an `unknown` request one of the three upper levels; it never says
 * "reads only" by itself and never lowers anything. Null: no level to show
 * ("Not verified").
 */
export function shownLevel(rule: RuleLevel, model?: unknown): RiskLevel | null {
  if (rule === 'unknown') return isRiskLevel(model) && model !== 'reads' ? model : null
  return raiseLevel(rule, model)
}

export interface RiskInput {
  toolName?: string
  input?: unknown
  /** The session's working folder: what "the project" means. */
  cwd?: string
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const strings = (value: unknown): string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : []

/** An MCP server asking the person something (Codex): a question, not a tool. */
export const ELICITATION = 'mcpServer/elicitation/request'

/** Whether the explainer reads a request: a tool to allow, never a question,
 *  an elicitation, or a question whose input did not parse. */
export function isExplainable(request: {
  toolName?: string
  questions?: readonly unknown[]
}): boolean {
  if (!request.toolName || request.questions?.length) return false
  return request.toolName !== ELICITATION && request.toolName !== 'AskUserQuestion'
}

// ── Tools ──

/** Built-in tools that read and change nothing: proven only on paths and
 *  globs that pass the path rule. */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
/** Built-in tools that touch no file, no network and nothing outside. */
const INERT_TOOLS = new Set(['TodoWrite', 'TodoRead', 'TaskOutput', 'BashOutput', 'ToolSearch'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const CODEX_COMMAND = new Set(['item/commandExecution/requestApproval', 'execCommandApproval'])
const CODEX_EDIT = new Set(['item/fileChange/requestApproval', 'applyPatchApproval'])

/** Words in an MCP tool's name that say it removes something for good. */
const MCP_FINAL = new Set(['delete', 'drop', 'destroy', 'purge', 'wipe', 'truncate'])
/** Words that say it writes a file (then a governing path is hard to undo). */
const MCP_WRITE = new Set(['write', 'edit', 'create', 'move', 'save', 'put', 'update', 'append'])

/** A tool name's words: `mcp__slack__chat_postMessage` → mcp, slack, chat, post, message. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

/** A database statement that removes data, as a client's command argument. */
const SQL_FINAL = /\b(?:drop|truncate)\b|\bdelete\s+from\b|\bflush(?:all|db)\b/i

/** Every string inside a tool's input, however deep. */
function inputStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) inputStrings(v, out, depth + 1)
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) inputStrings(v, out, depth + 1)
  return out
}

/** An MCP tool: a remote service, so outside at least; hard to undo when its
 *  name says it removes something, when it runs a statement that drops data,
 *  or when it writes a file that governs startup or permissions. */
function mcpLevel(name: string, input: unknown, ctx: Context, acc: Acc): RiskLevel {
  const words = nameWords(name.split('__').slice(2).join('__') || name)
  if (words.some((w) => MCP_FINAL.has(w))) return 'irreversible'
  const values = inputStrings(input)
  if (words.some((w) => w === 'sql' || w === 'query' || w === 'execute'))
    if (values.some((v) => SQL_FINAL.test(v))) return 'irreversible'
  if (words.some((w) => MCP_WRITE.has(w)))
    for (const v of values) {
      if (/\s/.test(v)) continue
      if (governingMention(v) || GOVERNING_FILES.some((re) => re.test(resolve(ctx.dir, v) ?? '')))
        return 'irreversible'
    }
  for (const v of values) if (!/\s/.test(v) && secretWord(v)) acc.maySecrets = true
  // A send or a post, or anything else on a remote service: outside.
  return 'outside'
}

/**
 * What the rules read of one permission request: the LEVEL (proven reads, a
 * detected upper level, or unknown), and beside it two things that never set
 * a level:
 *   - `maySecrets`: a best-effort NOTE that what is read may show a secret (a
 *     secret-like name, a recursive search from the project's root or a
 *     dot-folder, an environment dump, `git remote -v`, a dotfile glob). Its
 *     absence claims nothing.
 *   - `hints`: words the rules NOTICED without acting on them (a destructive
 *     or network word inside quoted text, a here-document body, interpreter
 *     code, a commit message), for the explainer's prompt only.
 */
export interface RuleReading {
  level: RuleLevel
  maySecrets: boolean
  hints: string[]
}

/** At most this many hints go to the prompt. */
const MAX_HINTS = 8

export function ruleReading({ toolName, input, cwd }: RiskInput): RuleReading {
  const acc = newAcc()
  const level = toolLevel(toolName ?? '', record(input), input, cwd, acc)
  return { level, maySecrets: acc.maySecrets, hints: [...acc.hints].slice(0, MAX_HINTS) }
}

/** The level of one permission request, from the rules alone. */
export function riskFloor(request: RiskInput): RuleLevel {
  return ruleReading(request).level
}

function toolLevel(
  name: string,
  p: Record<string, unknown>,
  input: unknown,
  cwd: string | undefined,
  acc: Acc
): RuleLevel {
  const ctx = startContext(cwd)
  if (READ_TOOLS.has(name)) return readToolLevel(name, p, ctx, acc)
  if (INERT_TOOLS.has(name)) return 'reads'
  if (WRITE_TOOLS.has(name)) {
    const path = text(p.file_path) || text(p.notebook_path)
    if (path && secretWord(path)) acc.maySecrets = true
    return path ? writeLevel(resolve(ctx.dir, path), ctx) : 'outside'
  }
  if (name === 'Bash') return scriptLevel(text(p.command), ctx, true, acc)
  // PowerShell is not the shell the proof knows: detected, never proven.
  if (name === 'PowerShell') return scriptLevel(text(p.command), ctx, false, acc)
  if (CODEX_COMMAND.has(name)) {
    const at = text(p.cwd) ? startContext(cwd, text(p.cwd)) : ctx
    const argv = strings(p.command)
    return scriptLevel(
      argv.length ? argv.map(shellQuote).join(' ') : text(p.command),
      at,
      true,
      acc
    )
  }
  if (CODEX_EDIT.has(name)) {
    const paths = codexPaths(p)
    // A file change is a change for sure; with no path named, what it
    // touches is the model's to read.
    if (!paths.length) return 'project'
    let level: RuleLevel = 'project'
    for (const path of paths) level = combine(level, writeLevel(resolve(ctx.dir, path), ctx))
    return level
  }
  if (name === 'item/permissions/requestApproval') return 'outside'
  if (name === ELICITATION) return 'outside'
  if (name === 'ExitPlanMode' || name === 'AskUserQuestion') return 'unknown'
  if (name.startsWith('mcp__')) return mcpLevel(name, input, ctx, acc)
  // WebFetch, WebSearch, a skill, a subagent, a tool the rules do not know:
  // the network, or code and instructions they cannot read, at least outside.
  return 'outside'
}

/** A Codex argv element as one shell word. */
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_\-.,/:=@%+]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Read, Glob, Grep, LS: reads only when every path and glob is inside the
 *  project; outside when one leaves it. A secret-like name or a dotfile glob
 *  is a note, not a level. */
function readToolLevel(
  name: string,
  p: Record<string, unknown>,
  ctx: Context,
  acc: Acc
): RuleLevel {
  const items: Array<{ value: string; glob: boolean }> = []
  if (name === 'Read') items.push({ value: text(p.file_path), glob: false })
  else if (name === 'NotebookRead') items.push({ value: text(p.notebook_path), glob: false })
  else {
    if (p.path !== undefined) items.push({ value: text(p.path), glob: false })
    if (name === 'Glob') items.push({ value: text(p.pattern), glob: true })
    if (name === 'Grep' && p.glob !== undefined) items.push({ value: text(p.glob), glob: true })
  }
  let proven = true
  let level: RuleLevel = 'unknown'
  for (const item of items) {
    if (!pathOk({ value: item.value, glob: item.glob, quoted: true }, ctx, true)) proven = false
    if (secretWord(item.value) || (item.glob && globMaySecret(item.value))) acc.maySecrets = true
    const at = resolve(ctx.dir, item.value.replace(/[*?[{].*$/, '') || '.')
    if (at === null || (!isDevice(at) && !inside(at, ctx.base))) level = combine(level, 'outside')
  }
  if (proven && level === 'unknown') return 'reads'
  return level
}

/** The paths a Codex file change names: `fileChanges` (by path), `changes`
 *  (each with a path), `grantRoot`. */
function codexPaths(p: Record<string, unknown>): string[] {
  const out: string[] = []
  out.push(...Object.keys(record(p.fileChanges)))
  if (Array.isArray(p.changes))
    for (const change of p.changes) {
      const c = record(change)
      const path = text(c.path) || text(c.file) || text(c.filePath)
      if (path) out.push(path)
    }
  const root = text(p.grantRoot)
  if (root) out.push(root)
  return out
}

// ── Paths ──

const PROJECT_SENTINEL = '/\u0000project'

interface Context {
  /** The project's root (the session's working folder). */
  base: string
  /** The folder the command is in now, followed through `cd`; null once
   *  the rules cannot follow it. */
  dir: string | null
}

function startContext(cwd?: string, at?: string): Context {
  const base = cwd ? (normalise(cwd) ?? PROJECT_SENTINEL) : PROJECT_SENTINEL
  const dir = at ? resolve(base, at) : base
  return { base, dir }
}

/** A path with `.` and `..` folded; a home-relative path keeps its `~`
 *  root. Null when `..` climbs above `~`. */
function normalise(path: string): string | null {
  const home = path === '~' || path.startsWith('~/')
  const parts: string[] = []
  for (const part of (home ? path.slice(1) : path).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (!parts.length && home) return null
      parts.pop()
    } else parts.push(part)
  }
  return (home ? '~/' : '/') + parts.join('/')
}

/** A path as the command names it, from the folder it is in. Null when the
 *  rules cannot place it: a variable, a substitution, an unknown folder. */
function resolve(dir: string | null, raw: string): string | null {
  const path = raw.trim()
  if (!path) return null
  const home = /^(?:~(?=\/|$)|\$HOME(?=\/|$)|\$\{HOME\}(?=\/|$))/.exec(path)
  if (home) return normalise('~' + path.slice(home[0].length))
  if (/[$`]/.test(path)) return null
  if (/^~[A-Za-z]/.test(path)) return null
  if (path.startsWith('/')) return normalise(path)
  if (dir === null) return null
  return normalise(`${dir}/${path}`)
}

/** What governs permissions, startup or the machine: a write there is hard to
 *  undo whatever folder it is in. Case-insensitive (macOS). */
const GOVERNING = [
  /(?:^|\/)\.(?:zshrc|zshenv|zprofile|zlogin|zlogout|bashrc|bash_profile|bash_login|bash_logout|profile|kshrc|cshrc|tcshrc|inputrc|xprofile|xinitrc)$/i,
  /(?:^|\/)\.config\/fish(?:\/|$)/i,
  /(?:^|\/)\.(?:ssh|aws|gnupg|kube)(?:\/|$)/i,
  /(?:^|\/)authorized_keys$/i,
  /(?:^|\/)\.claude\/settings[^/]*\.json$/i,
  /(?:^|\/)\.claude\/(?:hooks|agents|commands)(?:\/|$)/i,
  /^(?:~|\/Users\/[^/]+|\/home\/[^/]+|\/root)\/\.claude(?:\/|$)/i,
  /(?:^|\/)\.claude\.json$/i,
  /(?:^|\/)\.mcp\.json$/i,
  /(?:^|\/)\.git\/(?:hooks(?:\/|$)|config$)/i,
  /(?:^|\/)\.(?:gitconfig|npmrc|yarnrc|yarnrc\.yml|netrc|pypirc|curlrc|wgetrc)$/i,
  /(?:^|\/)Library\/(?:LaunchAgents|LaunchDaemons|StartupItems)(?:\/|$)/i,
  /(?:^|\/)crontab$/i,
  /^\/(?:etc|private\/etc|private\/var\/root|Library|System|usr|bin|sbin|var\/root|Applications)(?:\/|$)/i,
  /^\/$/
]
/** The governing FILES, without the system folders: what a mention or a
 *  tool's input is checked against. */
const GOVERNING_FILES = GOVERNING.slice(0, 13)
/** The same, as a NAME found anywhere in a word: a mention, not a resolved
 *  path. System folders are left out (a program run from `/usr/bin` is not a
 *  write there); `/etc` stays. */
const GOVERNING_NAME =
  /(?:^|[\s/'"=:])(?:\.(?:zshrc|zshenv|zprofile|zlogin|zlogout|bashrc|bash_profile|bash_login|bash_logout|profile|kshrc|cshrc|tcshrc|inputrc|gitconfig|npmrc|yarnrc|netrc|pypirc|curlrc|wgetrc|mcp\.json|claude\.json)\b|\.ssh\b|\.aws\b|\.gnupg\b|\.kube\b|authorized_keys\b|\.claude\/|\.git\/(?:hooks|config)\b|LaunchAgents\b|LaunchDaemons\b|crontab\b|(?:^|\/private)\/etc\b)/i
const governingMention = (word: string): boolean => GOVERNING_NAME.test(word)

/** A secret's name: matched against each component, for the NOTE only
 *  (R1: a name can never prove a file holds no secret, so it sets no level).
 *  The broad words (`token`, `secret`, `credential`) skip source and text
 *  files, where they are names of code rather than of a secret. */
const SECRET_NAME =
  /^(?:\.env.*|\.envrc|.*\.(?:pem|key|p12|pfx|keystore|jks|kdbx|tfvars|tfstate)|id_(?:rsa|dsa|ecdsa|ed25519).*|\.npmrc|\.netrc|\.pgpass|\.pypirc|\.git-credentials|\.aws-credentials|\.htpasswd|\.yarnrc.*|\.dev\.vars.*|\.vault-token|kubeconfig.*|auth\.json|serviceaccount.*\.json)$/i
const SECRET_BROAD = /secret|credential|token/i
const CODE_FILE =
  /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|h|cc|cpp|cs|php|md|mdx|txt|css|scss|html|vue|svelte|test|spec|snap|map|d\.ts)$/i
const SECRET_DIR = /^\.(?:ssh|aws|gnupg|kube|docker|config|azure|gcloud)$/i
/** What a glob component, read literally, says it is after. */
const SECRET_MARK =
  /\.env|\.pem|\.key|\.p12|\.pfx|id_rsa|id_dsa|id_ecdsa|id_ed25519|npmrc|netrc|yarnrc|credential|secret|token|tfvars|kubeconfig|\.ssh|\.aws|\.gnupg|\.kube|\.docker|keychain/i

const GLOB_CHARS = /[*?[]/

/** A glob component as a regular expression (`*`, `?`, `[…]`, `{a,b}`). */
function globRe(component: string): RegExp {
  let out = ''
  for (let i = 0; i < component.length; i++) {
    const c = component[i]
    if (c === '*') out += '.*'
    else if (c === '?') out += '.'
    else if (c === '[') {
      const end = component.indexOf(']', i + 2)
      if (end < 0) out += '\\['
      else {
        out += `[${component
          .slice(i + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')}]`
        i = end
      }
    } else if (c === '{') out += '(?:'
    else if (c === '}') out += ')'
    else if (c === ',') out += '|'
    else out += c.replace(/[.+^$()|\\]/g, '\\$&')
  }
  try {
    return new RegExp(`^${out}$`, 'i')
  } catch {
    return /^/
  }
}

/** Names a glob is tried against for the NOTE: if it could match one, what
 *  it reaches may hold a secret. `**` reaches every folder below, dot-folders
 *  included where the tool shows them. */
const SECRET_SAMPLES = [
  'server.pem',
  'server.key',
  'credentials.json',
  'secrets.json',
  'id_rsa',
  '.env',
  '.npmrc'
]
const globMaySecret = (word: string): boolean =>
  word.split('/').some((c) => {
    if (c === '**') return true
    if (!GLOB_CHARS.test(c) && !/[{}]/.test(c)) return false
    const re = globRe(c)
    return SECRET_SAMPLES.some((sample) => re.test(sample))
  })

const isSecretComponent = (c: string): boolean =>
  SECRET_NAME.test(c) || SECRET_DIR.test(c) || (SECRET_BROAD.test(c) && !CODE_FILE.test(c))

/** Whether a word names a secret, or could through a glob (detection, so
 *  read literally: `.e*`, `*credentials*`, `~/.ssh/x`). */
function secretWord(word: string): boolean {
  for (const piece of word.split(/[/:=\s,]+/)) {
    if (!piece) continue
    if (isSecretComponent(piece)) return true
    if (GLOB_CHARS.test(piece) || /[{}]/.test(piece)) {
      if (piece.startsWith('.')) return true
      if (SECRET_MARK.test(piece)) return true
    }
  }
  return /Keychains/i.test(word)
}

const isDevice = (path: string): boolean =>
  /^\/dev\/(?:null|stdout|stderr|stdin|tty|fd\/\d+)$/.test(path)
const inside = (path: string, base: string): boolean =>
  path === base || path.startsWith(base === '/' ? '/' : base + '/')

/** The level of writing a path. A path the rules cannot place is never the
 *  project: outside at least. */
function writeLevel(path: string | null, ctx: Context): RiskLevel {
  if (path === null) return 'outside'
  if (isDevice(path)) return 'reads'
  if (GOVERNING.some((re) => re.test(path))) return 'irreversible'
  return inside(path, ctx.base) ? 'project' : 'outside'
}

// ═════════════════════════════════════════════════════════════════════════
// 1. PROVEN reads only: the closed world
// ═════════════════════════════════════════════════════════════════════════

interface PWord {
  /** The word with its quotes taken off. */
  value: string
  /** An unquoted `*`, `?` or `[`: the shell will expand it. */
  glob: boolean
  /** Some part of it was quoted. */
  quoted: boolean
}

/**
 * The strict tokenizer: simple commands joined by `|`, `&&`, `||`, `;`, or
 * null as soon as anything else appears outside single quotes (any `$`,
 * backtick, backslash, parenthesis, brace, `#`, newline, `<`, `>`, `&` alone,
 * control or non-ASCII character), except the exact redirections `2>&1` and
 * `2>/dev/null`. Inside double quotes: no `$`, no backtick, and a backslash
 * only before `"` or `\`.
 */
function proofParse(script: string): PWord[][] | null {
  const commands: PWord[][] = []
  let current: PWord[] = []
  let word: PWord | null = null
  const n = script.length
  const endWord = (): void => {
    if (word) current.push(word)
    word = null
  }
  const endCommand = (): boolean => {
    endWord()
    if (!current.length) return false
    commands.push(current)
    current = []
    return true
  }
  const at = (i: number, s: string): boolean => script.startsWith(s, i)
  const boundary = (i: number): boolean => i >= n || ' |;&'.includes(script[i])
  let i = 0
  while (i < n) {
    const c = script[i]
    if (c === ' ') {
      endWord()
      i++
      continue
    }
    if (c === "'") {
      const end = script.indexOf("'", i + 1)
      if (end < 0) return null
      word ??= { value: '', glob: false, quoted: false }
      word.value += script.slice(i + 1, end)
      word.quoted = true
      i = end + 1
      continue
    }
    if (c === '"') {
      word ??= { value: '', glob: false, quoted: false }
      word.quoted = true
      i++
      for (;;) {
        if (i >= n) return null
        const d = script[i]
        if (d === '"') break
        if (d === '$' || d === '`') return null
        if (d === '\\') {
          const e = script[i + 1]
          if (e !== '"' && e !== '\\') return null
          word.value += e
          i += 2
          continue
        }
        word.value += d
        i++
      }
      i++
      continue
    }
    if (c === '|' || c === '&' || c === ';') {
      if (c === '|' && at(i, '||')) i += 2
      else if (c === '&' && at(i, '&&')) i += 2
      else if (c === '|' && script[i + 1] !== '&') i += 1
      else if (c === ';' && script[i + 1] !== ';') i += 1
      else return null
      if (!endCommand()) return null
      continue
    }
    if (!word && c === '2') {
      const redirect = at(i, '2>&1') ? 4 : at(i, '2>/dev/null') ? 11 : 0
      if (redirect && boundary(i + redirect)) {
        i += redirect
        continue
      }
    }
    if (c === '!' && !word && boundary(i + 1)) {
      current.push({ value: '!', glob: false, quoted: false })
      i++
      continue
    }
    const code = c.charCodeAt(0)
    if (code < 0x21 || code > 0x7e) return null
    if ('<>(){}#$`\\!'.includes(c)) return null
    word ??= { value: '', glob: false, quoted: false }
    word.value += c
    if (GLOB_CHARS.test(c)) word.glob = true
    i++
  }
  endWord()
  if (!current.length) return null
  commands.push(current)
  return commands
}

/**
 * Path rule: inside the working folder (a relative path never climbing above
 * it, an absolute one only inside it, no `~`, no zsh `=word`), and no glob
 * that (unless `leadingGlobOk`) could expand into a word starting with `-`.
 * Whether the file may hold a secret is NOT part of the proof (R1): the
 * rules say it in a note beside the level.
 */
function pathOk(word: PWord, ctx: Context, leadingGlobOk = false): boolean {
  const v = word.value
  if (!v || v.startsWith('~') || v.startsWith('=') || v.includes('\u0000')) return false
  if (word.glob && !leadingGlobOk && GLOB_CHARS.test(v[0])) return false
  let resolved: string | null
  if (v.startsWith('/')) {
    if (v.split('/').includes('..')) return false
    resolved = normalise(v)
  } else {
    if (ctx.dir === null) return false
    let depth = 0
    for (const part of v.split('/')) {
      if (part === '..') depth--
      else if (part && part !== '.') depth++
      if (depth < 0) return false
    }
    resolved = normalise(`${ctx.dir}/${v}`)
  }
  return !!resolved && inside(resolved, ctx.base)
}

type Check = (value: string, ctx: Context, word: PWord) => boolean
const NUM: Check = (v) => /^\d+$/.test(v)
const TAILNUM: Check = (v) => /^\+?\d+$/.test(v)
const ANY: Check = (v) => v.length > 0
const CHAR: Check = (v) => v.length === 1
const LIST: Check = (v) => /^[\d,-]+$/.test(v)
const SORTKEY: Check = (v) => /^[\d.,a-zA-Z]+$/.test(v)
const TYPE: Check = (v) => /^[A-Za-z0-9_+-]+$/.test(v)
const RGGLOB: Check = (v, ctx, w) =>
  pathOk({ value: v.replace(/^!/, ''), glob: true, quoted: w.quoted }, ctx, true)

interface Spec {
  /** Short option letters: true (no value) or the check of its value. */
  short?: Record<string, true | Check>
  /** Long options, exact: `--x` → true; `--x=` → the check of the value. */
  long?: Record<string, true | Check>
  /** `-N` as a number (head, tail). */
  numDash?: boolean
  operands: 'paths' | 'none' | 'any' | 'names'
  /** The first operand is a pattern, unless `-e` (or `--files`) is given. */
  pattern?: boolean
  minOperands?: number
}

const GREP: Spec = {
  short: {
    n: true,
    i: true,
    r: true,
    R: true,
    l: true,
    L: true,
    c: true,
    v: true,
    E: true,
    F: true,
    P: true,
    w: true,
    x: true,
    h: true,
    H: true,
    o: true,
    s: true,
    q: true,
    A: NUM,
    B: NUM,
    C: NUM,
    m: NUM,
    e: ANY
  },
  long: {
    '--include=': ANY,
    '--exclude=': ANY,
    '--exclude-dir=': ANY,
    '--color': true,
    '--color=': (v) => /^(?:always|never|auto)$/.test(v),
    '--line-number': true
  },
  operands: 'paths',
  pattern: true
}

/** The READ LIST: the only programs that can be proven, each with its
 *  allowlist. Adding a program here is a design decision, not a fix. */
const READ_LIST: Record<string, Spec> = {
  cat: { short: { n: true, b: true, s: true, v: true, e: true, t: true }, operands: 'paths' },
  head: { short: { n: NUM, c: NUM }, numDash: true, operands: 'paths' },
  tail: { short: { n: TAILNUM, c: TAILNUM }, numDash: true, operands: 'paths' },
  wc: { short: { l: true, w: true, c: true, m: true }, operands: 'paths' },
  nl: { operands: 'paths' },
  ls: {
    short: {
      l: true,
      a: true,
      A: true,
      h: true,
      t: true,
      r: true,
      R: true,
      '1': true,
      d: true,
      F: true,
      G: true,
      S: true
    },
    operands: 'paths'
  },
  pwd: { operands: 'none' },
  date: { operands: 'none' },
  whoami: { operands: 'none' },
  basename: { operands: 'any', minOperands: 1 },
  dirname: { operands: 'any', minOperands: 1 },
  true: { operands: 'none' },
  echo: { short: { n: true, e: true }, operands: 'any' },
  tree: { short: { L: NUM, d: true, a: true, I: ANY }, operands: 'paths' },
  du: { short: { h: true, s: true, d: NUM }, operands: 'paths' },
  df: { short: { h: true }, operands: 'paths' },
  stat: { operands: 'paths' },
  file: { operands: 'paths' },
  cut: { short: { d: CHAR, f: LIST, c: LIST }, operands: 'paths' },
  tr: { short: { d: true, s: true, c: true }, operands: 'any' },
  sort: {
    short: { n: true, r: true, u: true, f: true, k: SORTKEY, t: CHAR },
    operands: 'paths'
  },
  uniq: { short: { c: true, d: true, u: true, i: true }, operands: 'none' },
  which: { operands: 'names', minOperands: 1 },
  type: { operands: 'names', minOperands: 1 },
  grep: GREP,
  egrep: GREP,
  fgrep: GREP,
  rg: {
    short: {
      n: true,
      i: true,
      l: true,
      c: true,
      v: true,
      w: true,
      F: true,
      S: true,
      A: NUM,
      B: NUM,
      C: NUM,
      m: NUM,
      e: ANY,
      g: RGGLOB,
      t: TYPE
    },
    long: { '--files': true, '--no-heading': true },
    operands: 'paths',
    pattern: true
  }
}

/** Whether one simple command is proven to read only. */
function provenCommand(words: PWord[], ctx: Context): boolean {
  const first = words[0]
  // (c) a bare program name: no `/`, no `=`, no glob, on the list.
  if (first.glob || !/^[a-z][a-z0-9]*$/.test(first.value)) return false
  const program = first.value
  const args = words.slice(1)
  if (program === 'command') {
    if (args.length < 2 || args[0].value !== '-v') return false
    return args.slice(1).every(isName)
  }
  if (program === 'find') return provenFind(args, ctx)
  if (program === 'jq') return provenJq(args, ctx)
  if (program === 'git') return provenGit(args, ctx)
  const spec = READ_LIST[program]
  if (!spec) return false
  return provenBySpec(spec, args, ctx)
}

const isName = (w: PWord): boolean => !w.glob && /^[A-Za-z0-9_][A-Za-z0-9._+-]*$/.test(w.value)

function provenBySpec(spec: Spec, args: PWord[], ctx: Context): boolean {
  const operands: PWord[] = []
  let patternGiven = false
  let endOfOptions = false
  for (let i = 0; i < args.length; i++) {
    const w = args[i]
    const v = w.value
    if (endOfOptions || !v.startsWith('-') || v === '-') {
      operands.push(w)
      continue
    }
    if (v === '--') {
      endOfOptions = true
      continue
    }
    if (v.startsWith('--')) {
      const eq = v.indexOf('=')
      if (eq >= 0) {
        const check = spec.long?.[v.slice(0, eq + 1)]
        if (typeof check !== 'function') return false
        // A glob can only expand to a name that starts with the same option.
        if (w.glob && !/^--(?:include|exclude|exclude-dir)=/.test(v)) return false
        if (!check(v.slice(eq + 1), ctx, w)) return false
      } else {
        if (w.glob || spec.long?.[v] !== true) return false
        if (v === '--files') patternGiven = true
      }
      continue
    }
    if (w.glob) return false
    if (spec.numDash && /^-\d+$/.test(v)) continue
    // A cluster of short options: each letter allowed; a letter that takes a
    // value takes the rest of the cluster, or the next word.
    for (let j = 1; j < v.length; j++) {
      const option = spec.short?.[v[j]]
      if (!option) return false
      if (option === true) continue
      const rest = v.slice(j + 1)
      let value: PWord
      if (rest) value = { value: rest, glob: false, quoted: w.quoted }
      else {
        const next = args[++i]
        if (!next) return false
        value = next
      }
      if (value.glob && option !== RGGLOB) return false
      if (!option(value.value, ctx, value)) return false
      if (v[j] === 'e') patternGiven = true
      break
    }
  }
  let rest = operands
  if (spec.pattern && !patternGiven) {
    if (!rest.length || rest[0].glob) return false
    rest = rest.slice(1)
  }
  if (rest.length < (spec.minOperands ?? 0)) return false
  switch (spec.operands) {
    case 'none':
      return rest.length === 0
    case 'any':
      return true
    case 'names':
      return rest.every(isName)
    case 'paths':
      return rest.every((w) => pathOk(w, ctx))
  }
}

/** A find value the shell will not expand into something else. */
const findValue = (w: PWord | undefined): w is PWord => !!w && !w.glob && w.value.length > 0

function provenFind(args: PWord[], ctx: Context): boolean {
  let i = 0
  while (i < args.length && !args[i].value.startsWith('-') && args[i].value !== '!') {
    if (!pathOk(args[i], ctx)) return false
    i++
  }
  while (i < args.length) {
    const p = args[i].value
    if (args[i].glob) return false
    if (['!', '-not', '-a', '-o', '-print', '-prune'].includes(p)) {
      i++
      continue
    }
    const v = args[i + 1]
    if (['-name', '-iname', '-path', '-ipath'].includes(p)) {
      if (!findValue(v)) return false
    } else if (p === '-type') {
      if (!findValue(v) || !/^[fdlbcps]$/.test(v.value)) return false
    } else if (p === '-maxdepth' || p === '-mindepth') {
      if (!findValue(v) || !/^\d+$/.test(v.value)) return false
    } else if (p === '-size') {
      if (!findValue(v) || !/^[+-]?\d+[ckwbMGTP]?$/.test(v.value)) return false
    } else if (p === '-mtime') {
      if (!findValue(v) || !/^[+-]?\d+$/.test(v.value)) return false
    } else if (p === '-newer') {
      if (!v || !pathOk(v, ctx)) return false
    } else return false
    i += 2
  }
  return true
}

/** A jq filter that reads nothing but its input: no environment, no other
 *  input, no module, no shell formatting. */
const JQ_BANNED = /env|input|import|include|\$__loc__|\$__prog|@sh|modulemeta|get_search_list/i

function provenJq(args: PWord[], ctx: Context): boolean {
  let filter: PWord | null = null
  const files: PWord[] = []
  for (const w of args) {
    if (w.value.startsWith('-') && w.value.length > 1 && !filter) {
      if (w.glob || !/^-[rcesS]+$/.test(w.value)) return false
      continue
    }
    if (w.value.startsWith('-') && w.value.length > 1) return false
    if (!filter) filter = w
    else files.push(w)
  }
  if (!filter || filter.glob || JQ_BANNED.test(filter.value)) return false
  return files.every((w) => pathOk(w, ctx))
}

/** A git operand: a revision or a path, never above the project (a secret
 *  it names, `HEAD:.env`, is the note's business). */
function gitOperandOk(w: PWord, ctx: Context): boolean {
  const v = w.value
  if (!v || w.glob || v.startsWith('-') || v.startsWith('~') || v.startsWith('=')) return false
  if (v.startsWith('/')) return pathOk(w, ctx)
  return !v.split(/[/:]/).includes('..')
}

const GIT_HISTORY_FLAGS = new Set([
  '--oneline',
  '--stat',
  '--name-only',
  '--name-status',
  '--graph',
  '--decorate',
  '--all',
  '--cached',
  '--staged',
  '--no-color',
  '-p'
])
const GIT_HISTORY_EQ = /^--(?:since|until|author|grep)=./

function provenGit(args: PWord[], ctx: Context): boolean {
  if (!args.length || args.some((w) => w.glob)) return false
  const sub = args[0].value
  const rest = args.slice(1)
  const values = rest.map((w) => w.value)
  const only = (allowed: string[][]): boolean =>
    allowed.some((a) => a.length === values.length && a.every((x, k) => x === values[k]))
  switch (sub) {
    case 'status': {
      let paths = false
      for (const w of rest) {
        if (!paths && w.value === '--') paths = true
        else if (!paths && w.value.startsWith('-')) {
          if (
            ![
              '-s',
              '--short',
              '-b',
              '--branch',
              '--porcelain',
              '--porcelain=v1',
              '--porcelain=v2'
            ].includes(w.value)
          )
            return false
        } else if (!pathOk(w, ctx)) return false
      }
      return true
    }
    case 'log':
    case 'show':
    case 'diff': {
      let paths = false
      for (let i = 0; i < rest.length; i++) {
        const w = rest[i]
        const v = w.value
        if (paths) {
          if (!pathOk(w, ctx)) return false
        } else if (v === '--') paths = true
        else if (v.startsWith('-')) {
          if (GIT_HISTORY_FLAGS.has(v) || GIT_HISTORY_EQ.test(v) || /^-n?\d+$/.test(v)) continue
          if (v === '-n' && /^\d+$/.test(rest[i + 1]?.value ?? '')) {
            i++
            continue
          }
          return false
        } else if (!gitOperandOk(w, ctx)) return false
      }
      return true
    }
    case 'branch':
      return only([[], ['-a'], ['-r'], ['-v'], ['-vv'], ['--show-current']])
    case 'rev-parse':
      return rest.every((w) =>
        w.value.startsWith('-')
          ? ['--abbrev-ref', '--short', '--show-toplevel', '--git-dir'].includes(w.value)
          : gitOperandOk(w, ctx)
      )
    case 'ls-files':
      return rest.every((w) =>
        w.value.startsWith('-')
          ? ['-m', '-o', '--others', '--exclude-standard'].includes(w.value)
          : pathOk(w, ctx)
      )
    case 'remote':
      return only([[], ['-v']])
    case 'blame':
      for (let i = 0; i < rest.length; i++) {
        const v = rest[i].value
        if (v === '-L') {
          if (!/^[\d,+:-]+$/.test(rest[i + 1]?.value ?? '')) return false
          i++
        } else if (v === '--') continue
        else if (!gitOperandOk(rest[i], ctx)) return false
      }
      return true
    case 'describe':
      return rest.every((w) =>
        w.value.startsWith('-') ? ['--tags', '--always'].includes(w.value) : gitOperandOk(w, ctx)
      )
    case 'tag':
      return only([[], ['-l']])
    case 'stash':
    case 'worktree':
      return only([['list']])
    default:
      return false
  }
}

/** Whether a whole Bash command is proven to read only. */
export function provenReads(command: string, cwd?: string): boolean {
  return proven(command, startContext(cwd))
}

/** R2: `cd PATH` into the working folder is a proven step that moves the
 *  folder for the commands after it; any other `cd` (to `~`, `/tmp`, above
 *  the root, `-`, no argument) leaves the rest unproven. An operand that
 *  starts with `=` (zsh's `=word`, a program's path) is never proven. */
function proven(command: string, start: Context): boolean {
  const commands = proofParse(command)
  if (!commands) return false
  const ctx: Context = { base: start.base, dir: start.dir }
  for (const words of commands) {
    if (words.some((w) => w.value.startsWith('='))) return false
    if (words[0].value === 'cd' && !words[0].glob) {
      const args = words.slice(1).filter((w, i) => !(i === 0 && w.value === '--'))
      if (args.length !== 1 || args[0].glob || args[0].value.startsWith('-')) return false
      if (!pathOk(args[0], ctx)) return false
      ctx.dir = resolve(ctx.dir, args[0].value)
      continue
    }
    if (!provenCommand(words, ctx)) return false
  }
  return true
}

// ═════════════════════════════════════════════════════════════════════════
// 2. DETECTED upper levels: from the command's STRUCTURE only (R3)
// ═════════════════════════════════════════════════════════════════════════

/** What a reading gathers beside the level. */
interface Acc {
  maySecrets: boolean
  hints: Set<string>
  /** Program words run, for the rule across the whole request (a download
   *  run by a shell). */
  fetched: boolean
  /** A shell or interpreter that reads its code from its input. */
  stdinShell: boolean
  /** Files a download wrote. */
  downloaded: Set<string>
  /** Work left: a request too large to read is unknown past it. */
  budget: number
}
const newAcc = (): Acc => ({
  maySecrets: false,
  hints: new Set(),
  fetched: false,
  stdinShell: false,
  downloaded: new Set(),
  budget: 4000
})

/** The level of a shell command: proven reads, else what its structure
 *  shows, else unknown. `provable`: the shell is the one the proof knows. */
function scriptLevel(command: string, ctx: Context, provable: boolean, acc: Acc): RuleLevel {
  // An empty command: nothing the rules can read, and nothing a person
  // should be told is safe.
  if (!command.trim()) return 'outside'
  let level = detectScript(command, ctx, 0, acc)
  // A download run by a shell: piped or sourced into one, or saved and run.
  if (acc.fetched && acc.stdinShell) level = combine(level, 'irreversible')
  // The level: a proof wins over a detection (the note and hints stay).
  if (provable && proven(command, ctx)) return 'reads'
  return level
}

/** The level of a shell command, from the rules (exported for tests). */
export function commandLevel(command: string, cwd?: string): RuleLevel {
  return scriptLevel(command, startContext(cwd), true, newAcc())
}

interface Segment {
  /** Its words, quotes and backslashes taken off. */
  words: string[]
  /** Which words had a quoted part (not program text the shell splits). */
  quoted: boolean[]
  /** Its redirections: the operator and the word after it. */
  redirects: Array<{ op: string; target: string }>
  /** Command substitutions inside quotes or here-documents: they RUN, so
   *  they are read as structure. */
  code: string[]
  /** What it feeds a program on its input: here-documents and here-strings
   *  (code when the program is a shell). */
  stdin: string[]
  /** Text that is not structure (quoted strings, here-document bodies,
   *  `name=value` values, comments): read for hints only. */
  text: string[]
}

const newSegment = (): Segment => ({
  words: [],
  quoted: [],
  redirects: [],
  code: [],
  stdin: [],
  text: []
})

/** `$'…'`: the escapes a person cannot read (`\x72\x6d` is `rm`). */
function ansiC(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{1,4}|.)/g, (_m, e: string) => {
    if (/^[xu]/.test(e)) return String.fromCharCode(parseInt(e.slice(1), 16))
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8))
    return ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[e] ?? e
  })
}

/** The command substitutions in a string: `$(…)` (balanced) and backticks. */
function substitutions(s: string): string[] {
  const out: string[] = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '$' && s[i + 1] === '(') {
      let depth = 0
      let j = i + 1
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++
        else if (s[j] === ')' && --depth === 0) break
      }
      out.push(s.slice(i + 2, j).replace(/^\(|\)$/g, ''))
      i = j
    } else if (s[i] === '`') {
      const end = s.indexOf('`', i + 1)
      if (end < 0) break
      out.push(s.slice(i + 1, end))
      i = end
    }
  }
  return out
}

/**
 * The lenient lexer: never fails, splits a script into segments at every
 * place a command can start (`;`, `&`, `|`, newline, `(`, `)`, backtick,
 * `$(`, `<(`, a brace group), keeps substitutions inside quotes as code, and
 * everything else that is text as text.
 */
function lex(source: string): Segment[] {
  const s = source.replace(/\\\r?\n/g, '')
  const segments: Segment[] = []
  let seg = newSegment()
  let word = ''
  let started = false
  let wordQuoted = false
  let pending: string | null = null
  const heredocs: Array<{ delim: string; strip: boolean; quoted: boolean; owner: Segment }> = []
  let heredocNext: { strip: boolean } | null = null
  const endWord = (): void => {
    if (!started) return
    if (heredocNext) {
      heredocs.push({ delim: word, strip: heredocNext.strip, quoted: wordQuoted, owner: seg })
      heredocNext = null
    } else if (pending) {
      if (pending === '<<<') seg.stdin.push(word)
      else if (/^[<>]&$/.test(pending) && /^(?:\d+-?|-)$/.test(word)) {
        // a descriptor copied, not a file
      } else seg.redirects.push({ op: pending, target: word })
      pending = null
    } else {
      seg.words.push(word)
      seg.quoted.push(wordQuoted)
      if (word.includes('=')) seg.text.push(word.slice(word.indexOf('=') + 1))
      if (/[{},$]/.test(word)) seg.text.push(word.replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*|[{},]/g, ' '))
    }
    word = ''
    started = false
    wordQuoted = false
  }
  const endSegment = (): void => {
    endWord()
    pending = null
    heredocNext = null
    if (seg.words.length || seg.redirects.length || seg.code.length || seg.text.length)
      segments.push(seg)
    seg = newSegment()
  }
  const n = s.length
  let i = 0
  while (i < n) {
    const c = s[i]
    if (c === ' ' || c === '\t') {
      endWord()
      i++
      continue
    }
    if (c === '\n') {
      endSegment()
      i++
      // Here-document bodies: the lines up to each delimiter.
      for (const doc of heredocs.splice(0)) {
        const lines: string[] = []
        while (i < n) {
          let end = s.indexOf('\n', i)
          if (end < 0) end = n
          const line = s.slice(i, end)
          i = end + 1
          if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) break
          lines.push(line)
        }
        const body = lines.join('\n')
        doc.owner.stdin.push(body)
        doc.owner.text.push(body)
        if (!doc.quoted) doc.owner.code.push(...substitutions(body))
      }
      continue
    }
    if (c === "'" || (c === '$' && s[i + 1] === "'")) {
      const open = c === '$' ? i + 2 : i + 1
      let end = open
      if (c === '$') {
        while (end < n && s[end] !== "'") end += s[end] === '\\' ? 2 : 1
      } else end = s.indexOf("'", open)
      if (end < 0 || end > n) end = n
      const body = c === '$' ? ansiC(s.slice(open, end)) : s.slice(open, end)
      word += body
      started = true
      wordQuoted = true
      seg.text.push(body)
      i = end + 1
      continue
    }
    if (c === '"') {
      let body = ''
      let j = i + 1
      while (j < n && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < n) {
          body += s[j + 1]
          j += 2
        } else body += s[j++]
      }
      word += body
      started = true
      wordQuoted = true
      seg.text.push(body)
      seg.code.push(...substitutions(body))
      i = j + 1
      continue
    }
    if (c === '\\') {
      if (i + 1 < n) word += s[i + 1]
      started = true
      i += 2
      continue
    }
    if (c === '#' && !started) {
      let end = s.indexOf('\n', i)
      if (end < 0) end = n
      seg.text.push(s.slice(i + 1, end))
      i = end
      continue
    }
    if (c === '$' && s[i + 1] === '{') {
      const end = s.indexOf('}', i)
      const stop = end < 0 ? n : end + 1
      word += s.slice(i, stop)
      started = true
      i = stop
      continue
    }
    if (c === '$' && s[i + 1] === '(') {
      endSegment()
      i += 2
      continue
    }
    if ((c === '<' || c === '>') && s[i + 1] === '(') {
      endSegment()
      i += 2
      continue
    }
    if (c === '<' || c === '>' || (c === '&' && s[i + 1] === '>')) {
      if (started && /^\d+$/.test(word)) {
        word = ''
        started = false
      } else endWord()
      const op = /^(?:&>>|&>|<<<|<<-|<<|<>|<&|>>|>\||>&|>|<)/.exec(s.slice(i))?.[0] ?? c
      i += op.length
      if (op === '<<' || op === '<<-') heredocNext = { strip: op === '<<-' }
      else pending = op
      continue
    }
    if (';&|()`'.includes(c)) {
      endSegment()
      i++
      continue
    }
    if ((c === '{' && !started && (i + 1 >= n || /\s/.test(s[i + 1]))) || (c === '}' && !started)) {
      endSegment()
      i++
      continue
    }
    word += c
    started = true
    i++
  }
  endSegment()
  return segments
}

/** A word's program name: the last part of a path, lower-cased (macOS finds
 *  `RM` as `rm`). */
const baseName = (word: string): string => (word.split('/').pop() ?? word).toLowerCase()

const FETCH = new Set(['curl', 'wget', 'http', 'https', 'xh', 'aria2c'])
const NETWORK = new Set([
  ...FETCH,
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'socat',
  'mosh'
])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash'])
const INTERPRETERS = new Set([
  ...SHELLS,
  'node',
  'nodejs',
  'ruby',
  'perl',
  'php',
  'deno',
  'bun',
  'lua',
  'osascript',
  'pwsh'
])
const isInterpreter = (name: string): boolean =>
  INTERPRETERS.has(name) || /^python[\d.]*$/.test(name)
/** Command-line tools of a cloud. */
const CLOUD = new Set([
  'aws',
  'gcloud',
  'gsutil',
  'bq',
  'az',
  'doctl',
  'fly',
  'flyctl',
  'heroku',
  'vercel',
  'netlify',
  'wrangler',
  'firebase',
  'supabase',
  'railway',
  'pulumi'
])
/** Remote programs: outside whatever they are asked. */
const REMOTE = new Set([
  ...CLOUD,
  'gh',
  'glab',
  'docker',
  'podman',
  'kubectl',
  'helm',
  'terraform',
  'tofu',
  'brew',
  'pip',
  'pip3',
  'pipx',
  'npx',
  'bunx',
  'pnpx'
])
const DB_CLIENTS = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'mongo',
  'mongosh',
  'redis-cli',
  'clickhouse-client',
  'cqlsh',
  'sqlcmd',
  'duckdb'
])
/** Package managers' subcommands that reach the registry. */
const PACKAGE_NETWORK =
  /^(?:install|i|ci|add|update|upgrade|up|publish|unpublish|remove|uninstall|rm|dlx|create|outdated|audit|login|dedupe)$/
/** Programs that only read whatever they are given (a path outside the
 *  project they name is a read outside). */
const READERS = new Set([
  ...Object.keys(READ_LIST),
  'find',
  'jq',
  'less',
  'more',
  'bat',
  'diff',
  'xxd',
  'od',
  'hexdump',
  'strings',
  'shasum',
  'md5',
  'sha256sum'
])

/** Words worth pointing the model at when they appear in text the rules do
 *  not read as structure. */
const HINT_WORDS = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'truncate',
  'dd',
  'diskutil',
  'wipefs',
  'kill',
  'pkill',
  'killall',
  'sudo',
  'doas',
  'curl',
  'wget',
  'ssh',
  'scp',
  'rsync',
  'nc',
  'eval',
  'exec',
  'rmtree',
  'rmsync',
  'remove',
  'delete',
  'drop',
  'destroy',
  'terminate',
  'purge',
  'wipe',
  'force',
  'push',
  'publish',
  'chmod',
  'chown',
  'crontab',
  'system',
  'spawn',
  'popen',
  'writefile',
  'writefilesync'
])

function noticeText(text: string, acc: Acc): void {
  for (const token of text.split(/[^A-Za-z0-9_-]+/)) {
    const t = token.toLowerCase().replace(/^-+/, '')
    if (HINT_WORDS.has(t) || /^mkfs/.test(t)) acc.hints.add(t)
  }
  for (const m of text.matchAll(
    /\bgit\s+(push|reset|clean|checkout|restore|branch|filter-branch|reflog|gc|stash|rebase|worktree)\b/g
  ))
    acc.hints.add(`git ${m[1]}`)
  const governing = GOVERNING_NAME.exec(text)
  if (governing) acc.hints.add(governing[0].replace(/^[\s/'"=:]/, ''))
  if (/https?:\/\//.test(text)) acc.hints.add('a web address')
}

const isAssignment = (w: string): boolean => /^[A-Za-z_]\w*\+?=/.test(w)

function detectScript(source: string, start: Context, depth: number, acc: Acc): RuleLevel {
  if (depth > 8 || --acc.budget < 0) return 'unknown'
  const ctx: Context = { base: start.base, dir: start.dir }
  let level: RuleLevel = 'reads'
  for (const seg of lex(source)) {
    if (--acc.budget < 0) return combine(level, 'unknown')
    level = combine(level, segmentLevel(seg, ctx, depth, acc))
    for (const code of seg.code)
      if (code.trim()) level = combine(level, detectScript(code, ctx, depth + 1, acc))
    for (const t of seg.text) noticeText(t, acc)
    followCd(seg, ctx)
  }
  return level === 'reads' ? 'unknown' : level
}

/** `cd` inside a compound command: later relative paths resolve from there;
 *  a `cd` the rules cannot follow leaves the folder unknown. */
function followCd(seg: Segment, ctx: Context): void {
  const words = seg.words
  let k = 0
  while (k < words.length && isAssignment(words[k])) k++
  if (words[k] !== 'cd') return
  if (k > 0) {
    ctx.dir = null
    return
  }
  const args = words.slice(k + 1).filter((w) => w !== '--' && w !== '-P' && w !== '-L')
  if (args.length === 0) ctx.dir = '~/'
  else if (args.length === 1 && args[0] !== '-') ctx.dir = resolve(ctx.dir, args[0])
  else ctx.dir = null
}

/** The level of writing a word (a redirection, a write's target). */
function writeTarget(word: string, ctx: Context): RiskLevel {
  if (governingMention(word)) return 'irreversible'
  return writeLevel(resolve(ctx.dir, word), ctx)
}

/** The level of reading a word that names a path: outside when it leaves
 *  the project; nothing to say otherwise. */
function readTarget(word: string, ctx: Context): RuleLevel {
  if (!/^(?:\/|~|\$HOME\b|\$\{HOME\}|\.\.(?:\/|$))|\/\.\.(?:\/|$)/.test(word)) return 'unknown'
  const at = resolve(ctx.dir, word)
  return at === null || (!isDevice(at) && !inside(at, ctx.base)) ? 'outside' : 'unknown'
}

/** The machine's temporary folders. */
const scratch = (path: string | null): boolean =>
  path !== null && /^\/(?:private\/)?(?:tmp|var\/folders)\/./.test(path)

/** Values of these options are not operands (`xargs -n 1 rm`). */
const XARGS_VALUES = new Set(['-n', '-I', '-i', '-L', '-l', '-P', '-d', '-E', '-s', '-a', '-R'])

/** Past the wrappers the rules know, to the program they run: `sudo`,
 *  `doas`, `env`, `command`, `time`, `nice`, `nohup`, `timeout N`, `xargs`.
 *  `sudo`/`doas` themselves are hard to undo. */
function unwrap(
  words: string[],
  k: number,
  acc: Acc
): { at: number; level: RuleLevel; writes: string[] } {
  let i = k
  let level: RuleLevel = 'unknown'
  const writes: string[] = []
  for (;;) {
    const name = baseName(words[i] ?? '')
    if (name === 'sudo' || name === 'doas') {
      level = 'irreversible'
      i++
      while (i < words.length && words[i].startsWith('-')) {
        if (/^-[ugCDhpRrT]$/.test(words[i])) i++
        i++
      }
    } else if (name === 'env') {
      i++
      while (i < words.length && (words[i].startsWith('-') || isAssignment(words[i]))) {
        if (/^-[uCS]$/.test(words[i])) i++
        i++
      }
      if (i >= words.length) acc.maySecrets = true
    } else if (name === 'command' || name === 'builtin') {
      if (/^-[vV]$/.test(words[i + 1] ?? '')) return { at: words.length, level, writes }
      i++
      while (words[i] === '-p') i++
    } else if (name === 'time' || name === 'nohup') {
      i++
      while (i < words.length && words[i].startsWith('-')) {
        // `time -o FILE` writes FILE.
        if (/^(?:-o|--output)$/.test(words[i]) && words[i + 1] !== undefined) {
          writes.push(words[i + 1])
          i++
        } else if (words[i] === '-f') i++
        i++
      }
    } else if (name === 'nice') {
      i++
      while (i < words.length && words[i].startsWith('-')) {
        if (words[i] === '-n') i++
        i++
      }
    } else if (name === 'timeout') {
      i++
      while (i < words.length && words[i].startsWith('-')) {
        if (/^-[sk]$/.test(words[i])) i++
        i++
      }
      i++
    } else if (name === 'xargs') {
      i++
      while (i < words.length && words[i].startsWith('-')) {
        if (XARGS_VALUES.has(words[i])) i++
        i++
      }
    } else return { at: i, level, writes }
    if (i >= words.length) return { at: i, level, writes }
  }
}

function segmentLevel(seg: Segment, ctx: Context, depth: number, acc: Acc): RuleLevel {
  const words = seg.words
  let k = 0
  while (k < words.length && isAssignment(words[k])) k++
  let level: RuleLevel = 'reads'
  const raise = (l: RuleLevel): void => {
    level = combine(level, l)
  }

  // Redirections into a file: the project, outside, or what governs.
  for (const r of seg.redirects) {
    if (r.op.includes('>')) raise(writeTarget(r.target, ctx))
    if (secretWord(r.target)) acc.maySecrets = true
  }

  const { at, level: wrapped, writes } = unwrap(words, k, acc)
  raise(wrapped)
  for (const w of writes) raise(writeTarget(w, ctx))
  if (at >= words.length) return level
  const program = baseName(words[at])
  const args = words.slice(at + 1)
  noteSecrets(program, args, seg.quoted.slice(at + 1), ctx, acc)
  raise(programLevel(program, args, seg, ctx, depth, acc))
  return level
}

/** The secrets NOTE (R1): a secret-like name, a recursive search from the
 *  root or a dot-folder, an environment dump, `git remote -v`, a dotfile glob. */
function noteSecrets(
  program: string,
  args: string[],
  quoted: boolean[],
  ctx: Context,
  acc: Acc
): void {
  const search =
    program === 'grep' || program === 'egrep' || program === 'fgrep' || program === 'rg'
  let patternSkipped =
    !search || args.some((a) => a === '-e' || /^-[A-Za-z]*e$/.test(a) || a === '--files')
  const operands: string[] = []
  args.forEach((a, i) => {
    if (a.startsWith('-')) {
      const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : ''
      if (value && (secretWord(value) || dotGlob(value))) acc.maySecrets = true
      return
    }
    if (!patternSkipped) {
      patternSkipped = true
      return
    }
    operands.push(a)
    if (quoted[i] && /\s/.test(a)) return
    if (secretWord(a) || dotGlob(a) || (!quoted[i] && /[*?[]/.test(a) && globMaySecret(a)))
      acc.maySecrets = true
  })
  // A value of a short option (`rg -g secrets.*`).
  args.forEach((a, i) => {
    if (/^-[gI]$/.test(a) && args[i + 1] && (secretWord(args[i + 1]) || dotGlob(args[i + 1])))
      acc.maySecrets = true
  })
  const atRoot = (list: string[]): boolean =>
    list.length === 0 ||
    list.some((o) => {
      const r = resolve(ctx.dir, o)
      return r === ctx.base || r === null || /(?:^|\/)\.[^/.][^/]*/.test(o)
    })
  const flags = args.filter((a) => a.startsWith('-'))
  const recursiveGrep =
    (program === 'grep' || program === 'egrep' || program === 'fgrep') &&
    flags.some(
      (f) => /^-[A-Za-z]*[rR]/.test(f) || f === '--recursive' || f === '--dereference-recursive'
    )
  const hiddenRg =
    program === 'rg' &&
    flags.some((f) => f === '--hidden' || f === '-.' || /^-u{2,}$/.test(f) || f === '--no-ignore')
  if ((recursiveGrep || hiddenRg) && atRoot(operands)) acc.maySecrets = true
  if (
    program === 'find' &&
    atRoot(
      args
        .slice(
          0,
          Math.max(
            0,
            args.findIndex((a) => a.startsWith('-') || a === '!')
          )
        )
        .concat(args.findIndex((a) => a.startsWith('-')) < 0 ? args : [])
    )
  )
    acc.maySecrets = true
  if (program === 'tree' && flags.some((f) => /^-[A-Za-z]*a/.test(f)) && atRoot(operands))
    acc.maySecrets = true
  // Environment dumps.
  if (program === 'printenv') acc.maySecrets = true
  if (
    (program === 'set' || program === 'export' || program === 'declare' || program === 'typeset') &&
    (args.length === 0 || args.every((a) => /^-[px]+$/.test(a)))
  )
    acc.maySecrets = true
  if (program === 'jq' && args.some((a) => /\benv\b|\$ENV/.test(a))) acc.maySecrets = true
  if (program === 'ps' && args.some((a) => /^[a-z]*e[a-z]*$/.test(a))) acc.maySecrets = true
  if (program === 'security' && args.some((a) => /^find-/.test(a))) acc.maySecrets = true
  if (program === 'git') {
    const sub = args.find((a) => !a.startsWith('-'))
    if (sub === 'remote' && args.includes('-v')) acc.maySecrets = true
    if (sub === 'config' && args.some((a) => a === '-l' || a === '--list' || /url/.test(a)))
      acc.maySecrets = true
  }
}

/** A glob that can match a dotfile (`.e*`, `.*`, `src/.en?`). */
const dotGlob = (word: string): boolean =>
  word.split('/').some((c) => c.startsWith('.') && /[*?[]/.test(c))

function programLevel(
  program: string,
  args: string[],
  seg: Segment,
  ctx: Context,
  depth: number,
  acc: Acc
): RuleLevel {
  const flags = args.filter((a) => a.startsWith('-'))
  const operands = args.filter((a) => !a.startsWith('-'))
  const has = (...f: string[]): boolean => args.some((a) => f.includes(a))
  const shortHas = (letters: RegExp): boolean =>
    args.some((a) => /^-[A-Za-z]+$/.test(a) && letters.test(a.slice(1)))

  // Shells: `-c TEXT` is read as a command; code on their input too.
  if (SHELLS.has(program)) {
    const c = args.findIndex((a) => /^-[A-Za-z]*c[A-Za-z]*$/.test(a) || a === '--command')
    if (c >= 0 && args[c + 1] !== undefined) {
      const inner = newAcc()
      inner.budget = acc.budget
      let level = detectScript(args[c + 1], ctx, depth + 1, inner)
      acc.budget = inner.budget
      acc.maySecrets ||= inner.maySecrets
      for (const h of inner.hints) acc.hints.add(h)
      acc.fetched ||= inner.fetched
      // `bash -c "$(curl …)"`: it runs what was downloaded.
      if (inner.fetched && /\$\(|`/.test(args[c + 1])) level = combine(level, 'irreversible')
      if (inner.fetched && inner.stdinShell) level = combine(level, 'irreversible')
      return level
    }
    const script = operands.find((o) => o !== '-')
    if (script === undefined) {
      acc.stdinShell = true
      let level: RuleLevel = 'unknown'
      for (const body of seg.stdin) level = combine(level, detectScript(body, ctx, depth + 1, acc))
      return level
    }
    if (acc.downloaded.has(script)) return 'irreversible'
    return 'unknown'
  }
  if (program === 'source' || program === '.' || program === 'eval') {
    if (program === 'eval') return detectScript(args.join(' '), ctx, depth + 1, acc)
    if (!operands.length || acc.downloaded.has(operands[0])) acc.stdinShell = true
    return acc.downloaded.has(operands[0] ?? '') ? 'irreversible' : 'unknown'
  }
  if (isInterpreter(program)) {
    // Code from its input (`python3 -`, `node` alone) may be a download.
    if (!operands.length || operands[0] === '-')
      if (!args.some((a) => /^-[ce]$/.test(a))) acc.stdinShell = true
    if (operands[0] && acc.downloaded.has(operands[0])) return 'irreversible'
    return 'unknown'
  }

  // The network and remote programs.
  if (FETCH.has(program)) {
    acc.fetched = true
    let level: RuleLevel = 'outside'
    args.forEach((a, i) => {
      if (/^(?:-X|--request|--method)$/.test(a) && /^delete$/i.test(args[i + 1] ?? ''))
        level = 'irreversible'
      if (/^(?:-XDELETE|--request=DELETE|--method=DELETE)$/i.test(a)) level = 'irreversible'
      const out = /^(?:-o|-O|--output|--output-document)$/.test(a)
        ? args[i + 1]
        : /^--output(?:-document)?=(.+)$/.exec(a)?.[1]
      if (out && out !== '-') {
        acc.downloaded.add(out)
        level = combine(level, writeTarget(out, ctx)) as RiskLevel
      }
    })
    for (const r of seg.redirects) if (r.op.includes('>')) acc.downloaded.add(r.target)
    return level
  }
  if (program === 'ssh') {
    let i = 0
    while (i < args.length && args[i].startsWith('-')) {
      if (/^-[bcDEeFIiJLlmOoPpRSWw]$/.test(args[i])) i++
      i++
    }
    const remote = args.slice(i + 1)
    return remote.length
      ? combine('outside', detectScript(remote.join(' '), ctx, depth + 1, acc))
      : 'outside'
  }
  if (NETWORK.has(program)) return 'outside'
  if (program === 'rsync') {
    if (has('--delete') || flags.some((f) => /^--delete/.test(f) || f === '--remove-source-files'))
      return 'irreversible'
    if (operands.some((o) => /^[^/]*:/.test(o))) return 'outside'
    return operands.length ? writeTarget(operands[operands.length - 1], ctx) : 'unknown'
  }
  if (program === 'git') return gitLevel(args, ctx)
  if (program === 'gh') {
    const sub = operands.slice(0, 2)
    if (sub[1] === 'delete') return 'irreversible'
    if (
      sub[0] === 'api' &&
      args.some((a, i) => /^(?:-X|--method)$/.test(a) && /^delete$/i.test(args[i + 1] ?? ''))
    )
      return 'irreversible'
    if (args.some((a) => /^(?:-XDELETE|--method=DELETE)$/i.test(a))) return 'irreversible'
    return 'outside'
  }
  if (program === 'kubectl') return operands[0] === 'delete' ? 'irreversible' : 'outside'
  if (program === 'terraform' || program === 'tofu')
    return operands[0] === 'destroy' || (operands[0] === 'apply' && has('-destroy'))
      ? 'irreversible'
      : 'outside'
  if (program === 'docker' || program === 'podman') {
    const [a, b] = operands
    if (a === 'system' && b === 'prune') return 'irreversible'
    if (a === 'volume' && (b === 'rm' || b === 'prune')) return 'irreversible'
    if (
      (a === 'rm' || (a === 'container' && b === 'rm')) &&
      (has('-f', '--force') || shortHas(/f/))
    )
      return 'irreversible'
    return 'outside'
  }
  if (CLOUD.has(program)) {
    if (
      operands.some((o) => o.split('-').some((p) => /^(?:delete|destroy|terminate|rm|rb)$/.test(p)))
    )
      return 'irreversible'
    return 'outside'
  }
  if (REMOTE.has(program)) return 'outside'
  if (program === 'npm' || program === 'pnpm' || program === 'yarn' || program === 'bun') {
    const sub = operands[0]
    if (program === 'yarn' && sub === undefined) return 'outside'
    if (program === 'bun' && sub === 'x') return 'outside'
    return sub !== undefined && PACKAGE_NETWORK.test(sub) ? 'outside' : 'unknown'
  }
  if (DB_CLIENTS.has(program))
    return args.some((a) => SQL_FINAL.test(a)) ? 'irreversible' : 'unknown'

  // What deletes, wipes or overwrites for good.
  if (
    (program === 'rm' || program === 'rmdir' || program === 'unlink') &&
    operands.length &&
    operands.every((o) => scratch(resolve(ctx.dir, o)))
  )
    // Scratch files of the machine's temporary folder: outside, not lost work.
    return 'outside'
  if (program === 'rm') {
    if (flags.some((f) => /^-[A-Za-z]*[rRf]/.test(f) || f === '--recursive' || f === '--force'))
      return 'irreversible'
    // No operand: they come on its input (`… | xargs rm`), unplaceable.
    if (!operands.length) return 'irreversible'
    let level: RuleLevel = 'project'
    for (const o of operands) {
      const w = writeTarget(o, ctx)
      level = combine(level, w === 'project' ? 'project' : 'irreversible')
    }
    return level
  }
  if (program === 'rmdir' || program === 'unlink') {
    let level: RuleLevel = 'unknown'
    for (const o of operands) {
      const w = writeTarget(o, ctx)
      level = combine(level, w === 'project' ? 'project' : 'irreversible')
    }
    return level
  }
  if (program === 'find') {
    if (args.includes('-delete')) return 'irreversible'
    let level: RuleLevel = 'unknown'
    args.forEach((a, i) => {
      if (/^-(?:fprint0?|fprintf|fls)$/.test(a) && args[i + 1])
        level = combine(level, writeTarget(args[i + 1], ctx))
    })
    const exec = args.findIndex((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a))
    if (exec >= 0) {
      const end = args.findIndex((a, i) => i > exec && (a === ';' || a === '+'))
      const inner = args
        .slice(exec + 1, end < 0 ? args.length : end)
        .map((a) => (a === '{}' ? './x' : a))
      level = combine(
        level,
        segmentLevel(
          { ...newSegment(), words: inner, quoted: inner.map(() => false) },
          ctx,
          depth + 1,
          acc
        )
      )
    }
    for (const o of args) level = combine(level, readTarget(o, ctx))
    return level
  }
  if (program === 'dd') return args.some((a) => a.startsWith('of=')) ? 'irreversible' : 'unknown'
  if (/^mkfs/.test(program) || /^newfs/.test(program)) return 'irreversible'
  if (program === 'shred' || program === 'truncate' || program === 'wipefs') return 'irreversible'
  if (program === 'diskutil')
    return operands.some((o) => /^(?:erase|zero|secureErase|reformat|partitionDisk)/i.test(o))
      ? 'irreversible'
      : 'unknown'
  // crontab with anything but a listing installs or removes the table.
  if (program === 'crontab') return args.some((a) => a !== '-l') ? 'irreversible' : 'unknown'

  // What changes files of the project.
  if (program === 'mkdir' || program === 'touch' || program === 'tee') {
    let level: RuleLevel = program === 'tee' ? 'reads' : 'unknown'
    for (const o of operands) level = combine(level, writeTarget(o, ctx))
    return level
  }
  if (program === 'cp' || program === 'mv' || program === 'ln' || program === 'install') {
    if (operands.length < 2) return 'unknown'
    let level: RuleLevel = writeTarget(operands[operands.length - 1], ctx)
    for (const o of operands.slice(0, -1)) {
      level = combine(level, readTarget(o, ctx))
      // A move takes the file away from where it was.
      if (program === 'mv') level = combine(level, writeTarget(o, ctx))
    }
    return level
  }
  if (program === 'sed') {
    if (!flags.some((f) => /^-[A-Za-z]*i/.test(f) || /^--in-place/.test(f))) return 'unknown'
    const files = operands.slice(args.some((a) => a === '-e' || a === '-f') ? 0 : 1)
    let level: RuleLevel = 'project'
    for (const f of files) level = combine(level, writeTarget(f, ctx))
    return level
  }
  if (program === 'chmod' || program === 'chown' || program === 'chgrp') {
    let level: RuleLevel = 'unknown'
    for (const o of operands.slice(1)) {
      const w = writeTarget(o, ctx)
      level = combine(
        level,
        w === 'project' ? 'project' : flags.some((f) => /R/.test(f)) ? 'irreversible' : w
      )
    }
    return level
  }

  // A reader of a path outside the project reaches outside.
  if (READERS.has(program)) {
    let level: RuleLevel = 'unknown'
    for (const o of args) {
      const value = o.startsWith('-') && o.includes('=') ? o.slice(o.indexOf('=') + 1) : o
      level = combine(level, readTarget(value, ctx))
    }
    // An option that writes the file it names (`sort -o`, `tree -o`).
    args.forEach((a, i) => {
      if (/^(?:-o|--output)$/.test(a) && args[i + 1] && program !== 'find')
        level = combine(level, writeTarget(args[i + 1], ctx))
      const eq = /^--output=(.+)$/.exec(a)
      if (eq) level = combine(level, writeTarget(eq[1], ctx))
    })
    if (program === 'uniq' && operands.length >= 2)
      level = combine(level, writeTarget(operands[1], ctx))
    return level
  }
  // Anything else: unknown, the model reads it.
  return 'unknown'
}

// ── git ──

/** What a git command does, from what follows the word `git`. */
function gitLevel(args: string[], ctx: Context): RuleLevel {
  let i = 0
  while (i < args.length && args[i].startsWith('-')) {
    if (/^-[cC]$/.test(args[i]) || /^--(?:git-dir|work-tree|namespace|exec-path)$/.test(args[i]))
      i++
    i++
  }
  const sub = args[i]
  if (sub === undefined) return 'unknown'
  const rest = args.slice(i + 1)
  const has = (...flags: string[]): boolean => rest.some((a) => flags.includes(a))
  const positional = rest.filter((a) => !a.startsWith('-'))
  const output = (): RuleLevel => {
    let level: RuleLevel = 'unknown'
    rest.forEach((a, j) => {
      const out =
        a === '--output' ? rest[j + 1] : a.startsWith('--output=') ? a.slice(9) : undefined
      if (out !== undefined) level = combine(level, writeTarget(out, ctx))
    })
    return level
  }
  switch (sub) {
    case 'push':
      if (
        has('-f', '--force', '-d', '--delete', '--mirror', '--prune') ||
        rest.some((a) =>
          /^--force-with-lease|^--force-if-includes|^-[A-Za-z]*f[A-Za-z]*$/.test(a)
        ) ||
        positional.some((p) => p.startsWith('+') || p.startsWith(':'))
      )
        return 'irreversible'
      return 'outside'
    case 'fetch':
    case 'pull':
    case 'clone':
    case 'ls-remote':
      return 'outside'
    case 'clean':
    case 'filter-branch':
      return 'irreversible'
    case 'reset':
      return has('--hard') ? 'irreversible' : 'project'
    case 'restore':
      return positional.length ? 'irreversible' : 'unknown'
    case 'checkout': {
      if (has('--', '-f', '--force', '.')) return 'irreversible'
      const ops: string[] = []
      for (let j = 0; j < rest.length; j++) {
        if (['-b', '-B', '--orphan', '-t', '--track'].includes(rest[j])) j++
        else if (!rest[j].startsWith('-')) ops.push(rest[j])
      }
      return ops.length >= 2 ? 'irreversible' : 'project'
    }
    case 'switch':
      return has('-f', '--force', '--discard-changes') ? 'irreversible' : 'project'
    case 'branch':
      if (
        has('-D') ||
        rest.some((a) => /^-[A-Za-z]*D/.test(a)) ||
        (has('--delete') && has('--force'))
      )
        return 'irreversible'
      return 'unknown'
    case 'stash':
      return rest[0] === 'drop' || rest[0] === 'clear'
        ? 'irreversible'
        : rest[0] === 'list' || rest[0] === 'show'
          ? 'unknown'
          : 'project'
    case 'reflog':
      return rest[0] === 'expire' ? 'irreversible' : 'unknown'
    case 'gc':
      return rest.some((a) => /^--prune=now$/.test(a)) ? 'irreversible' : 'unknown'
    case 'worktree':
      return rest[0] === 'remove' || rest[0] === 'prune' ? 'irreversible' : 'unknown'
    case 'config':
      // Setting a key writes .git/config (or ~/.gitconfig), which governs
      // what git runs.
      if (has('--get', '--get-all', '--get-regexp', '-l', '--list') || positional.length < 2)
        return 'unknown'
      return 'irreversible'
    case 'add':
    case 'commit':
    case 'merge':
    case 'rebase':
      return 'project'
    default:
      return output()
  }
}

/** Plain words for the tools Clave knows, for the explainer to read beside
 *  the request (the tool's own description). */
export const TOOL_DESCRIPTIONS: Record<string, string> = {
  Bash: 'Runs a command in a terminal on the computer.',
  PowerShell: 'Runs a command in a terminal on the computer.',
  Read: 'Reads a file.',
  Glob: 'Lists files whose names match a pattern.',
  Grep: 'Searches inside files for some text.',
  LS: 'Lists the files of a folder.',
  Edit: 'Changes part of a file.',
  MultiEdit: 'Changes several parts of a file.',
  Write: 'Creates a file or replaces its whole content.',
  NotebookEdit: 'Changes a cell of a notebook file.',
  WebFetch: 'Downloads a web page and reads it.',
  WebSearch: 'Searches the web.',
  Skill: 'Loads a set of instructions the agent was given.',
  ExitPlanMode: 'Ends the planning step: the agent then starts working on the plan.',
  Agent: 'Starts a helper agent that works on part of the task.',
  Task: 'Starts a helper agent that works on part of the task.',
  'item/commandExecution/requestApproval': 'Runs a command in a terminal on the computer.',
  execCommandApproval: 'Runs a command in a terminal on the computer.',
  'item/fileChange/requestApproval': 'Changes files.',
  applyPatchApproval: 'Changes files.',
  'item/permissions/requestApproval': 'Asks for extra rights for the rest of the turn.'
}

export function toolDescription(toolName: string | undefined): string {
  if (!toolName) return ''
  if (TOOL_DESCRIPTIONS[toolName]) return TOOL_DESCRIPTIONS[toolName]
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (mcp) return `A tool named "${mcp[2]}" of the connected service "${mcp[1]}".`
  return ''
}
