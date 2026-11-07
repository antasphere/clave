import { useTrafficLights } from '../../hooks/use-traffic-lights'

/**
 * "Clave", beside the traffic lights: the app's one mark, and the only thing
 * in it not set in Geist. It carried a "by Antasphere" attribution until
 * 2026-11-07, removed on the product owner's ask; the notes below still name
 * the attribution where they explain the shared frame its paths were drawn in.
 *
 * OUTLINES, NOT A FONT — and that is a licence decision, not a nicety. The face
 * is Sentient, Fontshare's, under the ITF Free Font Licence: free to use,
 * including in a logo, and NOT free to redistribute as a file. Clave is a public
 * repo that ships a packaged app through GitHub Releases, so a bundled .woff2
 * inside the asar would be redistribution. An outline is drawing, not type, so
 * the wordmark travels and the licence stays where it belongs. Same call, same
 * reasoning, as the website's outlined "Antasphere" (company/website,
 * src/brand/assets.ts) — read that file before changing this one.
 *
 * ⚠️ Do NOT reintroduce a Sentient @font-face to "make it easier to edit". The
 * strings are fixed; if one ever has to change, rebuild the path.
 *
 * Two weights, on purpose: "Clave" is Sentient REGULAR 400 and the attribution
 * is LIGHT 300 at 62% of its size, which is also the weight the house sets its own
 * "Antasphere" in. The name is the mark; the attribution is a whisper under it.
 *
 * ── One frame, two boxes ────────────────────────────────────────────────────
 *
 * Both SVGs are drawn in ONE vertical frame (905 units tall) with the
 * baseline in the same place, and both are given the same CSS height. So the
 * two sit on one baseline because their boxes do — no vertical nudge in the
 * stylesheet, nothing to re-solve when the size changes. The frame is Clave's
 * ink (761 units) plus the depth the attribution's y and p drop below the
 * baseline; that is why the Clave box has empty air under it, and why
 * `--wordmark-h` (Clave's INK height, what has to land on the traffic lights'
 * centre line) is multiplied by 1.1892 to get the box height. See main.css.
 *
 * How the paths were outlined, for the day they must be rebuilt:
 *  - source: the `--font-display` woff2 the Astro Fonts API downloads to
 *    company/website/apps/website/.astro/fonts/ — font-display-400-normal-*
 *    for "Clave", font-display-300-normal-* for the attribution. The files are
 *    NOT kept in this repo; fetch them there, outline, and throw them away.
 *  - glyphs: fontTools SVGPathPen over the glyph set, one pen per glyph.
 *  - advances: hmtx, plus the 0.005em tracking the design carries, plus the
 *    GPOS kern pairs that actually apply to these words — a/v −20 and v/e −28
 *    in "Clave" at 400, b/y −18 and r/e −18 in the attribution at 300. Skip
 *    them and the words come out tens of units wide of what a browser shapes.
 *  - transform: Transform(1, 0, 0, −1, …) — font units are Y-up, SVG is Y-down
 *    — landing each word's baseline on the shared frame's baseline, y = 761.
 *  - boxes: ink bounds, quadratic extrema included — 2519 × 761 for "Clave",
 *    4214 wide for the attribution, both in a 905-tall frame.
 */
export function Wordmark(): React.ReactElement {
  return (
    <svg
      className="wordmark"
      viewBox="0 0 2519 905"
      role="img"
      aria-label="Clave"
      focusable="false"
    >
      <path
        d="M352 760Q187 760 93.5 667.5Q0 575 0 413Q0 251 94.5 153Q189 55 348 55Q459 55 572 104L586 261H558L512 193Q453 108 344 108Q242 108 176.5 193.5Q111 279 111 410Q111 543 178.5 623.5Q246 704 358 704Q495 704 569 550H597L576 694Q540 724 478.5 742Q417 760 352 760ZM930 750H677V724L717 709Q739 700 747 688.5Q755 677 755 653V153Q755 123 746 110Q737 97 716 92L679 84V58L829 0L853 14V653Q853 678 860.5 689Q868 700 890 709L930 724ZM1165 760Q1095 760 1052.5 722Q1010 684 1010 621Q1010 519 1134 477Q1202 454 1306 449V420Q1306 287 1212 287Q1169 287 1141 305Q1117 321 1092 393H1056L1026 304Q1124 238 1224 238Q1318 238 1361 281Q1404 324 1404 422V628Q1404 654 1412.5 665Q1421 676 1446 679L1482 683L1487 709L1357 760H1335L1310 686Q1284 720 1244.5 740Q1205 760 1165 760ZM1203 690Q1261 690 1306 640V490Q1241 493 1199 505Q1112 529 1112 605Q1112 644 1137 667Q1162 690 1203 690ZM1800 735 1743 761 1560 343Q1549 318 1540.5 308Q1532 298 1513 288L1485 274V248H1731V274L1703 283Q1665 294 1665 316Q1665 325 1672 342L1793 628L1913 342Q1920 325 1920 316Q1920 295 1882 283L1853 274V248H2047V274L2014 290Q1984 306 1969 342ZM2308 760Q2197 760 2133 692.5Q2069 625 2069 501Q2069 390 2135.5 314Q2202 238 2303 238Q2399 238 2457.5 297Q2516 356 2519 463V485H2175V498Q2175 593 2220.5 644Q2266 695 2347 695Q2419 695 2483 650L2507 681Q2425 760 2308 760ZM2178 439 2419 436Q2417 367 2386.5 326Q2356 285 2305 285Q2254 285 2221 325.5Q2188 366 2178 439Z"
        fill="currentColor"
      />
    </svg>
  )
}

/**
 * The strip the lockup lives in: the top band of whichever sidebar is showing.
 *
 * ONE component for all three sidebars — sessions, Settings, Extensions — and
 * that is the point. Settings and Extensions replace the sessions sidebar
 * wholesale, and each used to open with a bare 48px drag spacer, so stepping
 * into Settings made the app's only mark disappear and put the panel 2px out of
 * step with the list it replaced. The band is the same band whatever is under
 * it, so it is one thing.
 *
 * It is also the app's draggable top chrome, which is why the height is
 * `--content-top-offset` rather than a number: the toolbar's row height is a
 * token, and the first card in the content column starts at that offset, so
 * whatever the sidebar's first panel is lands on the terminal cards' top edge.
 *
 * The left padding is the traffic lights' business. On macOS they are placed at
 * x=16, y=18 (src/main/index.ts) and run about 52px wide by 12px tall — centre
 * line y=24, last edge 68px — so the mark starts at 90px, 22px clear. It used
 * to start at 84px, 16px past, which is the window gutter's own width and read
 * as the mark being crowded against the buttons rather than standing apart from
 * them: same-size gaps say "same row of things", and the mark is not one of the
 * buttons. 22px is a nudge, not a step: enough to break that row, short of the
 * mark looking parked in the middle of the strip.
 *
 * Whenever there are NO traffic lights over the strip that clearance is a hole,
 * and the mark takes the position the first button would have had instead —
 * 16px, the same x they are placed at, the window's own gutter and enough air
 * that the mark is not sitting on the edge. Two ways for them to be absent,
 * which is why this asks useTrafficLights() rather than fullscreen alone: macOS
 * takes them away in FULLSCREEN, and on Windows and Linux they were never there
 * — those windows keep a native frame and draw their controls above our
 * content, so clearance held there is a hole from the first paint.
 *
 * `pointer-events: none` over the lockup keeps the whole strip draggable — the
 * mark is a mark, not a target.
 */
export function WordmarkStrip(): React.ReactElement {
  const trafficLights = useTrafficLights()
  return (
    <div
      className="wordmark-strip flex-shrink-0 flex items-center"
      data-wordmark-strip
      data-traffic-lights={trafficLights ? 'true' : 'false'}
      style={
        {
          height: 'var(--content-top-offset)',
          paddingLeft: trafficLights ? '90px' : '16px',
          // Optical, not geometric. The lockup's box is 905 frame units deep
          // against Clave's 761 of ink — the rest is descender room the
          // attribution's y and p need and the name never uses — so the ink's
          // mass sits 1.3px above the middle of its own box. Centre the box
          // and you centre the wrong thing: the mark read high in the strip
          // for as long as it has existed. 3px of top padding buys the
          // descender back and lands Clave's ink centre on 25px, the middle
          // of the 50px band the launcher panel starts under.
          paddingTop: '3px',
          WebkitAppRegion: 'drag'
        } as React.CSSProperties
      }
    >
      <span className="wordmark-lockup" style={{ pointerEvents: 'none' }}>
        <Wordmark />
      </span>
    </div>
  )
}
