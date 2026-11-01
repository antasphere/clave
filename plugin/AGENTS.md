# Clave Plugin

The Clave agent plugin, shipped from inside the app repo. [Open Plugin v1](https://github.com/vercel-labs/open-plugin-spec). Plugin name is `clave`; all skills surface as `/clave:<skill>` in any installed host. Two skills: `clave:create-workspace` (generates `.clave` workspace files) and `clave:recover-sessions` (rebuilds a lost workspace from local Claude Code transcripts).

## Why it lives here

The `.clave` schema is mirrored in six places that do not import each other — five in the app's source, and `skills/create-workspace/SKILL.md`, which is the reference agents author `.clave` files from. Nothing in that chain fails loudly: a stale skill writes a field the app has renamed, and the feature simply does nothing.

Before this folder existed the sixth mirror was a separate repo, `codika-io/clave-plugin`, and keeping it in step meant a second PR that had to land *before* the app's. Now all six move in one commit. The full rule, with the round-trip checks that go with it, is in the repo root's `AGENTS.md` under **`.clave` schema sync rule** — read it there, not here, so there is only one copy.

The running app does **not** read this folder. It reads installed plugins from Claude Code's global `~/.claude/plugins/` cache, so the plugin is still independently installable and independently versioned; it just no longer lives anywhere else.

## Structure

```
plugin/
├── .plugin/plugin.json              # Vendor-neutral manifest (Open Plugin v1)
├── .claude-plugin/plugin.json       # Claude Code preferred manifest (kept in sync)
├── skills/
│   ├── create-workspace/
│   │   └── SKILL.md                 # The skill itself — agent discovers it at runtime
│   └── recover-sessions/
│       ├── SKILL.md
│       └── scripts/
│           └── scan-transcripts.py  # Read-only transcript scanner (stdlib only)
├── README.md
├── AGENTS.md
└── LICENSE
```

The repo root also carries `.claude-plugin/marketplace.json`, which is what makes `npx plugins add antasphere/clave` resolve to this folder. It names the marketplace `clave` and points `source` at `./plugin`, so the plugin installs as `clave@clave`. If you move or rename this folder, that file moves with you.

## Manifests

Two manifests kept intentionally in sync:

- `.plugin/plugin.json` — canonical Open Plugin v1 manifest. Read by `npx plugins`, Cursor, and any Open-Plugin-compatible host.
- `.claude-plugin/plugin.json` — Claude Code vendor-prefixed manifest. Per Open Plugin §5.1, Claude Code prefers this when both are present.

When editing manifest metadata (`version`, `description`, `keywords`, …), update **both** — they are byte-identical today and should stay that way.

## Adding a new skill

1. Create `skills/<skill-name>/SKILL.md` with YAML frontmatter (`name`, `description`).
2. The plugin loader picks it up automatically from the default `skills/` discovery location (Open Plugin §7.1) — no manifest edits needed.
3. Document it in `plugin/README.md` and in the root `README.md`'s *Agent plugin* section.
4. Bundled helper scripts go in `skills/<skill-name>/scripts/`. Keep them stdlib-only (no install step) and read-only where the skill touches user data — the `SKILL.md` must still describe the underlying signals so the skill degrades to hand-work if a script is missing.

## Versioning

The plugin versions independently of the app — `plugin/.claude-plugin/plugin.json` has nothing to do with the app's `package.json` version, and a plugin-only change does not need an app release. Follow [semver](https://semver.org/):

- **Major** — breaking: rename/remove a skill, change plugin `name`.
- **Minor** — additive: new skill, new references.
- **Patch** — doc/fix-only.

Update both manifests in lockstep.

## Local testing

From the repo root:

```bash
npx plugins add .
```

Skills surface as `/clave:<skill>` in any installed host. Note that this copies the working tree — in the Antasphere workspace, prefer `steward plugins`.

## Conventions

- Skills must NOT contain secrets, API keys, or internal URLs.
- Keep each `SKILL.md` self-contained — works standalone.
- A `.clave` format change in the app and the matching `SKILL.md` edit belong in the **same commit**. That is the entire reason this folder is here.

## History

Extracted from `antasphere/clave` into its own repo `codika-io/clave-plugin` in 2026-04, and folded back in here in 2026-08 (PRDCT-1699) once the cross-repo ordering constraint proved to be the format's main source of drift. The old repo's history is preserved in this repo through the subtree merge that vendored it.
