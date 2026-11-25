# Writing styles and the status card

How an agent writes to the person (how long, in which order, what it ends on)
used to be each harness's own business: Claude Code has its output styles,
Codex its developer instructions, OpenCode its instruction files, Pi a flag,
Antigravity nothing. A **writing style** (PRDCT-5166) is a named set of
instructions a machine keeps and every agent tab it launches starts with,
whatever its harness. A style may also ask for the **status card**: the agent
then ends its turn on a short status that Clave draws as a card under the
answer.

## A style

| Field         | What it is                                                              |
| ------------- | ----------------------------------------------------------------------- |
| `id`          | Its handle: what a tab's record keeps and what an agent names. A slug.  |
| `name`        | What the person reads in Settings.                                      |
| `description` | One line on when to use it. An agent choosing a style reads this.       |
| `text`        | The instructions, as the agent is given them.                           |
| `statusCard`  | Whether each answer ends on the status card: its rule follows the text. |

Clave ships two, the same on every machine and read-only (`BUILT_IN_STYLES`
in `src/shared/writing-styles.ts`): **Brief**, for a tab a person talks to
(the answer first, short, plain sentences), and **Quiet**, for work nobody
watches as it runs, a lane for instance (no comments on the way, one report at
the end). Both ask for the card. A machine starts on **no style**: an update
changes nothing for a person who chose nothing.

Three rules the rest follows from:

- **One style for every harness.** It says how to write to a person, which
  does not depend on the tool; only the way it reaches the tool does.
- **A tab keeps the style it was opened with.** Its id goes on the tab's
  record at its first launch and is read at every later one (a restore, a
  Resume, a move to another account or harness). Claude Code records its
  system prompt on a conversation's first request and replays it afterwards,
  so there a style cannot change in the middle of a conversation; a style
  edited or deleted since reaches the other harnesses at their next launch.
- **A style takes the place of the harness's own.** In a tab that has one,
  Claude Code's output style is reset and Codex's own `developer_instructions`
  are replaced, so two styles never argue. No style leaves both untouched.

## Where a machine keeps them

One document per machine, `writing-styles.json`, owned by the process that
holds that machine's settings, as the helpers' preference is
(`src/main/writing-styles/store.ts`): the machine's own styles and its default.
**Settings → Agents → Writing styles** shows and edits them for the machine the
group's picker names (this Mac, or a saved Clave server), picks the style new
tabs start with, and offers to import the person's Claude Code output style as
a style. The road is the Helpers page's, layer for layer (the wire's module is
`packages/contract/src/settings/writing-styles.ts`).

## How a style reaches each harness

`ptyManager.spawn` decides the style of every launch, in one place
(`decideLaunchStyle`, `src/main/writing-styles/launch.ts`): the style the
launch names, else the machine's default; the record's own for a tab launched
again; none for a plain terminal, for a routine's run that names none (nobody
reads it), and where the harness cannot take one. A style the launch names and
the machine does not have ends the launch with a sentence that lists the
machine's styles.

| Harness     | Terminal tab                                                                         | Chat tab                                               | Checked (25 Nov 2026)             |
| ----------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------ | --------------------------------- |
| Claude Code | `--append-system-prompt`, and `outputStyle: default` in the `--settings` it is given | the same                                               | real model, 2.1.332               |
| Pi          | `--append-system-prompt`                                                             | the same, in its rpc mode                              | real model, 1.6.1                 |
| OpenCode    | an instruction file named in `OPENCODE_CONFIG_CONTENT`, the TUI run `--standalone`   | the same variable on `opencode acp`                    | real model, 2.4.1                 |
| Codex       | `-c developer_instructions=…`                                                        | `developerInstructions` on `thread/start` and `resume` | read in its source, 0.53.0 onward |
| Antigravity | nothing: the CLI takes no instructions at launch                                     | sent with the conversation's first message             | read in its documentation         |

`STYLE_SUPPORT` (`src/shared/writing-styles.ts`) is the table the spawn, the
record and the Settings page read; a tab's record never names a style its
agent was not given. OpenCode keeps the person's own instruction files beside
Clave's. `scripts/replay-writing-style.ts` asks the real CLIs one question
under a style, started with the flags a tab starts them with, and reads their
answers with the app's own reader: run it when a harness releases a version.

## The agent tools

- `clave_open_session` takes `style`: a style of the machine by its id or its
  exact name, or `none`; omitted, the machine's default.
- `clave_launch_options` lists the machine's `styles` (id, name, description,
  whether it asks for the card, which is the default) and `defaultStyle`.
- `clave_list` says each tab's `style`.
- `clave_read_session`, for a chat tab, gives the agent's words without the
  raw status block, the status as plain lines under them, and `status`: the
  one its agent ended its last turn on (`doing`, `where`, `decide`, `next`,
  `needsYou`, and `answered` once the person has written since), or null.

## The status card

The rule the agent is given and the reader of what it writes back are one
module, `src/shared/status-card.ts`, so they cannot drift. The agent ends the
message that hands the turn back with one fenced block:

````
```clave-status
doing: what we are working on, in a few words
where: one or two sentences: what is done, what is left, what this turn changed
decide: a question only the person can answer, with your recommendation and why
next: the one thing the person must do now, or "nothing"
```
````

`decide` zero to three times; a `decide` or a `next` that says nothing is
owed is read as none. A block, not a tool call: no extra model round trip on
every turn, and it reads as text in a terminal.

The reader takes the agent's word and nothing else. A block is a card only
when it **ends the message at its top level**; a block quoted inside another
fence, followed by words, never closed, or naming no field is left in the text
exactly as written. Nothing guesses a status from prose.

Where the block goes:

- **The chat views** (Chat, Enclave, Folio): the one reducer takes it out of
  the answer (`plugins/chat-view/src/reducer.ts`: held back while the message
  streams, read into `entry.card` once it is final), so every reader of an
  answer's text reads its words alone: the copy, the export, the Find, the
  reading aloud, a handoff to another harness. The card is drawn under the
  answer (`StatusCard.tsx`), quieter once the person has written since. See
  "The status card" in `plugins/chat-view/README.md`.
- **A terminal tab** shows the block as the agent wrote it.
- **Another tab** reads it through `clave_read_session` (above).

## What a style is not

- Not a field of a `.clave` file: a workspace file names no style, and a tab
  it opens starts on the machine's default.
- Not a way to change a running conversation: pick the default, or name a
  style at the open, before the tab starts.
