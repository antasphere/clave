# A Workspace health deck, written by Clave

This folder is one run of the "Workspace health" routine (ADR 0004, routines), written by
Clave as a Slideless deck from the template `.clave/routines/workspace-health/` of the
workspace file that declares the routine.

- `index.html` is the page: the run's headline and status, then one card per check
  (`steward status`, `steward sync`, `steward secrets status`, `team tools outdated`,
  `steward doctor`) with its verdict, what was fixed and what is proposed. Self-contained.
- `data.json` is the same data: the envelope Clave wrote (the routine, the run with its
  status, headline and summary) and the agent's `data` as the schema describes it.
- `schema.json` is what the agent's `data` was validated against before the deck was written.
- Clave writes this folder once, when the run reports. Anything you add here stays until the
  routine's history forgets the run (the last twenty are kept).

The folder is yours. `slideless push <this folder>` puts it on Slideless on your own login if
you ever want; Clave never pushes anything.
