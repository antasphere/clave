# Running the Electron suite

Build the app once with `npm ci`, `npx install-electron`, `npm run native:build`
and `npx electron-vite build`. The suite needs macOS and tmux. Each app runs hidden
with its own user data. It does not use the installed Clave app.

`npm run test:e2e` retains the sequential runner. Arguments filter spec names.
`npm run test:e2e:parallel -- --workers=6` runs the full suite in six independent
Node processes. It prints the directory containing each worker's log and JSON
results. A failed assertion or crashed worker fails the command. Choose fewer
workers on a machine with less memory. The default is at most six, bounded by
the machine's available CPUs. The parallel command currently merges in-process
results; use the sequential runner for attached or separate server modes.

For independent CI runners, use `node tests/e2e/run.mjs --shard 1/8 --report
e2e-reports/shard-1.json`, changing the index for each runner. Selection sorts the
matching spec names and distributes them round-robin. Filters apply before
sharding. `--list` prints the selected filenames without importing specs.
Empty shards are valid, but an empty selection before sharding is an error.

Every shard adds its index to the fixture namespace. The local parallel command
also creates a unique run namespace, so simultaneous runs from the same
checkout do not sweep each other's files or tmux sessions. Run only one suite
per namespace. SIGINT and SIGTERM ask workers to clean up their own apps,
servers and tmux sessions. Failed runs retain fixtures for diagnosis.

CI runs eight full-suite shards alongside two gate jobs. The server job keeps
all three server modes. The other gate job keeps the package, renderer,
terminal-process, sign-in, server-upgrade and fleet checks. Each job installs
and builds its own checkout. This reduces elapsed time by using more runners;
it increases setup work and runner minutes. All specs still run.

The aggregate retains the existing `End-to-end (the real app, macOS)` check
name. It checks every shard and the complete spec inventory. Missing reports,
duplicate shards, omitted specs and failed gate jobs fail the check. Ordinary
full-suite assertion failures retain the existing report policy and appear in
the summary. Known failures and unstable specs use the same classification as
the sequential runner.

To compare schedules on identical code, manually run the Checks workflow twice
on the same ref. Set its `baseline` input to true for the original sequential
schedule and false for the sharded schedule. Compare the first job's start to
the last job's completion, and the full-suite step durations separately.
Report queue time separately and retain both run URLs. A cancelled or timed-out
baseline cannot substantiate a speedup. Local runs on a busy machine are useful
for checking behavior, but do not establish the CI ratio.
