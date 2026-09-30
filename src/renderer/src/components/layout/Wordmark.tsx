import { useTrafficLights } from '../../hooks/use-traffic-lights'

/**
 * "Clave by Antasphere", beside the traffic lights. The one piece of the
 * Antasphere identity in the app, and the only thing in it not set in Geist.
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
 * "by Antasphere", the second half of the lockup — and the way out to the
 * house's own site.
 *
 * Two SVGs here rather than one, because the two words do different jobs: "by"
 * is a preposition and the company name is a LINK, and a link wants its own
 * element to be hit, hovered and labelled. The button carries the name for a
 * screen reader and the drawing inside it is hidden, or the word is announced
 * twice. Splitting them at the space costs
 * the space itself, since each box is cropped to its own ink — so the phrase's
 * own word space (160 units of the shared frame, 0.2102 of Clave's ink) comes
 * back as the flex gap in main.css. Everything else is unchanged: same frame,
 * same baseline, same CSS height as "Clave", so the three still sit on one line
 * because their boxes do.
 *
 * The name is a real button, because the strip it sits in is a window DRAG
 * region with `pointer-events: none` over it — the mark is a mark, not a
 * target. `.wordmark-link` opts back out of both; without either half a click
 * lands on the window and drags it.
 */

/** The house, with the app named as the source.
 *
 *  `clave-app` and not `clave`: the source names the SURFACE a visit came from,
 *  and the house has more than one thing called Clave pointing at it — the
 *  website and the plugin among them. Retagged deliberately, on the product
 *  owner's ask, and worth the series break it costs: everything before this
 *  reads `clave`, so a chart spanning the change has two lines to add up.
 *  `tests/e2e/sidebar-foot.spec.mjs` pins the value, which is what makes this a
 *  decision rather than a typo — change one and the other fails. */
export const ANTASPHERE_URL = 'https://antasphere.com/?utm_source=clave-app'

export function WordmarkBy(): React.ReactElement {
  return (
    <span className="wordmark-by">
      <svg className="wordmark" viewBox="0 0 693 905" role="img" aria-label="by" focusable="false">
        <path
          d="M170.5 756.2Q127.1 756.2 91.8 734.5L60.1 750L48.4 742.6V366.8Q48.4 349.5 42.8 341.7Q37.2 334.0 24.2 332.1L0 329.0V315.4L80.0 285L92.4 292.4V484.0Q136.4 433.2 194.7 433.2Q252.3 433.2 288.9 475.0Q325.5 516.9 325.5 583.2Q325.5 663.2 284.0 709.7Q242.4 756.2 170.5 756.2ZM171.7 732.0Q218.9 732.0 248 694.5Q277.1 657 277.1 597.5Q277.1 538.0 250.5 502.9Q223.8 467.9 178.6 467.9Q127.1 467.9 92.4 513.2V667.5Q94.2 696.7 115.9 714.3Q137.6 732.0 171.7 732.0ZM425.9 905 391.8 874 398.0 861.6Q460.7 852.3 509.0 748.1L401.1 494.6Q394.3 479.1 389.1 472.2Q383.8 465.4 373.2 461.1L353.4 453.0V439.4H489.8V453.0L471.8 458.6Q446.4 464.8 446.4 478.4Q446.4 485.3 450.1 493.3L533.8 694.8L616.3 493.3Q620 482.8 620 478.4Q620 464.8 594.6 458.6L576.6 453.0V439.4H693.2V453.0L672.1 461.7Q661.5 466.7 656.0 472.9Q650.4 479.1 644.2 494.6L539.4 743.8Q481.7 880.2 425.9 905Z"
          fill="currentColor"
        />
      </svg>
      <button
        type="button"
        className="wordmark-link"
        aria-label="Antasphere"
        title="antasphere.com"
        onClick={() => window.electronAPI?.openExternal(ANTASPHERE_URL)}
      >
        <svg className="wordmark" viewBox="0 0 3361 905" aria-hidden="true" focusable="false">
          <path
            d="M129.6 750H-0.0V735.7L23.6 726.4Q37.8 720.9 43.1 715.9Q48.4 710.9 53.3 697.9L194.1 330.3L230.0 319.1L376.3 698.5Q381.9 711.6 386.6 716.2Q391.2 720.9 406.1 726.4L429.0 735.7V750H281.5V735.7L301.9 727.7Q328.0 719 328.0 709.1Q328.0 704.7 324.3 695.4L295.7 620.4H114.1L86.2 694.2Q81.8 707.2 81.8 709.1Q81.8 714.0 86.8 718.1Q91.8 722.1 108.5 727.7L129.6 735.7ZM202.7 380.5 124.0 593.1H284.6ZM599.5 750H456.9V736.4L483.0 728.3Q496.6 723.3 501.6 716.5Q506.5 709.7 506.5 696.1V518.7Q506.5 501.4 500.6 492.7Q494.8 484.0 481.7 482.2L457.6 479.1V466.7L533.8 433.2L546.2 440.6V503.2Q567.9 470.4 598.6 451.8Q629.3 433.2 662.8 433.2Q711.8 433.2 740.0 464.2Q768.2 495.2 768.2 548.5V696.1Q768.2 709.7 773.1 716.5Q778.1 723.3 791.7 728.3L817.8 736.4V750H675.2V736.4L701.8 728.3Q714.9 723.3 719.5 716.8Q724.2 710.3 724.2 696.1V559.0Q724.2 516.3 704.6 493.6Q685.1 471 647.9 471Q620.6 471 594.6 485.6Q568.5 500.1 550.6 525.6V696.1Q550.6 710.3 555.2 716.8Q559.9 723.3 572.9 728.3L599.5 736.4ZM978.4 756.2Q938.1 756.2 919.8 733.9Q901.5 711.6 901.5 658.9V467.3H853.7V445.6L902.7 437.5L933.1 355.1L945.5 361.9V439.4H1048.4V467.3H945.5V653.3Q945.5 692.3 957.6 708.5Q969.7 724.6 997.0 724.6Q1023.6 724.6 1053.4 710.9L1059.0 728.3Q1024.2 756.2 978.4 756.2ZM1196.0 756.2Q1152.6 756.2 1126.5 732.6Q1100.5 709.1 1100.5 670.0Q1100.5 604.9 1180.5 578.9Q1216.4 567.1 1285.3 564V543.5Q1285.3 458.6 1221.4 458.6Q1194.1 458.6 1174.9 469.1Q1158.8 478.4 1143.3 525.6H1126.5L1109.8 472.9Q1168.7 433.2 1226.4 433.2Q1280.3 433.2 1304.8 458.9Q1329.3 484.6 1329.3 544.2V681.8Q1329.3 699.2 1334.9 706.6Q1340.4 714.0 1354.1 714.7L1377.6 715.9L1380.1 729.5L1313.2 756.2H1301.4L1287.1 711.6Q1270.4 732.0 1245.9 744.1Q1221.4 756.2 1196.0 756.2ZM1212.1 722.7Q1251.8 722.7 1285.3 687.4V585.7Q1234.4 587.6 1207.1 595.6Q1147 612.4 1147 663.8Q1147 691.1 1164.7 706.9Q1182.3 722.7 1212.1 722.7ZM1540.7 756.2Q1476.2 756.2 1432.2 722.7L1438.4 657H1452.7L1465.1 686.8Q1475.0 707.2 1495.8 719.3Q1516.5 731.4 1542.6 731.4Q1574.2 731.4 1593.7 716.2Q1613.2 701.0 1613.2 675.6Q1613.2 653.3 1595.9 637.5Q1578.5 621.7 1532.6 603.1Q1483.7 583.8 1461.3 561.8Q1439.0 539.8 1439.0 511.3Q1439.0 476.6 1468.2 454.9Q1497.3 433.2 1544.4 433.2Q1594.0 433.2 1642.4 454.9L1636.2 516.3H1621.9Q1609.5 491.5 1600.2 481.5Q1580.4 458.0 1543.8 458.0Q1515.9 458.0 1498.5 470.4Q1481.2 482.8 1481.2 502.6Q1481.2 521.2 1498.5 535.5Q1515.9 549.7 1560.5 569.0Q1656.0 608.6 1656.0 665.7Q1656.0 706.6 1624.4 731.4Q1592.8 756.2 1540.7 756.2ZM1855.7 898.8H1701.3V885.2L1727.3 877.1Q1741.0 872.8 1746.2 865.9Q1751.5 859.1 1751.5 844.9V518.7Q1751.5 485.9 1727.3 482.2L1702.5 479.1V466.7L1779.4 433.2L1791.2 440.6V489.0Q1838.3 433.2 1897.8 433.2Q1955.5 433.2 1992.1 475.0Q2028.6 516.9 2028.6 583.2Q2028.6 663.2 1987.1 709.7Q1945.6 756.2 1873.6 756.2Q1827.8 756.2 1795.5 732.6V844.9Q1795.5 858.5 1801.4 864.4Q1807.3 870.3 1829 877.1L1855.7 885.2ZM1874.9 732.0Q1922 732.0 1951.1 694.5Q1980.3 657 1980.3 597.5Q1980.3 537.3 1953.6 502.3Q1927.0 467.3 1881.7 467.3Q1830.9 467.3 1795.5 513.2V666.9Q1797.4 696.1 1819.1 714.0Q1840.8 732.0 1874.9 732.0ZM2230.1 750H2087.5V736.4L2113.6 728.3Q2127.2 723.3 2132.2 716.5Q2137.1 709.7 2137.1 696.1V366.8Q2137.1 350.1 2131.2 342.0Q2125.4 334.0 2112.3 332.1L2088.2 329.0V315.4L2168.8 285L2181.2 292.4V496.4Q2202.9 466.7 2232.3 449.9Q2261.8 433.2 2293.4 433.2Q2342.4 433.2 2370.6 463.9Q2398.8 494.6 2398.8 547.9V696.1Q2398.8 709.7 2403.7 716.5Q2408.7 723.3 2422.3 728.3L2448.4 736.4V750H2305.8V736.4L2332.4 728.3Q2345.5 723.3 2350.1 716.8Q2354.8 710.3 2354.8 696.1V558.4Q2354.8 516.3 2335.2 493.6Q2315.7 471 2278.5 471Q2251.2 471 2225.2 485.6Q2199.1 500.1 2181.2 525.6V696.1Q2181.2 710.3 2185.8 716.8Q2190.5 723.3 2203.5 728.3L2230.1 736.4ZM2644.9 756.2Q2578.0 756.2 2539.5 714.7Q2501.1 673.1 2501.1 595.6Q2501.1 527.4 2540.4 480.3Q2579.8 433.2 2640.0 433.2Q2695.8 433.2 2731.4 469.1Q2767.1 505.1 2769.5 570.8V584.5H2548.2V595Q2548.2 656.4 2578.0 690.5Q2607.7 724.6 2658.6 724.6Q2709.4 724.6 2749.1 694.2L2760.9 709.7Q2711.3 756.2 2644.9 756.2ZM2550.7 560.3 2723.7 558.4Q2721.8 513.8 2699.5 485.9Q2677.2 458.0 2641.2 458.0Q2605.2 458.0 2581.4 485.6Q2557.5 513.2 2550.7 560.3ZM2980.3 750H2826.6V736.4L2852.6 728.3Q2866.3 723.3 2871.2 716.5Q2876.2 709.7 2876.2 696.1V518.7Q2876.2 485.9 2851.4 482.2L2827.2 479.1V466.7L2903.5 433.2L2915.9 440.6V500.8Q2948.1 433.2 3000.8 433.2Q3028.1 433.2 3054.1 452.4L3048.5 509.4H3034.9Q3023.7 487.7 3013.5 479.4Q3003.3 471 2987.8 471Q2969.8 471 2951.8 485.6Q2933.8 500.1 2920.2 525.6V696.1Q2920.2 709.7 2926.1 715.6Q2932.0 721.5 2953.7 728.3L2980.3 736.4ZM3236.4 756.2Q3169.4 756.2 3131 714.7Q3092.6 673.1 3092.6 595.6Q3092.6 527.4 3131.9 480.3Q3171.3 433.2 3231.4 433.2Q3287.2 433.2 3322.9 469.1Q3358.5 505.1 3361.0 570.8V584.5H3139.7V595Q3139.7 656.4 3169.4 690.5Q3199.2 724.6 3250.0 724.6Q3300.9 724.6 3340.6 694.2L3352.3 709.7Q3302.7 756.2 3236.4 756.2ZM3142.2 560.3 3315.1 558.4Q3313.3 513.8 3291.0 485.9Q3268.6 458.0 3232.7 458.0Q3196.7 458.0 3172.9 485.6Q3149.0 513.2 3142.2 560.3Z"
            fill="currentColor"
          />
        </svg>
      </button>
    </span>
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
 * mark is a mark, not a target. The house's name opts back out of that in
 * `.wordmark-link`, because it is the one thing here that IS a target.
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
        <WordmarkBy />
      </span>
    </div>
  )
}
