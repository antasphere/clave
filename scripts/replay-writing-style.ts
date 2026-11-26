/**
 * Replay a writing style on the REAL harnesses: each CLI is started the way a
 * tab of Clave starts it (the flags of `buildAgentArgv`, OpenCode's inline
 * configuration of `withOpencodeInstructions`), asked one question, and its
 * answer is read with the app's own reader. Exits 1 when a harness that was
 * asked did not end its answer on a status card the reader takes.
 *
 *   npx vite-node scripts/replay-writing-style.ts [--harness claude,pi,opencode,codex]
 *                                                 [--style brief] [--model <m>] [--runs 1]
 *                                                 [--question "<the person's message>"]
 *
 * A manual probe that spends real calls on each CLI's own login (Claude's on
 * the machine's `claude` login: pass a cheap `--model`, `haiku` by default):
 * never run it from the test suite. Run it when a harness releases a version,
 * to learn before the people do that it still takes a style
 * (`STYLE_SUPPORT` in `src/shared/writing-styles.ts` says what was checked,
 * and when). Antigravity is not here: it takes no style at launch, and its
 * chat's first message is the app's own road (`acp-adapter.ts`).
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BUILT_IN_LAUNCH_PROFILES, buildAgentArgv } from '../src/shared/agent-launch'
import { readStatusCard, statusCardLines } from '../src/shared/status-card'
import { BUILT_IN_STYLES, composeStyleText, findStyle } from '../src/shared/writing-styles'
import { withOpencodeInstructions } from '../src/main/clave-tools-launch'

type Harness = 'claude' | 'pi' | 'opencode' | 'codex'
const ALL: Harness[] = ['claude', 'pi', 'opencode', 'codex']

const args = process.argv.slice(2)
const option = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? undefined : args[at + 1]
}
const asked = (option('harness') ?? ALL.join(','))
  .split(',')
  .map((name) => name.trim())
  .filter((name): name is Harness => (ALL as string[]).includes(name))
const runs = Number(option('runs') ?? '1')
const model = option('model')
const style = findStyle(BUILT_IN_STYLES, option('style') ?? 'brief')
if (!style || style === 'none') {
  console.error(`usage: --style is one of ${BUILT_IN_STYLES.map((s) => s.id).join(', ')}`)
  process.exit(2)
}
const text = composeStyleText(style)
const QUESTION =
  option('question') ?? "I want to rename my repository's main branch to trunk. Should I?"

// A folder with nothing in it: no project instructions take part, and the
// calls stay small.
const cwd = mkdtempSync(path.join(os.tmpdir(), 'clave-style-replay-'))
const env: Record<string, string | undefined> = { ...process.env }
// The nested-session markers would make a CLI believe it runs inside a session.
for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID'])
  delete env[name]
// A CLI that trusts the shell's own word for where it is (OpenCode does)
// would answer about the folder this script was started from.
env.PWD = cwd

const installed = (command: string): boolean =>
  spawnSync('/bin/sh', ['-c', `command -v ${command}`], { env }).status === 0
const profileOf = (family: string): (typeof BUILT_IN_LAUNCH_PROFILES)[number] =>
  BUILT_IN_LAUNCH_PROFILES.find((profile) => profile.family === family)!

/** The command line and the environment of one question, the launch's own
 *  flags first, then what makes the CLI answer once and exit. */
function launchOf(harness: Harness): { argv: string[]; env: typeof env } {
  if (harness === 'claude') {
    const argv = buildAgentArgv({
      kind: 'claude',
      profile: profileOf('claude'),
      model: model ?? 'haiku',
      // The reset a tab with a style passes beside its hooks (`pty-backend.ts`).
      claudeSettings: JSON.stringify({ outputStyle: 'default' }),
      appendSystemPrompt: text
    })
    return { argv: [...argv, '-p', QUESTION], env }
  }
  if (harness === 'pi') {
    const argv = buildAgentArgv({
      kind: 'pi',
      profile: profileOf('pi'),
      model,
      appendSystemPrompt: text
    })
    return { argv: [...argv, '-p', '--no-session', '--no-context-files', QUESTION], env }
  }
  if (harness === 'codex') {
    // `codex exec` takes the same `-c` overrides as the TUI the argv is for.
    const argv = buildAgentArgv({
      kind: 'codex',
      profile: profileOf('codex'),
      model,
      developerInstructions: text
    })
    return { argv: [argv[0], 'exec', '--skip-git-repo-check', ...argv.slice(1), QUESTION], env }
  }
  const file = path.join(cwd, 'style.md')
  writeFileSync(file, text)
  const own = withOpencodeInstructions({}, file)
  return {
    argv: [
      'opencode',
      'run',
      '--standalone',
      '--archived',
      ...(model ? ['--model', model] : []),
      QUESTION
    ],
    env: { ...env, ...own }
  }
}

console.log(`style: ${style.name} (${text.length} characters), question: ${QUESTION}`)
let bad = 0
let ran = 0
for (const harness of asked) {
  const { argv, env: launchEnv } = launchOf(harness)
  if (!installed(argv[0])) {
    console.log(`${harness}: not installed on this machine, skipped`)
    continue
  }
  for (let run = 1; run <= runs; run++) {
    ran++
    const started = Date.now()
    const result = spawnSync(argv[0], argv.slice(1), {
      cwd,
      env: launchEnv as NodeJS.ProcessEnv,
      encoding: 'utf8',
      input: '',
      timeout: 180_000
    })
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    const answer = (result.stdout ?? '').trim()
    const { body, card } = readStatusCard(answer)
    if (result.status !== 0 || !card) bad++
    console.log(
      `\n${harness} #${run} ${seconds}s exit=${result.status ?? result.signal} ` +
        (card ? `CARD, ${body.split(/\s+/).filter(Boolean).length} words before it` : 'NO CARD')
    )
    if (card) for (const line of statusCardLines(card)) console.log(`  ${line}`)
    else console.log(`  the answer ended: ${JSON.stringify(answer.slice(-400))}`)
    if (result.status !== 0 && result.stderr.trim())
      console.log(`  stderr: ${JSON.stringify(result.stderr.trim().slice(0, 300))}`)
  }
}
console.log(`\n${ran - bad} of ${ran} answers ended on a status card`)
process.exit(bad === 0 && ran > 0 ? 0 : 1)
