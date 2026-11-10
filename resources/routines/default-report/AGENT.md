# A routine report, written by Clave

This folder is one run of a routine created on a Clave server (ADR 0004, routines;
PRDCT-4242), written by Clave from the built-in report page the app ships: a routine
made over the API or by an agent tool names no template of its own, so every run gets
this page.

- `index.html` is the page: the run's status and headline, when it ran, then one card
  per item the agent reported (a title, a verdict, a detail, what to do about it), the
  facts it kept, and the agent's summary. Self-contained, in Clave's colours, light and
  dark.
- `data.json` is the same data: the envelope Clave wrote (the routine, the run with its
  status, headline and summary) and the agent's `data` as the schema describes it.
- `schema.json` is what the agent's `data` was validated against before the deck was
  written.
- Clave writes this folder once, when the run reports. Anything you add here stays until
  the routine's history forgets the run (the last twenty are kept).

The folder is yours. `slideless push <this folder>` puts it on Slideless on your own login
if you ever want; Clave never pushes anything unless the routine says `publish`.
