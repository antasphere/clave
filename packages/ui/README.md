# Clave UI conventions — the field guide

Read this before writing any UI. It exists because a whole feature's buttons were
rebuilt three times against the wrong references: first improvised sizes, then the
toolbar's, before landing on the panel family that was the actual standard. Every
value here is a class or token that already exists in
`packages/ui/src/tokens.css` or `packages/ui/src/system.css` — this guide tells you
which one to reach for.
When something you need is missing there, extend `packages/ui/src/system.css` with a new semantic
class next to its family; never inline the styling at the call site.

## The two rules that beat everything else

1. **The design system is unlayered; Tailwind utilities are layered.** A dimension,
   color, or padding set by a design-system class BEATS `w-5`, `text-accent`,
   `pr-2` on the same element. Do not "fix" a system class with a utility — it
   silently loses. Where an override is genuinely wanted, it needs `!` (see the
   toolbar's `!text-accent`) — and wanting one usually means you picked the wrong
   class.
2. **Never hardcode a color, radius, size, or duration.** Three themes (plus
   charcoal) restate the tokens; a literal hex or px is invisible breakage in the
   other themes. If you type `#`, `rgba(`, or a px number that is not in this
   file, stop.

## The control spec and the frame spec

Every control reads five numbers from `tokens.css` and writes none of them as
a literal: `--control-h` (28px), `--control-px` (8px sides), `--control-gap`
(6px icon-to-label), `--control-text` (13px), `--control-radius` (6px). That is
the ratio of the workspace popover's rows, and it is the ratio of every button,
chip, tab, row and field because they all inherit it. Text buttons take
multiples of `--control-px` (`.btn-secondary` ×1.5, `.btn-primary` ×2).

A **frame** is a bordered box that groups **two or more** controls: the
launcher, the switcher, the side panel's bars, the toolbar (`.frame`). The rule
that keeps every frame the same size: **a control is 28px free-standing and one
size down inside a frame**, so the frame is one control tall (`--frame-h` 28px)
with the control's corner (`--frame-radius` 6px), and what sits inside is
`--framed-control-h` (24px) on `--framed-control-radius` (4px) with a 14px
glyph, applied by the "── Frames ──" descendant rule so a control class never
knows where it sits. **A single control is never framed**: a field alone is a
field, not a bar around a field. Surfaces (menus, cards, panes) are not frames:
they hold full-size rows and their corner, `--radius-xl`, is derived from the
control corner plus `--surface-inset` plus the border. Change the spec, and the
whole app moves; add a literal, and it stops.

## Boxes (panels, cards, overlays)

| Surface                                                              | Class                                                                 | Look                                                                                                                                        |
| -------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminal panes, main views                                           | `.floating-card`                                                      | radius-xl, 1px `--color-border`, `--surface-0`, **no shadow** (flat on purpose)                                                             |
| Frames: the toolbar, the launcher, the switcher, the side-panel bars | `.frame` / `.launcher-panel` / `.group-switcher-panel` / `.panel-bar` | one control tall, the control's corner, 70% surface-0; the controls inside are one size down                                                |
| The sidebar's foot                                                   | `.sidebar-panel`                                                      | a surface: radius-xl, same material at 70% surface-0                                                                                        |
| The side panel's Files / Git switch                                  | `.panel-tabs`                                                         | same material and border, but one control tall: a 28px track, 24px `.panel-tab` items on `--radius-md`, held in the 34px row by its margins |
| Menus, popovers, dropdowns, floating widgets                         | `.menu-surface`                                                       | radius-xl, border, surface-0, `--overlay-shadow`                                                                                            |
| Document-sized floaters (file preview, diff panel, palette)          | `.menu-surface menu-surface--sheet`                                   | same, heavier `--overlay-shadow-lg`                                                                                                         |
| Modal dialogs                                                        | `.modal-card` (+ `.modal-pop` for motion, `.modal-scrim`)             | radius-xl, border, surface-0, overlay-shadow-lg                                                                                             |

- A box's **contents sit 2px from its edge** (`.launcher-row` is `padding: 0 2px`;
  the message trail uses `px-0.5 py-0.5`). Controls fill the box; the box does not
  cushion them.
- Segments inside a bar are divided by `.launcher-sep` / `.panel-sep` (1px × 16px
  hairline), never by a full-height border.
- One corner for every 28px control: `--radius-control` (panel controls) and
  `--radius-lg` (dialog buttons, settings inputs, menu rows) are both 6px. The
  panel token survives as a name only, so the two families can still be told
  apart in the stylesheet; the 7px concentric-corner arithmetic it once carried
  is gone, because that pixel made the launcher, chips and toolbar buttons read
  heavier than the popover rows beside them.

## Buttons

**Icon buttons — the decision is "what box does it sit in":**

| Where it sits                                                                                       | Class                                                                     | Size / hover                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inside a panel, bar, or floating box (side panel path bar, terminal header, message trail, git bar) | `.panel-icon-btn`                                                         | 28px (`--control-h-md`) box, 16px icon (`w-4 h-4`), hover `--surface-100`, `data-active="true"` = accent tint (toggles), `:disabled` = 0.4; inside a frame the Frames rule makes it 24px with a 14px glyph |
| The sidebar launcher row specifically                                                               | `.launcher-icon-btn`                                                      | identical look; launcher-local name                                                                                                                                                                        |
| The sidebar's foot panel                                                                            | `.sidebar-footer-btn` (and `.sidebar-footer-line` for the row-shaped one) | identical box, but the hover fill is `--field-fill` — the user's own palette, not `--surface-100`                                                                                                          |
| The app toolbar and standalone spots                                                                | `.btn-icon btn-icon-md` (also `-sm`/`-xs`)                                | fixed square per size, hover `--surface-200`, `:disabled` = 0.4                                                                                                                                            |

- The sizes are **boxes, not paddings** — a fixed square, glyph chosen to read
  well inside it: `w-4 h-4` (16px) in a 28px box, `w-3.5` in 24px, `w-3` in 20px.
- **Icons are Heroicons 24/outline. No hand-rolled SVGs** for standard glyphs
  (the old header X and stop-square were the last two; they're gone).
- Toggle state is `data-active="true"` on `.panel-icon-btn` (accent text + 12%
  accent fill) — never a color utility bolted on.
- Never add `hover:bg-*` to any of these; the class owns its hover.

**Text buttons:** `.btn-primary` (the action ink), `.btn-secondary` (a neutral
raised control: `--surface-raised`, primary text, its edge and drop drawn by
`--raised-control-shadow`, so never add a border utility), `.btn-dialog`
(the Cancel/Confirm footer pair), `.launcher-btn` / `.panel-tab` /
`.group-switcher-chip` (28px chip: px-2, 13px text like a menu row, hover surface-100, selected
surface-200). Disabled is always `opacity: 0.4` + `cursor: not-allowed`.

## Inputs and search

- `.input-field` — 32px (`--control-h-lg`), radius-lg, surface-100, subtle border,
  accent border on focus. `.textarea-field` is its multi-line twin.
- `.input-compact` — 28px, the control label size, accent ring on focus; add
  `.input-compact-icon-right` when a trailing glyph needs room (a `pr-*` utility
  will NOT work — see rule 1).
- `.search-field` — the in-panel search (sidebar, side panel): 28px, radius-control,
  translucent surface-100 fill, clear button `.search-field-clear`. **Focus never
  draws a box inside a box**: inside a frame it is a segment that steps its fill
  up on focus; standing alone (the Files filter) it wears the frame's material
  itself, border, ground, height and corner, and the border takes the accent.

## Rows and lists

- Menu/popover rows: `.menu-item` (28px min, radius-lg, hover surface-100,
  `data-selected="true"` surface-200). Color variants are modifier classes on it,
  not text utilities.
- Sidebar rows: `.sidebar-item` (height `--sidebar-row-h`, 28px like every other row, padding
  `--sidebar-row-px`, its own resting colors). Align any sidebar chrome to
  `--sidebar-gutter`, never to hand-picked padding.
- Side-panel tree rows: `--panel-row-h` (28px); git tree section rows
  `--git-tree-row-h` (30px); hairlines between blocks use `--rule-color` only.
- **Filled rows never touch.** The row family owns the air between two of its
  rows (`--row-gap`, 2px) through the "Row rhythm" selector in `system.css`; a
  list of `.menu-item` or `.sidebar-item` is spaced by construction and needs no
  `space-y-*` from the call site. A new full-width row class with a hover fill
  joins that selector, or `src/renderer/src/lib/row-rhythm.test.ts` fails.

## Settings pages

The settings are built from `components/settings/primitives.tsx` and the `── Settings ──`
block of `packages/ui/src/system.css`, and from nothing else: a page never styles a control of its own.

| Piece                       | Component / class                                                              | Look                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The page                    | `SettingsPage` (`.settings-page-header`, `-title`, `-description`, `-actions`) | one width for every page (`max-w-3xl`), a title one type step above the section headings, a 13px description, the page's actions on the right                                                                                                                     |
| A section                   | `SettingsSection` (`.settings-section-title`, `-description`)                  | 15px primary title at default density, with room for a glyph (the agent families' logos), 12px secondary description                                                                                                                                              |
| A card                      | `SettingsCard` (`.settings-card`)                                              | the page ground: radius-xl, `--color-border`, transparent fill, rows seamed by `--border-subtle`                                                                                                                                                                  |
| A row                       | `SettingsRow` (`.settings-row`, `-title`, `-description`)                      | text left, the controls right in `.settings-row-controls` (one gap, the control's); `.settings-row-action` is the full-width add row                                                                                                                              |
| A row's metadata            | `tags` on `SettingsRow` (`.settings-row-tags` of `.badge badge-muted`)         | chips under the description (a plugin's permissions): never a second row pretending to be a second setting                                                                                                                                                        |
| A value a row only states   | `.settings-row-value`                                                          | the density stop, a token count, "Never": control label size, secondary ink, tabular                                                                                                                                                                              |
| A quiet fact beside a title | `.badge badge-muted`                                                           | "Built in", "Active", "This Mac", how an account signs in; never the two colour utilities by hand                                                                                                                                                                 |
| One of a set                | `Radio` (`.radio`, `data-checked`)                                             | 14px ring on the field fill, the accent when chosen; never a hand-rolled circle or a native radio                                                                                                                                                                 |
| A form field's label        | `.field-label`                                                                 | above an `.input-compact` in a dialog or a form row                                                                                                                                                                                                               |
| A select                    | `SettingsSelect` (`.select-trigger`, `.select-menu`, `.select-option`)         | a 28px trigger cut like `.input-compact` with the caret held off the edge, the options on `.menu-surface` / `.menu-item`; never a native `<select>`                                                                                                               |
| A switch                    | `Toggle` / `ToggleRow` (`.switch`, `.switch-knob`)                             | 36×22 in settings (28×16 elsewhere), `data-checked`, the knob on `--color-switch-knob`                                                                                                                                                                            |
| A callout                   | `SettingsCallout` (`.settings-callout[data-tone]`)                             | a confirmation or a picker under a card, the tone on the border only; `.settings-card + .settings-callout` owns the gap, never an `mt-*`                                                                                                                          |
| A callout inside a card     | `SettingsCallout inset` (`.settings-callout--inset`)                           | the confirmation attached to the row it guards (a plugin's enable review), a notice, a form the row opened: no outline of its own, the tone as a wash on the ground. A callout with its border INSIDE a card is a card in a card, the defect that earned this row |
| A callout's actions         | `actions` on `SettingsCallout` (`.settings-callout-actions`)                   | Cancel then the primary, right-aligned on the control ramp with the control's gap. `.btn-dialog` is the modal footer pair and never appears in a callout                                                                                                          |
| The sidebar's groups        | `.settings-nav-label` over `.sidebar-item` rows                                | regular case, control-sized tertiary text, 24px above subsequent groups                                                                                                                                                                                           |

Status in words uses `.status-text[data-status]`; a destructive icon button takes
`.btn-icon--danger` (the ink turns on hover only); the theme swatches are
`.theme-swatch` with a `data-theme` preview inside, so they never carry a copied hex.

## The one surface that is NOT grey: the sidebar's foot

The foot panel is made of the user's Antasphere field, and grey is the one hover
that cannot go over a coloured ground — it reads as dirt on the picture rather
than as a control waking up. So `SidebarFooter` hands the panel its palette's
signature hue as `--field-accent` (an inline custom property; the hue itself is
`Palette.accent` in `lib/brand-field.ts`, one per palette, always a member of
that palette's own `hues`), and `.sidebar-footer` derives `--field-fill` /
`--field-fill-strong` from it. Every control in that panel takes those instead
of `--surface-100` / `--surface-200`. Nothing else in the app does this: outside
the foot, the grey ladder below is still the answer.

That panel also insets its contents by the system's 3px, which the bare
`.sidebar-panel` does not — a row exactly one control tall in a box with no
padding puts the button ON the card's border, and it reads as a block cut out of
the card. `tests/e2e/sidebar-foot.spec.mjs` asserts both the inset and the tint.

## The ladder of grays (per theme, never literal)

`--surface-0` (panel ground) → `--surface-100` (hover in panels, input fills) →
`--surface-200` (selected / toolbar hover) → `--surface-300/400` (pressed, rare).
Text: `--text-primary` / `--text-secondary` / `--text-tertiary` (resting icon
color). Borders: `--color-border` (a panel's one structural border) →
`--border-subtle` (inner seams) → `--rule-color` (repeating list hairlines).

**Colour roles: verbs are ink, states are blue, everything else is neutral.** A
button that does something (Send, Save, Allow) is filled with `--color-action`
and labelled with `--color-action-foreground` (`bg-action
text-action-foreground hover:bg-action-hover`): the theme's own primary ink
on its ground. `--color-accent` is a per-theme signal blue reserved for state:
on, selected, active, focus, links, a drag target, progress. White text never
sits on the accent; if something filled with it needs a label, it is a verb
and wants the action role instead.

Every ink clears 4.5:1 on `--surface-50` in every theme, tertiary included (it
is the branch names, counters and placeholders people actually read). Keyboard
focus is one rule, the "── Keyboard focus ──" block: a 1.5px accent ring drawn
inside the control's edge for every control family; a new family joins that
selector, never invents its own ring, and never sets `outline: none` without it.

## Type and numbers

Geist Sans everywhere via `--font-sans`; `font-medium` resolves to 400 — do not
reach for 500/700. The working sizes: 13.5px sidebar rows, 13px menu rows and
dialog buttons, 12px chips/buttons/labels, 11px secondary lines and counters,
10px badges. Counters and anything columnar get `font-variant-numeric:
tabular-nums`.

## Motion

Color/background transitions are 150ms; press feedback is the shared 3% scale dip
on `--ease-out-expo` (buttons only, never rows). Overlays enter with
`.menu-pop` / `.menu-pop-mount` (140ms) or `.modal-pop` (160ms). Content
appearing/disappearing inside a box: Framer Motion, ~140–160ms, easeOut. Scrolling
a terminal programmatically glides (ease-out, duration scaled to distance, capped
400ms) — see `lib/terminal-scroll.ts`.

## Hover-revealed affordances

A control that only matters on approach (the trail's full-message chevron) is a
small overlay: 20px box, radius-control, ~90% surface-0 backdrop so it reads over
text, `opacity: 0 → 1` on the CONTAINER's hover, `pointer-events: none` until
shown. Place it where it cannot sit on another control's click center — Playwright
found the centered version stealing the message line's clicks before any human did.

## Checklist before you ship a control

- [ ] Its box size is a `--control-h-*` token and its radius answers its panel.
- [ ] Its class comes from this file; no `hover:bg-*`, no invented size.
- [ ] Icon is a Heroicon at the size paired with the box above.
- [ ] Toggle state uses `data-active` / `data-selected`, not a color utility.
- [ ] It looks right in dark AND light (and ideally coffee/charcoal).
- [ ] Disabled renders at 0.4 with no hover fill.

## Consuming the package

`@clave/ui` ships ESM TypeScript source for renderer bundlers. Import the stylesheet
once, after Tailwind and third-party editor styles, and scan the package with
Tailwind v4's `@source` (relative to the consuming CSS file):

```css
@import 'tailwindcss';
@import '@clave/ui/styles.css';
@source "../../../../packages/ui/src";
```

```tsx
import { ConfirmDialog, ColorPicker, cn } from '@clave/ui/components'
```

`styles.css` loads Geist Sans, `tokens.css`, and the unlayered `system.css` in
that order. Skins can import `@clave/ui/tokens.css` independently. Shared controls
must never import the app's stores, Electron bridge, or feature components.

`ColorPicker` accepts a `presets` map and an explicit `presetOrder` array; `ThemeToggle` accepts `theme` and `setTheme`;
`EmptyState` accepts an `action` node. The app keeps thin adapters at the old paths
for its terminal palette and new-session action; Appearance owns persisted skin selection. All other old
primitive paths are compatibility re-exports for one release.

## Verification

- `npm run typecheck -w @clave/ui` checks the standalone package.
- Root `npm test` runs `scripts/check-tokens.mjs` before the unit suite. Its pinned
  inventory comes from form-factor commit `76c0568`: 116 theme-block token names,
  of which 14 CodeMirror tokens intentionally remain in the app. It also pins each
  theme's own overrides, so dropping a light-theme value cannot fall back silently
  to dark. The brief's count of 122 does not match this baseline. The colour
  roles (accent, action, the raised control's shadow) grew it to 125.
- `tests/visual/ui-parity.mjs` runs the real, hidden Electron app. Build the baseline
  revision and run `node tests/visual/ui-parity.mjs baseline /tmp/clave-ui-baseline`,
  then build the changed revision and run the same script with `compare`. It checks
  eight views at a 0.1% changed-pixel limit, seeds the random brand grain, and deletes
  comparison PNGs afterwards. Use a dedicated temporary directory, never the repo.
  `CLAVE_UI_PARITY_MUTATE=1` on the comparison injects an incorrect surface fill;
  the check must exit nonzero. Removing `--surface-0` must similarly fail the token
  check. No screenshots are committed.
