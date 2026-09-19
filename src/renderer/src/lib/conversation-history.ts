/** Measure visual lines too: a long wrapped paragraph must keep normal arrow movement. */
export function isHistoryBoundary(
  input: HTMLTextAreaElement,
  direction: 'older' | 'newer'
): boolean {
  if (input.selectionStart !== input.selectionEnd) return false
  const position = input.selectionStart
  if (!input.value || (direction === 'older' ? position === 0 : position === input.value.length))
    return true
  const style = getComputedStyle(input)
  const mirror = document.createElement('div')
  mirror.className = 'conversation-caret-measure'
  for (const property of [
    'fontFamily',
    'fontSize',
    'fontWeight',
    'fontStyle',
    'lineHeight',
    'letterSpacing',
    'wordSpacing',
    'textIndent',
    'tabSize',
    'paddingTop',
    'paddingRight',
    'paddingBottom',
    'paddingLeft',
    'wordBreak',
    'overflowWrap'
  ] as const) {
    mirror.style[property] = style[property]
  }
  mirror.style.width = `${input.clientWidth}px`
  const start = document.createElement('span')
  const caret = document.createElement('span')
  const end = document.createElement('span')
  start.textContent = caret.textContent = end.textContent = '\u200b'
  mirror.append(start, input.value.slice(0, position), caret, input.value.slice(position), end)
  document.body.append(mirror)
  try {
    const boundary = direction === 'older' ? start : end
    return Math.abs(caret.getBoundingClientRect().top - boundary.getBoundingClientRect().top) < 1
  } finally {
    mirror.remove()
  }
}
