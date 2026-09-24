/* List continuation in the composer: a new line inside a list item carries the
   list on, so the reader types the items and never the markers. "- a" then a
   new line gives "- "; "1. a" gives "2. "; a new line on an item that has no
   text ends the list, taking the empty marker with it. */

const ITEM = /^(\s*)(?:([-*+])|(\d+)([.)]))(\s+)(.*)$/

/** The draft after a new line at the caret, and where the caret lands; null
 *  when the caret is not on a list item, which leaves the new line to the
 *  textarea itself. */
export function continueList(
  text: string,
  start: number,
  end: number = start
): { text: string; caret: number } | null {
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  const line = text.slice(lineStart, start)
  const m = ITEM.exec(line)
  if (!m) return null
  const [, indent, bullet, number, delimiter, gap, rest] = m
  // The tail of a split item drops the space that separated it from the head.
  const after = text.slice(end).replace(/^[ \t]+/, '')
  // An empty item ends the list: the marker goes, the line stays blank.
  if (rest.trim() === '' && end === start) {
    const kept = text.slice(0, lineStart) + indent
    return { text: kept + after, caret: kept.length }
  }
  const marker = bullet ? bullet : `${Number(number) + 1}${delimiter}`
  const inserted = `\n${indent}${marker}${gap}`
  return { text: text.slice(0, start) + inserted + after, caret: start + inserted.length }
}
