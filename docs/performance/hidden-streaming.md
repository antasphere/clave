# Hidden streaming transcript rendering

Issue [#191](https://github.com/antasphere/clave/issues/191), performance wave [#186](https://github.com/antasphere/clave/issues/186). Measured targets pass on the review candidate. Full repository checks and focused Electron checks pass. Independent verification is pending. No release or merge.

## Reproduction and cause

Both bundled native views stay mounted for each chat session. Previously neither received presentation visibility. A background delta therefore passed through transcript grouping, virtualized rows and Markdown rendering in hidden views. The synthetic baseline profile contains `check → gfmAtext → previousEmail → atBreak → … → fromMarkdown → parse → Markdown → renderWithHooks`. Driver query/focus stacks and garbage collection are separate costs; the parser samples do not explain the entire idle task difference.

The real Electron `chat/hidden-streaming` structure fixture failed before the product change, on frozen tooling commit `c3e88ee50625996e36aaaea019058c0b589c68f0`. Its product source matches `e8d4a9e51681417d53e20ef75052fe65d4654f1b`. A delta changed the inactive native transcript, yielding one DOM mutation where the regression expected zero. Fixture run `49b3132e-486b-4ee2-88d7-2ad11d32da10` exited 1 at that assertion. Earlier fixture import and view-switch setup failures were not counted as behavior proof.

## Before and after measurements

Three fresh launches in an exclusive wave CPU slot, same worktree, same built renderer and frozen runner. Each has 100 echo chats in 10 groups, 20 histories of 200 alternating turns, 80 short histories, and four hidden working chats. Off and on preserve that working state; on emits 128 ASCII bytes per event, 20Hz per chat.

| Build  | Launch | Quiet task ms | Streaming task ms | Extra task ms | Events/s | Delivered events |
| ------ | -----: | ------------: | ----------------: | ------------: | -------: | ---------------: |
| Before |      1 |        57.852 |           784.873 |       727.021 |    78.62 |             1060 |
| Before |      2 |        82.966 |           847.299 |       764.333 |    78.10 |             1084 |
| Before |      3 |        23.927 |           802.267 |       778.340 |    78.01 |             1036 |
| After  |      1 |        89.637 |           242.101 |       152.464 |    77.10 |              820 |
| After  |      2 |        45.298 |           256.892 |       211.594 |    76.43 |              960 |
| After  |      3 |        93.591 |           249.759 |       156.168 |    77.16 |              860 |

Task counters cover each initial five-second idle window. Event counts/rates cover the complete on phase, including later interactions, and matched the preload observers exactly. Median extra task time fell from **764.333ms to 156.168ms per five seconds**, a **79.568% reduction** against the accepted median target of 75%. The target ceiling is **191.083ms**. One after launch exceeded that ceiling; all run variation remains visible. Observed after stream rates were slightly lower, despite identical configured 20Hz cadence and 128-byte payloads. These are three fresh launches per side, not a confidence interval or a promise for every machine.

| Handler-to-second-rAF composer timing |        Before |         After |
| ------------------------------------- | ------------: | ------------: |
| Quiet p50 / p95, 90 samples           | 23.2 / 28.4ms | 19.9 / 29.1ms |
| Streaming p50 / p95, 90 samples       | 23.2 / 41.2ms | 20.7 / 28.1ms |

The streaming p95 remains below the accepted 50ms ceiling. This timer starts in the DOM input handler; the separate request-to-observation exercise below includes input queuing.

```sh
SHELL=/bin/zsh CLAVE_E2E_NS=clave-perf-1015-c-before \
  node scripts/performance/renderer-benchmark.mjs --build dev --streaming \
  --tabs 100 --groups 10 --history-tabs 20 --runs 3 --out <fresh-output>
```

Runner SHA-256 `2f41ec01d783f5f42209fa5a08b57579b1637ba5dc5b34a5c0f72603bba6c6bd`; renderer-data SHA-256 `4d8e242059ef34e2bfca31b97eaf525434beaaa529a3bf3a0b4ca1d93ba99d69`. The baseline renderer is `index-Cjkmx59C.js`. The measured candidate is `81a75b9d1a0f9242ab3446b4757a0206b345fba1`, renderer `index-CVeWTbZR.js`, SHA-256 `f99c64717f2619a8a75eea90c468f983dd1e73767d34a01ec01f153644a05582`. It was rebased to `18dc7a3afc3b123afbf806d1507e4926f101fc92` on the newer tooling parent `c76233746ff0f569a6088dac463d125f2d0aa1a7`. The product tree, package manifests, benchmark/data modules and Electron harness are byte-identical across that rebase. Parent changes are tests and reports only. CPU profiles include interactions as well as idle; idle task counters exclude those interactions. This measure is renderer task time, not whole-application CPU.

## Behavior and fixture

Presentation visibility combines the selected panes, workspace, grid overlays and active native slot. It preserves every selected pane in a multi-pane grid regardless of keyboard focus. Both views keep subscriptions, reducers, control requests, status/model reports and mounted local state. Only transcript grouping and presentation use the last visible snapshot. Reveal uses the latest reduced entries immediately. Hidden pagination/focus work is gated.

The shared transcript hook preserves reading intent and offset across hiding. A hidden element's zero-sized box must not turn a reader at a nonzero offset into one following the end. A second reveal failure was a stale virtualizer range: the native DOM identity survived and the real scroll container was at its end, but rendered rows remained at the beginning. Notifying scroll listeners on the first reveal frame synchronizes the cached range with the restored DOM offset. The completed fixture proves both offset retention and complete workspace/Settings reveal. Removing this synchronization must be covered by independent mutation verification.

`tests/e2e/hidden-chat-rendering-fixture.mjs` exports the reusable `chat/hidden-streaming` scenario with `@structure-ai/fixtures`. It composes the existing `openChat` echo adapter and recording route; app commands create the session and write the first message. Synthetic adapter output crosses the normal session transport. Each invocation has a fresh fixture run UUID and harness namespace, with isolated user data and workspace. Cleanup closes only its own Electron app and removes its own fixture directories. Test mode enables the fixture route; there is no inference or production target.

```sh
SHELL=/bin/zsh CLAVE_E2E_NS=clave-perf-1015-c-check \
  node tests/e2e/run.mjs hidden-chat-rendering
```

The regression covers hidden native slots, background tabs, workspace hiding, multiple selected panes, Settings covering the grid, exact ordered delta delivery and reveal catch-up in both views, permission/question UI, live header/sidebar/model metadata, retained draft and scroll. It also starts a wall-clock timer before Playwright dispatches native text input and observes the controlled textarea while another chat streams. That includes automation round trips and input queue delay; it does not measure physical key latency or pixels presented by the compositor.

## Input requests and profiling

The separate two-chat behavior fixture records 25 native Playwright text-input requests while one hidden chat streams at 20Hz. The two successful exclusive in-process runs below ran before formal after collection. Timers start before dispatch and finish after observing the controlled Message textbox. They include automation round trips and input queue delay.

| Fixture                   | Request-to-observed p50 |      p95 |  Maximum | Hidden events produced / observed |
| ------------------------- | ----------------------: | -------: | -------: | --------------------------------: |
| Diagnostic output enabled |                14.301ms | 35.243ms | 95.690ms |                             8 / 8 |
| Clean fixture             |                 6.606ms |  9.641ms | 10.246ms |                             3 / 3 |

The 95.690ms outlier is retained. The later parallel correctness checks also retain 25 raw samples per server mode: in-process p95 73.968ms, maximum 82.771ms; separate-server p95 16.733ms, maximum 16.870ms. Those overlapped correctness work and are excluded from the formal latency comparison. All four sets are in the input artifact. High-scale 100-tab figures retain the handler-start boundary. This exercise adds input-delivery coverage; neither metric measures hardware latency or compositor presentation.

[Sample attribution](hidden-streaming/profile-attribution.json) records Markdown-inclusive sampled weight over each complete on-phase profile, including interactions. Before, it was 2315–2579ms, 16.8–17.9% of observed profile time. After, no recorded samples were under Markdown. Sampling can miss short calls; these weights are corroborating attribution, not the five-second task counter and not a claim that every CPU cost disappeared.

## Artifacts and reproduction

[Comparison and raw interaction summaries](hidden-streaming/comparison.json), [before measurements](hidden-streaming/before/measurements.json), [after measurements](hidden-streaming/after/measurements.json), and [input request samples](hidden-streaming/input-request-samples.json) retain all observations and collection timestamps. Before ran 15:31:51–15:34:35 UTC; after ran 16:09:02–16:11:51 UTC on 15 October 2026.

All 36 sanitized raw/normalized CPU profiles are archived as lossless gzip, with all 18 openable HTML flamegraphs. [The manifest](hidden-streaming/manifest.json) records both original and compressed SHA-256 hashes. Decompress profiles beside their measurements before loading them into DevTools or following their original filenames. Signed raw intervals remain intact, and normalized profiles retain the same total observed span without tail extrapolation. Original unsanitized responses remain private and are never published.

Representative median-extra-task launches: [before quiet](hidden-streaming/before/run-2-stream-off.html), [before streaming](hidden-streaming/before/run-2-stream-on.html), [after quiet](hidden-streaming/after/run-3-stream-off.html), [after streaming](hidden-streaming/after/run-3-stream-on.html). Other launch graphs are alongside them.

```sh
gunzip -k docs/performance/hidden-streaming/{before,after}/*.cpuprofile.gz
```

## Validation and review status

On the rebased product tree `18dc7a3afc3b123afbf806d1507e4926f101fc92`:

- `npm test`: exit 0, 2961 passed, 2 skipped, 263 passing test files and one skipped file.
- `npm run lint`, `npm run typecheck`, `npm run build`: exit 0 each.
- Focused Electron suite: 40 passed, 0 failed, 0 known failures, 0 unstable in each of `in-process` and `separate` server modes.
- Artifact integrity: 56 files, 36 valid profiles, 18 raw/normalized pairs, original/compressed hashes and privacy checks passed; every normalization conserved its observed span.
- Rebuilt renderer SHA-256 matches the measured candidate after the test/report-only parent update.

```sh
SHELL=/bin/zsh CLAVE_E2E_NS=<fresh-namespace> CLAVE_E2E_SERVER=<in-process-or-separate> \
  node tests/e2e/run.mjs hidden-chat-rendering chat-scroll-end chat-terminal-rows \
  chat-input-history chat-prompt-dock chat-history-pages
```

The final report/archive commit changes no build inputs. Independent opposite-provider review, including a semantic mutation that removes reveal synchronization and a byte-identical restoration check, is pending. This report does not claim merge readiness or release.

## Limits

These are synthetic, hidden `--test-no-activate` windows with renderer background throttling disabled. Installed Clave remains untouched. Child-only `SHELL=/bin/zsh` makes POSIX shell probes reproducible while preserving the parent shell. No live conversations, credentials or inference workloads are included. The frozen runner writes each original profile to a fresh private mkdtemp directory; only sanitized artifacts can be published. Event conservation at preload is supplemented by native-view reveal checks, because transport delivery alone cannot prove a hidden transcript retained its content.
