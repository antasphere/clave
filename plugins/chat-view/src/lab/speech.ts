/* Reading a page aloud: what an answer sounds like once its markdown is taken
   out, cut into the short utterances speech synthesis reads reliably (a long
   one is cut off or never ends in Chromium). Pure, so a test can hear it. */

/** An answer as it should be spoken: prose only. A code block is named, not
 *  read character by character; a link reads its words; a bare address reads
 *  as "a link"; list and heading marks and emphasis go. */
export function speakable(markdown: string): string {
  return (
    markdown
      .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, '\n(A code block.)\n')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/<?https?:\/\/[^\s)>]+>?/g, 'a link')
      .replace(/`([^`]+)`/g, '$1')
      // Table rules and pipes, then the marks a line opens with.
      .replace(/^\s*\|?\s*:?-{3,}.*$/gm, '')
      .replace(/\|/g, ', ')
      .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
      .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, '$2')
      .replace(/^\s*(?:-{3,}|\*{3,})\s*$/gm, '')
      // A line that ends without a stop still ends a thought when spoken.
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => (/[.?!:;,)]$/.test(line) ? line : `${line}.`))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

export const CHUNK_MAX = 220

/** The text as utterances of at most `max` characters, cut between
 *  sentences, then between clauses, then between words. */
export function speechChunks(text: string, max = CHUNK_MAX): string[] {
  const sentences = text.match(/[^.?!]+(?:[.?!]+["')\]]*|$)\s*/g) ?? []
  const chunks: string[] = []
  let current = ''
  const flush = (): void => {
    if (current.trim()) chunks.push(current.trim())
    current = ''
  }
  const pieces = sentences.flatMap((sentence) =>
    sentence.length <= max ? [sentence] : split(sentence, max)
  )
  for (const piece of pieces) {
    if ((current + piece).trim().length > max) flush()
    current += piece
  }
  flush()
  return chunks
}

function split(sentence: string, max: number): string[] {
  const out: string[] = []
  let rest = sentence.trim()
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const clause = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '))
    const space = window.lastIndexOf(' ')
    const at = clause > max * 0.4 ? clause + 1 : space > 0 ? space : max
    out.push(rest.slice(0, at).trim() + ' ')
    rest = rest.slice(at).trim()
  }
  if (rest) out.push(rest + ' ')
  return out
}
