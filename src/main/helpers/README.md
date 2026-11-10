# Helpers

Every one-shot model call Clave makes on its own (no tab, no person typing) is a
**helper**: tab titles, exchange digests, work-card titles, commit messages, push
summaries (PRDCT-4326). One registry declares them, one runner runs them.

| File          | What it holds                                                                            |
| ------------- | ---------------------------------------------------------------------------------------- |
| `registry.ts` | `defineHelper`, `listHelpers`, `helperById`, and THE config seam `helperConfig`          |
| `runner.ts`   | `runHelper`: the queue, the cap, the CLI arguments, the typed failures, the kill on quit |
| `title.ts`    | the tab title (`title-generator.ts` calls it)                                            |
| `digests.ts`  | the exchange digest and the work-card title (`exchange-digest.ts` calls them)            |
| `git.ts`      | the commit message and the push summary (`git-manager.ts` calls them)                    |

The prompt helpers every builder shares (`asData`, `replyLines`, the system preamble,
`HelperFailureReason`) live in `src/shared/helper-prompt.ts`, so the shared digest
builders can use them.

## Declaring a helper

```ts
export const myHelper = defineHelper<Input, Output>({
  id: 'my-helper',            // the key its setting is filed under
  label: 'My helper',          // what Settings shows
  systemPrompt: `${HELPER_SYSTEM_PREAMBLE} Your one task: …`,
  buildPrompt: (input) => `${MY_MARKER}…\n\n${asData('content', input.text, 2000)}\n\nReply with …`,
  parseReply: (stdout, input) => /* the value, or null when not the asked shape */,
  model: 'haiku', fallbackModel: 'sonnet',
  timeoutMs: 30_000,
  priority: 50,                // higher runs first
  concurrency: 1,              // optional: at most this many of it at once
  attempts: 2                  // optional: one retry on an unreadable or failed reply
})
const outcome = await runHelper(myHelper, input, launchContext, { owner: sessionId })
```

Nothing in the runner changes for a new helper. Priorities today: commit message 80,
tab title 70, push summary 40, exchange digest 30, work digest 20. A helper the person
is waiting on in a modal (the permission explainer, PRDCT-4331) goes above them all.

## The rules every helper keeps

- **A function, not an agent.** Its own `--system-prompt` (it replaces the CLI's), no
  MCP server, no skill, no tool (`helperCliArgs`).
- **The content is data.** Wrap what the helper reads with `asData(tag, text, max)`,
  clipped, the instruction after it. Pasted raw after "write a title", a long first
  message was answered instead of titled four times in five.
- **Parsers read past the person's output style.** Their settings stay in force (an
  `apiKeyHelper` lives there; `--bare` drops the OAuth and keychain logins), so a reply
  may end with `Next: …`. Use `replyLines`, never trust the reply to be only the asked
  content.
- **The history marker opens the prompt.** A helper's transcript lands in the store like
  any conversation; `session-history/index.ts` keeps it out of the history by the
  prompt's first words (`TITLE_HELPER_MARKER`, `DIGEST_HELPER_MARKER`,
  `WORK_DIGEST_MARKER`, `GIT_HELPER_MARKER`). A new helper adds its marker there.
- **No Electron.** The standalone server loads the runner with the title generator and
  the exchange digest (`sessions/host-graph.test.ts`).

## Outcomes

`runHelper` never rejects. It answers `{ ok: true, value, attempts, model }` or
`{ ok: false, reason, detail }` with `reason` one of `timeout`, `auth`, `limit`,
`unreadable`, `cancelled`, `disabled`, `failed` — what a caller shows a person.

## The config seam (for the Settings page, PRDCT-4330)

Before each call the runner asks `helperConfig(definition)`: `{ enabled, model,
fallbackModel, claudeProfileId }`. Today it answers the helper's defaults and the
caller's account. `setHelperConfigSource((id) => partial)` installs the overrides; any
field the source answers wins. `claudeProfileId`: `undefined` = the caller's account
(the session's), `null` = the machine login, a string = that Claude account.

## Shutdown (PRDCT-3375)

`cancelAll()` answers every queued job `cancelled`, signals every running CLI (SIGTERM,
SIGKILL after `HELPER_CANCEL_GRACE_MS`) and drops a late answer; the door stays open
(the last window closing on macOS is not a quit). `shutdown()` also shuts the door: no
helper starts after the quit. The sessions' shutdown calls both through the title
generator and the exchange digest (`pty-manager.ts` killAll).
