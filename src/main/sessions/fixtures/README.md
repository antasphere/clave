`codex-glow-08ccc92.jsonl` is the unedited `exchange-capture/events.jsonl`
from the real Electron `codex-glow` spec on base `08ccc92`, run 2026-09-19.
The base archive was checked against every tracked blob at that commit.
The scratch harness used `/tmp/clave-base2527` fixture parents and
`TMUX_TMPDIR=/tmp/clave-2527-baseline-tmux`; assertions were unchanged.
Both Codex sessions produce exactly `session_state(exited)` then `tab_closed`.
The regression test drives the manager/plain-PTY and renderer/tmux exit paths,
compares event kinds and counts to this fixture, and asserts timestamp order.
Pi has no mode in the existing exos contract and remains excluded from capture.
