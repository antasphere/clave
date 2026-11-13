/**
 * What a Pi or OpenCode chat says when its agent ends before it spoke its
 * protocol (PRDCT-4427): the agent's own last words, off the tail of its
 * stderr the connection keeps, and its exit status. Without it the reader saw
 * "Session ended" and nothing else (Pi 1.5.2 refusing `--provider` without
 * `--model` prints one line and exits 1).
 *
 * Never anything from the process's environment: a value held under a
 * variable whose name says it is a credential is masked wherever it shows up
 * in those words. Pure.
 */

/** The last lines kept, and their length at most. */
const MAX_LINES = 3
const MAX_CHARS = 500

/** A variable whose value is a credential, or carries one. */
const SECRET_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|OPENCODE_CONFIG_CONTENT/i

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/g

/** The process's last words: the last non-empty lines of its stderr, plain
 *  text, every credential value of `env` masked; '' when it said nothing. */
export function lastWords(
  stderrTail: string | undefined,
  env?: Readonly<Record<string, string | undefined>>
): string {
  if (!stderrTail) return ''
  let text = stderrTail.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(CONTROL, '')
  for (const [name, value] of Object.entries(env ?? {}))
    if (value && value.length >= 4 && SECRET_NAME.test(name))
      text = text.split(value).join('‹hidden›')
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
  let words = lines.slice(-MAX_LINES).join(' ')
  if (words.length > MAX_CHARS) words = `…${words.slice(-(MAX_CHARS - 1))}`
  return words
}

/** The notice of an agent that ended before it spoke: its last words and
 *  its status, or its status alone when it said nothing. */
export function startRefusal(
  label: string,
  code: number,
  stderrTail: string | undefined,
  env?: Readonly<Record<string, string | undefined>>
): string {
  const words = lastWords(stderrTail, env)
  return words
    ? `${label} could not start: ${words} (exit status ${code})`
    : `${label} could not start: it exited with status ${code} and said nothing`
}
