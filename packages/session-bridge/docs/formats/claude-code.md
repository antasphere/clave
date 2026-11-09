# How Claude Code stores a conversation

Checked on 9 November 2026 against a transcript written by Claude Code 2.1.319, and
against Clave's reader of it (`ClaudeStreamTranslator.replay` in
`src/main/sessions/adapters/claude-adapter.ts`), which `src/readers/claude.ts` copies.

## The file

```
~/.claude/projects/<cwd with every non-alphanumeric character replaced by "-">/<session id>.jsonl
```

(`$CLAUDE_CONFIG_DIR/projects/…` when the CLI runs with another config dir.) One
JSON object per line. The conversation rows are `type: "user"` and `type:
"assistant"`; each carries `uuid`, `parentUuid` (the chain), `sessionId`, `cwd`,
`timestamp` (ISO 8601), `version` (the CLI's), `gitBranch`, `isSidechain` (true on
a subagent's own rows), sometimes `isMeta` (an injected skill text or context, not
the person's words), and `message`, an Anthropic message:

- a user row's `message.content` is a **string** (the prompt as typed) or an array of
  blocks: `text` (the person's words, or the CLI's own markup: a slash command as
  `<command-name>/name</command-name><command-args>…</command-args>`, an
  interruption as `[Request interrupted by user…]`), `tool_result`
  (`tool_use_id`, `content` as a string or blocks, `is_error`);
- an assistant row's `message.content` is an array of `thinking`, `text` and
  `tool_use` (`id`, `name`, `input`) blocks, one block per row in recent versions
  (the same `message.id` repeats across them), with `message.model` and
  `message.usage` (`input_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens`, `output_tokens`).

The CLI's own bookkeeping rows sit between them and are not the conversation:
`attachment`, `api-request`, `api-request-blob`, `api-request-shape`, `last-prompt`,
`tools-used`, `queue-operation`, `atis-latch`, and others.

## What the reader does with it

`replayClaudeTranscript` keeps the conversation and drops the rest: subagent and
meta rows out; a slash command read back as `/name args`; an injected `<…>` block
or a `Caveat:` notice dropped; an interruption notice as `turn_interrupted`; a tool
call the transcript never answered closed with an undefined result at the next
message; the context as it stood (the usage's four counts summed) as
`context_usage` whenever it changes. `readClaude` adds the head: the session id,
cwd, CLI version, the last assistant row's model, the first and last timestamps.

`fixtures/claude-transcript-sample.jsonl` is a synthetic file in these shapes;
`fixtures/claude-stream-*.ndjson` are the CLI's stream-json stdout frames, whose
`user` and `assistant` frames the same reader understands.

## Writing one (not built)

See `src/writers/claude.ts` for the notes and the open questions.
