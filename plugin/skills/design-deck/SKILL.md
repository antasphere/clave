---
name: design-deck
description: Designs a Slideless deck or an illustration in Clave's own branding and UI, the way the app draws them — a report deck (status hero, counts, cards, prose, Clave's colours in light and dark) and its drawings in the hand of the chat's drop card (ink line art, boxes of paper, the ringed dot, the accent used once). Use when asked to make, restyle or review a deck Clave shows (a routine's report template, an Analytics page, any page in Clave's panel or pane), or to draw an empty-state, drop-card or deck illustration for Clave.
---

# Design a deck, or a drawing, in Clave's hand

Clave shows Slideless decks in its panels and panes: a routine's report, the Analytics
pages. They are self-contained pages (one `index.html`, its style and script inlined, its
data in a `<script type="application/json" id="slideless-data">` block), so they cannot
import the app's stylesheet. This skill is how one is made to look like it belongs to the
app anyway, and how the small line drawings that light up an empty state or a deck are
drawn. Two parts: **the drawing**, then **the deck**. Do the drawing part on its own when
only an asset is asked for.

## Part 1: the drawing

A Clave drawing is a small, literal line illustration of the thing the reader is about to
get, in one hand shared by every drawing the app has (the chat's drop card for files and
for sessions, the routine panel's schedule and discussion). It is not decoration and not a
logo: a reader who sees it must be able to say what it shows.

### The hand, rule by rule

1. **Literal.** Draw the actual objects of the moment: a page, a folder, the composer, the
   sidebar's rows, a clock, a chat bubble, a lane of dots. Never a metaphor (no rocket, no
   lightbulb, no magic sparkle).
2. **Ink at low opacity, boxes of paper.** Lines are the ink at 30 to 55 percent; a box is
   filled with a breath of the ground, and the box in front with paper. No fills of colour.
3. **The accent ONCE**, on the one line that carries the meaning (the path a thing travels,
   the hand that moves, the line that rises), with its arrow head and the dot where it
   lands. Never a second accent element.
4. **The ringed dot is the focal marker**: where the accent line lands, a paper disc, a
   ring, a second ring that pulses once, and the accent dot in the middle.
5. **A ground line** under what stands on something (the composer, a page), thin.
6. **Dashed means owed or empty**: a seat a row has left, a folder owed its own line, a
   wait between two blocks.
7. **No words inside a drawing.** The card or the state under it says them.
8. **Motion is once, and optional**: the accent line draws itself (900 ms), the ring
   pulses once (1400 ms), a lifted thing settles. Never a loop. Under reduced motion, the
   still drawing.

### The canvas and the vocabulary

- `viewBox="0 0 240 150"`, drawn at about 176 to 240 CSS px wide. Keep 18 px of air on
  each side; the ground line sits near `y = 132` to `138`.
- Rounded corners: 6 to 9 for boxes, a page's folded corner 11.
- Strokes never scale (`vector-effect: non-scaling-stroke`), round caps and joins.
- The classes, on the `<svg>` with class `drawing` (inside the app: `chat-drawing`):

| Class | What it draws |
|---|---|
| `ln` | a line of the drawing, ink 45 % |
| `ln ln--thin` | a text line inside a box, a ground line, a tick: ink 30 %, 1 px |
| `ln ln--soft` | dashed: owed, empty, a wait |
| `ln ln--c travel` + `pathLength={1}` | THE accent line, drawn once; give it `marker-end` with the head |
| `bx` | a box at rest (ground at 40 %) |
| `bx bx--front` | the box in front (paper) |
| `dot`, `dot dot--seat` | a mark; a seated (resting) mark |
| `ring`, `ring ring--pulse` | the focal ring; its one pulse |
| `dot dot--c` | the accent dot at the landing |
| `head head--c` | the accent arrow head, in a `<marker>` |

The arrow head marker, the same in every drawing (give each drawing its own `id`):

```svg
<marker id="d-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="10" markerHeight="10"
  orient="auto-start-reverse" markerUnits="userSpaceOnUse">
  <path class="head head--c" d="M1.5,1.5 L8,5 L1.5,8.5" />
</marker>
```

The landing, always these four circles at one centre, radius 9:

```svg
<circle class="bx bx--front" cx="120" cy="115" r="9" />
<circle class="ring" cx="120" cy="115" r="9" />
<circle class="ring ring--pulse" cx="120" cy="115" r="9" />
<circle class="dot dot--c" cx="120" cy="115" r="3.5" />
```

The stylesheet that gives these classes their ink outside the app, in light and dark, is
[references/drawing.css](references/drawing.css): paste it into the page's `<style>`, or
into the `<svg>`'s own `<style>` for a standalone file. Inside the app, use the classes on
`chat-drawing` and nothing else; the app's tokens already style them.

### How to draw one

1. Say in one sentence what the reader is about to get, and which objects show it
   ("a session's activity: its working blocks on the clock, the wait between them, the
   cost rising").
2. Pick the one movement that carries it: that line is the accent.
3. Lay the objects on the 240 by 150 canvas, the main object left or centre, the landing
   where the movement ends. Few objects: three to five.
4. Write the SVG with the classes above only: no inline colours, no fills but the classes',
   no text, no gradients, no filters.
5. Look at it rendered, light and dark, at its real size. Ask: can a reader say what it
   shows? Is the accent on exactly one line? Does anything read as decoration? Fix and look
   again.

### A worked example: the chat's drop card, files

```svg
<svg viewBox="0 0 240 150" class="drawing" aria-hidden="true">
  <defs><!-- the marker above, id="d-head" --></defs>
  <line class="ln ln--thin" x1="18" y1="138" x2="222" y2="138" />           <!-- ground -->
  <rect class="bx bx--front" x="46" y="100" width="148" height="30" rx="9" /> <!-- composer -->
  <line class="ln ln--thin" x1="60" y1="115" x2="154" y2="115" />
  <circle class="dot" cx="179" cy="115" r="4" />                              <!-- send -->
  <!-- a folder behind, owed a line of its own: dashed -->
  <path class="ln ln--soft" d="M158,64 C158,82 150,98 134,108" />
  <!-- the page in front, and THE line that carries it into the message -->
  <path class="ln ln--c travel" pathLength="1" d="M98,76 C98,88 104,96 112,104" marker-end="url(#d-head)" />
  <!-- the landing: the four circles at (120,115) -->
</svg>
```

## Part 2: the deck

A deck Clave shows sits in a panel or a pane of the app, on the app's own ground, beside
the app's own controls. It must read as part of the app: the same colours, the same type,
the same calm, and the reader's eye going to the one thing the run or the page says.

### The layout, top to bottom

1. **The hero**: the status as a pill (a dot and one word: OK, Attention, Failed), the
   headline large (about 19 px, weight 600, balanced wrapping), then one quiet line with
   when (`Today, 15:05 · scheduled`). A card on paper, its edge and a faint top wash in the
   status tone, the drawing's ringed dot (three circles) in the top corner in that tone.
   Nothing else in the hero: the routine's name, the account and the model are the
   panel's, never repeated.
2. **The counts**: one tile per verdict, the figure large and the word under it; a tile is
   lit in its tone only when its count is not zero. Skip the strip when there is nothing
   to count.
3. **A section label** before each list: 11 px, uppercase, tracked, tertiary ink
   (`FINDINGS · 4 FILES`, `CHECKS`, `SUMMARY`).
4. **One card per item**: paper, a 1 px line, its tone as a 3 px bar on the left edge, the
   title bold on the left, the verdict as a small uppercase chip in its tone on the right,
   one or two sentences under it, then the lists it carries (`Fixed`, `Proposed`).
5. **The agent's account as prose**, at most 64 characters a line: paragraphs, `-` lists,
   `code` spans on the ground, **bold** in the primary ink. Render the little markdown an
   agent writes; never show it raw.
6. **An empty state**, when there is nothing: one short sentence in tertiary ink, and a
   drawing (Part 1) when the deck has room.

### The colours, light and dark

The deck follows the system scheme (`prefers-color-scheme`); Clave's panel injects the
app's theme. Use Clave's values, never a palette of your own:

| Role | Light | Dark |
|---|---|---|
| ground | `#fbfbf9` | `#0e0d0c` |
| card (paper) | `#ffffff` | `#161513` |
| wash (tiles, code) | `#eeedeb` | `#1d1c19` |
| ink, ink 2, ink 3 | `#1b1b18`, `#5c5c56`, `#70706a` | `rgba(255,255,255,.95)`, `.6`, `.47` |
| line | `rgba(0,0,0,.1)` | `rgba(255,255,255,.1)` |
| ok, fixed, attention, failed | `#1f9d5a`, `#1f5fcf`, `#b7791f`, `#d14343` | `#3fbf7a`, `#5aa2f7`, `#e0a43a`, `#ef6060` |

Type: Geist Sans, falling back to the system face; 13 px body, line height 1.5, tabular
figures for every number. Corners 8 px on cards and tiles, 10 px on the hero.

### Motion

None of the deck's own. The host reveals the page (Clave's panel fades the deck in once
it has painted); an entrance animation inside the deck plays under that reveal and ends
mid-flight when the reader first sees it, which reads as a glitch. Nothing loops, nothing
pulses, nothing rises in.

### The rules a deck keeps

- Self-contained: one `index.html`, no request to the network, the data in the
  `slideless-data` block, read once at load.
- Escape every value the agent wrote before it goes into the page.
- Every word earns its place: no label that repeats the panel, no meta line nobody reads.
- Look at it rendered, in the panel, light and dark, with real data, a long headline and
  an empty list, before calling it done.
