/* Where a reading stands on its page (PRDCT-4430): the parts the voice
   speaks mapped to the page's blocks, the bar's ticks (one per block), how
   much of it is filled, which tick sits under the pointer, and the time as
   the bar shows it. Pure, so a test pins it without a voice or a DOM. */
import type { SpeechPart } from './audio'

/** The blocks a reading's parts read, in order, each once: one tick each.
 *  A rendering without blocks has one tick, block 0. */
export function partTicks(parts: SpeechPart[]): number[] {
  const ticks: number[] = []
  for (const part of parts) if (ticks.at(-1) !== part.block) ticks.push(part.block)
  return ticks
}

/** Where part `at` is: the page block to light (null for block 0, a
 *  rendering filed before the blocks), its tick, and how much of its block
 *  is read once `partFraction` of the part is (a block in several parts
 *  counts each part as an equal share). */
export function partPlace(
  parts: SpeechPart[],
  at: number,
  partFraction = 0
): { block: number | null; tick: number; fraction: number } {
  const part = parts[at]
  if (!part) return { block: null, tick: 0, fraction: 0 }
  const tick = partTicks(parts.slice(0, at + 1)).length - 1
  let first = at
  while (first > 0 && parts[first - 1].block === part.block) first--
  let last = at
  while (last + 1 < parts.length && parts[last + 1].block === part.block) last++
  const share = Math.max(0, Math.min(1, partFraction))
  return {
    block: part.block > 0 ? part.block : null,
    tick,
    fraction: (at - first + share) / (last - first + 1)
  }
}

/** The part a reading starts at for page block `n`: the first part of that
 *  block, or of the next block that has one (a block with nothing to say has
 *  no part); -1 past the last. Block 0 is the first part. */
export function partFor(parts: SpeechPart[], n: number): number {
  return parts.findIndex((part) => part.block >= n)
}

/** How much of the bar is filled: the ticks read, and the share of the one
 *  in play. 0 to 1. */
export function scrubFill(tick: number, ticks: number, fraction: number): number {
  if (ticks <= 0) return 0
  return Math.max(0, Math.min(1, (tick + Math.max(0, Math.min(1, fraction))) / ticks))
}

/** What the bar shows: the reading's own tick and fill, or, while a drag is
 *  in progress, the tick under the pointer, filled to its start. A drag
 *  moves only this light; the reading moves once, where the drag ends
 *  (`dragSeek`). Pure. */
export function scrubShown(
  tick: number,
  fraction: number,
  ticks: number,
  dragTick: number | null
): { tick: number; fill: number } {
  if (dragTick === null) return { tick, fill: scrubFill(tick, ticks, fraction) }
  return { tick: dragTick, fill: scrubFill(dragTick, ticks, 0) }
}

/** The tick a press on the bar seeks once it is let go (a click, or the end
 *  of a drag): the tick it ended on, or null for none (no press, or the tick
 *  already in play). Each seek asks the server for a part, so a drag across
 *  the bar seeks once, never once per tick crossed. Pure. */
export function dragSeek(dragTick: number | null, current: number): number | null {
  return dragTick === null || dragTick === current ? null : dragTick
}

/** The tick under the pointer, `x` pixels into a bar `width` wide. */
export function tickAt(x: number, width: number, ticks: number): number {
  if (ticks <= 0 || width <= 0) return 0
  return Math.max(0, Math.min(ticks - 1, Math.floor((x / width) * ticks)))
}

/** A time as the bar shows it: m:ss, or –:–– while unknown. */
export function clockOf(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '–:––'
  const seconds = Math.floor(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
