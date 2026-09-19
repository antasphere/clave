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
`token-names.json` is generated from the design system, never hand-maintained.
Unspecified values inherit the selected base. The tree separator intensity is a
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
across windows. Changes under the skin directory reload automatically; invalid
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
