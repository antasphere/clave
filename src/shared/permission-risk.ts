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

/** Words in a tool's name that say it removes something for good. */
const FINAL_WORDS = new Set([
  'delete',
  'remove',
  'drop',
  'destroy',
  'purge',
  'erase',
  'wipe',
  'truncate',
  'revoke',
  'cancel',
  'archive',
  'transfer',
  'pay',
  'refund',
  'merge',
  'deploy',
  'release',
  'publish',
  'reset',
  'overwrite',
  'kill',
  'terminate',
  'flush',
  'unlink',
  'rm'
])
/** Words that say it sends, posts or runs something: once done, done. */
const SEND_WORDS = new Set([
  'send',
  'post',
  'reply',
  'message',
  'email',
  'mail',
  'tweet',
  'execute',
  'exec',
  'run',
  'sql',
  'invoke',
  'trigger',
  'dispatch',
  'broadcast',
  'notify',
  'push',
  'upload',
  'share'
])

/** A tool name's words: `mcp__slack__chat_postMessage` → mcp, slack, chat, post, message. */
function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
}

const SQL_CHANGE =
  /\b(?:drop|delete|truncate|update|alter|insert|replace|grant|revoke|merge|upsert)\b|\b(?:dropDatabase|deleteMany|deleteOne|findOneAndDelete|remove)\s*\(/i

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** Every string inside a tool's input, however deep. */
function inputStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) inputStrings(v, out, depth + 1)
  else if (value && typeof value === 'object')
    for (const v of Object.values(value)) inputStrings(v, out, depth + 1)
  return out
}

function mcpLevel(name: string, input: unknown, ctx: Context): RiskLevel {
  const words = nameWords(name.split('__').slice(2).join('__') || name)
  if (words.some((w) => FINAL_WORDS.has(w) || SEND_WORDS.has(w))) return 'irreversible'
  const body = safeJson(input)
  if (SQL_CHANGE.test(body) && /\b(?:sql|query|statement)\b/i.test(body + ' ' + name))
    return 'irreversible'
  // A path to what governs startup or permissions, handed to a tool the
  // rules cannot read: it may write there.
  for (const s of inputStrings(input))
    if (governingMention(s) || GOVERNING_FILES.some((re) => re.test(resolve(ctx.dir, s) ?? '')))
      return 'irreversible'
  return 'outside'
}

/** The level of one permission request, from the rules alone. */
export function riskFloor({ toolName, input, cwd }: RiskInput): RuleLevel {
  const name = toolName ?? ''
  const p = record(input)
  const ctx = startContext(cwd)
  if (READ_TOOLS.has(name)) return readToolLevel(name, p, ctx)
  if (INERT_TOOLS.has(name)) return 'reads'
  if (WRITE_TOOLS.has(name)) {
    const path = text(p.file_path) || text(p.notebook_path)
    return path ? writeLevel(resolve(ctx.dir, path), ctx) : 'outside'
  }
  if (name === 'Bash') return scriptLevel(text(p.command), ctx, true)
  // PowerShell is not the shell the proof knows: detected, never proven.
  if (name === 'PowerShell') return scriptLevel(text(p.command), ctx, false)
  if (CODEX_COMMAND.has(name)) {
    const at = text(p.cwd) ? startContext(cwd, text(p.cwd)) : ctx
    const argv = strings(p.command)
    return scriptLevel(argv.length ? argv.map(shellQuote).join(' ') : text(p.command), at, true)
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
  if (name.startsWith('mcp__')) return mcpLevel(name, input, ctx)
  // WebFetch, WebSearch, a skill, a subagent, a tool the rules do not know:
  // the network, or code and instructions they cannot read, at least outside.
  return 'outside'
}

/** A Codex argv element as one shell word. */
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_\-.,/:=@%+]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Read, Glob, Grep, LS: reads only when every path and glob passes the
 *  path rule; outside when one names a secret or leaves the project. */
function readToolLevel(name: string, p: Record<string, unknown>, ctx: Context): RuleLevel {
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
    if (secretWord(item.value)) level = combine(level, 'outside')
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
  /^\/(?:etc|private|Library|System|usr|bin|sbin|var\/root|Applications)(?:\/|$)/i,
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

/** A secret's name (path rule e): matched against each component. */
const SECRET_NAME =
  /^(?:\.env.*|.*\.(?:pem|key|p12|pfx|keystore|jks|kdbx)|id_(?:rsa|dsa|ecdsa|ed25519).*|\.npmrc|\.netrc|\.pgpass|\.pypirc|\.git-credentials|\.htpasswd|credentials.*)$/i
const SECRET_DIR = /^\.(?:ssh|aws|gnupg|kube|docker|config|azure|gcloud)$/i
/** What a glob component, read literally, says it is after. */
const SECRET_MARK =
  /\.env|\.pem|\.key|\.p12|\.pfx|id_rsa|id_dsa|id_ecdsa|id_ed25519|npmrc|netrc|credential|\.ssh|\.aws|\.gnupg|\.kube|\.docker|keychain/i
/** Names a glob is tried against before a proof: if it could match one, it
 *  could read a secret. A component not starting with `.` is not tried on
 *  dotfiles (a glob's `*` never matches a leading dot). */
const SECRET_SAMPLES = [
  'server.pem',
  'server.key',
  'cert.p12',
  'cert.pfx',
  'id_rsa',
  'id_ed25519',
  'credentials',
  'credentials.json'
]
const DOT_SAMPLES = ['.env', '.env.local', '.npmrc', '.netrc', '.ssh', '.aws', '.config']

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
        const body = component
          .slice(i + 1, end)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')
        out += `[${body}]`
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

const isSecretComponent = (c: string): boolean => SECRET_NAME.test(c) || SECRET_DIR.test(c)

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
 * Path rule (e): inside the working folder (a relative path never climbing
 * above it, an absolute one only inside it, no `~`), no secret's name on any
 * component, and no glob that could reach a dotfile, a secret, or (unless
 * `leadingGlobOk`) expand into a word starting with `-`.
 */
function pathOk(word: PWord, ctx: Context, leadingGlobOk = false): boolean {
  const v = word.value
  if (!v || v.startsWith('~') || v.includes('\u0000')) return false
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
  if (!resolved || !inside(resolved, ctx.base)) return false
  for (const component of v.split('/')) {
    if (!component) continue
    if (isSecretComponent(component)) return false
    if (word.glob && (GLOB_CHARS.test(component) || /[{}]/.test(component))) {
      if (component.startsWith('.')) return false
      if (component === '**') continue
      const re = globRe(component)
      if (SECRET_SAMPLES.some((s) => re.test(s))) return false
      if (DOT_SAMPLES.some((s) => re.test(s))) return false
    }
  }
  return true
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

/** The programs that only read whatever their options (a governing file they
 *  name is read, not written): the READ LIST, find, jq. Not `command`, which
 *  runs whatever follows it. */
const READERS = new Set([...Object.keys(READ_LIST), 'find', 'jq'])

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

/** A git operand: a revision or a path, never above the project, never a
 *  secret (`HEAD:.env` included). */
function gitOperandOk(w: PWord, ctx: Context): boolean {
  const v = w.value
  if (!v || w.glob || v.startsWith('-') || v.startsWith('~')) return false
  if (v.startsWith('/')) return pathOk(w, ctx)
  if (v.split(/[/:]/).includes('..')) return false
  return !v.split(/[/:]/).some(isSecretComponent)
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

function proven(command: string, ctx: Context): boolean {
  const commands = proofParse(command)
  if (!commands) return false
  return commands.every((words) => provenCommand(words, ctx))
}

// ═════════════════════════════════════════════════════════════════════════
// 2. DETECTED upper levels: lexical, recursive, erring upward
// ═════════════════════════════════════════════════════════════════════════

/** The level of a shell command: proven reads, else what is detected, else
 *  unknown. `provable`: the shell is the one the proof knows. */
function scriptLevel(command: string, ctx: Context, provable: boolean): RuleLevel {
  // An empty command: nothing the rules can read, and nothing a person
  // should be told is safe.
  if (!command.trim()) return 'outside'
  if (provable && proven(command, ctx)) return 'reads'
  const state: DetectState = { names: new Set(), budget: 4000 }
  let level = detectScript(command, ctx, false, 0, state)
  // Downloaded code into a shell: a fetch and a shell, interpreter, `source`
  // or `eval` anywhere in the same request.
  if ([...state.names].some((n) => FETCH.has(n)) && [...state.names].some((n) => RUNS_CODE.has(n)))
    level = combine(level, 'irreversible')
  return level
}

/** The level of a shell command, from the rules (exported for tests). */
export function commandLevel(command: string, cwd?: string): RuleLevel {
  return scriptLevel(command, startContext(cwd), true)
}

interface Segment {
  /** Its words, quotes and backslashes taken off. */
  words: string[]
  /** Its redirections: the operator and the word after it. */
  redirects: Array<{ op: string; target: string }>
  /** Text it carries that may be code: quoted strings, here-document bodies,
   *  `name=value` values, brace lists, comments. */
  subs: string[]
}

interface DetectState {
  /** Every program-like name seen, for the rules across the whole request. */
  names: Set<string>
  /** Work left: a request too large to read is outside at least. */
  budget: number
}

const newSegment = (): Segment => ({ words: [], redirects: [], subs: [] })

/** `$'…'`: the escapes a person cannot read (`\x72\x6d` is `rm`). */
function ansiC(body: string): string {
  return body.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|u[0-9a-fA-F]{1,4}|.)/g, (_m, e: string) => {
    if (/^x/.test(e)) return String.fromCharCode(parseInt(e.slice(1), 16))
    if (/^u/.test(e)) return String.fromCharCode(parseInt(e.slice(1), 16))
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8))
    return ({ n: '\n', t: '\t', r: '\r' } as Record<string, string>)[e] ?? e
  })
}

/**
 * The lenient lexer: never fails, splits a script into segments at every
 * place a command can start (`;`, `&`, `|`, newline, `(`, `)`, backtick,
 * `$(`, `<(`, a brace group), and keeps everything that may be code as text
 * to scan again.
 */
function lex(source: string): Segment[] {
  const s = source.replace(/\\\r?\n/g, '')
  const segments: Segment[] = []
  let seg = newSegment()
  let word = ''
  let started = false
  let wordQuoted = false
  let pending: string | null = null
  const heredocs: Array<{ delim: string; strip: boolean; owner: Segment }> = []
  let heredocNext: { strip: boolean } | null = null
  const endWord = (): void => {
    if (!started) return
    if (heredocNext) {
      heredocs.push({ delim: word, strip: heredocNext.strip, owner: seg })
      heredocNext = null
    } else if (pending) {
      if (pending === '<<<') seg.subs.push(word)
      else if (/^[<>]&$/.test(pending) && /^(?:\d+-?|-)$/.test(word)) {
        // a descriptor copied, not a file
      } else seg.redirects.push({ op: pending, target: word })
      pending = null
    } else seg.words.push(word)
    // Text inside a word that may be code; pushed only when it differs, so
    // the recursion always shrinks.
    const extra = [
      word.includes('=') ? word.slice(word.indexOf('=') + 1) : '',
      word.replace(/[{},]/g, ' '),
      word.replace(/\$\{[^}]*\}|\$[A-Za-z_]\w*/g, ' ')
    ]
    // A word built from several quoted parts (`'a '\''b'`) is read whole too.
    if (wordQuoted) extra.push(word)
    for (const e of extra) if (e && (e !== word || wordQuoted)) seg.subs.push(e)
    word = ''
    started = false
    wordQuoted = false
  }
  const endSegment = (): void => {
    endWord()
    pending = null
    heredocNext = null
    seg.subs = [...new Set(seg.subs)]
    if (seg.words.length || seg.redirects.length || seg.subs.length) segments.push(seg)
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
        doc.owner.subs.push(lines.join('\n'))
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
      seg.subs.push(body)
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
      seg.subs.push(body)
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
      seg.subs.push(s.slice(i + 1, end))
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
  // A here-document never closed: its body is the rest, already lexed.
  return segments
}

/** A word's program name: the last part of a path, lower-cased (macOS finds
 *  `RM` as `rm`), a leading `!` or backslash dropped. */
const baseName = (word: string): string =>
  (word.split('/').pop() ?? word).replace(/^[^A-Za-z0-9_./-]+/, '').toLowerCase()

/** Programs whose name alone, anywhere, means "Hard to undo". */
const DESTROY = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'srm',
  'truncate',
  'dd',
  'wipefs',
  'diskutil',
  'fdisk',
  'parted',
  'kill',
  'pkill',
  'killall',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'sudo',
  'doas',
  'su',
  'pkexec',
  'rimraf',
  'del-cli'
])
/** `asProgram`: the word stands where a program does, so a glob in it
 *  (`/bin/r? -rf x`) is tried against the list too. */
function destroyWord(word: string, asProgram = false): boolean {
  const b = baseName(word)
  if (DESTROY.has(b) || /^(?:mkfs|newfs)/.test(b)) return true
  if (asProgram && GLOB_CHARS.test(b)) {
    const re = globRe(b)
    return [...DESTROY].some((d) => re.test(d)) || re.test('mkfs')
  }
  return false
}

/** Options that remove what they name. */
const DELETE_FLAG = /^(?:--?delete(?:[-=].*)?|--remove-source-files|--delete-after)$/

const FETCH = new Set(['curl', 'wget', 'http', 'https', 'xh', 'fetch', 'aria2c', 'httpie'])
const NETWORK = new Set([
  ...FETCH,
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'rsync',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'mosh',
  'open',
  'xdg-open'
])
/** Network names that are also ordinary words: counted only as a program. */
const NETWORK_AMBIGUOUS = new Set(['open', 'fetch', 'http', 'https'])

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh', 'ash'])
const INTERPRETERS = new Set([
  ...SHELLS,
  'node',
  'nodejs',
  'ruby',
  'irb',
  'perl',
  'php',
  'deno',
  'bun',
  'lua',
  'luajit',
  'rscript',
  'osascript',
  'awk',
  'gawk',
  'mawk',
  'nawk',
  'tclsh',
  'pwsh',
  'powershell',
  'swift',
  'java',
  'jshell',
  'groovy',
  'make',
  'gmake',
  'just',
  'rake',
  'tsx',
  'ts-node',
  'vite-node',
  'busybox'
])
const isInterpreter = (name: string): boolean =>
  INTERPRETERS.has(name) || /^python[\d.]*$/.test(name) || /^pypy[\d.]*$/.test(name)
/** What runs code it is handed (for the download-into-a-shell rule). */
const RUNS_CODE = new Set([...INTERPRETERS, 'python', 'python3', 'source', 'eval', 'exec'])

/** Command-line tools that act on a remote service or the system. */
const REMOTE = new Set([
  'docker',
  'podman',
  'kubectl',
  'helm',
  'terraform',
  'tofu',
  'pulumi',
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
  'gh',
  'glab',
  'hub',
  'ansible',
  'ansible-playbook',
  'serverless',
  'sls',
  'cdk',
  'eksctl',
  'oc',
  'nomad',
  'vault',
  'consul',
  'stripe',
  's3cmd',
  'rclone',
  'minikube',
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'redis-cli',
  'mongo',
  'mongosh',
  'clickhouse-client',
  'cqlsh',
  'sqlcmd',
  'duckdb',
  'launchctl',
  'defaults',
  'systemctl',
  'service',
  'security',
  'dscl',
  'networksetup',
  'scutil',
  'pmset',
  'csrutil',
  'spctl',
  'tmutil',
  'nvram',
  'crontab',
  'brew',
  'port',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'pacman',
  'snap',
  'pip',
  'pip3',
  'pipx',
  'gem',
  'cargo',
  'go',
  'npm',
  'pnpm',
  'yarn',
  'bun',
  'npx',
  'bunx',
  'uv',
  'uvx',
  'poetry',
  'composer',
  'mvn',
  'gradle'
])
/** Remote names that are also ordinary words: in quoted text, counted only
 *  as the program. */
const REMOTE_AMBIGUOUS = new Set([
  'go',
  'hub',
  'service',
  'port',
  'security',
  'defaults',
  'snap',
  'vault',
  'consul',
  'gem',
  'oc',
  'bun',
  'stripe',
  'apt',
  'fly',
  'render'
])
/** Verbs that, beside a remote or system tool, remove or end something. */
const VERBS = new Set([
  'delete',
  'destroy',
  'terminate',
  'purge',
  'prune',
  'wipe',
  'erase',
  'remove',
  'uninstall',
  'rm',
  'rmi',
  'drop',
  'flushall',
  'flushdb',
  'publish',
  'unpublish',
  'deprecate',
  'merge',
  'transfer',
  'archive',
  'stop',
  'disable',
  'mask',
  'unload',
  'bootout'
])
const SQL_CLIENTS = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'mongo',
  'mongosh',
  'clickhouse-client',
  'cqlsh',
  'sqlcmd',
  'duckdb'
])

/** Code text that removes files. */
const CODE_DELETES =
  /unlink|remove|rmtree|rmsync|rmdir|\.delete\b|delete\s*\(|empty\s+trash|truncate/i

/** Variables that steer what a program runs or reads. */
const STEERING =
  /^(?:PATH|LD_\w+|DYLD_\w+|GIT_\w+|\w*PAGER|\w*EDITOR|LESS\w*|BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|NODE_OPTIONS|NODE_PATH|PYTHON\w*|PERL5\w*|RUBY\w*|IFS|CDPATH|HOME|SHELL|\w*CONFIG\w*|\w*_OPTS|\w*_OPTIONS)$/

/** Programs the detection knows, so it does not call them unknown. */
const KNOWN = new Set([
  ...Object.keys(READ_LIST),
  'find',
  'jq',
  'git',
  'cd',
  'set',
  'false',
  'test',
  '[',
  'sleep',
  'exit',
  'mkdir',
  'touch',
  'cp',
  'mv',
  'ln',
  'tee',
  'sed',
  'chmod',
  'chown',
  'install'
])
/** Programs that write the files they are given. */
const WRITERS = new Set(['mkdir', 'touch', 'cp', 'mv', 'ln', 'tee', 'install'])
/** Options whose value is a file the program writes. */
const WRITE_OPTION =
  /^(?:-o|--output|--out|--output-file|--outfile|--log-file|-fprint0?|-fprintf|-fls)$/
const WRITE_OPTION_EQ = /^(?:--output|--out|--output-file|--outfile|--log-file)=(.+)$/
/** Long options that run another program. */
const RUN_OPTION =
  /^--(?:exec|exec-batch|execdir|pre|hostname-bin|pager|to-command|use-compress-program|compress-program|checkpoint-action|command|editor|shell|filter|rsh|ssh|run|eval)(?:=|$)/

const isAssignment = (w: string): boolean => /^[A-Za-z_]\w*\+?=/.test(w)

function detectScript(
  source: string,
  start: Context,
  quoted: boolean,
  depth: number,
  state: DetectState
): RuleLevel {
  if (depth > 8 || --state.budget < 0) return 'outside'
  const ctx: Context = { base: start.base, dir: start.dir }
  let level: RuleLevel = 'unknown'
  for (const seg of lex(source)) {
    if (--state.budget < 0) return combine(level, 'outside')
    level = combine(level, segmentLevel(seg, ctx, quoted, state))
    for (const sub of seg.subs)
      if (sub.trim()) level = combine(level, detectScript(sub, ctx, true, depth + 1, state))
    followCd(seg, ctx)
  }
  return level
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

function segmentLevel(seg: Segment, ctx: Context, quoted: boolean, state: DetectState): RuleLevel {
  const words = seg.words
  let k = 0
  while (k < words.length && isAssignment(words[k])) k++
  const assigns = words.slice(0, k)
  const programWord = words[k]
  const program = programWord === undefined ? undefined : baseName(programWord)
  const names = words.map(baseName)
  for (const name of names) state.names.add(name)
  if (program === '.') state.names.add('source')
  let level: RuleLevel = 'unknown'
  const raise = (l: RuleLevel): void => {
    level = combine(level, l)
  }

  // Hard to undo: a destructive program's name, or an option that deletes.
  if (words.some((w, i) => destroyWord(w, i === k)) || words.some((w) => DELETE_FLAG.test(w)))
    return 'irreversible'

  // Variables that steer a program.
  if (assigns.some((a) => STEERING.test(a.slice(0, a.search(/\+?=/))))) raise('outside')

  // git, wherever it stands.
  names.forEach((name, i) => {
    if (name === 'git') raise(gitLevel(words.slice(i + 1), ctx))
  })

  // Remote services and the system.
  const tokens = words.flatMap((w) => w.split(/[^A-Za-z0-9_.+-]+/)).filter(Boolean)
  const lower = tokens.map((t) => t.toLowerCase())
  const counts = (n: string, i: number, ambiguous: Set<string>): boolean =>
    !ambiguous.has(n) || i === k || (!quoted && !NETWORK_AMBIGUOUS.has(n))
  if (names.some((n, i) => REMOTE.has(n) && counts(n, i, quoted ? REMOTE_AMBIGUOUS : new Set()))) {
    raise('outside')
    if (lower.some((t) => !t.startsWith('-') && t.split('-').some((part) => VERBS.has(part))))
      raise('irreversible')
    if (
      names.includes('gh') &&
      (tokens.some((t) => /delete|merge|transfer|archive/i.test(t)) ||
        words.some((w) => /^--(?:visibility|public)\b/.test(w)))
    )
      raise('irreversible')
    if (
      /\b(?:npm|pnpm|yarn)\b/.test(names.join(' ')) &&
      /\bconfig\s+(?:set|delete|rm|edit)\b/.test(words.join(' '))
    )
      raise('irreversible')
    if (
      names.some((n) => SQL_CLIENTS.has(n)) &&
      /\b(?:drop|delete|truncate)\b/i.test(words.join(' '))
    )
      raise('irreversible')
  }
  if (lower.some((t) => t === 'flushall' || t === 'flushdb')) raise('irreversible')
  // An HTTP DELETE.
  if (
    names.some((n) => FETCH.has(n) || n === 'gh') &&
    words.some((w) => /^(?:-X|--request=?|--method=?|-X=)?DELETE$/i.test(w))
  )
    raise('irreversible')

  // The network.
  if (names.some((n, i) => NETWORK.has(n) && (!NETWORK_AMBIGUOUS.has(n) || i === k)))
    raise('outside')

  // Shells and interpreters: code the rules cannot read.
  const interpreter = quoted
    ? program !== undefined && isInterpreter(program)
    : names.some(isInterpreter)
  if (interpreter) {
    raise('outside')
    if (CODE_DELETES.test(words.join(' '))) raise('irreversible')
  }

  // A program the rules do not know, or one called by a path (`./cat`).
  if (!quoted && programWord !== undefined) {
    if (/[/\\]/.test(programWord) || !KNOWN.has(programWord)) raise('outside')
  }
  if (program === 'set' && words.length === k + 1) raise('outside')
  if (program === 'jq' && /env|\$ENV|input|import|include/.test(words.slice(k + 1).join(' ')))
    raise('outside')
  if (program === 'date' && words.slice(k + 1).some((w) => !w.startsWith('+'))) raise('outside')

  // Secrets, and globs that reach dotfiles.
  if (words.some(secretWord) || seg.redirects.some((r) => secretWord(r.target))) raise('outside')

  // Paths outside the project (top level only: quoted text is not a path).
  if (!quoted) {
    for (const w of words.slice(k + 1)) {
      const candidate = w.includes('=') && w.startsWith('-') ? w.slice(w.indexOf('=') + 1) : w
      if (!/^(?:\/|~|\$HOME\b|\$\{HOME\}|\.\.(?:\/|$))|\/\.\.(?:\/|$)/.test(candidate)) continue
      const at = resolve(ctx.dir, candidate)
      if (at === null || (!isDevice(at) && !inside(at, ctx.base))) raise('outside')
    }
  }

  // What the program writes: options, writers, sed, chmod.
  const writes: string[] = []
  words.forEach((w, i) => {
    if (WRITE_OPTION.test(w) && !(w === '-o' && program === 'find') && words[i + 1] !== undefined)
      writes.push(words[i + 1])
    const eq = WRITE_OPTION_EQ.exec(w)
    if (eq) writes.push(eq[1])
  })
  // Program by program, wherever the program stands: behind a wrapper the
  // rules do not know (`nice chmod -R …`), its rule still applies.
  names.forEach((name, j) => {
    if (j < k) return
    const after = words.slice(j + 1)
    const operands = after.filter((w) => !w.startsWith('-'))
    if (WRITERS.has(name)) writes.push(...operands)
    if (name === 'uniq' && operands.length >= 2) writes.push(operands[1])
    if (name === 'file' && after.includes('-C')) raise('project')
    // crontab with anything but a listing installs or removes the table.
    if (name === 'crontab' && after.some((w) => w !== '-l')) raise('irreversible')
    if (name === 'sed') {
      raise('project')
      const script = after.join('\n')
      if (/(?:^|[\s;{}0-9$!/,])e(?:\s|;|}|$)|\/[gpIiMm0-9w]*e[gpIiMm0-9]*$/m.test(script))
        raise('outside')
    }
    if (name === 'chmod' || name === 'chown' || name === 'chgrp') {
      if (after.some((w) => /^-[A-Za-z]*R|^--recursive$/.test(w))) raise('irreversible')
      for (const w of operands.slice(1)) {
        const at = resolve(ctx.dir, w)
        raise(at !== null && writeLevel(at, ctx) === 'project' ? 'project' : 'irreversible')
      }
    }
    if (name === 'find' && after.some((w) => /^-(?:exec|execdir|ok|okdir)$/.test(w)))
      raise('outside')
    if (name === 'fd' && after.some((w) => /^-[A-Za-z]*[xX]/.test(w))) raise('outside')
  })
  if (words.some((w) => RUN_OPTION.test(w))) raise('outside')
  for (const w of writes)
    raise(governingMention(w) ? 'irreversible' : writeLevel(resolve(ctx.dir, w), ctx))

  // Redirections into a file.
  for (const r of seg.redirects) {
    if (!r.op.includes('>')) continue
    raise(governingMention(r.target) ? 'irreversible' : writeLevel(resolve(ctx.dir, r.target), ctx))
  }

  // A governing file named by anything but a known reader: it may write it.
  const reader =
    program !== undefined &&
    (program === 'cd' || READERS.has(program)) &&
    !/[/\\]/.test(programWord ?? '') &&
    writes.length === 0
  const mentions = words.slice(k + 1).concat(assigns)
  if (mentions.some((w) => governingMention(w) || governingPath(w, ctx)))
    raise(reader ? 'outside' : 'irreversible')
  return level
}

/** A word that resolves to a governing file (a dotfile under `~`, …). */
function governingPath(word: string, ctx: Context): boolean {
  const at = resolve(ctx.dir, word)
  return at !== null && GOVERNING_FILES.some((re) => re.test(at))
}

// ── git ──

/** What a git command does, from what follows the word `git`. */
function gitLevel(args: string[], ctx: Context): RuleLevel {
  let i = 0
  let level: RuleLevel = 'unknown'
  while (i < args.length && args[i].startsWith('-')) {
    const g = args[i]
    // `-c key=value` can name a program to run; `-C`/`--git-dir` move it.
    if (g === '-c' || g.startsWith('--config-env') || g.startsWith('-c')) level = 'outside'
    if (
      g === '-c' ||
      g === '-C' ||
      /^--(?:git-dir|work-tree|namespace|exec-path|config-env)$/.test(g)
    )
      i++
    if (g === '-C' || g.startsWith('--git-dir') || g.startsWith('--work-tree'))
      level = combine(level, 'outside')
    i++
  }
  const sub = args[i]
  if (sub === undefined) return level
  const rest = args.slice(i + 1)
  const has = (...flags: string[]): boolean => rest.some((a) => flags.includes(a))
  const hasPrefix = (re: RegExp): boolean => rest.some((a) => re.test(a))
  const positional = rest.filter((a) => !a.startsWith('-'))
  const raise = (l: RuleLevel): RuleLevel => (level = combine(level, l))
  switch (sub) {
    case 'push':
      raise('outside')
      if (
        has('-f', '--force', '-d', '--delete', '--mirror', '--prune') ||
        hasPrefix(/^--force-with-lease|^--force-if-includes|^-[A-Za-z]*f/) ||
        positional.some((p) => p.startsWith('+') || p.startsWith(':'))
      )
        raise('irreversible')
      return level
    case 'fetch':
    case 'pull':
    case 'clone':
    case 'ls-remote':
    case 'request-pull':
    case 'svn':
    case 'p4':
    case 'daemon':
    case 'instaweb':
    case 'credential':
    case 'mergetool':
    case 'difftool':
    case 'bisect':
    case 'submodule':
      raise('outside')
      if (sub === 'pull' && has('--rebase', '-r')) raise('irreversible')
      return level
    case 'send-email':
    case 'clean':
    case 'restore':
    case 'filter-branch':
    case 'filter-repo':
    case 'rebase':
    case 'replace':
    case 'update-ref':
    case 'prune':
      return raise('irreversible')
    case 'reset':
      return raise(has('--hard', '--keep', '--merge') ? 'irreversible' : 'project')
    case 'checkout': {
      if (has('--', '-f', '--force', '-p', '--patch', '--ours', '--theirs', '.'))
        return raise('irreversible')
      const ops: string[] = []
      for (let j = 0; j < rest.length; j++) {
        if (['-b', '-B', '--orphan', '-t', '--track'].includes(rest[j])) j++
        else if (!rest[j].startsWith('-')) ops.push(rest[j])
      }
      return raise(ops.length >= 2 ? 'irreversible' : 'project')
    }
    case 'switch':
      return raise(
        has('-f', '--force', '--discard-changes') || hasPrefix(/^-C$/) ? 'irreversible' : 'project'
      )
    case 'branch':
      if (has('-D', '-d', '--delete', '-M', '-C', '--force', '-f') || hasPrefix(/^-[a-zA-Z]*D/))
        return raise('irreversible')
      return raise(positional.length ? 'project' : level)
    case 'stash':
      return raise(
        ['drop', 'clear'].includes(rest[0] ?? '')
          ? 'irreversible'
          : rest[0] === 'list' || rest[0] === 'show'
            ? level
            : 'project'
      )
    case 'reflog':
      return raise(rest[0] === 'expire' || rest[0] === 'delete' ? 'irreversible' : level)
    case 'gc':
      return raise(hasPrefix(/^--prune/) ? 'irreversible' : 'project')
    case 'worktree':
      if (['remove', 'prune'].includes(rest[0] ?? '')) return raise('irreversible')
      return raise(rest[0] === 'list' ? level : 'project')
    case 'commit':
      return raise(has('--amend') ? 'irreversible' : 'project')
    case 'tag':
      if (has('-d', '--delete', '-f', '--force')) return raise('irreversible')
      return raise(positional.length && !has('-l', '--list') ? 'project' : level)
    case 'config':
      if (
        has('--get', '--get-all', '--get-regexp', '-l', '--list') ||
        rest[0] === 'get' ||
        rest[0] === 'list'
      )
        return raise('outside')
      return raise('irreversible')
    case 'remote':
      if (!rest.length || (rest.length === 1 && rest[0] === '-v')) return level
      if (['remove', 'rm', 'prune', 'set-url'].includes(rest[0])) return raise('irreversible')
      return raise('outside')
    case 'help':
      return raise(has('--web', '-w', '--browser') ? 'outside' : level)
    case 'add':
    case 'merge':
    case 'mv':
    case 'apply':
    case 'am':
    case 'cherry-pick':
    case 'revert':
    case 'init':
    case 'notes':
    case 'commit-tree':
    case 'update-index':
    case 'rm':
      return raise(sub === 'rm' ? 'irreversible' : 'project')
    case 'status':
    case 'log':
    case 'show':
    case 'diff':
    case 'blame':
    case 'rev-parse':
    case 'ls-files':
    case 'describe':
    case 'shortlog':
    case 'grep':
    case 'cat-file':
    case 'rev-list':
    case 'ls-tree':
    case 'for-each-ref':
    case 'show-ref':
    case 'name-rev':
    case 'merge-base':
    case 'whatchanged':
    case 'cherry':
    case 'range-diff':
    case 'version':
      if (has('--ext-diff', '--textconv', '--no-index') || hasPrefix(/^-O/)) raise('outside')
      for (let j = 0; j < rest.length; j++) {
        const a = rest[j]
        const out =
          a === '--output' ? rest[j + 1] : a.startsWith('--output=') ? a.slice(9) : undefined
        if (out !== undefined)
          raise(governingMention(out) ? 'irreversible' : writeLevel(resolve(ctx.dir, out), ctx))
      }
      return level
    default:
      // An alias or a command the rules do not know: an alias can run a shell.
      return raise('outside')
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
