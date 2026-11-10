# Routines: the example template

ADR 0004 (`docs/adr/0004-routines.md`) is the design; the create-workspace skill
(`plugin/skills/create-workspace/SKILL.md`, "Routines") is the reference a `.clave` is
authored from. This folder holds the **example deck template** the first routine uses, to
copy into a workspace's `.clave/routines/<name>/` folder and adapt: `workspace-health/` is
the "Workspace health" routine of the Antasphere workspace, a weekday morning check of the
machine against Steward's desired state.

A template folder holds `index.html` (the page, with the `slideless-data` block Clave fills
with the run's envelope and the agent's data), `schema.json` (the JSON Schema the agent's
`data` must match; the run is failed when it does not) and `AGENT.md` (what the folder is,
as every Slideless deck carries). Clave copies the folder into the run's deck, writes
`data.json` beside and fills the block; the Slideless viewer serves it on the loopback.

## The proposed routine, for the workspace files

To declare, in `~/.antasphere/.clave/workspaces/*.clave`, on the toolbar group of the root
workspace (the owner's call, after the merge):

```json
"routines": [{
  "name": "Workspace health",
  "schedule": "30 8 * * 1-5",
  "prompt": "Check this machine against the workspace's desired state. Run, in this order and in this directory: `steward status`, `steward sync`, `steward secrets status`, `team tools outdated`, `steward doctor`. Apply only the SAFE fixes: a fast-forward pull of a clean checkout, a missing clone (`steward clone --all`), a secret pull that overwrites no local edit (`steward secrets pull`), a tool update (`team tools update`). Never force, never discard a local change, never push, never touch a dirty or off-branch checkout: propose those with the exact command. Report one check per command with its verdict, what you fixed and what you propose. {{extra}}",
  "params": { "extra": "" },
  "cwd": ".",
  "agent": "claude",
  "form": "chat",
  "model": "claude-opus-5-5",
  "account": "any",
  "dangerousMode": true,
  "icon": "shield",
  "color": "teal",
  "catchUp": true,
  "timeoutMinutes": 30,
  "scope": "machine",
  "runsOn": "every",
  "report": {
    "template": ".clave/routines/workspace-health",
    "schema": ".clave/routines/workspace-health/schema.json",
    "width": 560,
    "height": 640
  }
}]
```

and the template copied to `~/.antasphere/.clave/routines/workspace-health/` (the three
files of `workspace-health/` here). A personal copy of the workspace file (`romain.clave`)
changes `params.extra` or the account without touching the shared one.

`runsOn` says where it runs, and it is required (PRDCT-4241): `"every"` runs it once on every
machine that reads the file, which is what a machine's own health check wants; a server's own
name or id (`"runsOn": "romains-mac-studio"`) runs it on that Clave server alone, every other
machine listing it without running it and a Mac connected to that server showing its runs in the
same Routines popover, the report read over the connection and Run now asked of the server. A
server's own name is shown and set in Settings › Servers (the first label of its hostname until
someone sets it). Add `"publish": true` inside `report` to also push every run's deck to the
workspace's Slideless, behind one share link the panel shows.

A routine that should run on one machine without touching a shared file is **created** on that
machine instead: an agent calls `clave_routine_create` (then `clave_routine_list`, `_update`,
`_pause`, `_delete`, `_run`), or a person uses the “+” of the machine's section in the Routines
popover. Such a routine is kept by that server in its own store, runs there alone on the
built-in report page the app ships (`resources/routines/default-report`, beside this folder's
example), and `clave_routine_move_to_file` writes it into a `.clave` file like the one above when
it should be shared, with `runsOn` set to the machine's name.

Until Steward's reconciler (`steward doctor` / `steward up`) lands, the prompt names
today's commands; the day it lands, the prompt shrinks to the reconciler and the schema
keeps its shape.
