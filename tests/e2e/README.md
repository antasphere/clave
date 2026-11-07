# Running the Electron suite

Build the app once with `npm ci`, `npx install-electron`, `npm run native:build`
and `npx electron-vite build`. The suite needs macOS and tmux. Each app runs hidden
with its own user data. It does not use the installed Clave app.

`npm run test:e2e` retains the sequential runner. Arguments filter spec names.
`npm run test:e2e:parallel -- --workers=4` runs the full suite in four independent
Node processes. It prints the directory containing each worker's log and JSON
results. A failed assertion or crashed worker fails the command. Choose fewer
workers on a machine with less memory. The default is at most four, bounded by
the machine's available CPUs. The parallel command currently merges in-process
results; use the sequential runner for attached or separate server modes.

For independent CI runners, use `node tests/e2e/run.mjs --shard 1/8 --report
e2e-reports/shard-1.json`, changing the index for each runner. Selection sorts the
matching spec names, reserves the clipboard group in shard 1, then assigns the
longest estimated specs to the least-loaded shard. Ties follow the original
order, then the shard index. Each shard runs its specs in the original order;
`1/1` retains the sequential schedule. Filters apply before sharding.
`--list` prints the selected filenames without importing specs.
Empty shards are valid, but an empty selection before sharding is an error.

`shard-durations.json` contains placement hints from the three complete runs
linked in that file. Each hint is the median per-spec duration, rounded to
seconds with a minimum of 1. New or renamed specs use the explicit 14-second
fallback, the median of those hints. Removed specs' hints add no work. Missing
or malformed hint data and nonpositive or nonnumeric values fail explicitly.
Update hints from complete comparable runs; do not use the current run's
reports or host data. The runner and aggregate read the same checked-in file
on macOS and Linux. Hints never define the inventory or change assertions,
timeouts, classifications or report validation.

Every shard adds its index to the fixture namespace. The local parallel command
also creates a unique run namespace, so simultaneous runs from the same
checkout do not sweep each other's files or tmux sessions. Run only one suite
per namespace. SIGINT and SIGTERM ask workers to clean up their own apps,
servers and tmux sessions. Failed runs retain fixtures for diagnosis.

CI uses four macOS suite shards, with one Electron process per runner. Each
runner then executes its assigned gates. Every existing gate and all three
server modes still run once. This needs four runners in total; it avoids a
separate gate job competing for a fifth slot. Each job installs and builds its
own checkout. Account capacity and unrelated runs can still add queue time.

Clipboard specs share a shard because fixture namespaces cannot isolate the
system pasteboard. List every clipboard producer or consumer in
`CLIPBOARD_SPECS`, including specs that use rendered Copy buttons. The source
scan catches direct API calls; indirect UI actions need an explicit entry.

`--report-dir=e2e-reports` writes local parallel logs and JSON reports to an
explicit empty directory, for example for CI artifact upload. The run still
gets a unique fixture namespace. A nonempty directory is refused to prevent
stale reports from passing a later run. Successful runs without an explicit
report directory remove their temporary logs. Explicit reports and failed-run
logs remain available for diagnosis.

The aggregate retains the existing `End-to-end (the real app, macOS)` check
name. It checks every shard and the complete spec inventory. Missing reports,
duplicate shards, omitted specs and failed gate jobs fail the check. Ordinary
full-suite assertion failures retain the existing report policy and appear in
the summary. Known failures and unstable specs use the same classification as
the sequential runner.

To compare schedules on identical code, manually run the Checks workflow twice
on the same ref. Set its `baseline` input to true for the original sequential
schedule and false for the sharded schedule. Measure workflow creation to the
last required job's completion, including queue time. Measure the suite window
from the earliest shard report's start to the latest report's end separately.
Report job queue and setup time, and retain both run URLs. Exclude the added
aggregate job from the original-schedule baseline, while including it in the
optimized result. Use a baseline where all required gates passed, since the
hardened conditions continue after an earlier gate fails. A cancelled or timed-out
baseline cannot substantiate a speedup. Local runs on a busy machine are useful
for checking behavior, but do not establish the CI ratio.

Baseline and normal runs use different concurrency groups, so they can run
together without cancelling one another. A newer run of the same kind on the
same ref cancels its predecessor. Keep the ref unchanged during the comparison.
