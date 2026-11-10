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
 * The principle (fix round 1): "reads only" is PROVEN or it is not said.
 *   - PROVEN reads: every part of the command runs a program on a strict
 *     list, with no option that writes a file, runs another program, or
 *     reaches a secret; no wrapper that could not be unwrapped, no
 *     redirection into a file.
 *   - DETECTED: a level found by a positive rule, after unwrapping, as far as
 *     the rules can, what a wrapper runs (`command`, `time`, `env`, `xargs`,
 *     `bash -lc`, `eval`, `ssh host '…'`, `find -exec`, `git -c …`, …). A
 *     wrapper takes the level of what it runs.
 *   - UNKNOWN: the rules cannot tell. Not a level, never shown as one; the
 *     explainer's model may give it one of the three upper levels, never
 *     "reads only" (`shownLevel`).
 * Running code the rules cannot read (an unknown program, a script, an
 * interpreter, a tool they do not know) is DETECTED as at least `outside`.
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

/** Built-in tools that read and change nothing (their paths still count). */
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead'])
/** Built-in tools that touch no file, no network and nothing outside. */
const INERT_TOOLS = new Set(['TodoWrite', 'TodoRead', 'TaskOutput', 'BashOutput', 'ToolSearch'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
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

function mcpLevel(name: string, input: unknown): RiskLevel {
  const words = nameWords(name.split('__').slice(2).join('__') || name)
  if (words.some((w) => FINAL_WORDS.has(w) || SEND_WORDS.has(w))) return 'irreversible'
  const body = safeJson(input)
  if (SQL_CHANGE.test(body) && /\b(?:sql|query|statement)\b/i.test(body + ' ' + name))
    return 'irreversible'
  return 'outside'
}

const safeJson = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** The level of one permission request, from the rules alone. */
export function riskFloor({ toolName, input, cwd }: RiskInput): RuleLevel {
  const name = toolName ?? ''
  const p = record(input)
  const ctx = startContext(cwd)
  if (READ_TOOLS.has(name)) {
    const path = text(p.file_path) || text(p.path) || text(p.notebook_path)
    return path ? readLevel(resolve(ctx.dir, path), ctx) : 'reads'
  }
  if (INERT_TOOLS.has(name)) return 'reads'
  if (WRITE_TOOLS.has(name)) {
    const path = text(p.file_path) || text(p.notebook_path)
    return path ? writeLevel(resolve(ctx.dir, path), ctx) : 'outside'
  }
  if (SHELL_TOOLS.has(name)) return scriptLevel(text(p.command), ctx, 0)
  if (CODEX_COMMAND.has(name)) {
    const at = text(p.cwd) ? startContext(cwd, text(p.cwd)) : ctx
    const argv = strings(p.command)
    if (argv.length) return argvLevel(argv, at, emptyIo(), 0)
    return scriptLevel(text(p.command), at, 0)
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
  if (name.startsWith('mcp__')) return mcpLevel(name, input)
  // A skill, a subagent, a tool the rules do not know: code or instructions
  // they cannot read, at least outside.
  return 'outside'
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
/** What a substitution reads as inside a word: a value the rules cannot know. */
const SUB = '\u0001'

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
  if (/[$`]/.test(path) || path.includes(SUB)) return null
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
  /(?:^|\/)\.ssh(?:\/|$)/i,
  /(?:^|\/)\.claude\/settings[^/]*\.json$/i,
  /(?:^|\/)\.claude\/(?:hooks|agents|commands)(?:\/|$)/i,
  /(?:^|\/)\.claude\.json$/i,
  /(?:^|\/)\.mcp\.json$/i,
  /(?:^|\/)\.git\/(?:hooks(?:\/|$)|config$)/i,
  /(?:^|\/)\.(?:gitconfig|npmrc|yarnrc|yarnrc\.yml|netrc|pypirc|curlrc|wgetrc)$/i,
  /(?:^|\/)Library\/(?:LaunchAgents|LaunchDaemons|StartupItems)(?:\/|$)/i,
  /(?:^|\/)crontab$/i,
  /^\/(?:etc|private|Library|System|usr|bin|sbin|var\/root|Applications)(?:\/|$)/i,
  /^\/$/
]
/** What holds a secret: reading it reaches outside. */
const SECRET = [
  /(?:^|\/)\.env(?:\.[^/]*)?$/i,
  /(?:^|\/)\.ssh(?:\/|$)/i,
  /\.(?:pem|key|p12|pfx|keystore|jks|kdbx|gpg|asc)$/i,
  /(?:^|\/)id_(?:rsa|dsa|ecdsa|ed25519)/i,
  /(?:^|\/)\.(?:aws|gnupg|kube|docker|azure|gcloud|config\/gcloud|config\/gh)(?:\/|$)/i,
  /(?:^|\/)\.(?:netrc|npmrc|pypirc|git-credentials|pgpass|my\.cnf)$/i,
  /(?:^|\/)Keychains(?:\/|$)/i,
  /(?:^|\/)(?:credentials|secrets?|tokens?)(?:\.[^/]*)?$/i,
  /(?:^|\/)\.claude\.json$/i,
  /^~\/?$/
]

const isDevice = (path: string): boolean =>
  /^\/dev\/(?:null|stdout|stderr|stdin|tty|fd\/\d+)$/.test(path)
const inside = (path: string, base: string): boolean =>
  path === base || path.startsWith(base === '/' ? '/' : base + '/')

/** The level of reading a path. */
function readLevel(path: string | null, ctx: Context): RuleLevel {
  if (path === null) return 'unknown'
  if (isDevice(path)) return 'reads'
  if (SECRET.some((re) => re.test(path))) return 'outside'
  return inside(path, ctx.base) ? 'reads' : 'outside'
}

/** The level of writing a path. A path the rules cannot place is never the
 *  project: outside at least. */
function writeLevel(path: string | null, ctx: Context): RiskLevel {
  if (path === null) return 'outside'
  if (isDevice(path)) return 'reads'
  if (GOVERNING.some((re) => re.test(path))) return 'irreversible'
  return inside(path, ctx.base) ? 'project' : 'outside'
}

// ── The shell: words, redirections, commands ──

interface Word {
  /** The word with its quotes taken off; a substitution reads as \u0001. */
  value: string
  /** Commands it substitutes (`$(…)`, backticks), and process substitutions. */
  subs: string[]
  /** A `<(…)` or `>(…)`: its command. */
  process?: string
}
interface Redirect {
  op: string
  target: Word
  /** A here-document's body. */
  body?: string
}
interface Simple {
  words: Word[]
  redirects: Redirect[]
}
/** Commands joined by pipes. */
type Pipeline = Simple[]

/** The pipelines of a script, in order (`;`, `&&`, `||`, `&`, new lines and
 *  parentheses all separate them). Null when the text does not parse. */
function parse(script: string): Pipeline[] | null {
  const pipelines: Pipeline[] = []
  let pipeline: Pipeline = []
  let simple: Simple = { words: [], redirects: [] }
  const pendingBodies: Redirect[] = []
  let i = 0
  const n = script.length
  const endSimple = (): void => {
    if (simple.words.length || simple.redirects.length) pipeline.push(simple)
    simple = { words: [], redirects: [] }
  }
  const endPipeline = (): void => {
    endSimple()
    if (pipeline.length) pipelines.push(pipeline)
    pipeline = []
  }
  /** Read the bodies of the here-documents opened on the line just ended. */
  const readBodies = (): boolean => {
    while (pendingBodies.length) {
      const redirect = pendingBodies.shift()!
      const delimiter = redirect.target.value
      const lines: string[] = []
      let found = false
      while (i < n) {
        const end = script.indexOf('\n', i)
        const line = script.slice(i, end === -1 ? n : end)
        i = end === -1 ? n : end + 1
        if ((redirect.op === '<<-' ? line.replace(/^\t+/, '') : line) === delimiter) {
          found = true
          break
        }
        lines.push(line)
      }
      if (!found) return false
      redirect.body = lines.join('\n')
    }
    return true
  }
  while (i < n) {
    const c = script[i]
    if (c === '\n') {
      i++
      endPipeline()
      if (!readBodies()) return null
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++
      continue
    }
    if (c === '#') {
      // A comment runs to the end of the line.
      while (i < n && script[i] !== '\n') i++
      continue
    }
    if (c === '\\' && script[i + 1] === '\n') {
      i += 2
      continue
    }
    if (c === ';' || c === '(' || c === ')') {
      i += c === ';' && script[i + 1] === ';' ? 2 : 1
      endPipeline()
      continue
    }
    if (c === '&' && script[i + 1] === '&') {
      i += 2
      endPipeline()
      continue
    }
    if (c === '|' && script[i + 1] === '|') {
      i += 2
      endPipeline()
      continue
    }
    if (c === '|') {
      i += script[i + 1] === '&' ? 2 : 1
      endSimple()
      continue
    }
    // Redirections: [n]>, >>, >|, &>, &>>, <, <<, <<-, <<<, <&, >&.
    const redirect = /^(?:\d*|&)(?:>>|>\||>&|>|<<<|<<-|<<|<&|<>|<)(?!\()/.exec(script.slice(i))
    if (redirect && !(c === '&' && !/^&>/.test(script.slice(i)))) {
      i += redirect[0].length
      while (i < n && (script[i] === ' ' || script[i] === '\t')) i++
      const op = redirect[0].replace(/^\d+/, '')
      const word = readWord()
      if (!word) return null
      if (op === '>&' || op === '<&') {
        // A descriptor duplication (`2>&1`, `>&2`), or `>& file`.
        if (!/^\d+$|^-$/.test(word.value)) simple.redirects.push({ op: '>', target: word })
        continue
      }
      const entry: Redirect = { op: op === '&>' || op === '&>>' ? '>' : op, target: word }
      simple.redirects.push(entry)
      if (op === '<<' || op === '<<-') pendingBodies.push(entry)
      continue
    }
    if (c === '&') {
      i++
      endPipeline()
      continue
    }
    const word = readWord()
    if (!word) return null
    simple.words.push(word)
  }
  endPipeline()
  if (pendingBodies.length && !readBodies()) return null
  return pipelines

  /** One word at `i`: quotes, escapes, substitutions. Null on an unclosed quote. */
  function readWord(): Word | null {
    let value = ''
    const subs: string[] = []
    let processSub: string | undefined
    let any = false
    while (i < n) {
      const c = script[i]
      if (/[\s;&|()<>]/.test(c)) {
        // A process substitution starts a word of its own.
        if ((c === '<' || c === '>') && script[i + 1] === '(' && !any) {
          const inner = balanced(i + 1)
          if (inner === null) return null
          processSub = inner.text
          subs.push(inner.text)
          value += '\u0001'
          i = inner.end
          any = true
          continue
        }
        break
      }
      any = true
      if (c === '\\') {
        value += script[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === "'") {
        const end = script.indexOf("'", i + 1)
        if (end === -1) return null
        value += script.slice(i + 1, end)
        i = end + 1
        continue
      }
      if (c === '$' && script[i + 1] === "'") {
        const end = script.indexOf("'", i + 2)
        if (end === -1) return null
        value += script.slice(i + 2, end)
        i = end + 1
        continue
      }
      if (c === '"') {
        i++
        while (i < n && script[i] !== '"') {
          if (script[i] === '\\' && i + 1 < n) {
            value += script[i + 1]
            i += 2
          } else if (script[i] === '$' && script[i + 1] === '(') {
            if (!substitution()) return null
          } else if (script[i] === '`') {
            if (!backtick()) return null
          } else value += script[i++]
        }
        if (i >= n) return null
        i++
        continue
      }
      if (c === '$' && script[i + 1] === '(') {
        if (!substitution()) return null
        continue
      }
      if (c === '`') {
        if (!backtick()) return null
        continue
      }
      value += c
      i++
    }
    return any ? { value, subs, ...(processSub !== undefined && { process: processSub }) } : null

    function substitution(): boolean {
      if (script[i + 2] === '(') {
        // `$((…))`: arithmetic, no command.
        const inner = balanced(i + 1)
        if (inner === null) return false
        value += '\u0001'
        i = inner.end
        return true
      }
      const inner = balanced(i + 1)
      if (inner === null) return false
      subs.push(inner.text)
      value += '\u0001'
      i = inner.end
      return true
    }
    function backtick(): boolean {
      const end = script.indexOf('`', i + 1)
      if (end === -1) return false
      subs.push(script.slice(i + 1, end))
      value += '\u0001'
      i = end + 1
      return true
    }
  }

  /** The text between the parenthesis at `open` and its match. */
  function balanced(open: number): { text: string; end: number } | null {
    let depth = 0
    let quote: string | null = null
    for (let k = open; k < n; k++) {
      const c = script[k]
      if (quote) {
        if (c === '\\' && quote === '"') k++
        else if (c === quote) quote = null
        continue
      }
      if (c === "'" || c === '"' || c === '`') quote = c
      else if (c === '\\') k++
      else if (c === '(') depth++
      else if (c === ')' && --depth === 0) return { text: script.slice(open + 1, k), end: k + 1 }
    }
    return null
  }
}

/** What a command reads on its standard input, as far as the rules know. */
interface Io {
  /** A here-document's body. */
  body?: string
  /** An earlier command of the same pipeline fetched from the network. */
  fetched: boolean
  /** Files fetched earlier in the same script (`curl -o i.sh`). */
  downloaded: Set<string>
}
const emptyIo = (): Io => ({ fetched: false, downloaded: new Set() })

const MAX_DEPTH = 8

/** The level of a shell script, the highest of its parts. */
export function commandLevel(command: string, cwd?: string): RuleLevel {
  return scriptLevel(command, startContext(cwd), 0)
}

function scriptLevel(script: string, ctx: Context, depth: number, io?: Io): RuleLevel {
  if (depth > MAX_DEPTH) return 'outside'
  if (!script.trim()) return 'outside'
  const pipelines = parse(script)
  if (pipelines === null) return 'outside'
  const downloaded = io?.downloaded ?? new Set<string>()
  let level: RuleLevel = 'reads'
  for (const pipeline of pipelines) {
    let fetched = io?.fetched ?? false
    for (const simple of pipeline) {
      const cmdIo: Io = { fetched, downloaded }
      level = combine(level, simpleLevel(simple, ctx, cmdIo, depth))
      if (fetchesFromNetwork(simple)) fetched = true
      if (level === 'irreversible') return level
    }
  }
  return level
}

const NETWORK_FETCH = new Set(['curl', 'wget', 'http', 'https', 'xh', 'fetch', 'aria2c'])
const fetchesFromNetwork = (simple: Simple): boolean => {
  const argv = stripAssignments(simple.words.map((w) => w.value)).argv
  return argv.length > 0 && NETWORK_FETCH.has(programName(argv[0]))
}

const programName = (word: string): string => (word.split('/').pop() ?? word).replace(/^\\/, '')

/** Variables that change what a later program is or does. */
const STEERING_VARS =
  /^(?:PATH|LD_\w+|DYLD_\w+|BASH_ENV|ENV|PROMPT_COMMAND|NODE_OPTIONS|PYTHONPATH|PYTHONSTARTUP|PERL5OPT|RUBYOPT|GIT_\w+|SHELLOPTS|IFS|HOME|ZDOTDIR|PAGER|EDITOR|VISUAL)=/

function stripAssignments(argv: string[]): { argv: string[]; steering: boolean } {
  let j = 0
  let steering = false
  while (j < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[j])) {
    if (STEERING_VARS.test(argv[j])) steering = true
    j++
  }
  return { argv: argv.slice(j), steering }
}

function simpleLevel(simple: Simple, ctx: Context, io: Io, depth: number): RuleLevel {
  let level: RuleLevel = 'reads'
  for (const word of simple.words)
    for (const sub of word.subs) level = combine(level, scriptLevel(sub, { ...ctx }, depth + 1))
  let body: string | undefined
  for (const redirect of simple.redirects) {
    for (const sub of redirect.target.subs)
      level = combine(level, scriptLevel(sub, { ...ctx }, depth + 1))
    if (redirect.op === '<<' || redirect.op === '<<-') body = redirect.body ?? ''
    else if (redirect.op === '<<<') body = redirect.target.value
    else if (redirect.op === '<' || redirect.op === '<>')
      level = combine(level, readLevel(resolve(ctx.dir, redirect.target.value), ctx))
    else level = combine(level, writeLevel(resolve(ctx.dir, redirect.target.value), ctx))
    if (redirect.op === '<>')
      level = combine(level, writeLevel(resolve(ctx.dir, redirect.target.value), ctx))
  }
  const words = simple.words
  const { argv, steering } = stripAssignments(words.map((w) => w.value))
  if (steering) level = combine(level, 'unknown')
  if (!argv.length) return level
  const offset = words.length - argv.length
  const processes = words.slice(offset).map((w) => w.process)
  const ownIo: Io = { ...io, ...(body !== undefined && { body }) }
  return combine(level, argvLevel(argv, ctx, ownIo, depth, processes))
}

// ── Programs ──

/** Programs whose arguments are data, never files, and that change nothing. */
const DATA_PROGRAMS = new Set([
  'echo',
  'printf',
  'true',
  'false',
  'test',
  '[',
  '[[',
  ']]',
  'expr',
  'seq',
  'sleep',
  'basename',
  'dirname',
  'wait',
  'exit',
  'return',
  'pwd',
  'whoami',
  'id',
  'groups',
  'uname',
  'uptime',
  'sw_vers',
  'locale',
  'tty',
  'arch',
  'nproc',
  'getconf',
  'which',
  'whereis',
  'type',
  'unset',
  'shift',
  'local',
  'declare',
  'typeset',
  'readonly',
  'read',
  'let',
  ':'
])
/** Programs that read the files they are given and nothing else, whatever
 *  their options: no option of theirs writes a file or runs a program. */
const READ_PROGRAMS = new Set([
  'cat',
  'head',
  'tail',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'ls',
  'stat',
  'file',
  'du',
  'df',
  'diff',
  'cmp',
  'comm',
  'cut',
  'tr',
  'nl',
  'fold',
  'fmt',
  'rev',
  'paste',
  'column',
  'join',
  'md5',
  'md5sum',
  'shasum',
  'sha1sum',
  'sha224sum',
  'sha256sum',
  'sha384sum',
  'sha512sum',
  'cksum',
  'b2sum',
  'readlink',
  'realpath',
  'od',
  'hexdump',
  'strings',
  'jq',
  'look',
  'zcat',
  'gzcat',
  'bzcat',
  'xzcat',
  'ps',
  'pgrep',
  'lsof',
  'top',
  'htop',
  'pstree',
  'tac',
  'expand',
  'unexpand',
  'iconv',
  'numfmt',
  'tsort',
  'pr',
  'otool',
  'nm',
  'lipo',
  'codesign',
  'plutil'
])
/** Programs that act on the machine itself, hard to take back. */
const FINAL_PROGRAMS = new Set([
  'sudo',
  'su',
  'doas',
  'rm',
  'unlink',
  'shred',
  'srm',
  'dd',
  'truncate',
  'mkfs',
  'newfs_apfs',
  'fdisk',
  'gpt',
  'shutdown',
  'reboot',
  'halt',
  'chsh',
  'passwd',
  'dscl',
  'sysadminctl',
  'spctl',
  'csrutil',
  'nvram',
  'pmset',
  'tccutil',
  'chroot',
  'mail',
  'mailx',
  'sendmail',
  'mutt',
  'msmtp',
  'rimraf'
])
const NETWORK_PROGRAMS = new Set([
  'ssh',
  'scp',
  'sftp',
  'nc',
  'ncat',
  'netcat',
  'telnet',
  'ftp',
  'ping',
  'dig',
  'nslookup',
  'host',
  'traceroute',
  'whois',
  'open',
  'pbcopy',
  'pbpaste',
  'say',
  'brew',
  'port',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'pacman',
  'apk',
  'snap',
  'pip',
  'pip3',
  'pipx',
  'uv',
  'poetry',
  'conda',
  'gem',
  'bundle',
  'composer',
  'npx',
  'bunx',
  'pnpx',
  'kill',
  'pkill',
  'killall'
])
const CLOUD_PROGRAMS = new Set([
  'gcloud',
  'gsutil',
  'az',
  'doctl',
  'heroku',
  'vercel',
  'netlify',
  'fly',
  'flyctl',
  'wrangler',
  'firebase',
  'supabase',
  'railway',
  'render',
  'stripe',
  'serverless',
  'sls',
  'cdk',
  'eksctl',
  'linode-cli',
  'hcloud',
  'scw'
])
const CLOUD_FINAL = new Set([
  'delete',
  'destroy',
  'remove',
  'rm',
  'deploy',
  'publish',
  'release',
  'rollback',
  'purge',
  'drop',
  'scale',
  'kill',
  'cancel',
  'refund',
  'transfer',
  'reset',
  'apply',
  'up',
  'promote'
])
const SQL_CLIENTS = new Set([
  'psql',
  'mysql',
  'mariadb',
  'sqlite3',
  'sqlcmd',
  'mongosh',
  'mongo',
  'clickhouse-client',
  'cockroach',
  'duckdb',
  'cqlsh',
  'bq'
])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'csh', 'tcsh'])
const INTERPRETERS = new Set([
  'node',
  'nodejs',
  'python',
  'python2',
  'python3',
  'ruby',
  'perl',
  'php',
  'deno',
  'ts-node',
  'tsx',
  'lua',
  'Rscript',
  'pwsh',
  'swift',
  'julia',
  'irb'
])
/** Wrappers that run the program after their own options. */
const WRAPPERS: Record<string, { values: RegExp; leading?: RegExp }> = {
  time: { values: /^-[fo]$/ },
  nice: { values: /^-n$/ },
  nohup: { values: /^$/ },
  timeout: { values: /^(?:-s|-k|--signal|--kill-after)$/, leading: /^\d/ },
  gtimeout: { values: /^(?:-s|-k|--signal|--kill-after)$/, leading: /^\d/ },
  stdbuf: { values: /^-[ioe]$/ },
  unbuffer: { values: /^$/ },
  caffeinate: { values: /^-[tw]$/ },
  exec: { values: /^-a$/ },
  builtin: { values: /^$/ },
  noglob: { values: /^$/ },
  nocorrect: { values: /^$/ },
  ionice: { values: /^-[cnp]$/ },
  taskset: { values: /^$/, leading: /^(?:0x)?[0-9a-f,-]+$/i },
  arch: { values: /^$/ },
  sandbox: { values: /^$/ },
  '!': { values: /^$/ },
  '{': { values: /^$/ },
  '}': { values: /^$/ },
  then: { values: /^$/ },
  else: { values: /^$/ },
  elif: { values: /^$/ },
  do: { values: /^$/ },
  if: { values: /^$/ },
  while: { values: /^$/ },
  until: { values: /^$/ },
  fi: { values: /^$/ },
  done: { values: /^$/ }
}

/** The arguments past a wrapper's own options. */
function pastOptions(args: string[], values: RegExp, leading?: RegExp): string[] {
  let j = 0
  while (j < args.length) {
    const a = args[j]
    if (a === '--') {
      j++
      break
    }
    if (a.startsWith('-') && a.length > 1) {
      j += values.test(a) ? 2 : 1
      continue
    }
    if (leading && leading.test(a)) {
      j++
      continue
    }
    break
  }
  return args.slice(j)
}

const isFlag = (a: string): boolean => a.startsWith('-') && a.length > 1 && a !== '--'
const positionals = (args: string[]): string[] => args.filter((a) => !isFlag(a))
/** A short flag alone or grouped (`-f`, `-fu`), or one of the long ones. */
const hasFlag = (args: string[], letters: string, ...long: string[]): boolean =>
  args.some(
    (a) =>
      long.some((l) => a === l || a.startsWith(l + '=')) ||
      (/^-[A-Za-z0-9]+$/.test(a) && [...letters].some((letter) => a.slice(1).includes(letter)))
  )
/** The value of an option: `-o v`, `-ov`, `--opt v`, `--opt=v`. */
function optionValues(args: string[], short: string[], long: string[]): string[] {
  const out: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    for (const l of long) {
      if (a === l && k + 1 < args.length) out.push(args[k + 1])
      else if (a.startsWith(l + '=')) out.push(a.slice(l.length + 1))
    }
    for (const s of short) {
      if (a === s && k + 1 < args.length) out.push(args[k + 1])
      else if (a.startsWith(s) && a.length > s.length && !a.startsWith('--'))
        out.push(a.slice(s.length))
    }
  }
  return out
}

/** The level of reading the paths among `args`. */
function readArgs(args: string[], ctx: Context): RuleLevel {
  let level: RuleLevel = 'reads'
  for (const a of positionals(args)) {
    if (a.includes('\u0001')) {
      level = combine(level, 'unknown')
      continue
    }
    // A pattern or a word that is no path reads nothing outside.
    const path = resolve(ctx.dir, a)
    level = combine(level, readLevel(path, ctx))
  }
  return level
}
function writeArgs(paths: string[], ctx: Context): RuleLevel {
  let level: RuleLevel = 'project'
  for (const path of paths) level = combine(level, writeLevel(resolve(ctx.dir, path), ctx))
  return level
}

/** A downloaded file or a process substitution fetching from the network. */
function runsFetched(arg: string, process: string | undefined, io: Io, ctx: Context): boolean {
  if (process !== undefined) return /\b(?:curl|wget|fetch|http|xh)\b/.test(process)
  const path = resolve(ctx.dir, arg)
  return path !== null && io.downloaded.has(path)
}

/** The level of one program run with its arguments. */
function argvLevel(
  argv: string[],
  ctx: Context,
  io: Io,
  depth: number,
  processes: (string | undefined)[] = []
): RuleLevel {
  if (depth > MAX_DEPTH) return 'outside'
  if (!argv.length) return 'reads'
  const raw = argv[0]
  if (raw.includes('\u0001') || /^\$/.test(raw)) return 'outside'
  const program = programName(raw)
  const args = argv.slice(1)
  const again = (next: string[]): RuleLevel =>
    argvLevel(next, ctx, io, depth + 1, processes.slice(argv.length - next.length))
  const script = (body: string, at: Context = { ...ctx }): RuleLevel =>
    scriptLevel(body, at, depth + 1)

  if (args.length === 1 && /^(?:--version|-v|-V|--help|-h)$/.test(args[0]) && !SHELLS.has(program))
    return FINAL_PROGRAMS.has(program) ? 'irreversible' : 'reads'
  if (FINAL_PROGRAMS.has(program)) return 'irreversible'

  // ── Wrappers: the level of what they run ──
  if (WRAPPERS[program]) {
    const rest = pastOptions(args, WRAPPERS[program].values, WRAPPERS[program].leading)
    return rest.length ? again(rest) : 'reads'
  }
  if (program === 'for' || program === 'case' || program === 'select' || program === 'function')
    return 'unknown'
  if (program === 'command') {
    if (hasFlag(args, 'vV')) return 'reads'
    const rest = pastOptions(args, /^$/)
    return rest.length ? again(rest) : 'reads'
  }
  if (program === 'env') {
    const split = optionValues(args, ['-S'], ['--split-string'])
    if (split.length) return script(split.join(' '))
    let j = 0
    while (j < args.length) {
      const a = args[j]
      if (/^-[uCP]$|^--(?:unset|chdir)$/.test(a)) j += 2
      else if (isFlag(a) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) j++
      else break
    }
    const rest = args.slice(j)
    // `env` alone prints every variable: tokens and keys among them.
    return rest.length
      ? combine(again(rest), stripAssignments(args).steering ? 'unknown' : 'reads')
      : 'outside'
  }
  if (program === 'xargs') {
    const rest = pastOptions(
      args,
      /^-[nLIPdEesa]$|^--(?:max-args|max-lines|replace|max-procs|delimiter|eof|arg-file)$/
    )
    return rest.length ? again(rest) : 'reads'
  }
  if (program === 'watch') {
    const rest = pastOptions(args, /^-[nd]$/)
    return rest.length ? script(rest.join(' ')) : 'reads'
  }
  if (program === 'eval') return args.length ? script(args.join(' ')) : 'reads'
  if (program === 'source' || program === '.') {
    if (!args.length) return 'outside'
    return runsFetched(args[0], processes[1], io, ctx) ? 'irreversible' : 'outside'
  }
  if (SHELLS.has(program)) return shellLevel(args, ctx, io, depth, processes.slice(1))
  if (INTERPRETERS.has(program) || program === 'bun' || program === 'osascript')
    return interpreterLevel(program, args, ctx, io, depth)

  // ── The shell's own state ──
  if (program === 'cd' || program === 'pushd') {
    const target = positionals(args)[0]
    if (target === undefined) ctx.dir = '~'
    else if (target === '-') ctx.dir = null
    else ctx.dir = resolve(ctx.dir, target)
    return 'reads'
  }
  if (program === 'popd') {
    ctx.dir = null
    return 'reads'
  }
  if (program === 'export') {
    return args.some((a) => STEERING_VARS.test(a)) ? 'unknown' : 'reads'
  }
  if (program === 'alias') return args.some((a) => a.includes('=')) ? 'unknown' : 'reads'
  if (program === 'set')
    return args.every((a) => /^[-+][euxvo]+$|^pipefail$|^errexit$|^nounset$|^xtrace$/.test(a))
      ? 'reads'
      : 'unknown'
  if (program === 'umask' || program === 'ulimit') return args.length ? 'unknown' : 'reads'
  if (program === 'history') return args.some((a) => /^-[cdwaprsn]/.test(a)) ? 'outside' : 'reads'
  if (program === 'trap' || program === 'shopt' || program === 'setopt' || program === 'unsetopt')
    return 'unknown'

  // ── Proven reads ──
  if (DATA_PROGRAMS.has(program)) return 'reads'
  if (READ_PROGRAMS.has(program)) return readArgs(args, ctx)
  if (program === 'printenv') return 'outside'
  if (program === 'date') {
    // `date +%F`, `date -u`, `date -r file` read; any other word may set the clock.
    const plain = args.every(
      (a, k) => a.startsWith('+') || /^-[uRj]+$|^--utc$|^-r$/.test(a) || args[k - 1] === '-r'
    )
    return plain ? 'reads' : 'outside'
  }
  if (program === 'hostname' || program === 'scutil' || program === 'networksetup')
    return args.length && !/^--get|^-get|^-list/.test(args[0]) ? 'irreversible' : 'reads'
  if (program === 'sort') {
    const out = optionValues(args, ['-o'], ['--output'])
    return out.length ? combine(writeArgs(out, ctx), readArgs(args, ctx)) : readArgs(args, ctx)
  }
  if (program === 'uniq') {
    const files = args.filter((a, k) => !isFlag(a) && !/^-[fs]$/.test(args[k - 1] ?? ''))
    return files.length >= 2
      ? combine(writeArgs([files[1]], ctx), readArgs([files[0]], ctx))
      : readArgs(args, ctx)
  }
  if (program === 'tree') {
    const out = optionValues(args, ['-o'], ['--output'])
    return out.length ? writeArgs(out, ctx) : readArgs(args, ctx)
  }
  if (program === 'base64') {
    const out = optionValues(args, ['-o'], ['--output'])
    return out.length ? writeArgs(out, ctx) : readArgs(args, ctx)
  }
  if (program === 'xxd') {
    const files = positionals(args.filter((_a, k) => !/^-[cglos]$/.test(args[k - 1] ?? '')))
    if (files.length >= 2) return combine(writeArgs([files[1]], ctx), readArgs([files[0]], ctx))
    return readArgs(args, ctx)
  }
  if (program === 'less' || program === 'more' || program === 'most' || program === 'bat') {
    // `+!cmd`, `-P`/`--pager`, LESSOPEN-style hooks run programs.
    const runs = args.filter((a) => a.startsWith('+'))
    const pager = optionValues(args, [], ['--pager'])
    if (runs.length || pager.length) {
      let level: RuleLevel = 'outside'
      for (const r of runs)
        if (r.includes('!')) level = combine(level, script(r.slice(r.indexOf('!') + 1)))
      for (const p of pager) level = combine(level, script(p))
      return level
    }
    return readArgs(args, ctx)
  }
  if (program === 'man') {
    const pager = optionValues(args, ['-P', '-H'], ['--pager', '--html'])
    if (pager.length) return combine('outside', script(pager.join(' ')))
    return args.some((a) => /^-[EtTZ]|^--(?:troff|ditroff)/.test(a)) ? 'unknown' : 'reads'
  }
  if (program === 'rg' || program === 'ag') {
    const pre = optionValues(args, [], ['--pre'])
    if (pre.length) return combine('outside', script(pre.join(' ')))
    if (args.some((a) => a === '--search-zip' || a === '-z' || a.startsWith('--pre-glob')))
      return combine('unknown', readArgs(args, ctx))
    return readArgs(
      args.filter((_a, k) => !/^(?:-[gtTmAB]|--(?:glob|type|max-count))$/.test(args[k - 1] ?? '')),
      ctx
    )
  }
  if (program === 'find' || program === 'gfind') return findLevel(args, ctx, io, depth)
  if (program === 'fd' || program === 'fdfind') {
    const k = args.findIndex((a) => /^(?:-x|-X|--exec|--exec-batch)$/.test(a))
    if (k !== -1) {
      const inner = args.slice(k + 1).filter((a) => !/^\{.*\}$/.test(a) && a !== ';')
      return combine(readArgs(args.slice(0, k), ctx), inner.length ? again(inner) : 'outside')
    }
    return readArgs(args, ctx)
  }
  if (program === 'sed' || program === 'gsed') return sedLevel(args, ctx)
  if (/^(?:awk|gawk|mawk|nawk)$/.test(program)) {
    if (args.some((a) => a === '-f' || /^-i/.test(a) || a === '--include' || a === '--inplace'))
      return 'outside'
    const prog = args.find((a) => !isFlag(a)) ?? ''
    if (/\bsystem\s*\(|\|\s*"|"\s*\||[^=!<>]>\s*"|>>|\bgetline\b|\bclose\s*\(/.test(prog))
      return 'outside'
    return readArgs(args.slice(args.indexOf(prog) + 1), ctx)
  }
  if (program === 'yq') {
    if (hasFlag(args, 'i', '--inplace')) return writeArgs(positionals(args).slice(1), ctx)
    return readArgs(positionals(args).slice(1), ctx)
  }
  if (program === 'crontab') return args.length === 1 && args[0] === '-l' ? 'reads' : 'irreversible'
  if (program === 'security')
    return /^(?:find|show|dump|list|export)-/.test(args[0] ?? '') ||
      /^(?:find|dump|export)/.test(args[0] ?? '')
      ? 'outside'
      : 'irreversible'
  if (program === 'defaults')
    return /^(?:read|domains|find|read-type)$/.test(args[0] ?? '') ? 'outside' : 'irreversible'
  if (
    program === 'launchctl' ||
    program === 'systemctl' ||
    program === 'service' ||
    program === 'diskutil'
  )
    return /^(?:list|print|status|info|is-active|show)$/.test(args[0] ?? '')
      ? 'reads'
      : 'irreversible'

  // ── Files ──
  if (program === 'mkdir' || program === 'touch' || program === 'rmdir' || program === 'tee') {
    const paths = positionals(args.filter((_a, k) => !/^-[m]$/.test(args[k - 1] ?? '')))
    return paths.length ? writeArgs(paths, ctx) : program === 'tee' ? 'reads' : 'project'
  }
  if (
    program === 'cp' ||
    program === 'mv' ||
    program === 'ln' ||
    program === 'install' ||
    program === 'ditto'
  ) {
    const target = optionValues(args, ['-t'], ['--target-directory'])
    const paths = positionals(
      args.filter((_a, k) => !/^-[tSmog]$|^--target-directory$/.test(args[k - 1] ?? ''))
    )
    if (!paths.length) return 'project'
    const dest = target.length ? target : [paths[paths.length - 1]]
    const sources = target.length ? paths : paths.slice(0, -1)
    let level: RuleLevel = combine(writeArgs(dest, ctx), readArgs(sources, ctx))
    // A move takes the sources away from where they were.
    if (program === 'mv') level = combine(level, writeArgs(sources, ctx))
    return level
  }
  if (/^(?:chmod|chown|chgrp|chflags|xattr|setfacl)$/.test(program)) {
    const paths = positionals(args).slice(program === 'xattr' ? 0 : 1)
    const level = paths.length ? writeArgs(paths, ctx) : 'project'
    const recursive = hasFlag(args, 'R', '--recursive')
    return recursive && level !== 'project' ? 'irreversible' : level
  }
  if (program === 'patch') {
    const out = optionValues(args, ['-o'], ['--output'])
    return out.length ? writeArgs(out, ctx) : combine('project', 'unknown')
  }
  if (program === 'tar' || program === 'bsdtar') {
    const flags = args[0] && !args[0].startsWith('-') ? args[0] : args.filter(isFlag).join('')
    const file = optionValues(args, ['-f'], ['--file'])
    if (/t/.test(flags) && !/[cxru]/.test(flags)) return file.length ? readArgs(file, ctx) : 'reads'
    if (/x/.test(flags)) {
      const dir = optionValues(args, ['-C'], ['--directory'])
      return dir.length ? writeArgs(dir, ctx) : writeArgs(['.'], ctx)
    }
    return file.length ? writeArgs(file, ctx) : 'project'
  }
  if (program === 'unzip') {
    if (hasFlag(args, 'lvt')) return readArgs(args, ctx)
    const dir = optionValues(args, ['-d'], [])
    return dir.length ? writeArgs(dir, ctx) : writeArgs(['.'], ctx)
  }
  if (/^(?:zip|gzip|gunzip|bzip2|bunzip2|xz|unxz|zstd|7z)$/.test(program)) {
    const paths = positionals(args)
    return paths.length ? writeArgs(paths, ctx) : 'project'
  }

  // ── The network, remotes and infrastructure ──
  if (program === 'git') return gitLevel(args, ctx, io, depth)
  if (program === 'gh') return ghLevel(args)
  if (['npm', 'pnpm', 'yarn'].includes(program)) return packageLevel(program, args, ctx, io, depth)
  if (NETWORK_FETCH.has(program)) return fetchLevel(program, args, ctx, io)
  if (program === 'ssh' || program === 'mosh') {
    const rest = pastOptions(args, /^-[bcDEeFIiJLlmOoPpQRSWw]$/)
    const command = rest.slice(1)
    return command.length
      ? combine('outside', script(command.join(' '), { base: ctx.base, dir: null }))
      : 'outside'
  }
  if (program === 'rsync') {
    if (args.some((a) => /^--(?:delete|del$|remove-source-files)/.test(a))) return 'irreversible'
    const paths = positionals(args)
    if (paths.some((a) => /^[^/]*:/.test(a))) return 'outside'
    return paths.length
      ? combine(writeArgs(paths.slice(-1), ctx), readArgs(paths.slice(0, -1), ctx))
      : 'outside'
  }
  if (program === 'docker' || program === 'podman' || program === 'nerdctl') {
    const words = positionals(
      pastOptions(args, /^(?:--context|-H|--host|--config|-c|--log-level)$/)
    )
    const sub = words.slice(0, 3).join(' ')
    if (
      /(?:^|\s)(?:rm|rmi|kill|prune)(?:\s|$)/.test(sub) ||
      (/compose (?:down|rm)/.test(sub) && hasFlag(args, 'v', '--volumes', '--rmi'))
    )
      return 'irreversible'
    if (/(?:^|\s)(?:rm|prune)(?:\s|$)/.test(words.slice(0, 2).join(' '))) return 'irreversible'
    return 'outside'
  }
  if (program === 'kubectl' || program === 'oc' || program === 'helm') {
    const sub = positionals(args)[0] ?? ''
    return /^(?:delete|drain|cordon|replace|patch|apply|edit|scale|rollout|set|uninstall|upgrade|rollback|install|taint|label|annotate)$/.test(
      sub
    )
      ? 'irreversible'
      : 'outside'
  }
  if (program === 'aws') {
    const words = positionals(args)
    return words.some((w) =>
      /^(?:rm|rb|mv)$|^(?:delete|terminate|remove|deregister|detach|revoke|disable|stop|put|update|modify|reset|purge|cancel)-/.test(
        w
      )
    ) ||
      (words.includes('sync') && args.includes('--delete'))
      ? 'irreversible'
      : 'outside'
  }
  if (program === 'terraform' || program === 'tofu' || program === 'pulumi')
    return /^(?:apply|destroy|import|state|taint|untaint|up|refresh|cancel|stack)$/.test(
      positionals(args)[0] ?? ''
    )
      ? 'irreversible'
      : 'outside'
  if (CLOUD_PROGRAMS.has(program))
    return positionals(args).some((w) => CLOUD_FINAL.has(w.toLowerCase()))
      ? 'irreversible'
      : 'outside'
  if (SQL_CLIENTS.has(program)) {
    const all = [...args, io.body ?? ''].join(' ')
    return SQL_CHANGE.test(all) || io.fetched ? 'irreversible' : 'outside'
  }
  if (program === 'redis-cli' || program === 'valkey-cli' || program === 'memcached-tool')
    return args.some((a) =>
      /^(?:flushall|flushdb|del|unlink|set|mset|expire|rename|restore|config|shutdown|debug|lpush|rpush|hset|sadd|zadd|incr|decr|eval|script)$/i.test(
        a
      )
    )
      ? 'irreversible'
      : 'outside'
  if (NETWORK_PROGRAMS.has(program)) {
    if (program === 'npx' || program === 'bunx' || program === 'pnpx') {
      const rest = positionals(pastOptions(args, /^(?:-p|--package|-c|--call)$/))
      if (rest[0] && FINAL_PROGRAMS.has(programName(rest[0]))) return 'irreversible'
    }
    return 'outside'
  }
  if (program === 'go' || program === 'cargo') {
    const sub = positionals(args)[0] ?? ''
    if (sub === 'publish') return 'irreversible'
    if (/^(?:get|install|mod|login|add|update|owner|yank)$/.test(sub)) return 'outside'
    return 'outside'
  }
  if (
    /^(?:make|gmake|tsc|eslint|prettier|vitest|jest|mocha|pytest|vite|electron-vite|webpack|rollup|esbuild|turbo|nx|lerna|cmake|ninja|gradle|mvn|xcodebuild|swiftc|clang|gcc|cc|rustc)$/.test(
      program
    )
  )
    // The project's own tools: they may write the project, and some run its
    // code (a Makefile, a test): the rules cannot tell what that does.
    return 'unknown'
  // An unknown program, a script, a relative path: code the rules cannot read.
  return 'outside'
}

function shellLevel(
  args: string[],
  ctx: Context,
  io: Io,
  depth: number,
  processes: (string | undefined)[]
): RuleLevel {
  let j = 0
  let script: string | null = null
  let syntaxOnly = false
  while (j < args.length) {
    const a = args[j]
    if (a === '--') {
      j++
      break
    }
    if (/^-o$|^\+o$|^--rcfile$|^--init-file$/.test(a)) {
      j += 2
      continue
    }
    if (/^[-+][A-Za-z]+$/.test(a)) {
      if (a.includes('c') && a.startsWith('-')) {
        script = args[j + 1] ?? ''
        j += 2
        break
      }
      if (a.includes('n')) syntaxOnly = true
      j++
      continue
    }
    if (a.startsWith('--')) {
      j++
      continue
    }
    break
  }
  if (script !== null) return scriptLevel(script, { ...ctx }, depth + 1)
  const file = args[j]
  if (file !== undefined) {
    if (syntaxOnly) return 'reads'
    return runsFetched(file, processes[j], io, ctx) ? 'irreversible' : 'outside'
  }
  if (io.body !== undefined) return scriptLevel(io.body, { ...ctx }, depth + 1)
  return io.fetched ? 'irreversible' : 'outside'
}

/** Code given on the command line: deleting is hard to undo, the rest
 *  reaches outside as far as the rules can tell. */
const CODE_DELETES =
  /\b(?:rmSync|rmdirSync|unlinkSync|rm|rmdir|unlink|remove|removedirs|rmtree|rimraf|deleteFile|delete_file|Remove-Item|FileUtils\.rm\w*|empty trash)\b|\brm\s+-[a-z]*[rf]/i

function interpreterLevel(
  program: string,
  args: string[],
  ctx: Context,
  io: Io,
  depth: number
): RuleLevel {
  if (program === 'bun') {
    const sub = positionals(args)[0] ?? ''
    if (/^(?:publish)$/.test(sub)) return 'irreversible'
    if (/^(?:install|i|add|remove|rm|update|upgrade|link|create|init|x|pm)$/.test(sub))
      return 'outside'
    if (sub === 'run' || sub === 'test') return scriptRunLevel(positionals(args)[1] ?? '')
  }
  if (program === 'osascript') {
    const code = optionValues(args, ['-e'], []).join('\n')
    return /\b(?:delete|empty|quit|do shell script|erase|remove|restart|shut down|log out|keystroke)\b/i.test(
      code
    )
      ? 'irreversible'
      : 'outside'
  }
  const code = optionValues(args, ['-e', '-c', '-p', '-r'], ['--eval', '--print', '--command'])
  if (code.length) {
    const body = code.join('\n')
    if (CODE_DELETES.test(body)) return 'irreversible'
    const shell =
      /\b(?:execSync|exec|spawnSync|spawn|system|popen|subprocess\.\w+|os\.system)\s*\(\s*(["'`])([^"'`]*)\1/.exec(
        body
      )
    if (shell) return combine('outside', scriptLevel(shell[2], { ...ctx }, depth + 1))
    return 'outside'
  }
  const file = positionals(args)[0]
  if (file && runsFetched(file, undefined, io, ctx)) return 'irreversible'
  if (!file && io.fetched) return 'irreversible'
  return 'outside'
}

/** A project script run by name (`npm run deploy`): the rules cannot read
 *  it; one whose name says it ships or removes something reaches outside. */
function scriptRunLevel(name: string): RuleLevel {
  return /deploy|publish|release|ship|push|prod|upload|clean|reset|nuke|wipe|drop|destroy|migrat|seed/i.test(
    name
  )
    ? 'outside'
    : 'unknown'
}

function findLevel(args: string[], ctx: Context, io: Io, depth: number): RuleLevel {
  if (args.includes('-delete')) return 'irreversible'
  let level: RuleLevel = 'reads'
  const starts: string[] = []
  let k = 0
  while (k < args.length && !/^[-(!]/.test(args[k])) starts.push(args[k++])
  level = combine(level, starts.length ? readArgs(starts, ctx) : 'reads')
  for (; k < args.length; k++) {
    const a = args[k]
    if (/^-(?:exec|execdir|ok|okdir)$/.test(a)) {
      const end = args.findIndex((x, m) => m > k && (x === ';' || x === '+'))
      const inner = args.slice(k + 1, end === -1 ? undefined : end).filter((x) => x !== '{}')
      level = combine(level, inner.length ? argvLevel(inner, ctx, io, depth + 1) : 'outside')
      k = end === -1 ? args.length : end
    } else if (/^-(?:fprint|fprint0|fprintf|fls)$/.test(a)) {
      level = combine(level, writeArgs([args[k + 1] ?? ''], ctx))
      k++
    }
  }
  return level
}

function sedLevel(args: string[], ctx: Context): RuleLevel {
  const inPlace = args.some(
    (a) => /^--in-place(?:=|$)/.test(a) || (/^-[A-Za-z]*[iI]/.test(a) && !a.startsWith('--'))
  )
  const scripts = optionValues(args, ['-e'], ['--expression'])
  if (args.some((a) => a === '-f' || a.startsWith('--file'))) return 'outside'
  // Positionals, with the values of -e, -i's suffix and -l taken out.
  const rest: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k]
    if (a === '-e' || a === '--expression' || a === '-l') {
      k++
      continue
    }
    if (/^-[iI]$/.test(a) && args[k + 1] === '') {
      k++
      continue
    }
    if (!isFlag(a)) rest.push(a)
  }
  const files = scripts.length ? rest : rest.slice(1)
  const programs = scripts.length ? scripts : rest.slice(0, 1)
  // `w file`, `W`, and `e` (GNU: run a command) inside the script.
  if (programs.some((p) => /(?:^|[;{}\n])\s*[wWe](?:\s|$)|\/[gpIiMm0-9]*w\s+\S/.test(p)))
    return 'outside'
  if (inPlace) return files.length ? writeArgs(files, ctx) : 'project'
  return readArgs(files, ctx)
}

const GIT_COMMAND_KEYS =
  /^(?:core\.(?:pager|fsmonitor|sshcommand|editor|hookspath|askpass|gitproxy)|alias\..+|.+\.textconv|diff\.external|diff\..+\.command|merge\..+\.driver|credential\..*helper|gpg\.program|gpg\..+\.program|sequence\.editor|filter\..+\.(?:clean|smudge|process)|uploadpack\.packobjectshook|pager\..+|interactive\.difffilter|include\.path|includeif\..+|protocol\..+|url\..+)$/i

const GIT_READ = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'blame',
  'describe',
  'shortlog',
  'cat-file',
  'grep',
  'whatchanged',
  'rev-list',
  'merge-base',
  'name-rev',
  'for-each-ref',
  'show-ref',
  'count-objects',
  'check-ignore',
  'check-attr',
  'diff-tree',
  'diff-index',
  'diff-files',
  'help',
  'version',
  'request-pull',
  'range-diff',
  'show-branch',
  'verify-commit',
  'verify-tag'
])
const GIT_PROJECT = new Set([
  'add',
  'commit',
  'merge',
  'cherry-pick',
  'revert',
  'mv',
  'rm',
  'init',
  'apply',
  'am',
  'notes',
  'tag',
  'mergetool',
  'sparse-checkout',
  'restore',
  'bisect'
])

function gitLevel(args: string[], ctx: Context, io: Io, depth: number): RuleLevel {
  let j = 0
  let level: RuleLevel = 'reads'
  let proof = true
  let at: Context = ctx
  while (j < args.length && args[j].startsWith('-')) {
    const a = args[j]
    if (a === '-C' && j + 1 < args.length) {
      at = { base: ctx.base, dir: resolve(ctx.dir, args[j + 1]) }
      j += 2
    } else if (a === '-c' && j + 1 < args.length) {
      // A setting for this one run: one that names a program runs it.
      const [key, ...value] = args[j + 1].split('=')
      if (GIT_COMMAND_KEYS.test(key))
        level = combine(
          level,
          combine('outside', scriptLevel(value.join('='), { ...ctx }, depth + 1))
        )
      proof = false
      j += 2
    } else if (
      /^--(?:git-dir|work-tree|namespace|exec-path|super-prefix|config-env)(?:=|$)/.test(a)
    ) {
      proof = false
      j += a.includes('=') ? 1 : 2
    } else j++
  }
  const sub = args[j] ?? ''
  const rest = args.slice(j + 1)
  const elsewhere = at.dir === null || !inside(at.dir, ctx.base)
  const done = (found: RuleLevel): RuleLevel => {
    let result = combine(level, found)
    if (elsewhere && result !== 'reads' && result !== 'unknown') result = combine(result, 'outside')
    if (elsewhere && (result === 'reads' || result === 'unknown')) result = 'outside'
    return !proof && result === 'reads' ? 'unknown' : result
  }
  if (GIT_READ.has(sub)) {
    const out = optionValues(rest, [], ['--output'])
    if (out.length) return done(writeArgs(out, at))
    if (
      rest.some((a) => /^(?:-O|--open-files-in-pager|--ext-diff)(?:=|$)/.test(a)) ||
      rest.some((a) => /^-O./.test(a))
    )
      return done('outside')
    return done('reads')
  }
  if (sub === 'config') return done(gitConfigLevel(rest))
  if (sub === 'push') {
    const destructive =
      rest.some((a) =>
        /^--(?:force|force-with-lease|force-if-includes|delete|mirror|prune)(?:=|$)/.test(a)
      ) ||
      hasFlag(
        rest.filter((a) => !a.startsWith('--')),
        'fd'
      ) ||
      positionals(rest).some((a) => /^\+/.test(a) || /^:/.test(a))
    return done(destructive ? 'irreversible' : 'outside')
  }
  if (/^(?:pull|fetch|clone|ls-remote|remote|submodule|lfs|svn|p4|archive)$/.test(sub)) {
    if (sub === 'submodule') {
      const k = rest.indexOf('foreach')
      if (k !== -1) {
        const inner = rest
          .slice(k + 1)
          .filter((a) => a !== '--recursive' && a !== '-q' && a !== '--quiet')
        return done(combine('project', scriptLevel(inner.join(' '), { ...ctx }, depth + 1)))
      }
      if (rest[0] === 'status' || rest[0] === 'summary') return done('reads')
    }
    if (
      sub === 'remote' &&
      (rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' || rest[0] === 'get-url')
    )
      return done('reads')
    if (sub === 'remote' && /^(?:add|rename|set-url|set-head|set-branches)$/.test(rest[0] ?? ''))
      return done('project')
    if (sub === 'remote' && /^(?:remove|rm|prune)$/.test(rest[0] ?? '')) return done('irreversible')
    if (sub === 'archive') {
      const out = optionValues(rest, ['-o'], ['--output'])
      return done(out.length ? combine('outside', writeArgs(out, at)) : 'reads')
    }
    return done('outside')
  }
  if (sub === 'send-email') return done('irreversible')
  if (sub === 'reset')
    return done(rest.some((a) => /^--(?:hard|merge|keep)$/.test(a)) ? 'irreversible' : 'project')
  if (sub === 'clean') {
    if (
      hasFlag(
        rest.filter((a) => !a.startsWith('--')),
        'n'
      ) ||
      rest.includes('--dry-run')
    )
      return done('reads')
    return done(
      hasFlag(
        rest.filter((a) => !a.startsWith('--')),
        'f'
      ) || rest.includes('--force')
        ? 'irreversible'
        : 'project'
    )
  }
  if (sub === 'checkout') {
    if (
      hasFlag(
        rest.filter((a) => !a.startsWith('--')),
        'f'
      ) ||
      rest.includes('--force') ||
      rest.includes('--')
    )
      return done('irreversible')
    const names = rest.filter(
      (a, k) => !isFlag(a) && !/^-[bBt]$|^--orphan$|^--track$/.test(rest[k - 1] ?? '')
    )
    if (rest.some((a) => /^-[bB]$|^--orphan$/.test(a)) && names.length <= 1) return done('project')
    // A tree and paths, or a path alone: what was not committed is gone.
    if (
      names.length >= 2 ||
      names.some((a) => a === '.' || /\.[A-Za-z0-9]+$/.test(a) || a.includes('*'))
    )
      return done('irreversible')
    return done('project')
  }
  if (sub === 'switch')
    return done(
      rest.some((a) => /^--(?:force|discard-changes)$/.test(a)) ||
        hasFlag(
          rest.filter((a) => !a.startsWith('--')),
          'f'
        )
        ? 'irreversible'
        : 'project'
    )
  if (sub === 'restore') {
    const staged = rest.includes('--staged') || rest.includes('-S')
    const worktree = rest.includes('--worktree') || rest.includes('-W')
    return done(staged && !worktree ? 'project' : 'irreversible')
  }
  if (sub === 'branch') {
    const short = rest.filter((a) => !a.startsWith('--'))
    if (
      rest.includes('-D') ||
      rest.includes('-M') ||
      rest.includes('-C') ||
      (rest.includes('--delete') && rest.includes('--force')) ||
      hasFlag(short, 'f')
    )
      return done('irreversible')
    if (
      !positionals(rest).length &&
      !rest.some((a) =>
        /^-[dmc]$|^--(?:delete|move|copy|set-upstream-to|unset-upstream|edit-description)/.test(a)
      )
    )
      return done('reads')
    return done('project')
  }
  if (sub === 'stash') {
    if (/^(?:drop|clear)$/.test(rest[0] ?? '')) return done('irreversible')
    if (/^(?:list|show)$/.test(rest[0] ?? '')) return done('reads')
    return done('project')
  }
  if (sub === 'tag')
    return done(
      rest.length === 0 || /^(?:-l|--list|-n\d*|--contains|--points-at)$/.test(rest[0])
        ? 'reads'
        : 'project'
    )
  if (sub === 'rebase') {
    const exec = optionValues(rest, ['-x'], ['--exec'])
    let found: RuleLevel = 'project'
    for (const e of exec) found = combine(found, scriptLevel(e, { ...ctx }, depth + 1))
    return done(found)
  }
  if (sub === 'bisect' && rest[0] === 'run')
    return done(combine('project', argvLevel(rest.slice(1), ctx, io, depth + 1)))
  if (sub === 'worktree') {
    if (rest[0] === 'list') return done('reads')
    if (rest[0] === 'remove' && hasFlag(rest, 'f', '--force')) return done('irreversible')
    return done('project')
  }
  if (sub === 'reflog')
    return done(/^(?:expire|delete)$/.test(rest[0] ?? '') ? 'irreversible' : 'reads')
  if (
    /^(?:filter-branch|filter-repo|update-ref|replace|prune|gc|repack|maintenance|fast-import)$/.test(
      sub
    )
  )
    return done(
      sub === 'gc' && !rest.some((a) => a.startsWith('--prune')) ? 'project' : 'irreversible'
    )
  if (sub === 'commit' && optionValues(rest, [], ['--fixup']).length === 0) return done('project')
  if (GIT_PROJECT.has(sub)) return done('project')
  if (/^(?:difftool|mergetool|web--browse|instaweb|daemon|credential|credential-\w+)$/.test(sub))
    return done('outside')
  // An alias or a command git finds on the path: anything.
  return done('outside')
}

function gitConfigLevel(rest: string[]): RuleLevel {
  const global = rest.some((a) => /^--(?:global|system)$/.test(a))
  const fileOpt = optionValues(rest, ['-f'], ['--file'])
  const reads = rest.some((a) =>
    /^--(?:get|get-all|get-regexp|get-urlmatch|list|show-origin|show-scope|name-only)$|^-l$/.test(a)
  )
  const words = positionals(
    rest.filter((_a, k) => !/^(?:-f|--file|--type|--default)$/.test(rest[k - 1] ?? ''))
  )
  const sub = words[0] ?? ''
  const isVerb = /^(?:get|set|unset|list|rename-section|remove-section|edit)$/.test(sub)
  const key = isVerb ? (words[1] ?? '') : sub
  const values = isVerb ? words.slice(2) : words.slice(1)
  const setting =
    !reads &&
    (rest.some((a) =>
      /^--(?:add|replace-all|unset|unset-all|rename-section|remove-section)$/.test(a)
    ) ||
      sub === 'set' ||
      sub === 'unset' ||
      sub === 'rename-section' ||
      sub === 'remove-section' ||
      values.length > 0)
  if (rest.some((a) => a === '-e' || a === '--edit') || sub === 'edit') return 'outside'
  if (!setting) return global ? 'outside' : 'reads'
  if (GIT_COMMAND_KEYS.test(key) || global || fileOpt.length) return 'irreversible'
  return 'project'
}

function ghLevel(args: string[]): RuleLevel {
  const words = positionals(
    args.filter(
      (_a, k) =>
        !/^(?:-R|--repo|-X|--method|-f|-F|--field|--raw-field|-H|--header|-q|--jq|-t|--template|--visibility)$/.test(
          args[k - 1] ?? ''
        )
    )
  )
  const [noun = '', verb = ''] = words
  if (noun === 'api') {
    const method = optionValues(args, ['-X'], ['--method']).join(' ').toUpperCase()
    if (/DELETE|PUT|PATCH/.test(method)) return 'irreversible'
    return 'outside'
  }
  if (/^(?:delete|merge|archive|transfer|rename|unarchive|lock)$/.test(verb)) return 'irreversible'
  if (noun === 'repo' && /^(?:edit|create|fork|sync|deploy-key)$/.test(verb))
    return verb === 'edit' || verb === 'sync' ? 'irreversible' : 'outside'
  if (noun === 'gist' && /^(?:create|edit|clone)$/.test(verb))
    return verb === 'clone' ? 'outside' : 'irreversible'
  if (noun === 'release' && /^(?:create|upload|edit)$/.test(verb)) return 'irreversible'
  if (
    /^(?:secret|variable|ssh-key|gpg-key|ruleset|cache)$/.test(noun) &&
    /^(?:set|delete|remove|add)$/.test(verb)
  )
    return 'irreversible'
  return 'outside'
}

const PACKAGE_FINAL =
  /^(?:publish|unpublish|deprecate|dist-tag|owner|access|token|adduser|login|logout|team|org|star|unstar|hook)$/
const PACKAGE_INSTALL =
  /^(?:install|i|add|ci|update|up|upgrade|remove|rm|uninstall|un|link|dlx|create|init|audit|rebuild|dedupe|prune|outdated|fund|ping|search|view|info|v|show|doctor|import|patch|patch-commit|why|pack)$/
const PACKAGE_READ = /^(?:ls|list|ll|la|root|prefix|bin|help|explain|query)$/

function packageLevel(
  program: string,
  args: string[],
  ctx: Context,
  io: Io,
  depth: number
): RuleLevel {
  // Global options before the command: `--filter app`, `-C dir`, `-w`, `--prefix d`.
  let j = 0
  while (j < args.length && args[j].startsWith('-')) {
    j +=
      /^(?:--filter|-F|-C|--dir|--prefix|--workspace|-w|--cwd)$/.test(args[j]) &&
      !/^-w$/.test(args[j])
        ? 2
        : 1
  }
  const sub = args[j] ?? ''
  const rest = args.slice(j + 1)
  if (PACKAGE_FINAL.test(sub)) return 'irreversible'
  if (sub === 'config' || sub === 'c' || sub === 'set') {
    // Setting the registry, the auth or a script shell steers every install after it.
    if (/^(?:set|delete|edit|fix)$/.test(rest[0] ?? '') || sub === 'set') return 'irreversible'
    return 'outside'
  }
  if (sub === 'exec' || sub === 'x' || (program === 'yarn' && sub === 'node')) {
    const next =
      sub === 'exec' || sub === 'x'
        ? pastOptions(rest, /^(?:-c|--call|-p|--package)$/)
        : ['node', ...rest]
    return next.length ? combine('outside', argvLevel(next, ctx, io, depth + 1)) : 'outside'
  }
  if (PACKAGE_INSTALL.test(sub)) return 'outside'
  if (PACKAGE_READ.test(sub)) return 'reads'
  if (/^(?:run|run-script|rum|urn)$/.test(sub)) return scriptRunLevel(positionals(rest)[0] ?? '')
  if (/^(?:test|t|tst|start|stop|restart)$/.test(sub)) return scriptRunLevel(sub)
  if (!sub) return program === 'yarn' ? 'outside' : 'reads'
  // `yarn build`, `pnpm lint`: a script of the project, by its name.
  if (program !== 'npm') return scriptRunLevel(sub)
  return 'outside'
}

function fetchLevel(program: string, args: string[], ctx: Context, io: Io): RuleLevel {
  const methods = [
    ...optionValues(args, ['-X'], ['--request', '--method']),
    ...(program === 'http' || program === 'https' || program === 'xh'
      ? positionals(args).slice(0, 1)
      : [])
  ].map((m) => m.toUpperCase())
  let level: RuleLevel = 'outside'
  if (methods.some((m) => m === 'DELETE' || m === 'PURGE')) level = 'irreversible'
  const outputs = [
    ...optionValues(args, ['-o'], ['--output']),
    ...(program === 'wget' ? optionValues(args, ['-O'], ['--output-document']) : [])
  ].filter((o) => o !== '-')
  for (const output of outputs) {
    const path = resolve(ctx.dir, output)
    if (path) io.downloaded.add(path)
    level = combine(level, writeLevel(path, ctx))
  }
  // Data sent out of a file: a secret read and sent.
  for (const data of optionValues(
    args,
    ['-d', '-F', '-T'],
    ['--data', '--data-binary', '--upload-file', '--form']
  ))
    if (data.startsWith('@'))
      level = combine(level, readLevel(resolve(ctx.dir, data.slice(1)), ctx))
  return level
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
