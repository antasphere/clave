import type React from 'react'

/* The empty folio, in the hand of the drop card's drawings (`DropDrawing`,
   the `.chat-drawing` rules): an open book lying on its ground line. The left
   page holds the question, two short lines; the right page is where the
   answer will be written, its first lines ruled and waiting, three ticks in
   its margin for the work noted beside it. The accent goes ONCE, on the line
   being written, which draws itself as the page comes up and ends on the
   ringed dot of the pen. Still for a reader who asked for no motion. */
export function FolioDrawing(): React.JSX.Element {
  return (
    <svg viewBox="0 0 240 150" className="chat-drawing folio-drawing" aria-hidden="true">
      {/* the ground line */}
      <line className="ln ln--thin" x1="18" y1="134" x2="222" y2="134" />
      {/* the back page, a breath behind the spread */}
      <path
        className="bx"
        d="M40,26 H200 a4,4 0 0 1 4,4 V122 a4,4 0 0 1 -4,4 H40 a4,4 0 0 1 -4,-4 V30 a4,4 0 0 1 4,-4 Z"
      />
      {/* the left page: the question */}
      <path
        className="bx bx--front"
        d="M118,20 C100,16 70,16 46,22 a4,4 0 0 0 -3,4 V118 C66,112 98,112 118,118 Z"
      />
      <line className="ln" x1="58" y1="40" x2="104" y2="38" />
      <line className="ln ln--thin" x1="58" y1="50" x2="92" y2="49" />
      {/* the right page: the answer, ruled and waiting */}
      <path
        className="bx bx--front"
        d="M122,20 C140,16 170,16 194,22 a4,4 0 0 1 3,4 V118 C174,112 142,112 122,118 Z"
      />
      <line className="ln ln--soft" x1="134" y1="62" x2="168" y2="62" />
      <line className="ln ln--soft" x1="134" y1="74" x2="162" y2="74" />
      <line className="ln ln--soft" x1="134" y1="86" x2="166" y2="86" />
      {/* the margin's notes: what was done, beside what was written */}
      <line className="ln ln--thin" x1="176" y1="46" x2="186" y2="46" />
      <line className="ln ln--thin" x1="176" y1="62" x2="184" y2="62" />
      <line className="ln ln--thin" x1="176" y1="74" x2="186" y2="74" />
      {/* the gutter */}
      <line className="ln ln--thin" x1="120" y1="20" x2="120" y2="118" />
      {/* the one line being written, and the pen at its end */}
      <path className="ln ln--c travel" pathLength={1} d="M134,48 C142,46 150,47 160,46" />
      <circle className="bx bx--front" cx="166" cy="46" r="7" />
      <circle className="ring" cx="166" cy="46" r="7" />
      <circle className="ring ring--pulse" cx="166" cy="46" r="7" />
      <circle className="dot dot--c" cx="166" cy="46" r="2.8" />
    </svg>
  )
}
