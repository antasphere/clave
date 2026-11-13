# Full-parser source experiment, 20 October 2026

This is prospective preparation under the dated issue 204 scope amendment.
It starts at P2 commit `5151c41e9e1fc746def610f4cd45db60ed6186f1`, tree
`7ce4c1a1344d68bfc5b0e186fa8105b0bc374f13`. P2 remains frozen in its own
worktree. This experiment has no build, runtime, performance, resource or
independent acceptance result.

Both native assistant rows now render canonical `entry.text` through the
public `ReactMarkdown` with `remarkGfm` and the existing stable component map.
The change is limited to imports and that boundary. Pane/entry/tool memoization,
live link/error callbacks, connected link/table identity, transcript behavior
and the 150 ms presentation/cancellation policy are retained unchanged.
There is no `final=true` cache bypass, disabled flag or dormant cache wrapper
on these callsites. The old cache files remain on disk for preserved diagnostics.

The direct client fixture uses that same public renderer in all three roles.
`full-a`, `full-b` and `candidate` are matrix labels for three repeatability
roots, not independent algorithms or evidence of cache reuse. Literal
correctness remains independent of their equality. The fixture records this
boundary/comparison meaning. The pure contract has no obsolete renderer label,
so it remains unchanged.

The complete 24 direct values, 16 native first samples, original depths
16/64/128/256, initial/grows grammar, StrictMode, literal HTML/text/order,
connected article identity, errors and cleanup guards remain required. The
native first-sample protocol remains a passive matching public event receipt,
fixed 200 ms settling and exactly two animation frames, with one raw sample
persisted before assertions. All 12 roots and 16 passive listeners must be
cleaned up. None of those assertions is removed by retiring the cache.

This source preparation is deliberately not a runnable acceptance candidate.
The existing `markdown-parser-deep-client.spec.mjs` still requires the old cache
files among its bundle inputs. A subsequent scoped change must replace that
cache-presence requirement with public renderer/GFM presence and actual cache
absence, retaining every content, first-sample and cleanup guard. The current
required `native-parser-path` and `markdown-parser-lifecycle` specs still target
the retired attempt/store graph; their results cannot qualify this shipping
path. No CI, test discovery or assertion was edited here to hide that mismatch.

A later assignment needs an explicit invariant-preserving test/CI replacement:
normal discovered complete positional MDAST/HAST/JSX/URL and literal regressions;
real native content, reveal/final/control timing, stable maps/live callbacks,
draft/scroll/selection and timer/listener/root/process lifecycle checks; source
negatives for missed cancellation, stale content and lost memo/DOM identity.
Cache-only tail/rebase/cap/store/owner/Fiber claims become inapplicable only
after the shipping graph and build genuinely lack those objects. Old findings
and failed receipts remain preserved, not passed or waived.

The executable original SSR dependency diagnostic remains unchanged.
PRDCT-3634 is unresolved. Cache removal and public full/full repeatability do
not repair SSR. Historical R2's 69.688% reduction is motivation only; it is not
current-source evidence and its tab/group/composer misses remain failures.

All quantitative targets remain unchanged: at least 60% median extra-task
reduction; tab/composer handler p95 at most 50 ms, group p95 at most 75 ms,
native composer request p95 at most 50 ms and zero unrelated pane renders.
Use the frozen 100-tab/10-group, 20-by-200-turn, 34380-byte reply workload with
128-byte deltas every 50 ms, three BEFORE then three AFTER launches, five
warmups/30 samples, five-second task windows and 1 ms profiling. Producer rate
must be 17–21 Hz with at most 10% pair difference; ordered canonical data and
zero page errors remain mandatory. Secondary alternating P/U and actual-orb
diagnostics cannot replace a primary miss. A miss requires attribution and a
new bounded decision, not weaker criteria or automatic cache reintroduction.

The prospective physical-resource comparison is the whole retained feature
against a nonidentical raw current-dev control, frozen after L/possible66.
An R2-equivalent full-parser control might be identical code and would measure
repeatability only. A separately reviewed small whole-heap collector must keep
three control plus three candidate launches, 100 sessions/20 long histories,
12 warm/closed milestones with five replacement cycles, normal archives/events
and equal populations. Detach producers/observers/debuggers, release all
measurement handles, settle one second with the same frame barriers, perform
two actual full GCs and record `Runtime.getHeapUsage.usedSize`. The predeclared
primary warm-median candidate/control ratio stays at most 1.20; retain every
cycle, range and cleanup result and investigate unexplained growth. This is
not exhaustive holder/no-leak proof. No old unqualified cache collector guard
may be bypassed to produce that result.

No install, build, test suite, Electron, timing or heap collection was run in
this source-only phase. Built cache absence is NOTRUN. No new collector,
physical cache deletion, commit, push, readiness or merge is authorized here.
Root owns the next build/test/CI/resource assignment and independent review.


## P4 implementation, 20 October 2026

The preparation statements above describe P3 and remain its historical record.
P4 now implements current full-pipeline units, real native/lifecycle gates,
required CI gates, actual Rollup module/output audit and the separate six-file
whole-renderer resource tool. The cache modules are archived under
tests/diagnostics/prefix-cache; cache-only native diagnostics are nested under
tests/e2e/diagnostics/prefix-cache, outside the runner's top-level discovery.
Their original assertions and reversible import provenance are retained.
The normal cache-algorithm unit tests remain discovered as legacy coverage.
The original SSR diagnostic remains executable with the archived pure parser.
Current functional execution, first failures, source mutants and exact restore
proof belong to performance-full-parser-functional-report.md/json in the
shared handoff directory. No performance/resource acceptance follows from those
functional results. Resource tests in P4 are pure validator/state-machine
tests only; no qualification probe or acceptance cohort runs in this phase.

The retained invariants map to current checks as follows. Original cache-only
assertions remain in the exact reversible legacy sources; none is called a
current integration pass.

| Retained obligation | Current check |
| --- | --- |
| Complete positional MDAST/HAST, JSX keys/props/order, URL transforms and actual full VFile/parser/error entry | markdown-full-pipeline.test.ts and independent delimiter grammar; malformed position/key/content negatives |
| Original 16/64/128/256 initial/append literals, 24 direct StrictMode values and 16 actual native first samples | markdown-parser-deep-client plus unchanged markdown-deep-contract and its negative tests; direct roles are repeatability controls |
| Both native views, late reference definitions, replacement rows, complete first HTML, safe/unsafe/relative URLs and live growing-link/error callbacks | markdown-full-native |
| Connected links, tables, scroll frames and nonzero table scroll during append | markdown-full-native and retained renderer-responsiveness/checkMarkdownIdentity; actual unstable-map mutant |
| Hidden freeze/latest reveal, immediate controls/finals, shared drafts, caret selection and reading offset | markdown-full-native, real full-lifecycle fixture and unchanged renderer-responsiveness/presentation checks; actual stale-reveal mutant |
| Pending timer cancellation, StrictMode/root cleanup, row isolation, abandoned/error renders, real host subscription release and no stale closed row | full-lifecycle fixture and native close gate; actual missed-unmount-cancel mutant; existing harness/server-boot own process cleanup |
| Zero unrelated native pane renders and retained memo/cadence | unchanged renderer-responsiveness and presentation unit tests; actual lost-pane-memo mutant |
| No custom cache in the shipped app/native view modules | actual Rollup chunk module/source/output audit, including positive ChatView/TerminalView/ReactMarkdown/GFM contributions; rebuilt cache-reconnection mutant |
| Cache attempt/tail/rebase/cap/store/owner publication semantics | legacy algorithm units and archived diagnostics only; those objects are absent from the audited shipping graph |
| Original mandatory SSR mismatch | original named diagnostic remains executable and FAIL; PRDCT-3634 remains unresolved |
| Resource ratio/trajectory and quantitative latency criteria | deferred frozen current-dev whole-feature tools, not inferred from functional gates or historical results |
