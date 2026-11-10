/**
 * How much a permission request can touch, from RULES alone (PRDCT-4331): a
 * pure reading of the tool's name and its input, with no model and nothing
 * read from disk, so the card shows a level the instant it arrives and the
 * explainer's model can only RAISE it (`raiseLevel`), never lower it. The
 * model reads text someone else may have written (the command, the agent's
 * words); the rules do not read the text as instructions, they only match it.
 *
 * Four levels, no percentage:
 *   reads       reads only, changes nothing
 *   project     changes files of the project (the session's working folder)
 *   outside     reaches outside the project, the machine, or the network
 *   irreversible  hard to undo: deletes, overwrites history, runs downloaded
 *               code, acts as the administrator, sends or publishes
 *
 * When the rules cannot tell (an unknown tool, an unknown program, a path
 * they cannot place), they answer `outside`, the cautious level: never
 * `reads`. `irreversible` is kept for what the rules KNOW is hard to undo.
 *
 * Pure, and free of Node and Electron: the renderer's card and the session
 * host both read it.
 */

export const RISK_LEVELS = ['reads', 'project', 'outside', 'irreversible'] as const
export type RiskLevel = (typeof RISK_LEVELS)[number]

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

/** The higher of the levels: the one rule of the model's reading, which may
 *  raise the floor and never lower it. An unknown value raises nothing. */
export function raiseLevel(floor: RiskLevel, ...others: readonly unknown[]): RiskLevel {
  let level = floor
  for (const other of others) if (isRiskLevel(other) && rank(other) > rank(level)) level = other
  return level
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

/** Claude's built-in tools that read and change nothing. */
const READ_TOOLS = new Set([
  'Read',
  'Glob',
  'Grep',
  'LS',
  'NotebookRead',
  'TodoWrite',
  'TodoRead',
  'TaskOutput',
  'BashOutput',
  'ToolSearch',
  'Skill',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool'
])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const NETWORK_TOOLS = new Set(['WebFetch', 'WebSearch'])
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
const CODEX_COMMAND = new Set(['item/commandExecution/requestApproval', 'execCommandApproval'])
const CODEX_EDIT = new Set(['item/fileChange/requestApproval', 'applyPatchApproval'])

/** An MCP tool whose name says it removes, sends or publishes something. */
const MCP_FINAL =
  /(?:^|[_\-.])(?:delete|remove|drop|destroy|purge|erase|wipe|send|publish|merge|deploy|release|transfer|pay|cancel|revoke|archive)(?:$|[_\-.A-Z])/i

/** The level of one permission request, from the rules alone. */
export function riskFloor({ toolName, input, cwd }: RiskInput): RiskLevel {
  const name = toolName ?? ''
  const p = record(input)
  if (READ_TOOLS.has(name)) {
    // A read of a file outside the working folder reaches outside it.
    const path = text(p.file_path) || text(p.path) || text(p.notebook_path)
    return path && placePath(path, cwd) !== 'inside' ? 'outside' : 'reads'
  }
  if (WRITE_TOOLS.has(name)) {
    const path = text(p.file_path) || text(p.notebook_path)
    return writeLevel(path, cwd)
  }
  if (NETWORK_TOOLS.has(name)) return 'outside'
  if (SHELL_TOOLS.has(name)) return commandLevel(text(p.command), cwd)
  if (name === 'ExitPlanMode') return 'project'
  if (CODEX_COMMAND.has(name)) {
    const command = Array.isArray(p.command)
      ? p.command.filter((v): v is string => typeof v === 'string').join(' ')
      : text(p.command)
    return commandLevel(command, text(p.cwd) || cwd)
  }
  if (CODEX_EDIT.has(name)) {
    const root = text(p.grantRoot)
    return root ? writeLevel(root, cwd) : 'project'
  }
  if (name.startsWith('mcp__'))
    return MCP_FINAL.test(name.split('__').slice(2).join('__') || name) ? 'irreversible' : 'outside'
  // An unknown tool: the cautious level.
  return 'outside'
}

// ── Paths ──

type Place = 'inside' | 'outside' | 'profile' | 'device'

/** Files that change how every shell, every login or the machine starts. */
const PROFILE_PATH =
  /(?:^|\/)(?:\.zshrc|\.zshenv|\.zprofile|\.zlogin|\.bashrc|\.bash_profile|\.bash_login|\.profile|\.config\/fish\/config\.fish|\.ssh\/[^/]+|\.gitconfig|\.npmrc|crontab)$|^\/etc\/|^\/Library\/LaunchDaemons\/|\/Library\/LaunchAgents\//

const normalise = (path: string): string => {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return '/' + parts.join('/')
}

/** Where a path sits against the working folder. A relative path is inside
 *  unless it climbs out; `~` and `$HOME` are outside; a path with a variable
 *  or a glob the rules cannot resolve is outside. */
export function placePath(raw: string, cwd?: string): Place {
  const path = raw.trim().replace(/^['"]|['"]$/g, '')
  if (/^\/dev\/(?:null|stdout|stderr|stdin|tty|fd\/\d)$/.test(path)) return 'device'
  if (/^(?:~|\$HOME|\$\{HOME\})/.test(path)) {
    return PROFILE_PATH.test(path.replace(/^(?:~|\$HOME|\$\{HOME\})/, '')) ? 'profile' : 'outside'
  }
  if (/\$/.test(path)) return 'outside'
  const base = cwd ? normalise(cwd) : null
  if (path.startsWith('/')) {
    const full = normalise(path)
    if (PROFILE_PATH.test(full)) return 'profile'
    if (base && (full === base || full.startsWith(base === '/' ? '/' : base + '/'))) return 'inside'
    return 'outside'
  }
  // Relative: inside unless it climbs above the working folder.
  let depth = 0
  for (const part of path.split('/')) {
    if (part === '..') depth--
    else if (part !== '' && part !== '.') depth++
    if (depth < 0) return 'outside'
  }
  return 'inside'
}

function writeLevel(path: string, cwd?: string): RiskLevel {
  if (!path) return 'outside'
  const place = placePath(path, cwd)
  if (place === 'profile') return 'irreversible'
  if (place === 'device') return 'reads'
  if (place === 'inside') return 'project'
  return 'outside'
}

// ── Commands ──

/** Programs that read and change nothing, whatever their arguments (their
 *  paths still place them). */
const READ_PROGRAMS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'echo',
  'printf',
  'pwd',
  'wc',
  'sort',
  'uniq',
  'cut',
  'tr',
  'diff',
  'cmp',
  'file',
  'stat',
  'which',
  'whereis',
  'type',
  'command',
  'du',
  'df',
  'tree',
  'less',
  'more',
  'jq',
  'yq',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'date',
  'whoami',
  'id',
  'hostname',
  'uname',
  'printenv',
  'true',
  'false',
  'test',
  '[',
  'column',
  'nl',
  'xxd',
  'od',
  'hexdump',
  'md5',
  'md5sum',
  'shasum',
  'sha1sum',
  'sha256sum',
  'ps',
  'sleep',
  'cd',
  'pushd',
  'popd',
  'fd',
  'bat',
  'comm',
  'paste',
  'fold',
  'fmt',
  'rev',
  'seq',
  'expr',
  'lsof',
  'uptime',
  'sw_vers',
  'locale',
  'man',
  'help',
  'history',
  'set',
  'export',
  'unset',
  'alias',
  'wait',
  'time',
  'exit'
])
/** Programs that reach the network or another machine. */
const NETWORK_PROGRAMS = new Set([
  'curl',
  'wget',
  'http',
  'https',
  'ssh',
  'scp',
  'sftp',
  'rsync',
  'nc',
  'netcat',
  'telnet',
  'ftp',
  'ping',
  'dig',
  'nslookup',
  'host',
  'traceroute',
  'gh',
  'aws',
  'gcloud',
  'az',
  'kubectl',
  'docker',
  'podman',
  'heroku',
  'vercel',
  'netlify',
  'fly',
  'flyctl',
  'wrangler',
  'firebase',
  'stripe',
  'open',
  'osascript',
  'brew',
  'apt',
  'apt-get',
  'yum',
  'dnf',
  'pip',
  'pip3',
  'pipx',
  'gem',
  'cargo',
  'go',
  'npx',
  'bunx',
  'pnpx',
  'mail',
  'sendmail'
])
/** Programs that act on the machine itself, hard to take back. */
const FINAL_PROGRAMS = new Set([
  'sudo',
  'su',
  'doas',
  'rm',
  'shred',
  'dd',
  'mkfs',
  'diskutil',
  'fdisk',
  'shutdown',
  'reboot',
  'halt',
  'launchctl',
  'crontab',
  'chsh',
  'passwd',
  'dscl',
  'security',
  'srm',
  'truncate'
])
/** Programs that change files where their paths say. */
const WRITE_PROGRAMS = new Set([
  'mkdir',
  'touch',
  'cp',
  'mv',
  'ln',
  'chmod',
  'chown',
  'rmdir',
  'tee',
  'patch',
  'unzip',
  'tar',
  'zip',
  'gzip',
  'gunzip',
  'install'
])
/** Programs that run something else, named after them. */
const WRAPPERS = new Set(['env', 'nohup', 'nice', 'timeout', 'xargs', 'exec', 'caffeinate'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'fish'])
/** The project's own tool runners: they change the project, never more. */
const PROJECT_RUNNERS = new Set([
  'tsc',
  'eslint',
  'prettier',
  'vitest',
  'jest',
  'pytest',
  'make',
  'cargo-build',
  'electron-vite',
  'vite'
])

/** The level of a shell command line, the highest of its parts. */
export function commandLevel(command: string, cwd?: string): RiskLevel {
  const line = command.trim()
  if (!line) return 'outside'
  // Downloaded code run at once: `curl … | sh`, `bash <(curl …)`.
  if (
    /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|python3?|node|perl|ruby)\b/.test(
      line
    ) ||
    /\b(?:sh|bash|zsh)\s+<\(\s*(?:curl|wget)\b/.test(line) ||
    /\beval\s+["']?\$\(\s*(?:curl|wget)\b/.test(line)
  )
    return 'irreversible'
  let level: RiskLevel = 'reads'
  // What runs inside `$(…)` and backticks counts as well.
  for (const inner of substitutions(line)) level = raiseLevel(level, commandLevel(inner, cwd))
  for (const segment of splitCommands(line)) {
    level = raiseLevel(level, segmentLevel(segment, cwd))
    if (level === 'irreversible') return level
  }
  return level
}

function substitutions(line: string): string[] {
  const found: string[] = []
  const dollar = /\$\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g
  for (let m = dollar.exec(line); m; m = dollar.exec(line)) found.push(m[1])
  const tick = /`([^`]*)`/g
  for (let m = tick.exec(line); m; m = tick.exec(line)) found.push(m[1])
  return found
}

/** The simple commands of a line: split on `;`, `&&`, `||`, `|`, `&` and
 *  new lines outside quotes. */
export function splitCommands(line: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\' && quote === '"' && i + 1 < line.length) {
        current += c + line[++i]
        continue
      }
      if (c === quote) quote = null
      current += c
      continue
    }
    if (c === '\\' && i + 1 < line.length) {
      current += c + line[++i]
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      current += c
      continue
    }
    // `>&2`, `2>&1`, `&>` are redirections, not a background `&`.
    if (c === '&' && (line[i - 1] === '>' || line[i + 1] === '>')) {
      current += c
      continue
    }
    if (c === ';' || c === '\n' || c === '|' || c === '&') {
      if (current.trim()) parts.push(current.trim())
      current = ''
      if ((c === '|' || c === '&') && line[i + 1] === c) i++
      continue
    }
    current += c
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/** A command's words, quotes taken off. */
function words(segment: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let any = false
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < segment.length) current += segment[++i]
      else current += c
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      any = true
      continue
    }
    if (c === '\\' && i + 1 < segment.length) {
      current += segment[++i]
      any = true
      continue
    }
    if (/\s/.test(c)) {
      if (current || any) out.push(current)
      current = ''
      any = false
      continue
    }
    current += c
  }
  if (current || any) out.push(current)
  return out
}

/** Redirections out of a command (`> file`, `>> file`, `2> file`), and the
 *  words left once they are taken off. */
function redirections(all: string[]): { targets: string[]; rest: string[] } {
  const targets: string[] = []
  const rest: string[] = []
  for (let i = 0; i < all.length; i++) {
    const w = all[i]
    const m = /^(?:\d|&)?>{1,2}(.*)$/.exec(w)
    if (m && !/^\d?>&\d$/.test(w) && !/^\d?>&-$/.test(w)) {
      const target = m[1] || all[++i] || ''
      if (!/^&\d$/.test(target)) targets.push(target)
      continue
    }
    if (/^\d?<{1,3}/.test(w)) {
      if (w.replace(/^\d?<{1,3}/, '') === '') i++
      continue
    }
    rest.push(w)
  }
  return { targets, rest }
}

const pathArgs = (args: string[]): string[] =>
  args.filter((a) => a && !a.startsWith('-') && /[/~.]|^\w[\w.-]*$/.test(a))

/** The level the paths of a read-only command reach: outside when one of
 *  them is outside the project. Arguments that are patterns, not paths, are
 *  only counted when they look like one (a slash or a tilde). */
function readPathsLevel(args: string[], cwd?: string): RiskLevel {
  for (const a of args) {
    if (a.startsWith('-')) continue
    if (!/^(?:~|\$HOME|\$\{HOME\}|\/|\.\.\/)/.test(a)) continue
    const place = placePath(a, cwd)
    if (place === 'outside' || place === 'profile') return 'outside'
  }
  return 'reads'
}

function segmentLevel(segment: string, cwd?: string): RiskLevel {
  const all = words(segment)
  const { targets, rest } = redirections(all)
  let level: RiskLevel = 'reads'
  for (const target of targets) level = raiseLevel(level, writeLevel(target, cwd))
  // Leading `VAR=value` assignments set the environment of the command.
  let i = 0
  while (i < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[i])) i++
  const argv = rest.slice(i)
  if (!argv.length) return level
  return raiseLevel(level, programLevel(argv, cwd))
}

function programLevel(argv: string[], cwd?: string): RiskLevel {
  const program = (argv[0].split('/').pop() ?? argv[0]).replace(/^\\/, '')
  const args = argv.slice(1)
  if (program === '(' || program === '{' || program === ')' || program === '}')
    return args.length ? programLevel(args, cwd) : 'reads'
  if (['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!'].includes(program))
    return args.length ? programLevel(args, cwd) : 'reads'
  if (program === 'for' || program === 'case' || program === 'esac') return 'reads'
  if (FINAL_PROGRAMS.has(program)) return 'irreversible'
  // `node --version`, `tool --help`: asking a program about itself.
  if (args.length === 1 && /^(?:--version|-v|-V|--help|-h)$/.test(args[0])) return 'reads'
  if (SHELLS.has(program)) {
    const c = args.indexOf('-c')
    if (c !== -1 && args[c + 1] !== undefined) return commandLevel(args[c + 1], cwd)
    if (args[0] === '-n') return 'reads'
    return 'outside'
  }
  if (WRAPPERS.has(program)) {
    // The program they run, past their own options and assignments.
    let j = 0
    while (
      j < args.length &&
      (args[j].startsWith('-') ||
        /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[j]) ||
        (program === 'timeout' && /^\d/.test(args[j])))
    )
      j++
    if (j >= args.length) return program === 'env' ? 'reads' : 'outside'
    return programLevel(args.slice(j), cwd)
  }
  if (program === 'git') return gitLevel(args, cwd)
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)) return packageLevel(program, args)
  if (program === 'find') {
    if (args.some((a) => a === '-delete')) return 'irreversible'
    const exec = args.findIndex((a) => a === '-exec' || a === '-execdir' || a === '-ok')
    if (exec !== -1) {
      const end = args.findIndex((a, k) => k > exec && (a === ';' || a === '\\;' || a === '+'))
      const inner = args.slice(exec + 1, end === -1 ? undefined : end).filter((a) => a !== '{}')
      return raiseLevel(
        readPathsLevel(args.slice(0, exec), cwd),
        inner.length ? programLevel(inner, cwd) : 'outside'
      )
    }
    return readPathsLevel(args, cwd)
  }
  if (program === 'sed' || program === 'perl') {
    const inPlace = args.some((a) => /^-i/.test(a) || /^-[a-zA-Z]*i/.test(a))
    if (program === 'perl' && !inPlace) return 'outside'
    if (!inPlace) return readPathsLevel(args, cwd)
    const files = pathArgs(args.slice(1))
    return files.length ? maxWrite(files, cwd) : 'project'
  }
  if (program === 'awk' || program === 'gawk') {
    const script = args.find((a) => !a.startsWith('-')) ?? ''
    if (/\bsystem\s*\(|[^>]>{1,2}\s*"|\|\s*"/.test(script)) return 'outside'
    return readPathsLevel(args, cwd)
  }
  if (program === 'tee') {
    const files = args.filter((a) => !a.startsWith('-'))
    return files.length ? maxWrite(files, cwd) : 'reads'
  }
  if (program === 'kill' || program === 'pkill' || program === 'killall') return 'outside'
  if (program === 'terraform' || program === 'pulumi')
    return /^(?:apply|destroy|import|state)$/.test(args[0] ?? '') ? 'irreversible' : 'outside'
  if (READ_PROGRAMS.has(program)) return readPathsLevel(args, cwd)
  if (NETWORK_PROGRAMS.has(program)) {
    if (
      program === 'curl' &&
      args.some((a, k) => /^-X$/.test(a) && /DELETE/i.test(args[k + 1] ?? ''))
    )
      return 'irreversible'
    if (program === 'gh')
      return /^(?:pr merge|repo delete|release create|release delete)/.test(
        args.slice(0, 2).join(' ')
      )
        ? 'irreversible'
        : 'outside'
    return 'outside'
  }
  if (WRITE_PROGRAMS.has(program)) {
    const files = pathArgs(args)
    return files.length ? maxWrite(files, cwd) : 'project'
  }
  if (PROJECT_RUNNERS.has(program)) return 'project'
  // An unknown program, a script, an interpreter: the cautious level.
  return 'outside'
}

function maxWrite(paths: string[], cwd?: string): RiskLevel {
  let level: RiskLevel = 'project'
  for (const path of paths) level = raiseLevel(level, writeLevel(path, cwd))
  return level
}

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
  'help',
  'version'
])
const GIT_PROJECT = new Set([
  'add',
  'commit',
  'switch',
  'merge',
  'rebase',
  'cherry-pick',
  'revert',
  'mv',
  'rm',
  'init',
  'apply',
  'am',
  'notes',
  'worktree',
  'submodule',
  'restore',
  'checkout',
  'stash',
  'tag',
  'branch',
  'config',
  'remote',
  'reset',
  'clean'
])
const GIT_NETWORK = new Set(['push', 'pull', 'fetch', 'clone', 'ls-remote', 'send-email'])

function gitLevel(args: string[], cwd?: string): RiskLevel {
  // `git -C dir …`, `git -c k=v …`: the subcommand is past them.
  let j = 0
  let where: string | undefined
  while (j < args.length && args[j].startsWith('-')) {
    if ((args[j] === '-C' || args[j] === '-c' || args[j] === '--git-dir') && j + 1 < args.length) {
      if (args[j] === '-C') where = args[j + 1]
      j += 2
    } else j++
  }
  const sub = args[j] ?? ''
  const rest = args.slice(j + 1)
  /** A short flag, alone or among others (`-f`, `-fu`). */
  const short = (letter: string): boolean =>
    rest.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(letter))
  const outsideRepo = where !== undefined && placePath(where, cwd) !== 'inside'
  if (GIT_READ.has(sub)) return outsideRepo ? 'outside' : 'reads'
  if (sub === 'push') {
    // Overwriting or deleting what the remote holds cannot be taken back.
    if (
      rest.some(
        (a) =>
          /^--force(?:-with-lease)?(?:=|$)/.test(a) ||
          a === '--delete' ||
          a === '--mirror' ||
          /^\+/.test(a) ||
          /^:[^/]/.test(a)
      ) ||
      short('f') ||
      short('d')
    )
      return 'irreversible'
    return 'outside'
  }
  if (GIT_NETWORK.has(sub)) return 'outside'
  if (sub === 'reset')
    return rest.includes('--hard') || rest.includes('--merge') ? 'irreversible' : 'project'
  if (sub === 'clean')
    return rest.some((a) => /^-[a-zA-Z]*[fx]/.test(a) || a === '--force')
      ? 'irreversible'
      : 'project'
  if (sub === 'branch') {
    if (rest.some((a) => a === '-D' || (a === '--delete' && rest.includes('--force'))))
      return 'irreversible'
    if (
      !rest.length ||
      rest.every((a) =>
        /^-(?:a|r|v|vv|l|-list|-all|-show-current|-contains|-merged|-no-merged)$/.test(a)
      )
    )
      return 'reads'
    return 'project'
  }
  if (sub === 'stash') {
    if (['drop', 'clear'].includes(rest[0] ?? '')) return 'irreversible'
    if (['list', 'show'].includes(rest[0] ?? '')) return 'reads'
    return 'project'
  }
  if (sub === 'checkout' || sub === 'restore') {
    // Discarding what is not committed cannot be taken back.
    if (sub === 'restore' && !rest.includes('--staged')) return 'irreversible'
    if (
      rest.includes('--') ||
      rest.includes('.') ||
      rest.includes('-f') ||
      rest.includes('--force')
    )
      return 'irreversible'
    return 'project'
  }
  if (sub === 'tag')
    return rest.length === 0 || rest[0] === '-l' || rest[0] === '--list' ? 'reads' : 'project'
  if (sub === 'remote')
    return rest.length === 0 || rest[0] === '-v' || rest[0] === 'show' ? 'reads' : 'project'
  if (sub === 'config')
    return rest.some((a) => a === '--get' || a === '--list' || a === '-l' || a === '--get-all')
      ? 'reads'
      : rest.includes('--global') || rest.includes('--system')
        ? 'outside'
        : 'project'
  if (sub === 'worktree')
    return rest[0] === 'list'
      ? 'reads'
      : rest[0] === 'remove' && rest.some((a) => a === '--force' || a === '-f')
        ? 'irreversible'
        : 'project'
  if (sub === 'reflog')
    return rest[0] === 'expire' || rest[0] === 'delete' ? 'irreversible' : 'reads'
  if (sub === 'filter-branch' || sub === 'filter-repo' || sub === 'update-ref')
    return 'irreversible'
  if (sub === 'gc' || sub === 'prune') return 'irreversible'
  if (GIT_PROJECT.has(sub)) return outsideRepo ? 'outside' : 'project'
  return 'outside'
}

const PACKAGE_INSTALL =
  /^(?:install|i|add|ci|update|up|upgrade|remove|rm|uninstall|un|link|dlx|create|init|exec|x)$/
const PACKAGE_FINAL =
  /^(?:publish|unpublish|deprecate|dist-tag|owner|access|token|adduser|login|logout)$/
const PACKAGE_READ =
  /^(?:ls|list|view|info|outdated|why|explain|audit|config|get|help|-v|--version|bin|root|prefix|search|doctor)$/

function packageLevel(program: string, args: string[]): RiskLevel {
  const sub = args.find((a) => !a.startsWith('-')) ?? ''
  if (PACKAGE_FINAL.test(sub)) return 'irreversible'
  if (PACKAGE_INSTALL.test(sub)) return 'outside'
  if (PACKAGE_READ.test(sub)) return 'reads'
  // `npm run build`, `npm test`, `yarn lint`, `bun x`: the project's own scripts.
  if (/^(?:run|run-script|test|t|start|build|lint|typecheck|format|dev)$/.test(sub))
    return 'project'
  if (program === 'yarn' && sub === '') return 'outside'
  if ((program === 'yarn' || program === 'pnpm' || program === 'bun') && sub) return 'project'
  return 'outside'
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
  'item/permissions/requestApproval': 'Asks for extra rights for the rest of the turn.',
  'mcpServer/elicitation/request': 'Uses a tool of a connected service.'
}

export function toolDescription(toolName: string | undefined): string {
  if (!toolName) return ''
  if (TOOL_DESCRIPTIONS[toolName]) return TOOL_DESCRIPTIONS[toolName]
  const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName)
  if (mcp) return `A tool named "${mcp[2]}" of the connected service "${mcp[1]}".`
  return ''
}
