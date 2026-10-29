/**
 * The two encodings the sign-in needs and the platform does not reliably
 * give: base64url (RFC 4648 §5, no padding) for the PKCE challenge and the
 * JWT segments, and UTF-8 for a token's JSON. Pure, so Hermes and Node run
 * the same code; `TextDecoder` is used when the runtime has it.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const VALUE_OF = new Map<string, number>([...ALPHABET].map((char, index) => [char, index]))

export function base64urlEncode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out +=
      ALPHABET[(n >> 18) & 63]! +
      ALPHABET[(n >> 12) & 63]! +
      ALPHABET[(n >> 6) & 63]! +
      ALPHABET[n & 63]!
  }
  if (i < bytes.length) {
    const second = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const n = (bytes[i]! << 16) | (second << 8)
    out += ALPHABET[(n >> 18) & 63]! + ALPHABET[(n >> 12) & 63]!
    if (i + 1 < bytes.length) out += ALPHABET[(n >> 6) & 63]!
  }
  return out
}

/** The bytes of a base64url text; throws on any character outside the
 *  alphabet, on padding, and on a length no byte sequence encodes to. */
export function base64urlDecode(text: string): Uint8Array {
  if (text.length % 4 === 1) throw new Error('not base64url: an impossible length')
  const out: number[] = []
  let buffer = 0
  let bits = 0
  for (const char of text) {
    const value = VALUE_OF.get(char)
    if (value === undefined) throw new Error('not base64url: a character outside the alphabet')
    buffer = ((buffer << 6) | value) & 0xffff
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out.push((buffer >> bits) & 0xff)
    }
  }
  return Uint8Array.from(out)
}

interface DecoderLike {
  decode(input: Uint8Array): string
}
type DecoderConstructor = new (label?: string, options?: { fatal?: boolean }) => DecoderLike

export function utf8Decode(bytes: Uint8Array): string {
  const Decoder = (globalThis as { TextDecoder?: DecoderConstructor }).TextDecoder
  if (Decoder) return new Decoder('utf-8', { fatal: true }).decode(bytes)
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const lead = bytes[i]!
    let code: number
    let extra: number
    if (lead < 0x80) {
      code = lead
      extra = 0
    } else if ((lead & 0xe0) === 0xc0) {
      code = lead & 0x1f
      extra = 1
    } else if ((lead & 0xf0) === 0xe0) {
      code = lead & 0x0f
      extra = 2
    } else if ((lead & 0xf8) === 0xf0) {
      code = lead & 0x07
      extra = 3
    } else throw new Error('not utf-8')
    if (i + extra >= bytes.length) throw new Error('not utf-8: a truncated sequence')
    for (let k = 1; k <= extra; k++) {
      const next = bytes[i + k]!
      if ((next & 0xc0) !== 0x80) throw new Error('not utf-8: a bad continuation byte')
      code = (code << 6) | (next & 0x3f)
    }
    out += String.fromCodePoint(code)
    i += extra + 1
  }
  return out
}

/** The bytes of an ASCII text (a PKCE verifier, a state): anything else is refused. */
export function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code > 0x7f) throw new Error('not ascii')
    out[i] = code
  }
  return out
}
