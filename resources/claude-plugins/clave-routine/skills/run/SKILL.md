---
name: run
description: The contract of a Clave routine run. Clave started this session by itself, on a schedule or on a click, with nobody watching; the first message invokes this skill with the run's facts and the job. Do the job, then END by calling the clave_routine_report tool with status, headline, summary and data matching the routine's JSON schema. A run that ends without a valid report counts as failed.
---

# A Clave routine run

You are not in a conversation. Clave, the desktop app that runs agent sessions as tabs, started
this session **by itself** because a `.clave` workspace file schedules it (ADR 0004, routines).
Nobody is reading the transcript while you work; the person sees only what you report, as a
badge on a toolbar icon and a report panel. Everything below is the contract between you and
that panel.

## What the first message gives you

The message that invoked this skill carries, one per line, before the job:

- `Routine:` the routine's name, and `Run:` the run's id.
- `Schema:` the absolute path of the JSON Schema your report's `data` must match. **Read it
  first** (the Read tool), before the job: it tells you what to measure and how to shape it.
- `Skill:` the routine's own skill, when the routine names one (for example
  `steward:workspace-health`). Load it with the Skill tool before starting the job, and follow
  it; this contract comes first only where the two disagree about reporting.
- `Working directory:` where the session runs.
- Then `Job:` and the job itself, the routine's prompt as the file wrote it.

## The job

Do what the job says, in that working directory, with the tools you have. Rules of an unattended
run:

- **Nobody can answer you.** Do not ask questions (no AskUserQuestion): decide from the job and
  the skill, and put what you would have asked in the report's proposals. A permission prompt
  that waits for a person stalls the run until it times out; prefer what the job allows, and
  report the rest as proposed.
- **Only what the job calls safe.** A job that says "apply the safe fixes and propose the rest"
  means exactly that: do the reversible, documented things; list the others.
- **Be brief in the transcript.** The report is the deliverable, not your narration.

## The report

End the run by calling **`clave_routine_report`** once, with:

- `status`: `ok` when everything is as it should be or was fixed; `attention` when something
  needs the person (a proposal, a drift you did not touch, a check you could not run);
  `failed` when the job itself could not be done.
- `headline`: ONE line, under 120 characters, what the person needs to know at a glance.
  Written for the badge's tooltip: "3 checkouts pulled, 1 secret to pull by hand", not "Done".
- `summary`: markdown, under 4000 characters: what you did, what you found, what you propose,
  in that order, short paragraphs or bullets. No transcript, no tool output pasted whole.
- `data`: the object the schema describes. **It must validate.** When the tool answers with
  validation errors, correct the data and call the tool again: the run is still in flight and
  the last valid report wins. Never invent a figure to satisfy the schema: a check you did not
  run is reported as such in the shape the schema offers for it.

A run that ends without a valid report is recorded as **failed** with "ended without a report".
A second valid report replaces the first. A report after the run ended is refused.

## What not to do

- Do not open tabs, groups or windows, do not message other sessions, do not notify: the badge
  is the notification.
- Do not write outside the working directory unless the job says so.
- Do not call `clave_routine_report` before the job is done, or more than once per state.
