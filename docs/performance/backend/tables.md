### Build, machine and co-running load

| configuration | build | machine | co-running load at each launch (1-min loadavg / other processes CPU %) |
|---|---|---|---|
| installed-separate · S135 | installed 3.0.0-beta.2, Electron 39.5.2 | Apple M2 Max, 12 cores, 96 GiB, macOS 26.6.2 | 14.6/482, 8.9/501, 11.7/339, 8.6/313 |
| dev-separate · S135 | dev e8d4a9e5 (tree bc08338e), Electron 39.5.2 | Apple M2 Max, 12 cores, 96 GiB, macOS 26.6.2 | 7.5/394, 7.3/589, 6.4/422, 6.2/444 |
| installed-separate · S0 | installed 3.0.0-beta.2, Electron 39.5.2 | Apple M2 Max, 12 cores, 96 GiB, macOS 26.6.2 | 8.1/470, 7.5/478, 6.3/539, 6.0/444 |

### Startup

| ms after launch | installed-separate · S135 | dev-separate · S135 | installed-separate · S0 |
|---|---|---|---|
| Playwright connected to main | 770 [737–772] (n=3) | 825 [764–1269] (n=3) | 749 [725–768] (n=3) |
| main process started | 28.9 [27.2–35.3] (n=3) | 32.8 [31.6–63.6] (n=3) | 29.6 [28.8–38.0] (n=3) |
| main event loop running | 27.9 [26.2–34.3] (n=3) | 31.8 [30.6–62.6] (n=3) | 28.6 [27.8–37.0] (n=3) |
| server process started | 515 [496–546] (n=3) | 614 [578–986] (n=3) | 521 [499–526] (n=3) |
| server event loop running | 1405 [1285–1415] (n=3) | 1496 [1377–1838] (n=3) | 1350 [1346–1394] (n=3) |
| main registered on its server | 2248 [2225–2327] (n=3) | 2077 [1950–2568] (n=3) | 2272 [2272–2279] (n=3) |
| window navigation start | 602 [589–612] (n=3) | 683 [630–1084] (n=3) | 589 [570–599] (n=3) |
| window DOMContentLoaded | 1465 [1447–1483] (n=3) | 1439 [1312–1888] (n=3) | 1477 [1442–1495] (n=3) |
| window boot complete | 2549 [2297–2561] (n=3) | 2339 [1941–2831] (n=3) | 2585 [2254–2589] (n=3) |
| every seeded tab in its group | 2647 [2627–2716] (n=3) | 2431 [2268–2914] (n=3) | – |

### Right after the boot

| configuration | process | seconds | mean CPU % of one core per launch |
|---|---|---|---|
| installed-separate · S135 | main | 5 | 2.4% [2.0%–2.5%] (n=3) |
| installed-separate · S135 | server | 5 | 12.9% [11.6%–13.7%] (n=3) |
| installed-separate · S135 | terminal | 5 | 0.0% [0.0%–0.0%] (n=3) |
| installed-separate · S135 | renderer | 5 | 30.7% [28.0%–36.5%] (n=3) |
| dev-separate · S135 | main | 5 | 1.0% [1.0%–1.4%] (n=3) |
| dev-separate · S135 | server | 5 | 13.5% [11.3%–15.7%] (n=3) |
| dev-separate · S135 | terminal | 5 | 0.0% [0.0%–0.0%] (n=3) |
| dev-separate · S135 | renderer | 5 | 34.9% [31.8%–37.4%] (n=3) |
| installed-separate · S0 | main | 5 | 1.0% [1.0%–1.2%] (n=3) |
| installed-separate · S0 | server | 5 | 1.2% [0.7%–2.4%] (n=3) |
| installed-separate · S0 | terminal | 5 | 0.0% [0.0%–0.0%] (n=3) |
| installed-separate · S0 | renderer | 5 | 0.0% [0.0%–0.5%] (n=3) |

### Idle

| configuration | process | CPU % of one core, p50 / p95 (1-s intervals) | mean CPU % | RSS MiB (end) | event-loop delay beyond the 10 ms timer, p50 / p99 / max ms (per launch, median) | ELU |
|---|---|---|---|---|---|---|
| installed-separate · S135 | main | 1.0% / 2.0% (n=87) | 1.5% | 301 [298–303] (n=3) | 1.93 / 3.39 / 15.8 | n/a (Electron loop) |
| installed-separate · S135 | server | 0.0% / 1.0% (n=87) | 0.4% | 275 [271–277] (n=3) | 1.03 / 1.99 / 17.9 | 0.6% |
| installed-separate · S135 | terminal | 0.0% / 0.0% (n=87) | 0.0% | 201 [201–203] (n=3) | – | – |
| installed-separate · S135 | renderer | 0.0% / 7.0% (n=87) | 1.4% | 358 [358–453] (n=3) | – | – |
| dev-separate · S135 | main | 1.0% / 1.0% (n=87) | 1.4% | 262 [261–263] (n=3) | 2.57 / 3.46 / 16.7 | n/a (Electron loop) |
| dev-separate · S135 | server | 0.0% / 1.0% (n=87) | 0.5% | 247 [246–247] (n=3) | 1.03 / 1.73 / 11.7 | 0.5% |
| dev-separate · S135 | terminal | 0.0% / 0.0% (n=87) | 0.0% | 185 [185–201] (n=3) | – | – |
| dev-separate · S135 | renderer | 0.0% / 8.0% (n=87) | 1.3% | 309 [295–316] (n=3) | – | – |
| installed-separate · S0 | main | 1.0% / 2.0% (n=87) | 1.2% | 303 [285–304] (n=3) | 2.56 / 3.46 / 16.2 | n/a (Electron loop) |
| installed-separate · S0 | server | 0.0% / 1.0% (n=87) | 0.2% | 267 [266–270] (n=3) | 1.03 / 2.06 / 13.1 | 0.5% |
| installed-separate · S0 | terminal | 0.0% / 0.0% (n=87) | 0.0% | 203 [203–231] (n=3) | – | – |
| installed-separate · S0 | renderer | 0.0% / 1.0% (n=87) | 0.7% | 294 [293–295] (n=3) | – | – |

### Query latency from the window

| configuration | method (road) | cold first call ms | warm p50 / p95 ms | answer bytes |
|---|---|---|---|---|
| installed-separate · S135 | windowIdentity (ipc (floor)) | 0.30 [0.20–0.30] (n=3) | 0.10 / 0.20 (n=600) | 85 |
| installed-separate · S135 | workspaceLoad (server) | 3.20 [2.40–3.60] (n=3) | 1.10 / 2.20 (n=600) | 2660 |
| installed-separate · S135 | launchProfilesList (server) | 1.40 [1.40–1.50] (n=3) | 0.90 / 1.30 (n=600) | 1080 |
| installed-separate · S135 | pluginsList (server) | 1.20 [1.10–3.20] (n=3) | 1.00 / 1.60 (n=600) | 4184 |
| installed-separate · S135 | listTrustedRoots (server) | 1.30 [1.20–1.50] (n=3) | 0.80 / 1.40 (n=600) | 76 |
| installed-separate · S135 | claudeAccountsList (server) | 1.10 [1.00–1.20] (n=3) | 0.80 / 1.40 (n=600) | 114 |
| installed-separate · S135 | sidebarLayoutLoad (server (sidebar)) | 0.50 [0.50–0.50] (n=3) | 0.20 / 0.30 (n=600) | 8373 |
| installed-separate · S135 | discoverClaveFilesRecursive (server) | 18.9 [15.2–19.4] (n=3) | 2.00 / 5.00 (n=600) | 2 |
| installed-separate · S135 | sessionsList (server) | 2.80 [2.20–4.50] (n=3) | 1.80 / 2.80 (n=600) | 43039 |
| installed-separate · S135 | sessionsHistory (server) | 13.9 [13.5–18.9] (n=3) | 1.70 / 2.80 (n=600) | 41624 |
| dev-separate · S135 | windowIdentity (ipc (floor)) | 0.30 [0.30–0.40] (n=3) | 0.10 / 0.10 (n=600) | 85 |
| dev-separate · S135 | workspaceLoad (server) | 2.40 [2.10–3.10] (n=3) | 1.00 / 2.60 (n=600) | 2570 |
| dev-separate · S135 | launchProfilesList (server) | 1.40 [1.30–1.70] (n=3) | 0.90 / 2.00 (n=600) | 1056 |
| dev-separate · S135 | pluginsList (server) | 1.40 [1.30–2.80] (n=3) | 0.90 / 2.00 (n=600) | 4300 |
| dev-separate · S135 | listTrustedRoots (server) | 1.60 [1.30–2.10] (n=3) | 0.70 / 1.30 (n=600) | 70 |
| dev-separate · S135 | claudeAccountsList (server) | 0.90 [0.90–1.00] (n=3) | 0.70 / 1.00 (n=600) | 114 |
| dev-separate · S135 | sidebarLayoutLoad (server (sidebar)) | 0.60 [0.40–0.60] (n=3) | 0.20 / 0.30 (n=600) | 8289 |
| dev-separate · S135 | discoverClaveFilesRecursive (server) | 15.7 [14.2–16.4] (n=3) | 1.70 / 2.80 (n=600) | 2 |
| dev-separate · S135 | sessionsList (server) | 2.30 [2.10–2.40] (n=3) | 1.70 / 2.80 (n=600) | 42230 |
| dev-separate · S135 | sessionsHistory (server) | 15.4 [14.5–16.9] (n=3) | 1.50 / 2.80 (n=600) | 41624 |
| installed-separate · S0 | windowIdentity (ipc (floor)) | 0.30 [0.20–0.40] (n=3) | 0.10 / 0.20 (n=600) | 85 |
| installed-separate · S0 | workspaceLoad (server) | 3.50 [3.00–21.6] (n=3) | 1.10 / 2.40 (n=600) | 352 |
| installed-separate · S0 | launchProfilesList (server) | 2.70 [2.10–2.90] (n=3) | 1.00 / 2.20 (n=600) | 1072 |
| installed-separate · S0 | pluginsList (server) | 1.30 [1.30–1.50] (n=3) | 1.00 / 2.20 (n=600) | 4184 |
| installed-separate · S0 | listTrustedRoots (server) | 1.70 [1.40–3.60] (n=3) | 0.80 / 1.50 (n=600) | 74 |
| installed-separate · S0 | claudeAccountsList (server) | 1.10 [1.00–1.20] (n=3) | 0.90 / 3.40 (n=600) | 114 |
| installed-separate · S0 | sidebarLayoutLoad (server (sidebar)) | 0.50 [0.50–0.50] (n=3) | 0.10 / 0.20 (n=600) | 71 |
| installed-separate · S0 | discoverClaveFilesRecursive (server) | 18.3 [18.0–19.1] (n=3) | 1.20 / 2.70 (n=600) | 2 |
| installed-separate · S0 | sessionsList (server) | 1.40 [1.30–1.50] (n=3) | 0.80 / 1.60 (n=600) | 2 |

### Main and server during the query pass

| configuration | process | pass s | CPU % of one core over the pass | event-loop delay beyond the 10 ms timer, p99 / max ms | ELU |
|---|---|---|---|---|---|
| installed-separate · S135 | main | 2.5 [2.1–2.9] (n=3) | 6.9% [6.3%–7.3%] (n=3) | 3.87 [2.92–4.51] (n=3) / 4.58 [3.80–9.12] (n=3) | n/a (Electron loop) |
| installed-separate · S135 | server | 2.5 [2.1–2.9] (n=3) | 71.6% [65.8%–72.2%] (n=3) | 2.07 [1.71–2.80] (n=3) / 8.74 [5.75–15.6] (n=3) | 49.6% [49.0%–52.2%] (n=3) |
| dev-separate · S135 | main | 2.3 [2.3–2.4] (n=3) | 3.1% [3.1%–3.5%] (n=3) | 4.55 [4.46–5.87] (n=3) / 7.53 [5.19–9.27] (n=3) | n/a (Electron loop) |
| dev-separate · S135 | server | 2.3 [2.3–2.4] (n=3) | 67.1% [66.1%–67.7%] (n=3) | 3.93 [2.33–5.06] (n=3) / 10.1 [6.05–12.3] (n=3) | 47.8% [45.4%–49.1%] (n=3) |
| installed-separate · S0 | main | 1.8 [1.8–2.1] (n=3) | 8.1% [3.4%–8.2%] (n=3) | 9.60 [3.01–10.8] (n=3) / 15.9 [6.06–25.1] (n=3) | n/a (Electron loop) |
| installed-separate · S0 | server | 1.8 [1.8–2.1] (n=3) | 68.4% [62.7%–69.1%] (n=3) | 5.65 [2.46–6.84] (n=3) / 16.1 [7.29–24.1] (n=3) | 53.1% [52.6%–59.1%] (n=3) |

### Profiler overhead

| configuration | boot complete, plain | boot complete, profiled |
|---|---|---|
| installed-separate · S135 | 2549 [2297–2561] (n=3) | 2241 [2241–2241] (n=1) |
| dev-separate · S135 | 2339 [1941–2831] (n=3) | 2039 [2039–2039] (n=1) |
| installed-separate · S0 | 2585 [2254–2589] (n=3) | 2625 [2625–2625] (n=1) |

### Where the CPU goes

#### installed-separate · S135 · idle-main

15.2 s sampled (11959 samples, 0 out of order): busy 55 ms = 0.4% (JS 5.2%, native 46.2%, GC 48.6% of busy). Flamegraph: `profiled-1-idle-main.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 26.6 | 48.6 | `(garbage collector)` |
| 25.3 | 46.2 | `(program)` |
| 1.4 | 2.5 | `post (node:inspector:118:7)` |
| 1.2 | 2.3 | `getAppMetrics` |
| 0.1 | 0.2 | `evaluate` |
| 0.1 | 0.2 | `dispatch` |
| 0.0 | 0.0 | `(anonymous)` |
| 0.0 | 0.0 | `post` |
| 0.0 | 0.0 | `startProfiler` |
| 0.0 | 0.0 | `anonymous` |
| 0.0 | 0.0 | `stopProfiler` |

No Clave frame was sampled in this window.

#### installed-separate · S135 · idle-server

15.1 s sampled (11988 samples, 0 out of order): busy 267 ms = 1.8% (JS 16.9%, native 76.1%, GC 7.0% of busy). Flamegraph: `profiled-1-idle-server.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 202.9 | 76.1 | `(program)` |
| 18.8 | 7.0 | `(garbage collector)` |
| 2.5 | 1.0 | `listOnTimeout (node:internal/timers:528:25)` |
| 2.5 | 1.0 | `js-to-wasm:i:i (wasm://wasm/0002f80e:1:34275)` |
| 2.2 | 0.8 | `addRootCerts` |
| 1.7 | 0.6 | `emit (node:events:466:44)` |
| 1.3 | 0.5 | `get (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:490:6)` |
| 1.3 | 0.5 | `_kill` |
| 1.3 | 0.5 | `addSpanStackTrace (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/internal/tracer.js:102:27)` |
| 1.3 | 0.5 | `onwrite (node:internal/streams/writable:615:17)` |
| 1.3 | 0.5 | `wasm_on_header_value (<app>/Contents/Resources/app.asar/node_modules/undici/lib/dispatcher/client-h1.js:149:29)` |
| 1.3 | 0.5 | `spawn` |

Clave code by total time:

| total ms | % of busy | self ms | frame |
|---|---|---|---|
| 12.5 | 4.7 | 0.0 | `readLimitsWith (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2814:30)` |
| 10.0 | 3.8 | 0.0 | `readFromEndpoint (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2744:32)` |
| 10.0 | 3.8 | 0.0 | `fetchWithTimeout (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2735:32)` |
| 2.5 | 0.9 | 1.2 | `readKeychainItem (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2580:32)` |
| 2.5 | 0.9 | 0.0 | `try (<app>/Contents/Resources/app.asar/out/main/chunks/grpc-eeCGQSuf.js:1932:10)` |
| 2.5 | 0.9 | 0.0 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/grpc-eeCGQSuf.js:1993:16)` |
| 2.5 | 0.9 | 0.0 | `readClaude (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:7336:19)` |
| 2.5 | 0.9 | 0.0 | `getLimits (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2855:18)` |
| 2.5 | 0.9 | 0.0 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2862:19)` |
| 2.5 | 0.9 | 0.0 | `read (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2915:11)` |
| 2.5 | 0.9 | 0.0 | `readKeychainAccessToken (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2572:39)` |
| 1.4 | 0.5 | 0.0 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/grpc-eeCGQSuf.js:1667:5)` |

#### installed-separate · S135 · queries-main

2.2 s sampled (1782 samples, 0 out of order): busy 29 ms = 1.3% (JS 86.7%, native 13.3%, GC 0.0% of busy). Flamegraph: `profiled-1-queries-main.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 7.3 | 25.7 | `structuredClone (node:internal/worker/js_transferable:112:25)` |
| 6.0 | 21.2 | `(anonymous) (node:electron/js2c/browser_init:2:112606)` |
| 5.0 | 17.4 | `readdir` |
| 3.8 | 13.3 | `(program)` |
| 1.3 | 4.7 | `post (node:inspector:118:7)` |
| 1.3 | 4.4 | `freeze (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13830:18)` |
| 1.3 | 4.4 | `identityFor (<app>/Contents/Resources/app.asar/out/main/index.js:12044:21)` |
| 1.3 | 4.4 | `_getProcessMemoryInfo` |
| 1.3 | 4.4 | `sendReply` |
| 0.0 | 0.0 | `emit (node:events:466:44)` |
| 0.0 | 0.0 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/index.js:7989:50)` |
| 0.0 | 0.0 | `get (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13858:6)` |

Clave code by total time:

| total ms | % of busy | self ms | frame |
|---|---|---|---|
| 14.8 | 52.0 | 0.0 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/index.js:7989:50)` |
| 13.6 | 47.5 | 0.0 | `get (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13858:6)` |
| 8.6 | 30.2 | 0.0 | `snapshot (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:14183:11)` |
| 8.6 | 30.2 | 0.0 | `frozen (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13828:16)` |
| 5.0 | 17.4 | 0.0 | `takeOrphans (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:14143:14)` |
| 5.0 | 17.4 | 0.0 | `keys (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:14233:11)` |
| 1.3 | 4.4 | 1.3 | `freeze (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13830:18)` |
| 1.3 | 4.4 | 1.3 | `identityFor (<app>/Contents/Resources/app.asar/out/main/index.js:12044:21)` |
| 1.3 | 4.4 | 0.0 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/index.js:12082:46)` |
| 1.3 | 4.4 | 0.0 | `keyOf (<app>/Contents/Resources/app.asar/out/main/index.js:7984:17)` |

#### installed-separate · S135 · queries-server

2.2 s sampled (1749 samples, 0 out of order): busy 940 ms = 43.6% (JS 90.2%, native 4.9%, GC 4.9% of busy). Flamegraph: `profiled-1-queries-server.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 46.1 | 4.9 | `(program)` |
| 45.9 | 4.9 | `(garbage collector)` |
| 32.0 | 3.4 | `readdir` |
| 28.5 | 3.0 | `addSpanStackTrace (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/internal/tracer.js:102:27)` |
| 26.5 | 2.8 | `evaluateEffect (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/internal/fiberRuntime.js:748:17)` |
| 24.5 | 2.6 | `(anonymous) (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/ParseResult.js:902:16)` |
| 22.1 | 2.4 | `writev` |
| 22.0 | 2.3 | `unsafeJson (<app>/Contents/Resources/app.asar/node_modules/@effect/platform/dist/cjs/internal/httpBody.js:105:20)` |
| 21.9 | 2.3 | `access` |
| 21.6 | 2.3 | `handleErrorFromBinding (node:internal/fs/promises:146:32)` |
| 19.8 | 2.1 | `getFiberRef (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/internal/fiberRuntime.js:420:14)` |
| 17.6 | 1.9 | `(anonymous) (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/internal/fiberRefs.js:149:73)` |

Clave code by total time:

| total ms | % of busy | self ms | frame |
|---|---|---|---|
| 73.7 | 7.8 | 2.4 | `findClaveFile (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13547:33)` |
| 43.6 | 4.6 | 5.1 | `scan (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13567:24)` |
| 32.6 | 3.5 | 1.3 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/api-mCXAl3qi.js:1510:54)` |
| 29.1 | 3.1 | 1.3 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/Shutdown-BmdoS0zN.js:61:51)` |
| 27.4 | 2.9 | 1.3 | `exists (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13209:22)` |
| 22.6 | 2.4 | 0.0 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/grpc-eeCGQSuf.js:1790:27)` |
| 22.6 | 2.4 | 0.0 | `history (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13067:14)` |
| 22.6 | 2.4 | 0.0 | `history (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:761:10)` |
| 16.8 | 1.8 | 2.4 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/Shutdown-BmdoS0zN.js:392:70)` |
| 16.8 | 1.8 | 1.3 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13583:37)` |
| 13.8 | 1.5 | 4.8 | `replay (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:9311:9)` |
| 13.8 | 1.5 | 0.0 | `history (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:9875:10)` |

#### dev-separate · S135 · idle-main

15.2 s sampled (11524 samples, 0 out of order): busy 10 ms = 0.1% (JS 39.5%, native 60.5%, GC 0.0% of busy). Flamegraph: `profiled-1-idle-main.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 6.1 | 60.5 | `(program)` |
| 2.3 | 22.4 | `post (node:inspector:118:7)` |
| 1.7 | 17.2 | `innerSerialize` |
| 0.0 | 0.0 | `(anonymous)` |
| 0.0 | 0.0 | `startProfiler` |
| 0.0 | 0.0 | `post` |
| 0.0 | 0.0 | `evaluate` |
| 0.0 | 0.0 | `_promiseAwareJsonValueNoThrow` |
| 0.0 | 0.0 | `safeJson` |
| 0.0 | 0.0 | `jsonValue` |
| 0.0 | 0.0 | `serializeAsCallArgument` |
| 0.0 | 0.0 | `serialize` |

No Clave frame was sampled in this window.

#### dev-separate · S135 · idle-server

15.1 s sampled (11515 samples, 0 out of order): busy 227 ms = 1.5% (JS 13.7%, native 86.3%, GC 0.0% of busy). Flamegraph: `profiled-1-idle-server.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 196.0 | 86.3 | `(program)` |
| 6.3 | 2.8 | `processTimers (node:internal/timers:508:25)` |
| 4.7 | 2.1 | `normalizeSpawnArguments (node:child_process:566:33)` |
| 1.3 | 0.6 | `Socket._destroy (node:net:808:37)` |
| 1.3 | 0.6 | `popAsyncContext (node:internal/async_hooks:561:25)` |
| 1.3 | 0.6 | `EffectPrimitive (<repo>/node_modules/effect/dist/cjs/internal/core.js:75:3)` |
| 1.2 | 0.5 | `tell (<repo>/node_modules/effect/dist/cjs/internal/fiberRuntime.js:306:7)` |
| 1.2 | 0.5 | `evaluate (<repo>/out/main/chunks/grpc-eeCGQSuf.js:1648:24)` |
| 1.2 | 0.5 | `ReadableState (node:internal/streams/readable:262:23)` |
| 1.2 | 0.5 | `connect` |
| 1.2 | 0.5 | `post (node:inspector:118:7)` |
| 1.2 | 0.5 | `finishMaybe (node:internal/streams/writable:928:21)` |

Clave code by total time:

| total ms | % of busy | self ms | frame |
|---|---|---|---|
| 5.9 | 2.6 | 0.0 | `try (<repo>/out/main/chunks/grpc-eeCGQSuf.js:1932:10)` |
| 5.9 | 2.6 | 0.0 | `getLimits (<repo>/out/main/chunks/standalone-JvqQiB-6.js:2855:18)` |
| 5.9 | 2.6 | 0.0 | `(anonymous) (<repo>/out/main/chunks/standalone-JvqQiB-6.js:2862:19)` |
| 3.4 | 1.5 | 0.0 | `(anonymous) (<repo>/out/main/chunks/grpc-eeCGQSuf.js:1998:16)` |
| 3.4 | 1.5 | 0.0 | `readCodex (<repo>/out/main/chunks/standalone-JvqQiB-6.js:7338:18)` |
| 3.4 | 1.5 | 0.0 | `read (<repo>/out/main/chunks/standalone-JvqQiB-6.js:3116:11)` |
| 3.4 | 1.5 | 0.0 | `readCodexLimits (<repo>/out/main/chunks/standalone-JvqQiB-6.js:2999:25)` |
| 3.4 | 1.5 | 0.0 | `(anonymous) (<repo>/out/main/chunks/standalone-JvqQiB-6.js:3000:22)` |
| 2.8 | 1.2 | 0.0 | `readLimitsWith (<repo>/out/main/chunks/standalone-JvqQiB-6.js:2814:30)` |
| 2.5 | 1.1 | 0.0 | `(anonymous) (<repo>/out/main/chunks/grpc-eeCGQSuf.js:1993:16)` |
| 2.5 | 1.1 | 0.0 | `readClaude (<repo>/out/main/chunks/standalone-JvqQiB-6.js:7336:19)` |
| 2.5 | 1.1 | 0.0 | `read (<repo>/out/main/chunks/standalone-JvqQiB-6.js:2915:11)` |

#### dev-separate · S135 · queries-main

2.3 s sampled (1845 samples, 0 out of order): busy 30 ms = 1.3% (JS 70.2%, native 29.8%, GC 0.0% of busy). Flamegraph: `profiled-1-queries-main.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 8.9 | 29.8 | `(program)` |
| 6.9 | 23.2 | `readdir` |
| 5.1 | 16.9 | `(anonymous) (node:electron/js2c/browser_init:2:112606)` |
| 2.6 | 8.6 | `sendReply` |
| 1.4 | 4.6 | `post (node:inspector:118:7)` |
| 1.3 | 4.3 | `(anonymous) (node:internal/webidl:287:18)` |
| 1.3 | 4.2 | `getIpcEmittersForFrameEvent (node:electron/js2c/browser_init:2:115026)` |
| 1.3 | 4.2 | `structuredClone (node:internal/worker/js_transferable:112:25)` |
| 1.3 | 4.2 | `_getProcessMemoryInfo` |
| 0.0 | 0.0 | `emit (node:events:466:44)` |
| 0.0 | 0.0 | `(anonymous) (<repo>/out/main/index.js:7989:50)` |
| 0.0 | 0.0 | `get (<repo>/out/main/chunks/standalone-JvqQiB-6.js:13858:6)` |

Clave code by total time:

| total ms | % of busy | self ms | frame |
|---|---|---|---|
| 10.7 | 35.9 | 0.0 | `(anonymous) (<repo>/out/main/index.js:7989:50)` |
| 9.5 | 31.7 | 0.0 | `get (<repo>/out/main/chunks/standalone-JvqQiB-6.js:13858:6)` |
| 6.9 | 23.2 | 0.0 | `takeOrphans (<repo>/out/main/chunks/standalone-JvqQiB-6.js:14143:14)` |
| 6.9 | 23.2 | 0.0 | `keys (<repo>/out/main/chunks/standalone-JvqQiB-6.js:14233:11)` |
| 2.5 | 8.5 | 0.0 | `snapshot (<repo>/out/main/chunks/standalone-JvqQiB-6.js:14183:11)` |
| 2.5 | 8.5 | 0.0 | `frozen (<repo>/out/main/chunks/standalone-JvqQiB-6.js:13828:16)` |
| 1.3 | 4.2 | 0.0 | `keyOf (<repo>/out/main/index.js:7984:17)` |

#### dev-separate · S135 · queries-server

2.2 s sampled (1790 samples, 0 out of order): busy 947 ms = 42.2% (JS 88.9%, native 5.5%, GC 5.6% of busy). Flamegraph: `profiled-1-queries-server.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 53.4 | 5.6 | `(garbage collector)` |
| 51.8 | 5.5 | `(program)` |
| 34.6 | 3.7 | `access` |
| 26.0 | 2.8 | `writev` |
| 26.0 | 2.7 | `(anonymous) (<repo>/node_modules/effect/dist/cjs/ParseResult.js:902:16)` |
| 23.6 | 2.5 | `evaluateEffect (<repo>/node_modules/effect/dist/cjs/internal/fiberRuntime.js:748:17)` |
| 23.6 | 2.5 | `(anonymous) (<repo>/node_modules/effect/dist/cjs/internal/fiberRefs.js:149:73)` |
| 21.1 | 2.2 | `(anonymous) (<repo>/node_modules/effect/dist/cjs/Function.js:107:23)` |
| 20.2 | 2.1 | `readdir` |
| 20.0 | 2.1 | `encode (node:internal/encoding:351:9)` |
| 20.0 | 2.1 | `addSpanStackTrace (<repo>/node_modules/effect/dist/cjs/internal/tracer.js:102:27)` |
| 17.9 | 1.9 | `handleErrorFromBinding (node:internal/fs/promises:146:32)` |

Clave code by total time:

| total ms | % of busy | self ms | frame |
|---|---|---|---|
| 70.2 | 7.4 | 2.5 | `findClaveFile (<repo>/out/main/chunks/standalone-JvqQiB-6.js:13547:33)` |
| 47.3 | 5.0 | 0.1 | `exists (<repo>/out/main/chunks/standalone-JvqQiB-6.js:13209:22)` |
| 38.8 | 4.1 | 1.3 | `scan (<repo>/out/main/chunks/standalone-JvqQiB-6.js:13567:24)` |
| 24.1 | 2.5 | 0.0 | `(anonymous) (<repo>/out/main/chunks/grpc-eeCGQSuf.js:1790:27)` |
| 24.1 | 2.5 | 0.0 | `history (<repo>/out/main/chunks/standalone-JvqQiB-6.js:13067:14)` |
| 24.1 | 2.5 | 0.0 | `history (<repo>/out/main/chunks/standalone-JvqQiB-6.js:761:10)` |
| 21.5 | 2.3 | 1.3 | `(anonymous) (<repo>/out/main/chunks/Shutdown-BmdoS0zN.js:392:70)` |
| 17.8 | 1.9 | 0.0 | `(anonymous) (<repo>/out/main/chunks/standalone-JvqQiB-6.js:13583:37)` |
| 15.1 | 1.6 | 1.3 | `history (<repo>/out/main/chunks/standalone-JvqQiB-6.js:9875:10)` |
| 13.8 | 1.5 | 1.7 | `replay (<repo>/out/main/chunks/standalone-JvqQiB-6.js:9311:9)` |
| 13.8 | 1.5 | 0.0 | `loadHistory (<repo>/out/main/chunks/standalone-JvqQiB-6.js:9878:14)` |
| 12.6 | 1.3 | 0.0 | `(anonymous) (<repo>/out/main/chunks/api-mCXAl3qi.js:1510:54)` |

#### dev-separate · S135 · run-main

12.0 s sampled (9215 samples, 0 out of order): busy 1153 ms = 9.6% (JS 95.9%, native 1.3%, GC 2.8% of busy). Flamegraph: `startup-profile-main.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 192.2 | 16.7 | `wrapSafe (node:internal/modules/cjs/loader:1603:18)` |
| 78.5 | 6.8 | `u.internalModuleStat (node:electron/js2c/node_init:2:16645)` |
| 76.2 | 6.6 | `readFileSync (node:fs:433:22)` |
| 76.1 | 6.6 | `createWindow (<repo>/out/main/index.js:15572:22)` |
| 63.1 | 5.5 | `get exports (node:internal/modules/package_json_reader:86:20)` |
| 38.1 | 3.3 | `compileForInternalLoader (node:internal/bootstrap/realm:385:27)` |
| 34.2 | 3.0 | `compileSourceTextModule (node:internal/modules/esm/utils:345:33)` |
| 32.7 | 2.8 | `(garbage collector)` |
| 16.8 | 1.5 | `realpathSync (node:fs:2722:22)` |
| 16.1 | 1.4 | `openSync (node:fs:559:18)` |
| 15.1 | 1.3 | `(program)` |
| 14.6 | 1.3 | `parseCJS (node:internal/deps/cjs-module-lexer/lexer:40:19)` |

Clave code by total time:

| total ms | % of busy | self ms | frame |
|---|---|---|---|
| 390.7 | 33.9 | 0.0 | `(anonymous) (<repo>/out/main/index.js:657:28)` |
| 389.0 | 33.8 | 0.0 | `(anonymous) (<repo>/out/main/chunks/index-DwCbGoWj.js:1:1)` |
| 209.8 | 18.2 | 3.7 | `(anonymous) (<repo>/out/main/index.js:1:1)` |
| 189.5 | 16.4 | 1.2 | `(anonymous) (<repo>/out/main/chunks/api-mCXAl3qi.js:1:1)` |
| 114.3 | 9.9 | 4.6 | `(anonymous) (<repo>/out/main/index.js:15686:31)` |
| 102.2 | 8.9 | 0.0 | `(anonymous) (<repo>/out/main/chunks/Shutdown-BmdoS0zN.js:1:1)` |
| 86.4 | 7.5 | 76.1 | `createWindow (<repo>/out/main/index.js:15572:22)` |
| 86.4 | 7.5 | 0.0 | `openPersistedWindows (<repo>/out/main/index.js:15663:30)` |
| 48.9 | 4.2 | 7.6 | `(anonymous) (<repo>/out/main/chunks/standalone-JvqQiB-6.js:1:1)` |
| 33.3 | 2.9 | 4.5 | `(anonymous) (<repo>/out/main/chunks/manifest-o4CFA0_o.js:1:1)` |
| 13.4 | 1.2 | 1.2 | `(anonymous) (<repo>/out/main/index.js:8643:5)` |
| 12.8 | 1.1 | 0.0 | `readLimitsWith (<repo>/out/main/chunks/standalone-JvqQiB-6.js:2814:30)` |

#### dev-separate · S135 · run-server

11.5 s sampled (9082 samples, 0 out of order): busy 1457 ms = 12.7% (JS 91.2%, native 2.9%, GC 5.9% of busy). Flamegraph: `startup-profile-server.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 191.6 | 13.1 | `wrapSafe (node:internal/modules/cjs/loader:1603:18)` |
| 91.2 | 6.3 | `readFileSync (node:fs:433:22)` |
| 86.3 | 5.9 | `(garbage collector)` |
| 75.6 | 5.2 | `u.internalModuleStat (node:electron/js2c/node_init:2:16645)` |
| 58.1 | 4.0 | `get exports (node:internal/modules/package_json_reader:86:20)` |
| 50.1 | 3.4 | `compileForInternalLoader (node:internal/bootstrap/realm:385:27)` |
| 41.8 | 2.9 | `(program)` |
| 36.4 | 2.5 | `writeFileSync (node:fs:2417:23)` |
| 28.4 | 1.9 | `renameSync (node:fs:1018:20)` |
| 20.1 | 1.4 | `(anonymous) (<repo>/node_modules/effect/dist/cjs/Function.js:107:23)` |
| 14.9 | 1.0 | `Module._load (node:internal/modules/cjs/loader:1176:24)` |
| 11.5 | 0.8 | `evaluateEffect (<repo>/node_modules/effect/dist/cjs/internal/fiberRuntime.js:748:17)` |

Clave code by total time:

| total ms | % of busy | self ms | frame |
|---|---|---|---|
| 683.8 | 46.9 | 0.0 | `(anonymous) (<repo>/out/main/server-entry.js:1:1)` |
| 673.9 | 46.3 | 1.9 | `(anonymous) (<repo>/out/main/chunks/grpc-eeCGQSuf.js:1:1)` |
| 113.0 | 7.8 | 0.0 | `spawn (<repo>/out/main/chunks/standalone-JvqQiB-6.js:11962:14)` |
| 68.2 | 4.7 | 0.0 | `writeChatRecord (<repo>/out/main/chunks/standalone-JvqQiB-6.js:12062:18)` |
| 67.4 | 4.6 | 0.1 | `(anonymous) (<repo>/out/main/chunks/api-mCXAl3qi.js:1:1)` |
| 56.8 | 3.9 | 1.5 | `write (<repo>/out/main/chunks/standalone-JvqQiB-6.js:1965:10)` |
| 55.3 | 3.8 | 0.0 | `writeEventSessionRecord (<repo>/out/main/chunks/standalone-JvqQiB-6.js:8500:26)` |
| 55.3 | 3.8 | 0.0 | `writeSessionRecord (<repo>/out/main/chunks/standalone-JvqQiB-6.js:8006:28)` |
| 46.4 | 3.2 | 0.0 | `(anonymous) (<repo>/out/main/chunks/Shutdown-BmdoS0zN.js:1:1)` |
| 43.5 | 3.0 | 0.0 | `spawnSession (<repo>/out/main/chunks/standalone-JvqQiB-6.js:12715:28)` |
| 42.4 | 2.9 | 9.4 | `(anonymous) (<repo>/out/main/chunks/standalone-JvqQiB-6.js:1:1)` |
| 28.9 | 2.0 | 0.0 | `(anonymous) (<repo>/out/main/chunks/manifest-o4CFA0_o.js:1:1)` |

#### dev-separate · S135 · run-terminal

10.6 s sampled (8345 samples, 0 out of order): busy 503 ms = 4.7% (JS 95.8%, native 1.4%, GC 2.7% of busy). Flamegraph: `startup-profile-terminal.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 126.8 | 25.2 | `wrapSafe (node:internal/modules/cjs/loader:1603:18)` |
| 52.1 | 10.4 | `get exports (node:internal/modules/package_json_reader:86:20)` |
| 38.1 | 7.6 | `compileForInternalLoader (node:internal/bootstrap/realm:385:27)` |
| 34.9 | 6.9 | `u.internalModuleStat (node:electron/js2c/node_init:2:16645)` |
| 30.8 | 6.1 | `readFileSync (node:fs:433:22)` |
| 13.8 | 2.7 | `(garbage collector)` |
| 7.3 | 1.4 | `(program)` |
| 6.9 | 1.4 | `normalizeString (node:path:93:25)` |
| 6.9 | 1.4 | `Module._findPath (node:internal/modules/cjs/loader:676:28)` |
| 6.3 | 1.2 | `findParentPackageJSON (node:internal/modules/package_json_reader:142:31)` |
| 6.3 | 1.2 | `isConditionalExportsMainSugar (node:internal/modules/esm/resolve:558:39)` |
| 6.3 | 1.2 | `realpathSync (node:fs:2722:22)` |

Clave code by total time:

| total ms | % of busy | self ms | frame |
|---|---|---|---|
| 429.8 | 85.5 | 2.3 | `(anonymous) (<repo>/out/main/terminal-process.js:1:1)` |
| 148.8 | 29.6 | 0.1 | `(anonymous) (<repo>/out/main/chunks/Shutdown-BmdoS0zN.js:1:1)` |
| 81.6 | 16.2 | 0.0 | `(anonymous) (<repo>/out/main/chunks/wire-ClTBVT3L.js:1:1)` |
| 4.8 | 1.0 | 0.0 | `startTerminalProcess (<repo>/out/main/terminal-process.js:273:36)` |
| 2.5 | 0.5 | 0.0 | `(anonymous) (<repo>/out/main/terminal-process.js:241:43)` |
| 2.2 | 0.4 | 0.0 | `main (<repo>/out/main/terminal-process.js:519:20)` |
| 1.3 | 0.3 | 1.3 | `(anonymous) (<repo>/out/main/terminal-process.js:550:31)` |
| 1.3 | 0.3 | 1.3 | `stop (<repo>/out/main/terminal-process.js:538:16)` |
| 1.3 | 0.3 | 0.0 | `(anonymous) (<repo>/out/main/terminal-process.js:547:25)` |
| 1.3 | 0.2 | 1.3 | `(anonymous) (<repo>/out/main/terminal-process.js:329:31)` |
| 0.8 | 0.2 | 0.0 | `(anonymous) (<repo>/out/main/terminal-process.js:81:28)` |
| 0.2 | 0.0 | 0.2 | `(anonymous) (<repo>/out/main/terminal-process.js:35:76)` |

#### installed-separate · S0 · idle-main

15.1 s sampled (11681 samples, 0 out of order): busy 13 ms = 0.1% (JS 31.3%, native 68.7%, GC 0.0% of busy). Flamegraph: `profiled-1-idle-main.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 9.1 | 68.7 | `(program)` |
| 1.5 | 11.3 | `getAppMetrics` |
| 1.4 | 10.5 | `post (node:inspector:118:7)` |
| 1.3 | 9.5 | `params` |
| 0.0 | 0.0 | `(anonymous)` |
| 0.0 | 0.0 | `evaluate` |
| 0.0 | 0.0 | `startProfiler` |
| 0.0 | 0.0 | `post` |

No Clave frame was sampled in this window.

#### installed-separate · S0 · idle-server

15.1 s sampled (11669 samples, 0 out of order): busy 237 ms = 1.6% (JS 11.3%, native 88.7%, GC 0.0% of busy). Flamegraph: `profiled-1-idle-server.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 210.4 | 88.7 | `(program)` |
| 10.7 | 4.5 | `processTimers (node:internal/timers:508:25)` |
| 3.7 | 1.6 | `listOnTimeout (node:internal/timers:528:25)` |
| 1.9 | 0.8 | `exchange (node:internal/async_context_frame:62:18)` |
| 1.4 | 0.6 | `FiberRuntime (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/internal/fiberRuntime.js:181:3)` |
| 1.3 | 0.5 | `connectionListenerInternal (node:_http_server:695:36)` |
| 1.3 | 0.5 | `string (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/Hash.js:117:16)` |
| 1.3 | 0.5 | `_Request (node:internal/deps/undici/undici:9759:18)` |
| 1.2 | 0.5 | `post (node:inspector:118:7)` |
| 1.2 | 0.5 | `writeLatin1String` |
| 1.2 | 0.5 | `noop (node:internal/util/debuglog:57:14)` |
| 1.1 | 0.5 | `spawn` |

Clave code by total time:

| total ms | % of busy | self ms | frame |
|---|---|---|---|
| 2.4 | 1.0 | 0.0 | `readLimitsWith (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2814:30)` |
| 1.3 | 0.5 | 0.0 | `readFromEndpoint (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2744:32)` |
| 1.3 | 0.5 | 0.0 | `fetchWithTimeout (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2735:32)` |
| 1.1 | 0.5 | 0.0 | `try (<app>/Contents/Resources/app.asar/out/main/chunks/grpc-eeCGQSuf.js:1932:10)` |
| 1.1 | 0.5 | 0.0 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/grpc-eeCGQSuf.js:1993:16)` |
| 1.1 | 0.5 | 0.0 | `readClaude (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:7336:19)` |
| 1.1 | 0.5 | 0.0 | `getLimits (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2855:18)` |
| 1.1 | 0.5 | 0.0 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2862:19)` |
| 1.1 | 0.5 | 0.0 | `read (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2915:11)` |
| 1.1 | 0.5 | 0.0 | `readKeychainAccessToken (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2572:39)` |
| 1.1 | 0.5 | 0.0 | `readKeychainItem (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:2580:32)` |
| 0.5 | 0.2 | 0.3 | `evaluate (<app>/Contents/Resources/app.asar/out/main/chunks/grpc-eeCGQSuf.js:1648:24)` |

#### installed-separate · S0 · queries-main

1.9 s sampled (1455 samples, 0 out of order): busy 24 ms = 1.3% (JS 68.3%, native 31.7%, GC 0.0% of busy). Flamegraph: `profiled-1-queries-main.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 7.7 | 31.7 | `(program)` |
| 6.3 | 25.7 | `readdir` |
| 2.5 | 10.4 | `sendReply` |
| 1.5 | 6.3 | `post (node:inspector:118:7)` |
| 1.3 | 5.2 | `(anonymous) (node:electron/js2c/browser_init:2:132538)` |
| 1.3 | 5.2 | `readdirSync (node:fs:1586:21)` |
| 1.3 | 5.2 | `(anonymous) (node:electron/js2c/browser_init:2:112606)` |
| 1.3 | 5.2 | `emit (node:events:466:44)` |
| 1.3 | 5.1 | `getIpcEmittersForFrameEvent (node:electron/js2c/browser_init:2:115026)` |
| 0.0 | 0.0 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/index.js:7989:50)` |
| 0.0 | 0.0 | `get (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13858:6)` |
| 0.0 | 0.0 | `takeOrphans (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:14143:14)` |

Clave code by total time:

| total ms | % of busy | self ms | frame |
|---|---|---|---|
| 7.5 | 30.9 | 0.0 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/index.js:7989:50)` |
| 7.5 | 30.9 | 0.0 | `get (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13858:6)` |
| 7.5 | 30.9 | 0.0 | `takeOrphans (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:14143:14)` |
| 7.5 | 30.9 | 0.0 | `keys (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:14233:11)` |
| 1.3 | 5.2 | 0.0 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/index.js:12082:46)` |

#### installed-separate · S0 · queries-server

1.8 s sampled (1422 samples, 0 out of order): busy 838 ms = 45.3% (JS 90.0%, native 3.2%, GC 6.7% of busy). Flamegraph: `profiled-1-queries-server.flame.html`.

Heaviest frames by self time:

| self ms | % of busy | frame |
|---|---|---|
| 56.3 | 6.7 | `(garbage collector)` |
| 27.1 | 3.2 | `(program)` |
| 20.8 | 2.5 | `(anonymous) (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/Function.js:107:23)` |
| 19.5 | 2.3 | `evaluateEffect (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/internal/fiberRuntime.js:748:17)` |
| 18.9 | 2.3 | `onconnection (node:net:2235:22)` |
| 18.5 | 2.2 | `addSpanStackTrace (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/internal/tracer.js:102:27)` |
| 17.6 | 2.1 | `getFiberRef (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/internal/fiberRuntime.js:420:14)` |
| 15.2 | 1.8 | `(anonymous) (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/internal/fiberRefs.js:149:73)` |
| 11.6 | 1.4 | `unsafeJson (<app>/Contents/Resources/app.asar/node_modules/@effect/platform/dist/cjs/internal/httpBody.js:105:20)` |
| 11.6 | 1.4 | `(anonymous) (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/internal/fiberRuntime.js:1150:42)` |
| 11.2 | 1.3 | `(anonymous) (<app>/Contents/Resources/app.asar/node_modules/effect/dist/cjs/internal/fiberRuntime.js:130:46)` |
| 9.1 | 1.1 | `writev` |

Clave code by total time:

| total ms | % of busy | self ms | frame |
|---|---|---|---|
| 28.1 | 3.4 | 2.5 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/api-mCXAl3qi.js:1510:54)` |
| 22.1 | 2.6 | 2.5 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/grpc-eeCGQSuf.js:1037:68)` |
| 22.1 | 2.6 | 0.0 | `findClaveFile (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13547:33)` |
| 19.6 | 2.3 | 1.3 | `tokenMatches (<app>/Contents/Resources/app.asar/out/main/chunks/grpc-eeCGQSuf.js:1031:22)` |
| 18.3 | 2.2 | 0.0 | `safeEqual (<app>/Contents/Resources/app.asar/out/main/chunks/grpc-eeCGQSuf.js:1027:19)` |
| 18.0 | 2.1 | 0.0 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/Shutdown-BmdoS0zN.js:61:51)` |
| 16.6 | 2.0 | 2.6 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/Shutdown-BmdoS0zN.js:392:70)` |
| 15.8 | 1.9 | 0.0 | `scan (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13567:24)` |
| 12.1 | 1.4 | 1.3 | `exists (<app>/Contents/Resources/app.asar/out/main/chunks/standalone-JvqQiB-6.js:13209:22)` |
| 10.0 | 1.2 | 0.0 | `try (<app>/Contents/Resources/app.asar/out/main/chunks/grpc-eeCGQSuf.js:1932:10)` |
| 8.4 | 1.0 | 0.0 | `(anonymous) (<app>/Contents/Resources/app.asar/out/main/chunks/api-mCXAl3qi.js:1397:38)` |
| 8.1 | 1.0 | 1.3 | `resolveId (<app>/Contents/Resources/app.asar/out/main/chunks/api-mCXAl3qi.js:1376:21)` |
