# Asking the person: the agent request tools

An agent running in a Clave tab has three ways to put something to the person
without typing it into the chat as prose, all MCP tools of Clave's own server
(`src/main/mcp/mcp-server.ts` for the desktop, `src/main/mcp/standalone-mcp.ts`
for a server running without a Mac). They share one rhythm: the call blocks for
a short while, then returns `pending` with a request id the agent polls, so a
person can take as long as they like while the tool call never outlives the
host's own timeout.

| The agent needs                                                                                                                     | The tool                                                  | The person sees                                                                           | What comes back                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| A plain value, a choice, a yes or no, a long text, a file or folder, a link to open and come back from, or several of those at once | `clave_request_input`, written to with `clave_input_set`, read with `clave_input_result` | A form drawn in the chat under the agent's turn, one field per question, checked as typed, alive across the agent's turns | The answers, keyed by the question's id, as the person's next message once approved |
| A credential (an API key, a token)                                                                                                  | `clave_request_secret`, polled with `clave_secret_result` | The toolbar's key popover: the exact command or file under review, a masked field         | Never the value: the command's redacted output, or the file written |
| To hand the person a value to paste elsewhere                                                                                       | `clave_offer_copy`                                        | A copy button in the tab's header                                                         | Nothing: the agent is not told when it is copied                    |

The first is the plain counterpart of the second: the value IS returned to the
agent and may be shown. Nothing sensitive goes through it; the tool has no
secret kind, on purpose.

## `clave_request_input` (PRDCT-4157)

The card asks everything at once, as one small form, so a long run is never
interrupted later: the onboarding of a newcomer's machine asks the GitHub
login, whether the person administers the Mac, whether an SSH key exists and
the machine's name before it starts anything.

The form is the deterministic half of a conversation, and the chat stays the
chat. The agent asks, says in one sentence that the form is there and that the
person may fill it in or just answer, and ends its turn. The person either
fills the fields and approves, or writes "I'm luca-a, I'm admin, there's a key
already" in the composer: that message reaches the agent as any message does,
the agent sets the fields from it with `clave_input_set`, the card follows
(each field lands with its seat ticked, a step answered folds into one line
and the card moves on to the next open one), and the agent ends its turn again
saying what is still open. The person's Approve, or the agent's when the person
said to go ahead, closes the form; a later "actually, call it studio-romain" is
`clave_input_set` on the same request, and the record row reads Revised.

```json
{
  "description": "Three things before this machine is set up.",
  "questions": [
    { "id": "email", "label": "Your team e-mail", "kind": "email", "hint": "The one on the hub" },
    { "id": "login", "label": "Your GitHub login", "kind": "github-login" },
    {
      "id": "projects",
      "label": "The client projects you join",
      "kind": "choice",
      "multiSelect": true,
      "optional": true,
      "options": [{ "label": "syndicable" }, { "label": "reb" }, { "label": "wat" }]
    },
    {
      "id": "sign",
      "label": "Sign in to GitHub, then come back",
      "kind": "link",
      "url": "https://github.com/login",
      "confirm": "I'm signed in"
    }
  ],
  "layout": "form"
}
```

- `description`: what is asked and why, shown verbatim above the fields.
- `questions` (1 to 20): one field each. `id` is the key the answer comes back
  under (lowercase, digits, `-`, `_`); `label` the question, shown verbatim.
  `kind` is one of `text` (the default, one line), `long-text`, `email`, `url`,
  `github-login`, `number` (with `min`, `max`), `date` (`YYYY-MM-DD`), `choice`
  (with `options`, `multiSelect`), `file`, `folder` (a native picker on a local
  tab; typed on a server's tab, since the picker would browse this Mac), `link`
  (with `url` and `confirm`: the person opens it in the browser and confirms
  they are back). `hint`, `placeholder`, `default` and `optional` are the
  field's own words and leave.
- `layout`: `form` (every field at once, one Send; the default) or `steps`
  (one question per page, the motion of a provider's native question).
- `timeoutSeconds` (0 to 300, default 0): how long the call waits for the
  person before returning `pending`. The default returns at once, for an
  agent that ends its turn; a wait is for an agent that cannot, kept well
  under the MCP client's tool timeout.

The result is `{ requestId, status, answers?, revised? }`: `pending` with the
fields set so far, `completed` with every answer (a string per question; a
multi-select's labels as an array; a confirmed link as `"done"`; an optional
question left empty is left out), `dismissed` when the person skipped,
`cancelled` when the session ended with the form still open. Results are kept
ten minutes.

The form lives across the agent's turns: a turn's end leaves it open and the
session reads as waiting for the person, where a provider's own question is
withdrawn with its turn. When the person approves or skips it while no read of
the tool is waiting on it, the server writes the outcome to the session as the
person's next message (the form's description, one line per answer, the
request id), so an idle agent wakes with the answers; a view draws no bubble
for that message, the form's record row stands for it. An agent that waited
in the call, or in `clave_input_result { requestId, waitSeconds }` (45 at most
per call), reads the outcome there instead.

### `clave_input_set`

`{ requestId, answers, submit? }`: the agent writes to a form it asked. Each
value is judged by its question's kind, the same rule as the card's, and one
that does not fit is refused with the reason under the question's id, nothing
set. On the open form the fields go to its draft, which the card shows landing
and `clave_input_result` reads; `submit: true` approves the open form with what
it then holds, refused while a required field is unanswered, and meant only
for when the person said to go ahead in the chat. On an approved form the
fields replace the answers and the form reads `revised`. A skipped or
cancelled form takes nothing more.

A typed answer is checked where it is typed, and again by the server as it is
handed the answer, from the one rule in
`packages/contract/src/input-kinds.ts`: an answer that does not fit leaves the
card where it is, with one line under the field saying what to type instead.

### How it rides

The request is a record of the server's pending-requests service
(`packages/server/src/requests/service.ts`, `createHosted`), in every mode
(in-process, the app's own separate server, a standalone daemon), with a
provider id the server minted under the `clave:` prefix. That id is what lets it
take the native question road into every view of the session: published as a
`permission_request` event with `questions` (the request-aware host,
`src/main/sessions/request-aware-host.ts`), drawn by the same card the chat
draws Claude's `AskUserQuestion` and Codex's `request_user_input` with, answered
by the same write (`permission_response` with `answers`), settled once for every
client attached to the session, withdrawn from every view when settled. The
desktop's MCP server creates it on whichever server hosts the session through
the typed client (`requests.create`, `requests.set`, `requests.result`); the
daemon's creates it in place.

Three things tell a hosted request from a native one on that road. The turn's
end cancels the provider's own requests and leaves the hosted ones (an unnamed
`cancelNative`), and the host puts the session back to `blocked` when a turn
ends with a form open. A field the agent sets (`setAnswers`) is published as a
`permission_updated` event with the patch, `sent` once the form is approved,
so every view updates its card or its record row, and a view that subscribes
late gets the draft as the questions' defaults. And the person's approve or
skip, settled with no result read waiting (`SettledMeta.polled`), is written to
the session as a `user_message` carrying `form` (the provider id), which the
chat view's reducer folds into the form's record instead of drawing a bubble;
the agent's own `submit` writes no message.

### What the person sees

The card sits in the agent's own column, under its words, with no box around
it (`InputPrompt.tsx`, placed by `InlineQuestion` in `PromptDock.tsx`): a
drawing in the chat's hand at its head beside the agent's sentence, then the
fields down a rail, one seat per field, the accent running down the rail as far
as the field the person is on and all the way once every answer fits, then Skip
and Approve. The fields are the paper's controls; their height, the buttons'
height, the air between fields and the inset come from four density tokens
(`--ask-field-h`, `--ask-btn-h`, `--ask-gap`, `--ask-pad`) that every Density
preset restates, so the card reads as the chrome around it. Enter moves to the
next field and approves on the last; ⌘↩ approves; Esc skips. A field the agent
set from what the person said lands with its seat ticked and a short flash,
and a line under the agent's words says it filled in what was said. In the
`steps` layout an answered step folds into one line above the live question
(the question, then what was said; a click reopens it), the card moves on to
the next open step on its own, and once every step is answered it shows them
all folded with Approve under them. Once approved, the card gives way to one
muted row with each question and what was said, which reads Revised when the
agent set a field again later. A person scrolled up the transcript when a
question arrives is told above the composer and brought to it. The dock above
the composer keeps what it always held best: a tool to allow.

A provider's own question is drawn inline the same way since this change; its
motion (one question per page, the review, a note on an option) is unchanged.
One card is drawn per request still waiting, on its latest entry and, for a
server's session, only for the server's own records of that session: a replayed
duplicate or a dead process's question stays a muted row.

## A provider's own question, and when to use which

Claude Code's `AskUserQuestion` is a multiple choice, one to four questions,
with the reader's own words allowed. Codex's `request_user_input` is its
counterpart. Both are drawn inline by Clave with no tool call of Clave's.
`clave_request_input` complements them with what they cannot ask: a typed value
checked as typed, a path picked in a dialog, a link to open and come back from,
a form asked all at once. A bare choice may go through either.

## The standalone server

A server running without a Mac (`docs/server-requests.md`) offers the same two
tools, beside its older `clave_request_clarification` and
`clave_request_approval`, which stay for the agents written against them. A
request created there is answered from any Mac attached to the server, in the
chat of that session; the first valid answer wins.
