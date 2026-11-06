/* The three drawings of the analytics pages, in Clave's hand (the design-deck
 * skill of the Clave plugin): the markup of page/drawings/*.svg without its
 * standalone stylesheet, since deck.css styles `.drawing` on the app's tokens.
 * Derived from those files by hand; drawings.test.ts keeps the two equal. */

export type DrawingKind = 'workspace' | 'group' | 'session'

export const DRAWINGS: Record<DrawingKind, string> = {
  workspace: `
  <!-- The workspace home: the groups as lanes, their sessions in the column of their state, one moving from working to needs you. -->
  <defs>
    <marker id="home-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="10" markerHeight="10" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
      <path class="head head--c" d="M1.5,1.5 L8,5 L1.5,8.5" />
    </marker>
  </defs>
  <!-- the board: three lanes (the groups), three columns (working, idle, needs you) -->
  <line class="ln ln--thin" x1="18" y1="132" x2="222" y2="132" />
  <rect class="bx" x="22" y="26" width="196" height="26" rx="8" />
  <rect class="bx bx--front" x="22" y="60" width="196" height="26" rx="8" />
  <rect class="bx" x="22" y="94" width="196" height="26" rx="8" />
  <line class="ln ln--soft" x1="96" y1="20" x2="96" y2="126" />
  <line class="ln ln--soft" x1="158" y1="20" x2="158" y2="126" />
  <!-- the sessions, seated in the column of their state -->
  <circle class="dot dot--seat" cx="48" cy="39" r="3.5" />
  <circle class="dot dot--seat" cx="64" cy="39" r="3.5" />
  <circle class="dot dot--seat" cx="124" cy="39" r="3.5" />
  <circle class="dot dot--seat" cx="118" cy="107" r="3.5" />
  <circle class="dot dot--seat" cx="134" cy="107" r="3.5" />
  <circle class="dot" cx="52" cy="73" r="4" />
  <circle class="dot dot--seat" cx="124" cy="73" r="3.5" />
  <!-- one session moves from working to needs-you: THE line -->
  <path class="ln ln--c travel" pathLength="1" d="M58,73 C90,56 150,56 176,70" marker-end="url(#home-head)" />
  <circle class="bx bx--front" cx="186" cy="73" r="9" />
  <circle class="ring" cx="186" cy="73" r="9" />
  <circle class="ring ring--pulse" cx="186" cy="73" r="9" />
  <circle class="dot dot--c" cx="186" cy="73" r="3.5" />
`,
  group: `
  <!-- A group: its sessions as rows of working blocks on one clock, now down the clock to the block at work. -->
  <defs>
    <marker id="group-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="10" markerHeight="10" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
      <path class="head head--c" d="M1.5,1.5 L8,5 L1.5,8.5" />
    </marker>
  </defs>
  <!-- the clock: the ground and its hour ticks -->
  <line class="ln ln--thin" x1="18" y1="132" x2="222" y2="132" />
  <line class="ln ln--thin" x1="40" y1="128" x2="40" y2="136" />
  <line class="ln ln--thin" x1="90" y1="128" x2="90" y2="136" />
  <line class="ln ln--thin" x1="140" y1="128" x2="140" y2="136" />
  <line class="ln ln--thin" x1="190" y1="128" x2="190" y2="136" />
  <!-- three sessions, each a row: its state dot, its working blocks on the clock -->
  <circle class="dot dot--seat" cx="26" cy="38" r="3" />
  <rect class="bx" x="38" y="32" width="38" height="12" rx="4" />
  <rect class="bx" x="104" y="32" width="22" height="12" rx="4" />
  <circle class="dot dot--seat" cx="26" cy="68" r="3" />
  <rect class="bx" x="52" y="62" width="58" height="12" rx="4" />
  <line class="ln ln--soft" x1="114" y1="68" x2="136" y2="68" />
  <rect class="bx bx--front" x="140" y="62" width="34" height="12" rx="4" />
  <circle class="dot dot--seat" cx="26" cy="98" r="3" />
  <rect class="bx" x="38" y="92" width="24" height="12" rx="4" />
  <rect class="bx" x="86" y="92" width="44" height="12" rx="4" />
  <!-- now: THE line, down the clock to the block at work -->
  <path class="ln ln--c travel" pathLength="1" d="M190,18 L190,50 C190,60 188,66 184,68" marker-end="url(#group-head)" />
  <line class="ln ln--soft" x1="190" y1="80" x2="190" y2="126" />
  <circle class="bx bx--front" cx="174" cy="68" r="9" />
  <circle class="ring" cx="174" cy="68" r="9" />
  <circle class="ring ring--pulse" cx="174" cy="68" r="9" />
  <circle class="dot dot--c" cx="174" cy="68" r="3.5" />
`,
  session: `
  <!-- A session: its working blocks on the clock, the wait dashed, the cost rising with the work. -->
  <defs>
    <marker id="session-head" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="10" markerHeight="10" orient="auto-start-reverse" markerUnits="userSpaceOnUse">
      <path class="head head--c" d="M1.5,1.5 L8,5 L1.5,8.5" />
    </marker>
  </defs>
  <!-- the clock the session ran on -->
  <line class="ln ln--thin" x1="18" y1="132" x2="222" y2="132" />
  <!-- its working blocks, the wait between them dashed -->
  <rect class="bx" x="26" y="110" width="40" height="14" rx="4" />
  <line class="ln ln--soft" x1="70" y1="117" x2="96" y2="117" />
  <rect class="bx" x="100" y="110" width="28" height="14" rx="4" />
  <rect class="bx bx--front" x="132" y="110" width="52" height="14" rx="4" />
  <!-- the cost, rising with the work and flat in the wait: THE line -->
  <path class="ln ln--c travel" pathLength="1" d="M26,100 L66,82 L100,82 L128,70 L176,40" marker-end="url(#session-head)" />
  <!-- the figures it adds up to: a card with two lines -->
  <rect class="bx" x="128" y="18" width="40" height="14" rx="4" />
  <line class="ln ln--thin" x1="134" y1="25" x2="160" y2="25" />
  <circle class="bx bx--front" cx="186" cy="34" r="9" />
  <circle class="ring" cx="186" cy="34" r="9" />
  <circle class="ring ring--pulse" cx="186" cy="34" r="9" />
  <circle class="dot dot--c" cx="186" cy="34" r="3.5" />
`
}
