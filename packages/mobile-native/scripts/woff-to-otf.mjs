/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS, run by node and imported by a vitest */
// WOFF 1.0 → the sfnt it wraps (OTF or TTF), in plain Node. A WOFF is the
// font's own tables, each zlib-deflated when that made it smaller, behind a
// header and a directory; unwrapping it inflates every table and lays them
// out again behind a standard sfnt offset table. No glyph is touched, and
// the checksums are the ones the WOFF directory recorded for the original.
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'

const WOFF_HEADER = 44
const WOFF_ENTRY = 20
const SFNT_HEADER = 12
const SFNT_RECORD = 16

const pad4 = (n) => (n + 3) & ~3

/** The sfnt a WOFF 1.0 file wraps, as a Buffer. */
export function woffToOtf(woffBytes) {
  const woff = Buffer.from(woffBytes.buffer, woffBytes.byteOffset, woffBytes.byteLength)
  if (woff.length < WOFF_HEADER || woff.toString('latin1', 0, 4) !== 'wOFF')
    throw new Error('woff-to-otf: not a WOFF 1.0 file (bad signature)')
  const flavor = woff.readUInt32BE(4)
  const numTables = woff.readUInt16BE(12)
  if (woff.length < WOFF_HEADER + numTables * WOFF_ENTRY)
    throw new Error('woff-to-otf: truncated table directory')

  const tables = []
  for (let i = 0; i < numTables; i++) {
    const at = WOFF_HEADER + i * WOFF_ENTRY
    const tag = woff.readUInt32BE(at)
    const offset = woff.readUInt32BE(at + 4)
    const compLength = woff.readUInt32BE(at + 8)
    const origLength = woff.readUInt32BE(at + 12)
    const origChecksum = woff.readUInt32BE(at + 16)
    const name = woff.toString('latin1', at, at + 4)
    if (offset + compLength > woff.length)
      throw new Error(`woff-to-otf: table ${name} is truncated`)
    const raw = woff.subarray(offset, offset + compLength)
    const data = compLength < origLength ? inflateSync(raw) : raw
    if (data.length !== origLength)
      throw new Error(
        `woff-to-otf: table ${name} is ${data.length} bytes, the directory says ${origLength}`
      )
    tables.push({ tag, origChecksum, data })
  }

  const entrySelector = numTables > 0 ? Math.floor(Math.log2(numTables)) : 0
  const searchRange = 16 * 2 ** entrySelector
  const rangeShift = numTables * 16 - searchRange
  let size = SFNT_HEADER + numTables * SFNT_RECORD
  for (const t of tables) size += pad4(t.data.length)

  const out = Buffer.alloc(size)
  out.writeUInt32BE(flavor, 0)
  out.writeUInt16BE(numTables, 4)
  out.writeUInt16BE(searchRange, 6)
  out.writeUInt16BE(entrySelector, 8)
  out.writeUInt16BE(rangeShift, 10)
  let offset = SFNT_HEADER + numTables * SFNT_RECORD
  tables.forEach((t, i) => {
    const at = SFNT_HEADER + i * SFNT_RECORD
    out.writeUInt32BE(t.tag, at)
    out.writeUInt32BE(t.origChecksum, at + 4)
    out.writeUInt32BE(offset, at + 8)
    out.writeUInt32BE(t.data.length, at + 12)
    t.data.copy(out, offset)
    offset += pad4(t.data.length)
  })
  return out
}

/** Lowercase hex SHA-256 of some bytes. */
export function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}
