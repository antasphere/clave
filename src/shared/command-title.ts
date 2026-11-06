/**
 * A shell command, said in a few words for a row that has no room for it:
 * `pkill …; cd ~/x/clave-app && exec npm run dev -- --flag > dev.log 2>&1`
 * reads "npm run dev in clave-app". Used where the agent gave no title of its
 * own for the command (Claude's Bash `description` is preferred wherever the
 * call carries one); the whole command stays in the row's tooltip.
 *
 * Deterministic on purpose: no model call, the same command always reads the
 * same, and a command it cannot read comes back trimmed rather than invented.
 */

const MAX = 60
/** A command this short is shown whole. */
const SHORT = 40

/** Steps that prepare or wait rather than do the work the command is for. */
const SETUP = new Set([
  'cd',
  'pushd',
  'popd',
  'export',
  'unset',
  'set',
  'source',
  '.',
  'sleep',
  'wait',
  'true',
  'false',
  ':',
  'echo',
  'printf',
  'mkdir',
  'pkill',
  'kill',
  'killall',
  'pgrep',
  'perl',
  'test',
  '['
])
/** Words that only wrap the program they precede. */
const WRAPPERS = new Set(['exec', 'env', 'nohup', 'time', 'command', 'builtin', 'caffeinate'])

interface Word {
  text: string
  /** Any part of it was quoted: never an operator, never a redirection. */
  quoted: boolean
}

/** Split a command into its top-level steps (on `&&`, `||`, `;`, `|`, `&`,
 *  newlines), each a list of words with quotes resolved. A pipe's later
 *  stages are marked so a step reads by its first stage only. */
function steps(command: string): { words: Word[]; piped: boolean }[] {
  const out: { words: Word[]; piped: boolean }[] = []
  let words: Word[] = []
  let word = ''
  let quoted = false
  let started = false
  let piped = false
  const endWord = (): void => {
    if (started) words.push({ text: word, quoted })
    word = ''
    quoted = false
    started = false
  }
  const endStep = (nextPiped: boolean): void => {
    endWord()
    if (words.length) out.push({ words, piped })
    words = []
    piped = nextPiped
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1)
      const end = close === -1 ? command.length : close
      word += command.slice(i + 1, end)
      quoted = true
      started = true
      i = end
    } else if (c === '\\' && i + 1 < command.length) {
      word += command[++i]
      started = true
    } else if (c === ' ' || c === '\t') endWord()
    else if (c === '\n' || c === ';') endStep(false)
    else if (c === '&' && command[i + 1] === '&') {
      endStep(false)
      i++
    } else if (c === '|' && command[i + 1] === '|') {
      endStep(false)
      i++
    } else if (c === '|') endStep(true)
    else if (c === '&' && command[i - 1] !== '>' && command[i + 1] !== '>') endStep(false)
    else {
      word += c
      started = true
    }
  }
  endStep(false)
  return out
}

const isRedirection = (w: Word): boolean => !w.quoted && /^\d*(>>?|<|>&|&>)/.test(w.text)
const isAssignment = (w: Word): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text)
const basename = (path: string): string => path.replace(/\/+$/, '').split('/').pop() || path

/** The words a step runs, without its redirections, its leading `VAR=value`
 *  assignments and the wrappers before its program. */
function program(words: Word[]): string[] {
  const kept: string[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]
    if (isRedirection(w)) {
      // `> file` names its target in the next word; `>file` and `2>&1` carry it.
      if (/^\d*(>>?|<)$/.test(w.text)) i++
      continue
    }
    if (!kept.length && (isAssignment(w) || WRAPPERS.has(w.text))) continue
    kept.push(w.text)
  }
  return kept
}

/** "npm run dev": the program and the plain words after it, up to the first
 *  flag, path, or `--`, at most four words. */
function headOf(words: string[]): string {
  const [first, ...rest] = words
  const head = [basename(first)]
  for (const w of rest) {
    if (head.length >= 4 || !w || w.startsWith('-') || w.includes('/') || w.includes('=')) break
    if (/\s/.test(w)) break
    head.push(w)
  }
  return head.join(' ')
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX ? `${flat.slice(0, MAX - 1).trimEnd()}…` : flat
}

/** A name that is already words, not a command: the CLI sometimes lists a
 *  background shell under a sentence of its own ("Watch the build"). */
const isProse = (text: string): boolean =>
  /^[A-Z][a-z]/.test(text) && /\s/.test(text.trim()) && !/[|&;<>$`=\\/]/.test(text)

export function commandTitle(command: string): string {
  // A short one-liner already reads; only a long command needs shortening.
  const flat = command.trim()
  if (isProse(flat) || (flat.length <= SHORT && !flat.includes('\n'))) return clip(flat)
  const all = steps(command)
  if (!all.length) return clip(command)
  // The directory it runs in, as the last `cd` before the chosen step said.
  let dir: string | null = null
  let chosen: { head: string; dir: string | null } | null = null
  let fallback: string | null = null
  for (const step of all) {
    const words = program(step.words)
    if (!words.length) continue
    const name = basename(words[0])
    if (name === 'cd' || name === 'pushd') {
      const target = words[1]
      dir = target && target !== '-' && target !== '~' ? basename(target) : null
      continue
    }
    if (step.piped) continue
    fallback ??= headOf(words)
    if (SETUP.has(name)) continue
    // The last real step is what the command is for: what comes before it
    // usually clears the way (a kill, a wait, a check).
    chosen = { head: headOf(words), dir }
  }
  if (!chosen) return clip(fallback ?? command)
  return clip(chosen.dir ? `${chosen.head} in ${chosen.dir}` : chosen.head)
}
