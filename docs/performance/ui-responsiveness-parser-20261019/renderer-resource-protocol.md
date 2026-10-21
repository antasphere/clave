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
its real runId, completed fixture keys, values and positive live session-query
readiness saved. The unchanged seed's 100 last-turn native DOM barriers still
run. A temporary supported session-host subscription observes each actual live
seed in the server, then unsubscribes in finally. Node checks all 100 ordered
receipts, exact 200/2-turn content/order, live session-query state=done and
observer disposal. A repeated done event can be suppressed by SessionManager;
readiness uses its public queried state rather than requiring that notification.
Echo has no adapter history; sessionsHistory is not a readiness oracle. No
production adapter/history behavior is changed. Each hidden separate-server launch uses its own
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
no unchanged failed-cohort retry. The owned page's default locator timeout is
set to the fixed 15000 ms immediately after boot. Cleanup still runs.

Both usedSize and totalSize must be finite numbers, with usedSize positive and
totalSize >= usedSize. The recorded raw getHeapUsage response must still equal
the receipt; matching malformed raw values never qualify as numeric evidence.

The separate build audit requires schema 2 and exact equality between a fresh
recursive on-disk JavaScript output inventory and unique sidecar chunk records.
Every physical contributing module, including CommonJS-wrapped source, needs
its actual source hash. Only the two named generated Vite/CommonJS helpers lack
physical files. Output, source, lock and config hashes and positive/forbidden
module checks remain mandatory. Existing schema-1 build artifacts stay frozen;
rebuild and actual output/negative qualification require a later runtime lease.

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

### Ownership evidence correction, 20 October 2026, isolated source candidate

Original formal ce0 R1 remains FAIL/STOP at control2 before any sample. The unavailable PID/callsite was not recorded, and worker2 creation was uncaptured. No actual race or memory cause is established. The twelve control1 observations remain partial, with no ratio or accepted formal dataset.

The isolated source correction preserves strict identity admission for every main/server/terminal/renderer/utility/discovered descendant. Record the attempted PID, role, exact callsite/phase, expected parent and already-known creation context, prior identity, observed identity and observed fields from the fixed comm-only OS query before rethrow. Successful execFileSync exposes stdout only; successful stderr is null/unobserved with observability.stdout=true/observability.stderr=false. Error-outcome captured stdout/stderr and all strict classification remain unchanged. No argument/environment capture. Only an exact exit1/no-output/no-stderr/no-signal outcome is absence; permission, signal, malformed, wrong PID, parent mismatch or creation reuse remains failure. Absence during initial ownership admission also remains STOP; no descendant skip is introduced.

The original spawning parent synchronously captures each direct worker's PID/creation/parent immediately after installing its existing completion handlers and before yielding. It writes that receipt before handling the later exit, and records actual numeric exit/signal separately. A missed initial creation remains unknown/STOP, including on exit0. No creation is fabricated after exit. Capture is not atomic with OS exit; if a worker disappears first, full creation proof is unavailable. The existing current-child cleanup and ten-minute fence remain; no new worker protocol, watchdog or unproven-PID signal is introduced. No subsequent launch or sample set is accepted after capture failure. Existing deadline cleanup may signal a worker only when its current PID/creation/parent matches the original parent-captured identity.

Workload, app/render/CDP observers, profiler, fixture,1000ms minimum, frames, GC order, native target, counts, all metric thresholds and existing deadlines are unchanged. The focused source suite exercises the actual ownership helpers, inventory query body and original parent loop using in-memory query, child, timer and write dependencies. It checks failed admission receipts, truthful success observability, strict unknown outcomes, missing creation, exit/error/signal/deadline handling, no next launch after failure and the original six-launch order. Four source-bound ce0 counterexamples fail their evidence/safety assertions; the same assertions pass on the corrected source. These are synthetic source checks, not new process, measurement or historical-cause evidence. Logging-only changes do not resolve F1 or authorize a formal retry. Before physical use, retained A6/c277 must review the concrete source/pure results and the new source/overlay/private/freeze/isolation bindings. Any later execution requires explicit root authority, fresh outputs and complete current qualification/formal evidence. Old ce0 data and accepted primary/secondary/qualification records remain separate and immutable.

### SD-A6-F1 custody correction, 20 October 2026, isolated source follow-up

Retained A6 found a separate forward custody defect in the original ownership proposal and the first internal source candidate. A successful identity query followed by a failed worker-spawn receipt write could reject the parent before its child completed and prevent the captured row from reaching the parent. The source-bound pure counterexample reproduces that path against the first internal commit. It is not an observed disk failure or evidence of the cause of historical F1.

The follow-up returns the proven identity with an in-memory evidence failure when that new receipt cannot be written. The parent keeps the existing child-completion/fence path and rejects missing evidence even on exit0, without advancing or comparing. Initial absence stays unknown/invalid. Matched original identity alone remains eligible for the unchanged deadline cleanup; receipt failure permits no late PID enrollment or new signaling policy. The original600000ms fence remains at the same point. A child error with an assigned PID retains that same exit/fence custody and fails acceptance; a no-PID spawn error remains an immediate failed spawn. Completion/error receipt-write failures reject without throwing out of their handlers, preserve the original failure and retain downstream diagnostics in the existing combined raw log where available. No new watchdog, worker protocol, query, delay, workload, metric or threshold is added.

Actual parent/iteration tests use in-memory child/query/timer/write callbacks, including successful capture plus failed receipt pending until exit/fence, missing capture, reused/reparented/absent current identity, fast completion, downstream write failures and no next worker. They provide no physical custody, complete stream-tail or generic filesystem/stream/OOM recovery guarantee. Old failures, raw records, source gates and prior reports remain immutable. Historical F1 remains OPEN/UNKNOWN and worker2 creation remains missing. Retained peers must review the exact new committed source; source/private/freeze/isolation rebinding and any diagnostic or formal authority remain separate. This correction grants no retry or execution permission.

### FIRST complete-row ownership, schema 2, 21 October 2026

This source candidate implements the explicitly approved prospective real-UID
acquisition exception. Original formal b206 R1 remains FAIL: control1 completed
12 observations; control2 failed before sampling. Its pgrep child PID41319 had
no initial identity at the subsequent targeted query. That record remains
fatal, and why that child disappeared remains UNKNOWN. Older failures whose
PID/site was not captured remain UNKNOWN. No data is adopted or retry granted.

At each existing inventory site, ONE shell-free query acquires complete rows:
`/bin/ps -U <decimal-real-UID> -x -ww -o ruid=,pid=,ppid=,lstart=,ucomm=`.
Targeted direct-spawn/current/fence/cleanup queries use
`/bin/ps -p <PID> -ww -o ruid=,pid=,ppid=,lstart=,ucomm=`. Every query uses
only its own C locale, the original10000ms deadline and explicit1MiB default
buffer ceiling. Both streams, numeric status, signal and bounded error category
are observed. Nonzero discovery, any stderr/signal/error, partial framing,
invalid encoding/date, ambiguity and overflow STOP. Only targeted status1 with
both streams empty and no signal/error denotes absence; initial absence for
EVERY role remains fatal. No PID-only list, retry, census poller or late fill.

Schema2 identity rows contain pid,parent,creation,creationCodec=
`ps-lstart-C-seconds`,realUid,commandName,commandNameCodec=
`ps-ucomm-field-width16-verbatim`,commandSource=`ps.ucomm`,role and provenance.
The original PID/expected-parent/second-resolution PS creation contract stays.
The exact16-byte ucomm output field is preserved, including its spaces; it is
nonblank diagnostic text, never a normalized name, executable/path witness or
ownership key. Apple's formatter prints C lstart in width28 and ucomm in
minimum width16. The decoder accounts for these declared column boundaries
without trimming unknown bytes. A name's trailing spaces cannot be separated
from formatter padding and are deliberately retained. Other encoding/control
or column ambiguity fails. [Apple formatters](https://raw.githubusercontent.com/apple-oss-distributions/adv_cmds/6bed8737a34dbb54782a18f47dccf933a9967a12/ps/print.c),
[keyword widths](https://raw.githubusercontent.com/apple-oss-distributions/adv_cmds/6bed8737a34dbb54782a18f47dccf933a9967a12/ps/keyword.c),
[kernel name bound](https://raw.githubusercontent.com/apple-oss-distributions/xnu/f6217f891ac0bb64f3d375211650a4c1ff8ca1ea/bsd/sys/param.h).
These pinned sources do not establish installed-binary compatibility.

The WHOLE selected table is framed before filtering. Indexed ancestry is
independent of output order, process groups, sessions and names. Main, server,
terminal-process, target renderer, current metric roles and all reachable
transitive descendants require complete rows and exact edges. Known instances
and parents supporting new edges have before/after tuple fences. Duplicate or
cyclic PIDs, missing required references, reparent/reuse, UID mismatch and
unresolved previously known chains STOP before GC. Additions are staged until
ALL guards pass; failure retains the original map and initial objects. Matching
later diagnostic observations remain separate. A complete captured leaf can
subsequently be absent while its initial evidence remains available for cleanup.

Before any worker/app spawn, the NEW freeze must explicitly declare:
`ownershipFixture={schema:2,fixture:'chat/renderer-resource',provider:
'dev-echo-adapter',credentialScope:'nonroot-inherited-real-equal-effective',
credentialChangingActions:false}`. Both sides must bind the nine reviewed
fixture/spawn source paths and exact hashes in OWNERSHIP_FIXTURE_SOURCES through
sourceFiles/toolingFiles. Runner real/effective UID must match and be nonzero.
Current Node,/bin/zsh,Electron and four helper executables must be regular,
executable and free of setuid/setgid mode bits. This is a fixed unprivileged
fixture/source/artifact precondition, not observed per-child EUID evidence or
coverage of arbitrary privileged/provider children. Missing coverage, changed
source/modes or unknown credential scope STOP. Future source/artifact transfer
review must bind these prerequisites, including the no-credential-action claim.

Raw selected tables and stderr exist only in transient query memory. No
unrelated rows/names/paths/argv/environment or raw child Error/cause are stored
on success OR failure. Receipts contain only safe query argv/UID, status,
signal, bounded error category, byte counts/observability/bounds, necessary row
counts, owned rows and edge observations. The old comm-only/no-argv claim above
is historical: comm may internally acquire argv. All NEW collector identity
paths use ucomm; old receipts/schema are not relabeled or normalized.

Worker initial capture, optional successful-spawn evidenceFailure omission,
mandatory exit errors, custody through receipt-write failures and the original
600000ms fence remain. New worker acceptance/cleanup require schema2. Forced
cleanup additionally rejects changed parent or UID; TERM/250ms/KILL bounds
are unchanged. This is a new narrow guard; legacy force cleanup checked only
creation. No unknown/unproven identity becomes signal-eligible.

No atomic process tree, all-birth history, full path or unique generation token
is claimed. Processes born/gone between inventories and unknown cross-UID
children are outside the sampled fixed-fixture scope; one-second reuse limits
remain. Original100 sessions/20 long histories, five cycles/12 samples,
1000ms+frames, two GCs, all thresholds and original3+3 usedSize ratio<=1.20 are
unchanged. No app, live OS query, build or collector CLI is run in this source
phase. Actual-source tests/mutants do not qualify a measurement method. Exact
retained independent source/schema/platform review and current required CI,
then NEW both-side tooling/source/artifact maps, immutable private/checker/helper
schema consumers, freeze/isolation, fresh qualification faults/restorations and
separate formal authority remain mandatory. Frozen13a/14c and all failed history
stay immutable and cannot authorize this new source.

### C1/C2 source repair, 21 October 2026

Retained independent review of4d75 is SOURCE NOT READY. INV-A6-C1 found that
rejected targeted/pre/post-fence current identities could still persist their
unproven command names. The parent deadline receipt also serialized current
worker metadata when the original worker fence rejected it. INV-A6-C2 found a
complete exposed row800->absent previously-known500->main200 could be silently
filtered. These are prospective source findings, not historical process causes
or observed real-data leakage. The full review and counterexamples remain
immutable; author corrections require the same retained reviewer to clear.

Rejected current rows now serialize only an explicitly marked
`unproven-comparison-tuple`: PID,parent,creation/codec,realUID and a diagnostic
omission flag. This evidence has no schema2 identity tag, commandName/source,
role or provenance and cannot serve as an admitted identity. Targeted failure
receipts retain their original proven identity and safe query/mismatch reason.
Inventory failure fences retain original known identities plus safe current
tuples; no rejected or merely staged diagnostic name survives the failure.
Successful, fully validated observations may retain changed diagnostic names.
Deadline receipts keep a complete current worker row only when the unchanged
original worker eligibility check proves a match; otherwise they use the safe
tuple or explicit absence. The parent body has this narrow serialization change;
its custody, handlers,600000ms deadline, rejection, signal eligibility and
advance behavior are unchanged. Its entire body is no longer byte-identical.

The cycle-checked indexed ancestry walk also records each selected chain's
terminal parent PID. Before staging/commit, every unmatched row chain is checked
for an absent previously-known anchor/intermediate. Such a chain is unresolved
and STOPs, preserving all original map objects. The original proven anchor, safe failure/query metadata and explicitly
unproven numeric PID/parent edges persist, preserving the ambiguity without
diagnostic names or an inferred parent-generation witness. The exposed rows are not queried,
enrolled or signaled; no parent generation is inferred. Complete-known-leaf
absence with no exposed ambiguous child chain remains valid. No new census,
retry, observer, sleep, deadline or atomic-tree claim is added.

Actual-source regression tests cover targeted mismatch, pre/post reuse/reparent,
rejected deadline workers including missing initial capture, direct/deep
unresolved chains and ordinary leaf absence. Narrow semantic inverses must
restore the privacy leaks or dropped chain and fail these assertions. All
original workload/math/3+3/caps/GC/timing/source/cleanup gates remain unchanged.
No app/live OS query/build/collector CLI/private/freeze/GO is authorized here.
Exact changed-head independent review, current CI, new source/pair/private
bindings and qualification/formal authority are still required.
