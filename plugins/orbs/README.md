# Thinking orbs (`clave.orbs`)

A bundled mark pack: in Appearance → Agent mark it offers **Orb**, one of the nine
dotted animations of [`thinking-orbs`](https://github.com/Jakubantalik/thinking-orbs)
(Jakub Antalik, MIT) in place of the provider's logo wherever an agent is shown —
the sidebar tab, the chat pane's status, the mark at the end of a transcript — and
in place of the spinner on a tool call in flight.

The pack owns two things the app does not:

- **Which orb stands for the agent** (`src/orbs.ts`, saved as `clave-orbs-state`): the
  user picks it in the pack's own settings block, rendered under the Agent mark row
  when the pack is chosen. It rests on a still frame and moves while the agent works.
- **Which orb stands for each kind of tool call** (`TOOL_ORBS`): a search draws
  `searching`, an edit `composing`, a web call `connecting`, a subagent `weaving`, a
  command `working`, a skill `solving`, a read `searching`, anything else `breathing`.
  Only a running call is an orb; a finished one keeps its kind's glyph.

The contract it implements is `MarkPack` in `src/renderer/src/lib/marks.ts`; the map
from `clave.orbs/orbs` to the pack is `components/plugins/native-marks.tsx`, the same
shape bundled views and panels use. The ink follows the skin's base (light ink on a
dark ground); a status colour the app passes tints it.

`tests/e2e/agent-mark-orb.spec.mjs` drives the pack through the real app.
