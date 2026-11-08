# Session Groups

Groups let you organize sessions and save workspace configurations for quick launch.

## Creating Groups

Select one or more sessions and press **Cmd+G** (or right-click → **Group**) to create a group. Drag a session onto a group to move it there — a drag always moves just the row you grabbed, never the rest of your selection. You can:

- **Rename**: Right-click the group header
- **Color**: Assign a color (8 presets or custom hex)
- **Collapse/Expand**: Click the folder icon, or click the header of a selected group
- **Undo**: Cmd+Z undoes the last group, move, rename, or recolor

## Group Terminals

Each group can have terminal configs: pre-configured commands that spawn new sessions inside the group. The terminal icon in the group header shows how many are attached and lights up in a running terminal's colour; hover it (or click) for the list — click a terminal to start or focus it, right-click to edit, and **New terminal** at the bottom adds one. The `+` beside it starts a new session in the group. Terminals support:

- **Command**: The shell command to run
- **Command mode**: `prefill` (paste into terminal for you to run) or `auto` (execute immediately)
- **Icon**: Choose from 18 icons (terminal, fire, bolt, rocket, globe, cube, etc.)
- **Color**: Match or override the group color
- **Working directory**: Override the group's default folder
- **Auto-launch localhost**: Automatically open detected localhost URLs

## Pinned Groups (.clave Files)

Pin a group to make it persistent. Pinned groups are saved as `.clave` JSON files and remember their full configuration across restarts. You can also:

- **Import**: Drop a `.clave` file into the pin area to load it
- **Export**: Right-click a group to export it as a shareable `.clave` file
- **Multi-group files**: A single `.clave` file can define multiple groups
- **Watch for changes**: Clave watches `.clave` files and reloads when they change on disk

Share `.clave` files with your team to standardize workspace setups.

## Toolbar Quick Actions

Mark a terminal inside a pinned group as a **toolbar** item. It appears as an icon button in the main toolbar for one-click session spawning.
