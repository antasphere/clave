# Backend performance baseline: Electron main and the server

Issue [#188](https://github.com/antasphere/clave/issues/188), part of the wave
[#186](https://github.com/antasphere/clave/issues/186): measure before choosing
what to make faster. This page covers the **Electron main process** and the
**server** (in-process, or the separate child the installed app runs). The
renderer, its interactions and its frames are lane A's
([#187](https://github.com/antasphere/clave/issues/187)); the renderer's
process totals appear here only as context.

Nothing in this phase changes the app. The targets at the end are proposals for
the measurement review, not decisions.

## Summary

Measured on 2026-10-15. Machine: Apple M2 Max, 12 cores, 96 GiB, macOS 26.6.2.

The machine was shared. The person's own Clave and other work kept running, with a
1-minute load average of 6–15 and other processes using 3–6 cores' worth of CPU at
every launch. These are therefore figures from a busy machine, not an isolated one.

The window was hidden (`--test-no-activate`), so nothing here is foreground latency.

1. **At rest, main and the server are not where the sluggishness is.**
   - With 135 synthetic tabs and nothing asked of the app, main uses 1.5% of one core
     and the server 0.4%.
   - Their event loops stay within 3.5 ms of the timer at p99.
   - Live, under active agents, the coordinator measured the server at 10–12% and the
     renderer at 130–140%. Synthetic idle does not reproduce that. Streaming agent
     output is the workload that does, and it is lane A's case.
2. **The separate server is slow to start.**
   - Its process starts about 0.5 s after launch, but its event loop only runs about
     0.9 s later.
   - In the dev launch-to-quit profile, evaluating the server's gRPC chunk alone took
     674 ms, 46% of all the server's CPU over the launch.
   - Main reaches its server at 2.25 s, and the window finishes its boot at 2.3–2.6 s.
3. **Restoring 135 tabs keeps the server busy after the window shows them.**
   - In the 5 s after boot, the server averages 13% of one core at S135, against 1.2%
     at S0.
   - The heaviest Clave frames there write session records back
     (`writeChatRecord`, `writeEventSessionRecord`).
4. **Each query through the server costs about 1 ms more than the IPC floor, and
   the framework dominates that cost.**
   - Warm calls take 0.7–1.8 ms at p50 against 0.1 ms for a plain IPC round trip.
   - The query pass makes about 2,100 calls (10 methods × 211). Over it, the server's
     process CPU (`process.cpuUsage`, plain launches) works out to about 0.85 ms per
     call.
   - Its sampled main-thread time (profiled launch) is 940 ms, about 0.45 ms per call.
     44% of that is self time in the Effect runtime, while Clave's own frames are 6%.
5. **The backend holds about 770 MiB resident before any session runs.**
   - Main about 300 MiB, the server about 270 MiB, and the terminal process about
     200 MiB with no terminal open.
6. **Test isolation gap.**
   - Even under its own `--user-data-dir` and `--test-no-activate`, an instance reads
     the machine's Claude login from the macOS Keychain and calls the usage-limits
     endpoint at boot. The path is `readLimitsWith` → `readKeychainAccessToken` →
     `readFromEndpoint` in `src/main/usage-manager.ts`.
   - That is not inference and nothing is billed, but the benchmark is not
     credential-isolated on this point.

The installed 3.0.0-beta.2 and dev `e8d4a9e` (same source tree) measure alike. Every
dev figure falls inside or next to the installed range at n=3: boot 2339 ms
[1941–2831] against 2549 [2297–2561]. Dev's RSS is 16–39 MiB lower per process; that
difference is not explained by the measurements and was not investigated further.

## Results

Configurations were measured in three runs, each with 3 plain launches and 1 profiled
launch: `installed-separate · S135`, `dev-separate · S135` and `installed-separate ·
S0`. The other configurations (`dev-in-process`, `S24`) were not measured in this
bounded pass.

The complete tables are in [`backend/tables.md`](backend/tables.md). Each
configuration has its own folder under `backend/` with the raw samples (`raw.json`),
the scrubbed profiles (`*.cpuprofile.gz`) and the flamegraphs (`*.flame.html`).

### Startup (ms after the launch call; median [min–max], n=3)

| mark                          | installed · S135 | dev · S135       | installed · S0   |
| ----------------------------- | ---------------- | ---------------- | ---------------- |
| main process started          | 29 [27–35]       | 33 [32–64]       | 30 [29–38]       |
| server process started        | 515 [496–546]    | 614 [578–986]    | 521 [499–526]    |
| server event loop running     | 1405 [1285–1415] | 1496 [1377–1838] | 1350 [1346–1394] |
| window DOMContentLoaded       | 1465 [1447–1483] | 1439 [1312–1888] | 1477 [1442–1495] |
| main registered on its server | 2248 [2225–2327] | 2077 [1950–2568] | 2272 [2272–2279] |
| window boot complete          | 2549 [2297–2561] | 2339 [1941–2831] | 2585 [2254–2589] |
| every tab in its group        | 2647 [2627–2716] | 2431 [2268–2914] | –                |

Boot time is the same at 0 and 135 tabs, so the restore is not on the boot's
critical path in this setup. The span from the server's process start to its
event loop (about 0.9 s) and main's registration on its server (about 2.25 s)
are.

### CPU and memory

| configuration    | process          | 5 s after boot, mean CPU % | idle CPU %, p50 / p95 (n=87 one-second intervals) | idle mean | idle RSS MiB | idle event-loop delay beyond the timer, p99 ms |
| ---------------- | ---------------- | -------------------------- | ------------------------------------------------- | --------- | ------------ | ---------------------------------------------- |
| installed · S135 | main             | 2.4                        | 1.0 / 2.0                                         | 1.5       | 301          | 3.4                                            |
| installed · S135 | server           | 12.9                       | 0.0 / 1.0                                         | 0.4       | 275          | 2.0                                            |
| installed · S135 | terminal process | 0.0                        | 0.0 / 0.0                                         | 0.0       | 201          | –                                              |
| dev · S135       | main             | 1.0                        | 1.0 / 1.0                                         | 1.4       | 262          | 3.5                                            |
| dev · S135       | server           | 13.5                       | 0.0 / 1.0                                         | 0.5       | 247          | 1.7                                            |
| installed · S0   | main             | 1.0                        | 1.0 / 2.0                                         | 1.2       | 303          | 3.5                                            |
| installed · S0   | server           | 1.2                        | 0.0 / 1.0                                         | 0.2       | 267          | 2.1                                            |

How to read the CPU columns:

- `ps` reports CPU time in 10 ms steps, so a 1-second interval reads in steps of 1%.
  The mean is exact; the quantiles are coarse.
- Main's event-loop utilisation is not given: Electron runs Chromium's loop, and
  `eventLoopUtilization` reads 0 there whatever main does.

### Queries from the window (warm calls pooled across launches, n=600 per cell)

| method                                       | road             | installed · S135 p50 / p95 ms | dev · S135  | installed · S0 | cold first call, installed · S135 (median of 3) |
| -------------------------------------------- | ---------------- | ----------------------------- | ----------- | -------------- | ----------------------------------------------- |
| `windowIdentity`                             | IPC (floor)      | 0.10 / 0.20                   | 0.10 / 0.10 | 0.10 / 0.20    | 0.3                                             |
| `sidebarLayoutLoad`                          | server (sidebar) | 0.20 / 0.30                   | 0.20 / 0.30 | 0.10 / 0.20    | 0.5                                             |
| `listTrustedRoots`                           | server           | 0.80 / 1.40                   | 0.70 / 1.30 | 0.80 / 1.50    | 1.3                                             |
| `claudeAccountsList`                         | server           | 0.80 / 1.40                   | 0.70 / 1.00 | 0.90 / 3.40    | 1.1                                             |
| `launchProfilesList`                         | server           | 0.90 / 1.30                   | 0.90 / 2.00 | 1.00 / 2.20    | 1.4                                             |
| `pluginsList`                                | server           | 1.00 / 1.60                   | 0.90 / 2.00 | 1.00 / 2.20    | 1.2                                             |
| `workspaceLoad`                              | server           | 1.10 / 2.20                   | 1.00 / 2.60 | 1.10 / 2.40    | 3.2                                             |
| `sessionsList` (42 kB at S135)               | server           | 1.80 / 2.80                   | 1.70 / 2.80 | 0.80 / 1.60    | 2.8                                             |
| `sessionsHistory` (newest page of 200 turns) | server           | 1.70 / 2.80                   | 1.50 / 2.80 | –              | 13.9                                            |
| `discoverClaveFilesRecursive`                | server           | 2.00 / 5.00                   | 1.70 / 2.80 | 1.20 / 2.70    | 18.9                                            |

The server's own cost over the whole query pass:

- Installed S135: 72% of one core for 2.5 s, event-loop utilisation 50%.
- Main over the same pass: 3–8%.

### Where the CPU goes (V8 profiles)

| profile                                       | busy                       | where                                                                                                                                                                                              |
| --------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| dev · S135 · server, launch to quit           | 1457 ms                    | Stacks under a module load or compile frame 50%. The gRPC chunk's top-level evaluation is 674 ms (46%). Restore: `spawn` 113 ms, `writeChatRecord` 68 ms, `writeEventSessionRecord` 55 ms.         |
| dev · S135 · main, launch to quit             | 1153 ms                    | Stacks under a module load or compile frame 58%: main's bundle and its `index`, `api` and `Shutdown` chunks. `openPersistedWindows`/`createWindow` 86 ms. The usage read (`readLimitsWith`) 13 ms. |
| dev · S135 · terminal process, launch to quit | 503 ms                     | 91% under a module load or compile frame; no terminal ran.                                                                                                                                         |
| installed · S135 · server, query pass         | 940 ms (44% of the window) | By leaf: Effect runtime 44%, Node internals 23%, Clave code 6%. Heaviest Clave frames: `findClaveFile`/`scan` (recursive discovery), `exists`, `history`.                                          |
| installed · S135 · server, idle 15 s          | 267 ms (1.8%)              | Mostly native work and GC. The Clave frames are the boot-time usage read (`readLimitsWith`, `fetchWithTimeout`, `readKeychainItem`).                                                               |
| installed · S135 · main, idle 15 s            | 55 ms (0.4%)               | Nothing to rank.                                                                                                                                                                                   |

No profile had an out-of-order sample in this pass.

There are no launch-to-quit profiles for the installed app, because the signed app
ignores `NODE_OPTIONS`. See Limitations.

## Bottlenecks, ranked by measured impact

1. **Server cold start.**
   - About 0.9 s from the separate server's process start to its event loop, on the
     critical path to main's registration (about 2.25 s) and so to the boot (about
     2.5 s).
   - Evidence: 674 ms of top-level evaluation of the gRPC chunk in the dev
     launch-to-quit profile (`startup-profile-server.flame.html`).
2. **Restore tail at scale.**
   - About 0.65 s of server CPU in the 5 s after boot at 135 tabs: 13% of one core
     for 5 s, against 1.2% with no tab.
   - It goes on writing records back during restore.
3. **Per-request framework overhead.**
   - About 0.85 ms of server process CPU per query (0.45 ms on its main thread), with
     Clave's code about 6% of the main-thread time.
   - Invisible at these call rates (each call is 1–2 ms), but it multiplies with any
     high-frequency server traffic, such as a streaming session's events.
   - That traffic was not measured here.
4. **Resident memory before any work**: about 770 MiB across the three backend
   processes, about 200 MiB of it a terminal process with no terminal.
5. **Cold first calls** of the recursive discovery (about 15–19 ms) and of a long
   history page (about 14–15 ms).

## Proposed targets, for the measurement review

These are proposals with their rationale, not decisions. Nothing here estimates a
gain the measurements do not show.

| #   | target                                                                                               | measured now                   | rationale                                                                                                                                                                        |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | Server event loop running ≤ 0.6 s after its process starts, on the installed app at S135             | 0.9 s (1405 − 515 ms)          | Removes most of the gRPC chunk's evaluation from the critical path, if its use at boot is not required. Check with this tool's startup marks and the dev launch-to-quit profile. |
| T2  | Main registered on its server ≤ 1.6 s after launch                                                   | 2.25 s                         | Follows T1. The registration is what the boot waits on.                                                                                                                          |
| T3  | Server CPU in the 5 s after boot at S135 ≤ 2× S0                                                     | 12.9% against 1.2% (about 10×) | The restore's record rewrites are the heaviest Clave frames of that window.                                                                                                      |
| T4  | Before any change to the request path: measure the server's per-event cost under a streaming session | not measured                   | Bottleneck 3 only matters if real traffic is high-frequency. Lane A's streaming workload is the place to measure it.                                                             |
| T5  | Test-mode instances never read the Keychain login or call the usage endpoint                         | they do                        | Isolation for every benchmark and E2E run on a person's machine.                                                                                                                 |

## Out of scope and not measured

The following were not measured:

- `dev-in-process` and `S24`;
- startup profiles of the installed app;
- foreground, visible latency;
- streaming agent output and any other active-agent workload;
- the renderer's own interaction costs (lane A).

None of these may be inferred from this page.

## What is measured, and how

One run of `tests/performance/backend-bench.mjs` is one **configuration**: a
variant on a scale, launched N times on fresh data, then once more with the
profilers on.

| Variant              | What runs                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------- |
| `installed-separate` | `/Applications/Clave.app` as installed, on its separate server (the packaged default on macOS) |
| `dev-separate`       | this checkout's `out/` under its `node_modules` Electron, `--server=separate`                  |
| `dev-in-process`     | the same build, the server inside Electron main                                                |

| Scale  | Synthetic profile                                                                            |
| ------ | -------------------------------------------------------------------------------------------- |
| `S0`   | one workspace, no session                                                                    |
| `S24`  | 24 chat tabs in 4 groups                                                                     |
| `S135` | 135 chat tabs in 14 groups, 15 workspaces: the size of the live profile reported to the wave |

The chats are restored records (60% Codex, 40% Claude) whose agents are stubs
that log their start and sleep: nothing reaches a provider, nothing is
inferred, the shared `clave` tmux socket is never used (chats are event
sessions). Twenty Claude chats carry a synthetic 200-turn transcript, read by
the history query; the others are dormant tabs. No real conversation, account
or profile is read: every launch gets its own `--user-data-dir`, its own
transcript roots (`CLAVE_TRANSCRIPTS_ROOT`, `CLAVE_CODEX_ROOT`), a stub login
shell, and telemetry off.

Per launch:

- **Startup marks**, in ms after `electron.launch` was called: each process's
  own start (`performance.timeOrigin`) and event-loop start
  (`performance.nodeTiming.loopStart`) for main and the server, main's
  registration on its server (the discovery file it writes), the window's
  navigation start and `DOMContentLoaded`, the boot (`<html data-boot>`), and
  every seeded tab in its group. The window-side marks are polled every 10 ms
  inside the page, so the driver's latency is not in them.
- **Right after the boot**: 5 s of `ps` readings, kept apart, because the
  restore's tail (sessions adopted, records written) runs past the moment the
  tabs are drawn.
- **Idle**: then nothing asked for 30 s. `ps` reads the CPU time and RSS of main,
  the server, the terminal process and the renderer every second; main and the
  server record their event-loop delay (`monitorEventLoopDelay`, 10 ms
  resolution) and event-loop utilisation; Electron's `getAppMetrics` gives the
  GPU and utility processes over the same window.
- **Queries**: the window's own `window.electronAPI` calls, timed inside the
  page: the first call alone (cold), 10 untimed warm-ups, then 200 timed calls
  each, every answer checked. `windowIdentity` is a plain IPC round trip, the
  floor; the others go through the server (`viaServer`). Main's and the
  server's event loop and CPU are recorded over the whole pass.
- **CPU profiles** (the profiled launch only): V8 sampling at 1 ms, through
  the inspector inside each process over the idle window and over the query
  pass, and from launch to quit with `NODE_OPTIONS=--cpu-prof` in every Node
  process of the app.

### How profiles become flamegraphs

Every number comes from the sampled stacks. A profile is ingested the way Chrome
DevTools does it (`CPUProfileDataModel`: `convertTimeDeltas`, `sortSamples`,
`normalizeTimestamps`):

- **Timestamps.** V8's signed `timeDeltas` are summed into absolute timestamps.
  A sample V8 logged a few µs out of order is sorted back into place together
  with its own stack, never clamped or dropped.
- **Weights.** Each sample weighs the time until the next sample, and the last
  sample weighs the time until the profile's end. The weights therefore add up
  exactly to the sampled span.
- **Outputs.** Each profile is folded into collapsed stacks (`*.folded.txt`,
  which speedscope, inferno and `flamegraph.pl` read). It is attributed per
  function and `file:line` (self and total time), and drawn as a
  self-contained HTML flamegraph (`*.flame.html`) that opens in any browser
  and supports click-to-zoom.
- **Privacy.** Raw profiles stay on the measuring machine. Published copies
  have their paths scrubbed (`<repo>`, `<app>`, `~`, `<tmp>`, `<run>`), and the
  run fails if any home folder, temp folder or other private root survives in
  any published file.

### What makes a run fail

A run fails, and prints no figures, when any of these happens:

- a launch does not boot, or a seeded tab never reaches its group;
- a query throws or returns nothing usable;
- `ps` loses a process during a window;
- a sample set is empty, non-finite, or shorter than the plan;
- an event-loop histogram recorded nothing;
- a profile is missing, malformed or too thin (fewer than 50 samples for a window, 100 for a whole run);
- a private path survives the scrub;
- any process of the app is still alive after the close.

`scripts/performance/backend-*.test.mjs` checks each of these rules on fixtures
built to break them. They run under `npm test`.

### Statistics

Raw values are kept for every figure: `raw.json` in each configuration's folder.

- **Quantiles.** They are nearest-rank, so every value printed was actually
  measured.
- **p95.** Printed only from 20 values on, and p99 only from 100. Below that,
  a cell reads `median [min–max] (n)`.
- **Startup.** Three launches per configuration give median and range only.
- **Idle CPU and queries.** These pool 1-second intervals and calls across
  launches, so they carry p95.

## Reproduce

```sh
npm ci && npm run build        # the dev variants run out/
node tests/performance/backend-bench.mjs --variant installed-separate --scale S0
node tests/performance/backend-bench.mjs --variant installed-separate --scale S135
node tests/performance/backend-bench.mjs --variant dev-separate --scale S135
node scripts/performance/backend-report.mjs /tmp/clave-perf-1015-b/results/<run>... \
  --publish docs/performance/backend
```

Options: `--launches` (3), `--profiled-launches` (1), `--idle-seconds` (30),
`--profile-idle-seconds` (15), `--query-iterations` (200), `--query-warmup` (10),
`--history-chats` (20), `--history-turns` (200), `--allow-missing-run-profile
<role>` (records the gap as a limitation instead of failing).

## Limitations

- **Not foreground latency.** Every launch runs under `--test-no-activate`: the
  window is never shown and never takes focus, and background throttling is
  off, so there is no compositor and no visible frame. Visible launches would
  take the person's focus on a shared machine, and none were made.
- **Shared machine.** The person's own Clave keeps running during the runs.
  Each launch records the 1-minute load average and the CPU of every other
  process. The numbers are therefore not from an isolated machine.
- **Synthetic data, not a copy of a real profile.** The live profile's 135
  tabs across 15 workspaces is modelled as 135 tabs in 14 groups in the
  window's workspace, with 14 further empty workspaces in the registry.
- **Same code in both baselines.** Installed 3.0.0-beta.2 and dev `e8d4a9e`
  share source tree `bc08338e`. They can only differ by packaging (asar,
  Electron build, version string) and by the installed app's single update
  check five seconds after launch (a read with no download, `autoDownload`
  off). Agent auto-updates and usage polling are off in test mode in both.
