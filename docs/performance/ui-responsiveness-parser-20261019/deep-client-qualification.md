# Desktop parser functional qualification — PRDCT-3633 / #204

The shipped renderer uses client `createRoot` and `StrictMode`; both native
assistant views call `MarkdownMessage` with the canonical unfinished flag.
The deep case now tests that client feature through the actual pinned public
synchronous ReactMarkdown/GFM entry and real React client DOM. It no longer
requires SSR serialization parity in that one case. Other correctness cases,
parser errors, fallback/caps, clone isolation and lifecycle assertions remain.

The original SSR source is retained in
`scripts/diagnostics/react-ssr-deep-original.test.ts`. Its only changes are the
two relative imports needed at that location. Reversing those substitutions
must reproduce original SHA256
`cf3f5117023b0aa6f3638bfd9b0d4f6f68ae4ddbd7572aa435bda5a99574089b`.
Run it explicitly with:

```sh
node_modules/.bin/vitest run --config scripts/diagnostics/react-ssr-deep.config.ts -t 'does not add a deep phrasing' --reporter=verbose
```

The original isolated case and extracted diagnostic both failed before this
qualification. Their first logs/exits are preserved in the delivery evidence.
PRDCT-3634 remains Backlog and unfixed. No dependency patch, stack tuning,
output normalization, discovery filter, skip, xfail or allowlist is introduced.
A diagnostic failure is a dependency failure, never a passed feature test.

The original discovered case keeps its title, depths 16/64/128/256, literal
inputs, initial/append order and fresh slot per depth. Its helper calls the
actual hook-free synchronous public export. It checks independent complete
positional MDAST and literal HAST/JSX grammar before complete MDAST/HAST/JSX/URL
parity. JSX projection retains type, key, every prop and ordered child; only
React's private owner/debug/validation bookkeeping is omitted. Unsupported
values, component types, cycles and symbol keys fail. Append must enter the
actual original parser with a shorter tail and the full downstream VFile.
Prior snapshots remain unchanged and disjoint from returned descendants.
A fixed safe/unsafe URL case covers the URL policy absent from the deep input.

`markdown-parser-deep-client` bundles unchanged real components without source
transforms. Three fresh connected roots per depth render full-a/full-b/candidate
under StrictMode, retaining those roots for append: 24 raw values and all 12
unmounts. Each value must match literal unnormalized HTML, text, ordered nested
tags, both paragraphs, one `middle`, all emphasis/strong nodes and Mutable tail
before parity. React, console and page errors fail the check.

The native matrix uses eight fresh real echo sessions: four depths in each
ChatView and TerminalView, initial then append in the same connected assistant
article. Before delivery, a passive scoped public `onSessionStream` listener
records the matching canonical assistant event and renderer timestamp. From
that receipt the renderer waits a fixed **200 ms** (the existing 150 ms
presentation cadence plus 50 ms functional margin), then exactly two animation
frames. It takes **one** full raw article sample and persists it before any
assertion. This is functional settling, not a latency measurement or 50 ms
claim. No expected-value polling, retries, warmup, finalization, reveal/remount
shortcut or first-value discard is permitted. Missing delivery, callback error,
wrong count, disconnected/replaced article or incorrect first value fails and
stops the remaining matrix as NOTRUN. Public listeners are retired; only owned
hidden Electron processes and isolated fixture/profile directories are closed.

The required macOS CI step runs all three discovered specs:

```sh
node tests/e2e/run.mjs markdown-parser-deep-client native-parser-path markdown-parser-lifecycle
```

The latter two retain their separate debugger/store observations to prove real
native shorter-tail use and committed-only publication. They are required,
non-advisory gates and are not part of the uninstrumented primary or timing.
Source negatives must show each native final=true bypass and an abandoned or
failed publication fail the required integration checks, then restore exact
source bytes. Forged checker rows supplement that proof; they cannot replace it.

Normal lint, types, units, generated-code currency, build, packaged-module,
server-boot and delivered-dropdown checks remain required. The delivery report
binds their actual commands/results to source and build hashes, preserves first
failures and records any NOTRUN. This document grants no independent review,
performance/resource acceptance or merge readiness. Those remain blocked until
the dispatcher freezes the final dev baseline after the other lanes and the
unchanged latency/resource criteria are proved on it.
