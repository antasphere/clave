# Routine report (`clave.routine-report`)

A bundled first-party native view for the sessions a routine runs (ADR 0004,
`docs/adr/0004-routines.md`). A routine is a prompt a `.clave` file schedules
and the Clave server runs by itself in a hidden session; the run ends with the
agent calling `clave_routine_report`, and the server validates the data against
the routine's schema and writes it into a deck (the routine's template folder,
copied, with `data.json` beside and the `slideless-data` block filled), served
on the loopback by the Slideless viewer.

`src/RoutineReport.tsx` renders one run: the deck through the hardened page
guest when the viewer serves it, else the envelope (status, headline, summary)
as a plain card with the one-line reason. `src/RoutineReportView.tsx` is the
session view the chat plugin's `chat` and `terminal` sit beside: given a run's
session, it finds the run in the routines store and renders its report, so a
run opened as a tab can be read as **Routine report**, **Chat** or **Terminal**
from the pane's picker. The toolbar's floating panel
(`src/renderer/src/components/routines/`) renders the same component directly,
with the history, Run again, Open as a tab and Dismiss, and the Discussion
toggle that mounts the chat view on the run's session.

The plugin owns no data: the routines, their runs and the viewer's address are
the server's (`routines.list`), mirrored in `store/routines-store.ts`.
