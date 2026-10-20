# Whole-renderer resource protocol, 20 October 2026

This tool is implemented for future qualification. P4 runs pure unit checks
only. No heap cohort or resource PASS is authorized by this document. Root must
review the implementation, qualify real cleanup/content negatives, freeze raw
settled CURRENT DEV and the committed whole-feature candidate, then provide an
exact freeze-bound collection GO. Historical R2 and the retired cache collector
are not controls for this question. PRDCT-3634's original SSR defect remains
unfixed and executable separately.

The six files named `renderer-resource` own the protocol, workload and pure
validation. Existing harness, echo adapter, seed and fixture APIs remain public
and unchanged. The actual fixture scenario is `chat/renderer-resource`, with
its real runId, completed fixture keys, values and positive session/history
query readiness saved. Each hidden separate-server launch uses its own
namespace and user-data directory, SHELL=/bin/zsh, no machine usage, debugger,
profiler or visible window. Canonical input, expected HTML, chunks and evidence
remain in Node or the owned server. The renderer holds only a disposable public
receipt/sampling closure, removed before any measurement.

All launches keep 100 live sessions, 10 groups and the original 20 sessions with
200 seeded turns each. Slot 99 starts with the 34,380-byte LONG_RESPONSE and 500
numbered 128-byte chunks every 50 ms, unfinished and working. Its last chunk's
public receipt starts a fixed 200 ms delay and exactly two animation frames.
The first complete DOM HTML is persisted before assertion. Visit Chat, Terminal,
Chat with one fixed first sample per view. No SSR oracle, normalization, output
poll, retry or reduced depth/population is allowed.

The independent shallow HTML recipe in `resourceLiteral` explicitly accounts
for CommonMark consuming the single trailing source space on each paragraph
line. It declares every strong element, anchor, heading, numbered chunk and
newline. These native components introduce no dynamic HTML attributes for this
grammar. This is a declared literal before execution, not normalization of an
observed value. The public literal/semantic/deep/ordered-stream functional gates
remain separately mandatory. A terminal chunk receipt and complete DOM do not
independently establish every event callback identity.

The twelve heap samples are `warm`, then `cycle-1-warm`, `cycle-1-closed` through
cycle 5, then `final-closed`. Close and replace the initial warm probe WITHOUT a
sample. Each of five replacements receives LONG_RESPONSE, its unique cycle
label and 20 chunks before its warm sample, then is closed and replaced by an
ordinary two-turn short echo session for its closed sample. `final-closed` is an
idle repeat on the final UNWARMED short replacement. There are SIX total closes,
not seven. Normal application archives/events remain; no deletion or truncation
is used to flatten memory.

Before each sample, the tool positively acknowledges stopped/deleted producers,
settled injection promises, off() and cleared passive waiter/promise/timer/frame
slots. Its ownership ledger blocks GC with pending work or unknown handles.
It acquires no object handles on the normal path. Same-target identity is checked
before the measurement transaction. After two frames, 1000 ms and two frames,
a fresh CDP session bound to that same Playwright renderer page sends ONLY:

1. Runtime.releaseObjectGroup for the owned renderer-resource group.
2. HeapProfiler.collectGarbage, acknowledged.
3. HeapProfiler.collectGarbage, acknowledged.
4. Runtime.getHeapUsage exactly once, with its complete raw response persisted.

Detach before another lifecycle action. No Runtime.evaluate, object acquisition,
snapshot, Fiber traversal, derived accounting or RSS is used in this sequence.
Known app main, renderer, server, terminal-process and observed child identities
include OS creation identity. A resolved app.close or empty harness map is not
exit proof. Every known identity must be positively gone; forced, unknown or
timed-out cleanup fails the launch. Kill only a proven owned identity.

Deadlines are boot 60 s, fixture 120 s, locator 15 s, MCP 10 s, producer 60 s,
each CDP operation 10 s, whole launch 10 minutes. A timeout fences late results,
persists the first failure and makes every later sample/launch NOTRUN. There is
no unchanged failed-cohort retry. Cleanup still runs.

The future freeze JSON contains schema 1, createdAt, exact per-side root and
binding, complete sourceFiles/buildFiles/productFiles manifests and identical
toolingFiles. Bindings include commit/tree/source/build/product/lock/tooling/
workload/runtime/settings. Product inventory is all tracked product source in
src/plugins/packages excluding tests, scripts and fixtures; each product blob
must equal its committed side. The control is rawCurrentDev=true and the remote
dev head must still match. Product hashes must differ; every unrelated product
difference needs root reconciliation before freeze. No optimized product overlay
into control is allowed. Tooling overlays, lock/runtime/settings and workloads
are identical. Build manifests cover all out files. The freeze binds exact
tooling, not just the top-level collector, and source/build identities.

The future GO JSON must say purpose=whole-renderer-resource-collection,
authorized=true, qualificationVerdict=PASS and bind freezeSha256. Only root's
later explicit assignment supplies these files. Future invocation:
`node scripts/performance/renderer-resource.mjs --freeze <freeze.json> --go <go.json> --out <new-evidence-dir>`.
Three complete controls run before three candidates. All 72 actual usedSize
values are retained. Primary median(candidate initial warm)/median(control
initial warm) must be <=1.20; later cycles never enter that statistic. Publish
all stage medians/ranges, corresponding ratios and trajectories. Unexplained
growth needs investigation even after the primary ratio passes. The result is
target renderer V8 usedSize, not server/native/GPU/machine memory, exhaustive
holder accounting or proof of no small leak. Pure validator/state-machine
negatives are checker evidence only. Real retained-waiter/producer and stale
replacement negatives, cleanup qualification and all six launches remain NOTRUN
until root GO. All original latency targets and functional obligations remain.
