# Renderer benchmarks

This runner measures a fresh, isolated Clave instance through Playwright's real Electron API. It never connects to the running user's app. It uses the repository's existing echo adapter and fixture transport, with synthetic text and no inference.

The [15 October baseline](renderer-baseline/report.md) includes the raw timings, sampled stacks, flamegraphs, rejected collection attempts, and interpretation limits.

## Reproduce on macOS

Use the repository's npm workflow. Build and sample sequentially, with other development builds and checks paused during sampling. An installed Clave may stay running, but record that source of contention. Do not stop unrelated applications to obtain a cleaner number.

```sh
npm ci
npm run build
node --test tests/performance/renderer-data.test.mjs tests/performance/renderer-cli.test.mjs
mkdir -p /tmp/clave-renderer-measurements
CLAVE_E2E_NS=clave-perf-1015-a node scripts/performance/renderer-benchmark.mjs \
  --build installed --source 4dd8e425e10b7fb13186fa45179aa1c87a84c2d6 \
  --out /tmp/clave-renderer-measurements/installed
CLAVE_E2E_NS=clave-perf-1015-a node scripts/performance/renderer-benchmark.mjs \
  --build dev --out /tmp/clave-renderer-measurements/dev
```

`--source` is the operator's release-tag attribution, not a commit extracted from the executable. Check the installed version and tag before supplying it. The runner records the executable's SHA-256 and the version reported by the launched app. A dev run records Git HEAD; use a clean product tree and record any tooling changes. The baseline's two source commits have identical trees.

The output directory must not exist. Failed runs exit nonzero, retain their partial `measurements.json`, and do not produce a completed summary. Each launch has a unique directory under `/tmp/clave-perf-1015-a`; it is removed after the app closes. The runner requests `--server=separate`, removes inherited server endpoints, verifies its actual data path and server mode, and uses OS-assigned ports. It closes only the process it launched, with a bounded exact-PID fallback. It does not change trust or authentication settings.

The options `--runs`, `--samples`, `--tabs`, `--turns`, and `--idle-ms` control the workload. Defaults are five fresh process launches, thirty retained observations per interaction and pass, twenty-four chats across four groups, two hundred alternating user/assistant turns per chat, and five-second idle windows. Five warmup observations precede each scenario. Tabs must divide evenly into four groups, with at least eight tabs. A small pilot is a setup check and is not comparable to the published baseline.

## What each observation means

| Field                     | Start and end                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `startupMs`               | Before Electron launch to the first window's boot and fresh server discovery record. Includes Playwright connection and readiness polling. Fresh data, warm filesystem caches. |
| `reloadStartupMs`         | Renderer reload to the same readiness criterion, with server already running and CDP profiling active. Not whole-process startup.                                              |
| `emptyIdle`, `loadedIdle` | CDP Performance counter differences over the requested idle window. `taskMs` is renderer main-thread task time; `scriptMs` is its script subset.                               |
| `tab`                     | Captured click on a session in the first group to the second requestAnimationFrame callback. Cycles through that group's six tabs.                                             |
| `group`                   | Captured click on each group header to the second requestAnimationFrame callback. Selects the group's six-session layout.                                                      |
| `composer`                | Captured input event for one typed `x` to the second requestAnimationFrame callback, with a single selected chat. The draft is cleared outside the measurement.                |
| `scroll`                  | Captured scroll event to the second requestAnimationFrame callback, alternating transcript top/end. Requires actual overflow and movement.                                     |

The runner verifies the selected session, synthetic transcript, accepted composer value, and scroll movement. It preserves scroll position between passes, as the product does. Seeding each tab must display its final synthetic turn; setup time is recorded separately from startup.

These are hidden-window event-to-rendering-opportunity measurements. `--test-no-activate` keeps the window off screen and background throttling off. Two animation frames impose a refresh-cadence floor. The measurements exclude Playwright's actionability wait and event dispatch overhead, and do not measure input hardware, OS dispatch, compositor presentation, or pixels seen by a foreground user. A low number here cannot disprove reported foreground sluggishness.

Each launch runs an unsampled pass, then the same scenarios under a 1 ms V8 profiler. The paired distributions describe sensitivity to instrumentation. Fixed pass order, cache warming, and shared-machine load prevent treating their difference as a causal overhead estimate. Profiles also contain Playwright's injected selectors, focus operations, and the measurement callbacks. A large `focus` or selector bucket can belong to the driver. Attribute it from the stack before choosing a product change.

All raw observations remain in `measurements.json`. Quantiles use nearest rank. p95 is omitted below twenty samples. Pooled interaction p95 combines five runs with thirty observations each; those observations are clustered within runs. The per-run arrays and quantiles are retained. Five startup launches support median/range, not a reliable tail percentile.

## Profiles and flamegraphs

The runner writes actual CDP `.cpuprofile` files and self-contained `.html` flamegraphs for renderer reload, empty idle, loaded idle, and the sampled interaction pass. Open the HTML directly in a browser. Width is inclusive sample time; the root is at the top. Hover to inspect names, source locations, and weights. Idle, program, and garbage-collection samples are retained. These graphs aggregate stacks rather than drawing an interaction timeline. They cover the renderer's V8 thread, including its preload world, not Electron main, the separate server, the GPU, or every compositor thread.

Derived profiles must contain samples, matching finite nonnegative durations, known node references, and a consistent tree. The signed-input policy and raw retention are described below. The reload phase can retry the entire reload up to three times when its profile is rejected. Every failed reload duration and diagnostic stays in `reloadAttempts`; raw sample intervals are never clamped, overwritten, or silently discarded. An exhausted retry or a failure in another phase fails the run.

The publication scrubber rebuilds profiles from known fields. It keeps asset basenames, safe Node runtime names, preload basenames, and line/column positions; it drops other source URLs and absolute paths. The baseline archives all accepted profiles as gzip, plus first-run openable HTML for each scenario. To inspect a compressed profile in Chromium DevTools, decompress it first:

```sh
gzip -dc docs/performance/renderer-baseline/installed/run-1-interactions.cpuprofile.gz \
  > /tmp/clave-renderer-interactions.cpuprofile
```

Private run logs, provider conversations, and the sample of the user's installed renderer are outside the publication set. The checked-in artifacts contain only the synthetic workload. Verify the durable evidence with:

```sh
node --test tests/performance/renderer-*.test.mjs
```

The normal Vitest suite invokes these same Node checks through `scripts/performance/renderer.test.mjs`. The explicit command is useful for focused verification.

## High-scale background stream comparison

The amended workload uses 100 tabs in ten groups, with 200 turns in the first twenty tabs and two turns in the remaining eighty. The first group supplies the measured tab switches and composer. Four chats in other groups stay hidden and working in both phases. The off phase sends no text deltas; the on phase targets one 128-byte ASCII delta per chat every 50 ms, with a 30-second ceiling. Actual event counts, elapsed time and realized rate are recorded, rather than assuming the requested cadence was achieved. Renderer observers subscribe through the normal preload API in both phases and assert exact produced/delivered counts. This adds four instrumented subscriptions and counter callbacks to the workload.

```sh
CLAVE_E2E_NS=clave-perf-1015-a node scripts/performance/renderer-benchmark.mjs \
  --build installed --source 4dd8e425e10b7fb13186fa45179aa1c87a84c2d6 \
  --streaming --tabs 100 --groups 10 --history-tabs 20 --runs 3 \
  --out /tmp/clave-renderer-measurements/installed-100
CLAVE_E2E_NS=clave-perf-1015-a node scripts/performance/renderer-benchmark.mjs \
  --build dev --streaming --tabs 100 --groups 10 --history-tabs 20 --runs 3 \
  --out /tmp/clave-renderer-measurements/dev-100
```

Both phases are profiled. Their idle/task counters and tab/composer samples compare streaming off/on under the same instrumentation, starting from the same tab/history data. Working-state animation is present in both. Fixed phase order and the growing hidden assistant text remain confounders. This controlled comparison is distinct from the 24-tab done-state baseline and does not include group-header or scroll timings.

## Signed profile intervals and raw retention

The first baseline runner strictly rejected negative intervals and did not retain the original rejected responses. Its excluded-attempt diagnostics cannot recover those stacks. The accepted 24-tab profiles have nonnegative intervals; their original weights remain unchanged.

The amended runner saves every original CDP response privately before validation. A scrubbed `.raw.cpuprofile` retains the original sample IDs and signed intervals for publication. A separate derived `.cpuprofile` orders cumulative timestamps together with their sample IDs. It assigns each observed interval to its paired ending sample, preserving the exact observed span. Timestamps outside the profile bounds, or sorting that would change the observed span, are rejected. No final interval is extrapolated. An audit records reordered samples, negative intervals, duration before/after and the unsampled tail. This is a conservative declared weighting policy, rather than a claim of identical DevTools flame-chart durations.

Chrome DevTools also forms cumulative timestamps and sorts the associated sample IDs with them, then performs its own timestamp normalization. That implementation informed the paired sorting; its estimated final interval is not used here. See the [primary DevTools implementation](https://github.com/ChromeDevTools/devtools-frontend/blob/main/front_end/models/cpu_profile/CPUProfileDataModel.ts), inspected on 15 October 2026.

To archive a completed streaming collection, use a new destination:

```sh
node scripts/performance/renderer-archive.mjs \
  --input /tmp/clave-renderer-measurements/installed-100 \
  --out /tmp/clave-renderer-measurements/installed-100-archive
```

Repeat `--input` when a bounded scheduling slot required multiple compatible collections. The archiver refuses incomplete inputs or differing workload, protocol, source, machine, or runtime-tool hashes. It preserves each original measurement file and raw/derived profile pair in a `collection-N` directory, and writes a pooled summary with explicit provenance. It neither changes raw observations nor treats multiple actions as independent process launches.
