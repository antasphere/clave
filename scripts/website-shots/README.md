# Website screenshots

Product shots of the real Clave app for the website, taken from a fixed, staged scene.

```
npx electron-vite build && node scripts/website-shots/capture.mjs --out <dir>
```

It launches the built app the way the e2e suite does (`tests/e2e/harness.mjs`): an isolated user-data
folder, `--test-no-activate` (no window on screen, no Dock icon, no focus stolen), and
`--force-device-scale-factor=2`. Every fixture lives under `/tmp/website-shots/` (`CLAVE_E2E_NS`,
`website-shots` by default). No model is called and no account is read: the chat tab is fed by a
stand-in `claude` that speaks the stream-json protocol, the reviewer tab runs a Python stand-in for
Codex, and the sidebar's usage reading is fixed.

The script exits 0 only when every required shot was written at its expected pixel size (2x the
content size) and nothing of the run is left behind (its tmux sessions, its fixture folder, its dev
server). It takes about 40 seconds. `--keep` leaves the fixture folder in place for inspection.

## The shots

| File                  | Content size | What it shows                                                                   |
| --------------------- | ------------ | ------------------------------------------------------------------------------- |
| `hero.png`            | 1440×900     | The sidebar with three groups and the four Checkout tabs tiled (shift-click)    |
| `chat.png`            | 1200×800     | The "Lane · checkout" chat tab, the tool-call group opened, the markdown answer |
| `chat-permission.png` | 1200×800     | The same tab after a follow-up, an Edit permission waiting above the composer   |
| `group-view.png`      | 1200×800     | The Checkout group's live view on the dev server's checkout page                |
| `side-panel.png`      | 1200×800     | The chat tab with `docs/checkout-plan.md` in the side panel                     |
| `git.png`             | 1200×800     | The Git panel on the shop repo, the uncommitted change's diff open (optional)   |

The PNGs are 2x: `hero.png` is 2880×1800, the others 2400×1600.

The hero's chat cell is scrolled to the answer's heading; the chat's "Scroll to end" button, which the
app shows whenever a chat is scrolled up, is hidden for that one shot.

## The scene, and how to change it

- `project/`: the workspace "Atelier Nord", a small web-shop project. `capture.mjs` (`stageProject`)
  copies it to `/tmp/website-shots/atelier-nord` in four dated commits on `main`, switches to the
  `lane/checkout` branch, then writes `changes/validate.ts` over `src/lib/validate.ts`. That is the
  uncommitted change the git shot shows.
- `project/public/index.html` + `project/server.mjs`: the checkout page the dev server serves (a free
  port) and the group view shows.
- `chat-script.cjs`: what the chat says. One entry per user message, as stream-json frames shaped like
  `src/main/sessions/fixtures/claude-stream/` (turn 1 is the finished answer, turn 2 stops on a
  permission request). `fake-claude.cjs` plays it.
- `project/test-watch.mjs`: what the "tests" tab prints, a finished `npm test -- --watch` run.
- `fake-codex.py`: the Verifier tab's review text. It sets the terminal title that puts the tab in
  "needs you".
- `capture.mjs`: groups, tab names, user messages, the theme (light), the profile shown in the foot
  (Lena Maes), and the order and staging of each shot (`stageScene`, `captureAll`). The sizes and the
  required/optional flag of each shot are in `SHOTS`.
