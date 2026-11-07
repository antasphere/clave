# Clave renderer baseline, 15 October 2026

Four hidden synthetic streams add a median **728.4 ms installed and 636.6 ms dev** of renderer main-thread task time per five-second idle window in the 100-tab workload. The sampled application stacks include Markdown scanning. The user selected a next-phase target of at least 75% less extra task time, while keeping the existing handler-to-frame typing p95 below 50 ms. A separate product lane owns that change; this PR includes measurement tooling and evidence only.

These are controlled synthetic hidden-window results. They identify a repeatable cost but do not establish the cause of all sluggishness in the live app. The latency metric starts at event dispatch and excludes input queuing, Playwright actionability, hardware and presented pixels. A driver action-request wall timer was not added within the bounded collection slot; that coverage is still missing.

Issue [#187](https://github.com/antasphere/clave/issues/187), wave [#186](https://github.com/antasphere/clave/issues/186). [Reproduction and metric definitions](../renderer-benchmarks.md).

## 100 tabs, streaming off versus on

Three fresh launches per build, ten groups, twenty 200-turn histories and eighty two-turn histories. Every tab displays its synthetic tail during setup. Four chats at indices 10, 20, 30 and 40 remain hidden and working in both phases. The visible tab/composer is in the first group. Both phases are profiled at 1 ms; only on sends 128-byte ASCII assistant deltas at a requested 20 Hz per chat. Four normal preload observer subscriptions exist in both phases. Off/on start with the same tab/history data; on adds text as it runs. Fixed phase order, warming and text growth remain confounders.

Raw [installed series](installed-100/measurements.json) and [dev series](dev-100/measurements.json) preserve original collections in linked collection folders. Dev was split into one plus two launches to honor scheduling deadlines; pooling validates identical source, workload, protocol, machine and runtime-file hashes. The compiled product is still the same dev baseline and byte-identical renderer described below. The 100-tab runner executed at tooling HEAD 8d6fb84b with amendment files fingerprinted by toolingSha256; the final candidate preserves those runtime bytes.

| Build / run | Off task ms / 5 s | On task ms / 5 s | Extra task ms | On delivered events | Actual rate / s | Stream duration s |
| ----------- | ----------------: | ---------------: | ------------: | ------------------: | --------------: | ----------------: |
| installed 1 |              45.6 |            835.8 |         790.3 |                 824 |           78.57 |            10.487 |
| installed 2 |              53.4 |            781.8 |         728.4 |                 836 |           78.68 |            10.625 |
| installed 3 |              46.6 |            602.5 |         556.0 |                 832 |           78.47 |            10.603 |
| dev 1       |              61.4 |            781.3 |         719.9 |                 884 |           78.43 |            11.271 |
| dev 2       |              47.7 |            684.3 |         636.6 |                 900 |           77.29 |            11.644 |
| dev 3       |              50.7 |            672.0 |         621.3 |                 848 |           77.72 |            10.911 |

The event totals cover the complete on phase, including its initial five-second idle window and subsequent input actions. Produced and renderer-observed counts match exactly for every hidden chat; off counts are zero. Task values above are from the idle window alone, before input actions, and represent renderer main-thread counters rather than OS whole-process CPU. The constant observers add instrumentation overhead. Counts prove per-chat totals, not ordered exactly-once delivery: a drop plus a duplicate of the identical payload could cancel out.

Each action has five warmups and thirty retained observations per launch, for ninety pooled observations per build/phase/kind. Values below are p50 / p95 / max in milliseconds, at event-handler-to-second-animation-frame boundaries.

| Kind     |      Installed off |       Installed on |            Dev off |             Dev on |
| -------- | -----------------: | -----------------: | -----------------: | -----------------: |
| tab      | 34.9 / 45.1 / 47.0 | 33.2 / 35.8 / 45.5 | 37.8 / 43.3 / 47.0 | 33.3 / 39.1 / 50.1 |
| composer | 21.7 / 25.1 / 33.8 | 24.5 / 28.1 / 29.5 | 20.8 / 24.2 / 29.5 | 22.1 / 35.2 / 41.6 |

The lower on-phase tab p95 is not a speedup claim. Fixed order, warming and frame quantization prevent that inference. The 100-tab off phase also differs from the 24-tab reference in group size, history distribution, working state and instrumentation; their timing difference is not a pure tab-count scaling coefficient. Both builds already meet the selected 50 ms handler-only typing p95 guardrail. This does not prove low input-queue or foreground latency.

## Attribution and selected next target

The first installed on profile includes check at bundle line 53295, atBreak at 56530 and go2 at 56797. Inspecting the byte-identical renderer bundle maps these to Markdown Unicode/whitespace scanning, tokenizer break detection and tokenizer state transitions. Product ReactMarkdown rendering is in plugins/chat-view/src/ChatView.tsx, around lines 288-314. Those single-stack-node self weights are about 98.8, 98.0 and 77.4 ms over the full first on phase. They are concrete candidate attribution, not proof that every extra task millisecond is Markdown. Transport/preload, GC, observers and other rendering work also contribute. The full phase profiles contain input-driver work; do not attribute its query/focus stacks to product code.

| 100-tab phase   | Installed first-run graph                                      | Dev first-run graph                                      |
| --------------- | -------------------------------------------------------------- | -------------------------------------------------------- |
| Renderer reload | [graph](installed-100/collection-1/run-1-renderer-reload.html) | [graph](dev-100/collection-1/run-1-renderer-reload.html) |
| Streaming off   | [graph](installed-100/collection-1/run-1-stream-off.html)      | [graph](dev-100/collection-1/run-1-stream-off.html)      |
| Streaming on    | [graph](installed-100/collection-1/run-1-stream-on.html)       | [graph](dev-100/collection-1/run-1-stream-on.html)       |

The accepted 75% target means a same-protocol median extra task cost at or below **182.1 ms installed** or **159.2 ms dev** per five seconds, calculated from each build's own baseline. A dev product change must use the dev baseline, rather than the larger installed denominator. Maintain comparable delivered event rates and identical payload/workload; reducing or discarding input is not an optimization. Keep typing p95 below 50 ms with the handler-only definition visible. No product improvement is claimed here.

The benchmark checks delivery to its preload observers, not the native conversation view's final retained content after revealing each hidden chat. Product verification must prove every delta survives and becomes visible on focus. Otherwise dropping hidden content could satisfy a performance number while breaking the chat. This correctness check belongs to the product lane and is not implied by observer counts.

## Profile provenance and collection quality

There are sixteen accepted launches across the reference and high-scale matrices, 58 derived CPU profiles, 18 scrubbed raw high-scale profiles and fourteen openable first-run graphs. The original high-scale CDP responses are retained privately before validation; published raw copies remove private paths. Derived profiles pair sample IDs with cumulative timestamps, sort the pairs, and conserve the exact observed span without extending the unsampled tail. Two raw profiles contain a negative interval of -2 microseconds. Dev run 1 stream-off retains all 8,286 samples, reorders two positions and conserves exactly 10,676,541 microseconds. Installed run 2 renderer-reload retains all 1,039 samples, reorders two positions and conserves exactly 1,250,572 microseconds. Both raw/derived pairs and normalization audits are retained. See the [signed-interval policy and primary implementation reference](../renderer-benchmarks.md#signed-profile-intervals-and-raw-retention). The old 24-tab method's rejected raw-response limitation remains documented below.

All accepted launches completed their assertions, reported no uncaught renderer exception, closed without a timeout fallback and removed their temporary app data. Raw private captures are deliberate retained evidence, separate from app data and publication. No real conversation or live-user profile is included. Collection was serialized through wave leases, with explicit original-collection provenance. Start-of-run one-minute machine load ranged from 3.3 to 8.4 for installed-100 and 4.0 to 14.4 for dev-100; dev collection 2 ran at 13.0 to 14.4. These shared-machine conditions limit cross-build comparisons.

## 24-tab done-chat reference

The 24-tab done-chat reference shows very little renderer main-thread activity. It does not explain the reported sustained process CPU use in the user's app, because whole-process renderer CPU was not measured here. In twenty-four idle chats with two hundred turns each, the measured renderer main thread spent less than 1.1 ms on tasks during every unsampled five-second loaded-idle window. Whole-process startup is the largest repeatable delay in this workload. A single dev tab-switch outlier reached 112.9 ms. These observations do not establish the cause of foreground sluggishness. No product optimization is included.

Issue [#187](https://github.com/antasphere/clave/issues/187), wave [#186](https://github.com/antasphere/clave/issues/186). See the [runner and exact metric definitions](../renderer-benchmarks.md).

## Build and environment

| Item                | Installed                                                                    | Dev                                        |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| Source attribution  | `4dd8e425e10b7fb13186fa45179aa1c87a84c2d6`, release tag supplied by operator | `e8d4a9e51681417d53e20ef75052fe65d4654f1b` |
| Reported version    | 3.0.0-beta.2                                                                 | 2.4.0, package.json version                |
| Electron / Chromium | 39.5.2 / 142.0.7444.265                                                      | 39.5.2 / 142.0.7444.265                    |
| Transport           | Separate server, explicit flag                                               | Separate server, explicit flag             |

Both source commits resolve to tree `bc08338ebee1e11d4dbced2b78a97df709003396`. The 6,895,452-byte renderer bundle `assets/index-Cjkmx59C.js` is byte-identical, SHA-256 `5c029310da0a66ba0018e9e2a53b4080afa0f864f88066dfbdf675a03cb669b9`. The [bundle identity record](renderer-identity.json) and each run's executable hash separate source identity from packaging.

Machine: Apple M2 Max, 12 logical CPUs, 96 GiB RAM, arm64, macOS 26.6.2 build 25G83, Darwin 25.6.0, Node v22.12.0. Viewport 1400 × 900 CSS pixels, device pixel ratio 2. Every window remained hidden, with background throttling disabled. The installed user app and other machine workloads kept running.

Five fresh data-directory/process launches per build. Each launch measures an empty app, then twenty-four echo chats in four six-tab groups, 4,800 alternating synthetic user/assistant turns in total. Assistant turns include markdown and code fences. All chats are done, with no continuing agent stream. Every tab is visited while seeding; group clicks select the six-pane group layout, while composer/scroll measurements select one chat. Setup is separate from app startup. Five warmups and thirty retained observations per interaction/pass yield 150 observations per build/scenario/pass.

## Timing results

Nearest-rank quantiles. Startup has only five launches, so the table gives median and range; no startup p95. Interaction quantiles are pooled across five clusters of thirty observations, not 150 independent application launches.

| Metric                                              |               Installed |                     Dev |
| --------------------------------------------------- | ----------------------: | ----------------------: |
| Process launch to boot, median [min, max] ms        | 2743.2 [2648.9, 3253.7] | 2079.2 [1994.0, 3512.3] |
| Profiled warm renderer reload, median [min, max] ms | 1198.7 [1150.2, 1279.9] |    901.0 [850.0, 962.5] |
| Create and seed workload, median [min, max] ms      | 3538.5 [3346.3, 4048.5] | 3218.8 [3043.8, 4433.0] |

Raw [installed measurements](installed/measurements.json) and [dev measurements](dev/measurements.json) include every per-run sample, timer, idle counter, load average, runtime version, and cleanup result.

The following are event-to-second-animation-frame milliseconds, not input-to-visible-pixel latency. Each value is p50 / p95 / max.

| Interaction       | Installed unsampled | Installed profiled |       Dev unsampled |       Dev profiled |
| ----------------- | ------------------: | -----------------: | ------------------: | -----------------: |
| Same-group tab    |  27.5 / 28.7 / 29.3 | 28.1 / 29.4 / 31.3 | 27.7 / 28.9 / 112.9 | 28.4 / 29.5 / 32.3 |
| Group header      |  26.5 / 28.1 / 29.0 | 27.7 / 30.1 / 30.7 |  27.1 / 28.4 / 29.3 | 27.4 / 30.0 / 31.0 |
| Composer input    |  20.7 / 30.6 / 32.0 | 20.8 / 29.2 / 31.5 |  20.9 / 30.5 / 32.1 | 21.6 / 30.0 / 32.3 |
| Transcript scroll |  17.4 / 18.3 / 19.0 | 17.3 / 18.3 / 18.5 |  17.3 / 18.0 / 18.5 | 17.3 / 18.3 / 18.8 |

The dev tab-switch maximum is one 112.9 ms observation; its sampled pass never exceeds 32.3 ms. That outlier has no simultaneous CPU profile, so these traces cannot explain it. Retain it in the distribution and investigate with event-aligned tracing rather than attributing it to a sampled stack from a different pass.

## Idle, memory, and observer effects

| Five-second window  | Installed task-ms range | Dev task-ms range |
| ------------------- | ----------------------: | ----------------: |
| Empty, unsampled    |             0.701–2.304 |       0.343–0.636 |
| 24 chats, unsampled |             0.278–0.645 |       0.277–1.025 |
| Empty, profiled     |             4.438–8.802 |      4.965–30.559 |
| 24 chats, profiled  |            0.056–63.177 |      0.063–42.466 |

These are CDP renderer main-thread task counters, not OS process CPU percentages. They exclude other renderer threads, GPU work, and the separate server. The loaded-idle V8 profiles are overwhelmingly idle. Native sampling of the actual user app remains private context and is not comparable to this synthetic hidden-window run.

The first loaded profiled idle window includes 63.2 ms of task time installed and 42.5 ms dev, with a large heap reduction. The corresponding profiles contain garbage collection. Later loaded profiled windows are below 0.1 ms. This shows why profiled and unprofiled idle counters must be kept separate. It is not evidence that the profiler improves idle efficiency.

Loaded unsampled JS heap snapshots span 197.3–316.0 MiB installed and 116.1–240.4 MiB dev. Collection was not forced and snapshots occur between collections; the subsequent large heap drops prevent treating these ranges as retained memory or evidence of a leak. Process RSS is outside this renderer measurement.

At interaction p95 the sampled-minus-unsampled differences range from −1.4 to +2.0 ms. Fixed pass order, frame quantization, warm caches, and shared-machine load prevent treating this as a precise profiler-overhead estimate. Both distributions and the larger profiled idle/GC effects are published instead of subtracting an assumed correction.

Installed collection began at 14:22:20 UTC, after the other lane's build ended at 14:22:07. No accepted run overlaps that build. Installed run-start one-minute load averages nevertheless fell from 36.84 to 14.25; dev run-start averages ranged 7.83–20.73. The first installed measurements therefore retain recent machine-load history, and installed runs precede dev runs. The 664 ms median startup difference cannot be assigned solely to packaging. No other lane build/check/sampling was knowingly concurrent with the accepted collection.

## Sampled stacks and candidate investigations

Each link opens a standalone first-run graph. All forty accepted raw profiles are archived beside the measurements as `.cpuprofile.gz`. Decompress them to import into DevTools. First-run graphs are representative examples; the hotspot figures below aggregate self time across all five runs, rather than selecting one favorable profile.

| Scenario         | Installed                                          | Dev                                          |
| ---------------- | -------------------------------------------------- | -------------------------------------------- |
| Renderer reload  | [flamegraph](installed/run-1-renderer-reload.html) | [flamegraph](dev/run-1-renderer-reload.html) |
| Empty idle       | [flamegraph](installed/run-1-empty-idle.html)      | [flamegraph](dev/run-1-empty-idle.html)      |
| 24-chat idle     | [flamegraph](installed/run-1-many-idle.html)       | [flamegraph](dev/run-1-many-idle.html)       |
| Interaction pass | [flamegraph](installed/run-1-interactions.html)    | [flamegraph](dev/run-1-interactions.html)    |

1. **Investigate preload/module bootstrap first.** Renderer reload medians are about 1.20 s installed and 0.90 s dev, while interaction medians are about 17–28 ms. Across installed reload profiles, `splitPath` frames account for about 246 ms self time per reload, `makeContextifyScript` about 101 ms, package export reads about 47 ms, and `compileSourceTextModule` about 36 ms. Dev retains about 94 ms of `makeContextifyScript` and 37 ms of module compilation. Safe Node source names identify module loading/path work; the preload is part of this renderer process. Inspect `src/preload/index.ts`, its first routed `@clave/client/node` import, the package graph, and Electron asar resolution before selecting a change. This is a candidate investigation, not proof that any one product import should be removed. Reproduce with alternating installed/dev order before estimating a packaging penalty.

2. **Capture the long tab-switch path at the event that stalls.** One dev observation reached 112.9 ms with a 28.9 ms p95. A continuous event-aligned trace on a busy synthetic workload can determine whether the delay is React work, scheduling, layout, or another process. The current separate sampled pass cannot assign that observation a cause.

3. **Treat scroll callbacks as smaller candidates.** Mean sampled interaction self time is about 68 ms installed and 58 ms dev in `loop` at bundle line 34395, and about 63 ms in the callback at line 142972. The first maps to Radix ScrollArea's `addUnlinkedScrollListener` polling loop, the second to `useTranscriptEnd` in `plugins/chat-view/src/transcript.ts`. These are totals over the complete sampled interaction pass, not time per scroll. They are below 1% each of sampled wall time in these passes. Preserve the existing behavior and establish a larger busy-workload cost before optimizing them. Source locations are bundle line/column positions; the byte-identical bundle lets a reviewer inspect the same functions in the dev output.

The interaction profiles also include roughly 362–389 ms of `focus` and 247–265 ms of injected `query` self time per pass. Those stacks include Playwright's focus/selector driver. They must not be presented as product-only costs. Idle and program buckets are retained, and the graphs do not subtract driver overhead or imply that inclusive ancestor times add together.

## Proposed targets for the next phase

These are review proposals, not forecasts of achieved gains. No product change is authorized by this report.

| Proposal                                                                    | Reason and condition                                                                                                                                                                                                  |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reproduce the high-CPU foreground complaint before claiming it fixed        | Add a controlled synthetic busy-stream/working-state case and foreground tracing when it can run without disrupting the user. Capture an event-aligned trace for every interaction over 100 ms.                       |
| Explore process-start median ≤2.0 s and warm renderer reload median ≤750 ms | Current medians are 2.74 s and 1.20 s installed. Confirm the preload/module cost under alternating run order first; the numbers are acceptance proposals, not predicted savings.                                      |
| Keep same-protocol composer/group/tab p95 ≤50 ms and scroll p95 ≤34 ms      | These guardrails leave a small number of 60 Hz rendering opportunities. Current p95 values already meet them. Also report every >100 ms outlier so a good p95 does not hide stutter.                                  |
| Keep idle cost separated from foreground/busy cost                          | For this done-chat hidden workload, propose ≤5 ms renderer task time per five seconds without the profiler, while separately recording GC and process/GPU CPU. This does not set a bound for live streaming sessions. |

## Collection quality and limits

The [excluded collections](excluded-collections.json) retain small setup pilots and failed development attempts. They are not included in the baseline summary. Failures exposed a multi-pane selector, a Node-only hash accidentally inserted into a page callback, an assertion that incorrectly expected a virtualized tail to remain mounted after scrolling up, and invalid profiler intervals. Those runner mistakes were fixed before the accepted collection. One accepted dev launch rejected an initial reload profile with a −2 µs interval, then recorded a valid entire-reload retry. Both durations and the diagnostic remain in its `reloadAttempts`. No CPU intervals were clamped or repaired. The earlier −4 µs rejected profile is recorded among excluded attempts.

All ten accepted launches completed their full workloads, reported no uncaught renderer exception, closed without the fallback timeout, and removed their temporary app data. Checks validate sample counts, quantiles, profile references/tree/weights, graph sample counts, and path scrubbing. They refuse invalid CLI inputs before any app is launched. No real conversation, provider transcript, credentials, or live-user profile is included.

Coverage ends at deterministic done-state chats, a fresh default plugin/settings profile, and hidden windows on one Mac. There are no live provider streams, long-running working animations, terminal PTY output, attachments, restored real histories, third-party plugins, foreground presentation measurements, GPU profiles, or OS-level renderer CPU/RSS series. The baseline therefore supplies a reproducible lower-complexity reference and concrete startup evidence, rather than a complete reproduction of the user's workload. Main/server measurements belong to lane B.

## Verification

Run `node --test tests/performance/renderer-*.test.mjs` for timing/profile validation, CLI refusal checks, and the published-artifact assertions. The repository Vitest suite invokes the same checks. Repository gate results and the independent opposite-provider report are recorded on issue #187 and its PR. This baseline does not imply that independent review or CI passed.

## Final local checks and test environment

After the 100-tab amendments, the focused Node suite passed all 13 checks, including collection provenance, signed sample attribution/conservation, exact stream delivery, all published profiles and path scrubbing. Lint, build with typecheck, and the full unit suite passed again: 263 files and 2,961 tests passed, one file/two tests skipped.

The inherited interactive shell was /opt/homebrew/bin/nu. The existing server-boot probes use POSIX shell syntax; rerunning the unchanged spec with child-only SHELL=/bin/zsh passed all 71 checks, with no known or unstable results. No global shell/configuration or product code changed. The original combined Nushell command recorded 84 passed and six failed checks: 19 passes from the focused chat-scroll/no-activate specs, plus 65 passes and six terminal-output failures in server-boot. The later single-spec POSIX run passed all 71 server-boot checks. Both outcomes are retained in the issue record and private logs. This was a test-environment failure, not a waived assertion. Use the same child-only POSIX shell setting when reproducing that spec. The earlier completed chat-scroll-end and test-no-activate specs passed. The extra broad chat-view exercise remains incomplete at its known unstable permission-state assertion; no full-chat-view pass is claimed. Independent opposite-provider verification and current-head CI remain separate gates and are not implied by these local results.
