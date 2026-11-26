# Decisions

Every question Clave asks Jev, TypeSafe's decision model, on its own (no tab, no person
typing) is a **decision** (PRDCT-5179): one request carries a `state` and typed
questions, and the answer is a probability per answer, no prose, in about 220 ms. A
decision is to Jev what a helper (`../helpers/`) is to a one-shot model call. One registry
declares them, one runner runs them, and they run on the process that holds the machine's
Jev key (`../integrations/jev.ts`).

| File                 | What it holds                                                                          |
| -------------------- | -------------------------------------------------------------------------------------- |
| `registry.ts`        | `defineDecision`, `listDecisions`, `decisionById`, and THE config seam `decisionConfig` |
| `runner.ts`          | `runDecision`: the key, the queue, the cap, the fallback, the retry, the quit          |
| `jev-client.ts`      | `askJev`: one request, every way it ends as an outcome, answers read defensively       |
| `scrub.ts`           | `clip` and `scrubText`: what a decision sends, made fit to leave the machine           |
| `preferences.ts`     | the switches of Settings, `decision-preferences.json`, and the refusal outside owner   |
| `catalog.ts`         | every decision declared, in one place                                                  |
| `project-options.ts` | the projects a tab may work on: the groups of the workspace's `.clave` files           |
| `tab-reading.ts`     | what a tab said and touched, read from its transcript                                  |
| `tab-project.ts`     | the first decision: which project a tab works on                                       |

## Declaring a decision

```ts
export const myDecision = defineDecision<Input, Outcome>({
  id: 'my-decision',         // kebab-case: the key its switch is filed under
  label: 'My decision',       // what Settings shows
  description: 'What it decides, and what it reads to decide it.', // one sentence
  model: JEV_MODEL,           // the versioned model its floors were measured on
  fallbackModel: JEV_FALLBACK_MODEL, // optional: asked once when the model is gone
  timeoutMs: 8000,
  build: (input) => /* { state, questions }, or null when there is nothing to ask */,
  read: (answers, input) => /* the outcome, or null when not the asked shape */
})
const outcome = await runDecision(myDecision, input)
```

A new decision is also one more export in `catalog.ts`: the Settings page lists the
catalog, and the standalone server knows a decision only once the catalog has loaded its
file. `catalog.test.ts` loads every module of this folder and fails when the registry
knows a decision the catalog does not name, or when a module reaches Electron.

## The rules every decision keeps

- **What it reads is data, clipped and scrubbed.** Everything a person said or an agent
  touched goes through `scrubText` (a path inside the workspace made relative, any other
  `<path>`, a `file://` link the same, a link cut after its host with its user and
  password gone, e-mail addresses, JWTs and token-like runs taken out: the rules and
  their limit are in `scrub.ts`) and `clip` before it is put in the `state` or a
  criterion. It leaves the machine for TypeSafe.
- **Paths relative to the workspace, the others dropped.** An absolute path carries the
  person's name; the workspace's own folders are what a project is recognised by, and
  a path outside the workspace, the home folder's included, never leaves the machine.
- **Floors in one pure function of the contract package.** How an answer becomes a
  decision (the shares that decide, the companion yes-or-no that says nothing fits) is a
  measured rule, `packages/contract/src/tab-projects-rules.ts` for the first decision, so
  the renderer and the server read it the same way. Change a floor only with a
  measurement of the same kind; never tune one here.
- **A real call never from the test suite.** The tests stub `ask` or `fetch`. A real
  request is made by hand with the replay script, on a key of your own.
- **A base URL other than TypeSafe's under the harness only.** `CLAVE_JEV_BASE_URL` is
  honoured under `--test-no-activate` and ignored everywhere else, with no escape hatch:
  whoever can set a server's environment must not be able to send the key elsewhere. A
  test passes its own `baseUrl` to the runner.
- **No Electron.** The standalone server loads this folder (`catalog.test.ts` fails the
  import if one comes back).

## Outcomes

`runDecision` never rejects. It answers `{ ok: true, value, model, ms, inputTokens }`
(`model` is the versioned model that answered) or `{ ok: false, reason, detail }`, with
`reason` one of, in the order they are checked:

| Reason        | When                                                                                |
| ------------- | ----------------------------------------------------------------------------------- |
| `disabled`    | switched off in Settings, or this process runs no decision (the detail says which)  |
| `no-key`      | no Jev key on this machine, when asked or when its turn comes: nothing sent         |
| `nothing`     | `build` answered null: nothing to ask                                               |
| `refused`     | 401 or 403: the key, in TypeSafe's own words when it gave some                      |
| `limit`       | 429 or 529, after ONE retry (the service's `retry-after`, else 500 ms, at most 1.5 s) |
| `unreachable` | no answer: the network or the deadline                                              |
| `unreadable`  | `read` answered null: not the shape asked                                           |
| `failed`      | any other status, or the model gone with no fallback left                           |
| `cancelled`   | `cancelAll` or `shutdown`                                                           |

When the service says the model does not exist (a 400, 404 or 422 whose detail names
`model`: TypeSafe's documentation says nothing more precise), the runner asks ONE more
request on `fallbackModel`. At most `MAX_RUNNING_DECISIONS` (4) requests are in flight;
the rest wait in the order asked, and a decision's turn reads the switch and opens the
key again: one switched off, or whose key was removed, while it waited answers
`disabled` or `no-key` and sends nothing.

## Replaying a decision by hand

`TYPESAFE_API_KEY=… npx vite-node scripts/replay-decide-call.ts <input.json>` sends the
app's own `tab-project` request for an input of `{ tab, options, workspaceRoot, home }`
(`scripts/fixtures/replay-decide-example.json` is an invented one) through `runDecision`,
so its fallback and its retries are the runner's, prints the model, the time, the reading
and the shares, and exits 1 when the answer is not the documented shape. It never prints
the key. Real calls: never from the test suite (`replay-decide-call.test.mjs` runs it on a
stubbed `fetch`).

## The config seam

Before each request the runner asks `decisionConfig(definition)`: `{ enabled, refused? }`.
It asks it first when the decision is asked (a refusal costs no queue), then again before
every request, retries included, and it opens the key again before each one too, but
the first request of a decision that did not wait its turn, whose key it opened a moment
before: a request carries the key read just before it. A decision is on unless a source
says otherwise. `installDecisionPreferences()` makes the
switches of `decision-preferences.json` that source; it is the owner's call, the process
that holds the machine's settings and its Jev key. A process that is not the owner (main
with a server of its own behind the window) calls `refuseDecisionsHere()`: every decision
is refused there before the key is read, whoever asks and by whatever road.

## Shutdown (the helpers' PRDCT-3375 rule)

`cancelAll()` answers every waiting decision `cancelled`, aborts every request in flight
(its answer, if one still comes, is dropped) and ends a wait before a retry; the door
stays open (the last window closing on macOS is not a quit). `shutdown()` also shuts the
door: no request is sent after the quit.
