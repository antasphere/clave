# Clave skins

A skin is a data-only package. It supplies known `@clave/ui/tokens.css` custom
properties; it cannot run JavaScript, add selectors, import stylesheets or fetch
resources. All panels consuming `@clave/ui` inherit the active tokens.

```text
my-skin/
  clave-plugin.json
  skin.json
  skin.css             # optional
```

```json
{
  "kind": "skin",
  "id": "my-skin",
  "name": "My skin",
  "version": "1.0.0",
  "engines": { "clave": ">=1.90.2" },
  "skin": { "tokens": "skin.json", "base": "dark", "css": "skin.css" }
}
```

`id` is a lowercase letter followed by lowercase letters, digits or hyphens (up
to 64 characters). Versions must be semver; the engine range must accept the
running Clave version. Base is `dark` or `light`. File names are fixed and cannot
traverse directories. Bundled ids cannot be replaced or removed.

`skin.json` is a flat map from full custom-property name to CSS value:

```json
{ "--color-accent": "#bd89e5", "--surface-0": "#201c25" }
```

The accent token is **`--color-accent`**, not `--accent`. Unknown names are errors.
`token-names.json` is generated from the design system with the explicit
`excluded-token-names.json` list. Skins change colour and material only: metrics,
radii, fonts, animation and easing remain owned by the stylesheet.
Both folder and JSON imports store only declared overrides; unspecified values
inherit the current selected base at read time. The tree separator intensity is a
user preference and is preserved when applying a skin.

Optional CSS accepts only `:root { --known-token: value; }` declarations. It is
parsed as CSS, not injected into the page. Selectors other than `:root`, at-rules,
nesting, important declarations, unknown properties, unknown variable references,
URLs, escaped syntax and unsupported functions are rejected. CSS values override
JSON values. Files are capped at 128 KB and symlink inputs are refused.

Appearance lists bundled and installed skins. Import accepts a folder or a single
JSON token map, validates before writing, and copies only normalized manifest and
token data into `~/.clave/skins/<id>`. A single JSON file receives an `imported-`
id based on its filename and a dark base. Import activates the new skin. Removing
an active skin reverts to Dark. The active id lives in app preferences and applies
across windows. First boot keeps the legacy theme without persisting a skin id;
only a user choice persists one. The skins folder is created on first import. Changes under the skin directory reload automatically; invalid
packages are excluded and their errors appear in Appearance. Test-mode apps use
`<isolated-user-data>/skins` instead of the user's home directory.

The preload bridge exposes `skinsList`, `skinsActivate(id)`, `skinsImport(path?)`,
`skinsRemove(id)` and `onSkinsChanged`. Omitting the import path opens the picker.

## Bundled conversion

Run `node packages/skins/scripts/extract-skins.mjs` from any working directory.
The script parses `packages/ui/src/tokens.css`, combines shared defaults and the
dark defaults with each theme's overrides, and writes the four bundled packages
and token inventory. The existing CSS definitions remain as the compatibility
cascade for nested swatches. Extraction must produce no diff on a second run.

`tests/visual/skins-parity.mjs` compares the original CSS cascade with the applied
skin in real Electron at a 0.1% changed-pixel threshold. Screenshots stay in memory.
`CLAVE_SKIN_PARITY_MUTATE=1` must make this check fail.

## Terminals

`--terminal-*` tokens in `@clave/ui` preserve the original four terminal palettes.
`skin-to-xterm.ts` is the only mapping for local, remote and toolbar terminals;
background and cursor accent use `--surface-0`, while ANSI, foreground, selection
and cursor colors use their named terminal tokens. `none` leaves selection
foreground unset, retaining xterm's original behavior. Token references resolve
before reaching xterm; the renderer converts modern CSS colors to RGBA.

For installed skins, an explicit `--color-accent` override also supplies the
terminal cursor accent unless `--terminal-accent` or `--terminal-cursor` is
provided. Thus a single accent edit updates panels and already-running terminals.
Bundled cursor colors remain exactly as before. `tests/visual/fixtures/legacy-xterm.json`
is a test-only snapshot of the palettes before conversion; unit and Electron
checks compare every original property against it.

`CLAVE_SKIN_E2E_MUTATE=1 node tests/e2e/run.mjs skins` blocks the real
main-to-renderer skin update event and must fail the watched-edit assertion.
