import { useEffect, useRef, useState } from 'react'
import { PauseIcon, PlayIcon, StopIcon } from '@heroicons/react/24/outline'
import { LOCAL_SERVER_ID } from '@clave/contract/fleet'
import {
  loadIntegrations,
  useIntegrationsStore
} from '../../../../src/renderer/src/store/integrations-store'
import { ownerOf } from '../../../../src/renderer/src/lib/fleet-identity'
import type { Page } from './pages'
import { FolioLoader } from './PageTitle'
import type { Reading, useReadAloud } from './read-aloud'
import { clockOf, dragSeek, KEY_SEEK_MS, keySeekTarget, scrubShown, tickAt } from './progress'
import { fallbackLine, spokenKeyOf, useSpokenState } from './spoken'
import { macVoiceLine, stepSeconds, voiceCardState, voiceSource } from './voice-card'

/* The voice card (PRDCT-4430, PRDCT-4411): the one place a person reads and
   drives a page's reading, in the page's margin at its head, above the notes.
   It says which voice will read before a click, then each step as it runs
   (the answer rewritten for the voice, the voice created), then the player
   (play and pause, stop, the block, the bar, the time), and why when the
   Mac's voice reads. Every state is on the card (`data-voice-state`) and
   every step (`data-step`), for the specs. */

/** The card's figure: the Integrations card's (`VoiceDrawing`, a page, the
 *  line being read, the voice leaving it as a wave to the ringed dot where it
 *  is heard) drawn again at the margin's size, and made to say the step: the
 *  pen goes over the line while it is rewritten, the wave draws itself while
 *  the voice is created, and breathes while it plays; still otherwise, and
 *  still for a reader who asked for no motion. */
function VoiceFigure(): React.JSX.Element {
  return (
    <svg viewBox="0 0 88 40" className="chat-drawing folio-voice-figure" aria-hidden="true">
      <line className="ln ln--thin" x1="1" y1="38" x2="87" y2="38" />
      <rect className="bx" x="7" y="2" width="22" height="31" rx="3" />
      <rect className="bx bx--front" x="3" y="5" width="22" height="31" rx="3" />
      <line className="ln" x1="7.5" y1="12" x2="19" y2="12" />
      <line className="ln folio-voice-read" x1="7.5" y1="18" x2="17" y2="18" />
      <path
        className="ln ln--c folio-voice-pen"
        pathLength={1}
        d="M7.5,18.5 C9.5,16.5 11,19.5 13,17.5 S16,17 17.5,18"
      />
      <line className="ln ln--thin" x1="7.5" y1="24" x2="20" y2="24" />
      <line className="ln ln--soft" x1="7.5" y1="30" x2="14" y2="30" />
      <path
        className="ln ln--c folio-voice-wave"
        pathLength={1}
        d="M19,18 C22,18 23,12 26,12 S30,24 34,24 S38,13 42,13 S46,22 50,22 S54,18 58,18"
      />
      <circle className="bx bx--front" cx="64" cy="18" r="5" />
      <circle className="ring" cx="64" cy="18" r="5" />
      <circle className="ring ring--pulse folio-voice-pulse" cx="64" cy="18" r="5" />
      <circle className="dot dot--c" cx="64" cy="18" r="2" />
      <path className="ln ln--thin" d="M73,11.5 C75.5,15 75.5,21 73,24.5" />
      <path className="ln ln--soft" d="M78,7.5 C82,13 82,23 78,28.5" />
    </svg>
  )
}

/** The bar of the reading (PRDCT-4430): one tick per block, the part read
 *  filled; a click goes to the block under the pointer, a drag moves the
 *  light with the pointer and goes to the block it is let go on (one seek,
 *  one part asked: never one per tick crossed); the time read and the
 *  whole, once known. */
function Scrub({
  reading,
  pending,
  onSeek
}: {
  reading: Reading
  /** The tick the arrow keys moved the light to, before their seek. */
  pending: number | null
  onSeek: (tick: number) => void
}): React.JSX.Element {
  const bar = useRef<HTMLDivElement>(null)
  const pressed = useRef<number | null>(null)
  const [drag, setDrag] = useState<number | null>(null)
  const tickUnder = (clientX: number): number | null => {
    const rect = bar.current?.getBoundingClientRect()
    if (!rect) return null
    return tickAt(clientX - rect.left, rect.width, reading.blocks)
  }
  const follow = (clientX: number): void => {
    const tick = tickUnder(clientX)
    if (tick === null || tick === pressed.current) return
    pressed.current = tick
    setDrag(tick)
  }
  const letGo = (seek: boolean): void => {
    const tick = pressed.current
    pressed.current = null
    setDrag(null)
    const to = seek ? dragSeek(tick, reading.tick) : null
    if (to !== null) onSeek(to)
  }
  const shown = scrubShown(reading.tick, reading.fraction, reading.blocks, drag ?? pending)
  return (
    <div className="folio-player-bar">
      <div
        ref={bar}
        className="folio-scrub"
        data-testid="folio-scrub"
        data-dragging={drag !== null ? 'true' : undefined}
        role="slider"
        aria-label="Block being read"
        aria-valuemin={1}
        aria-valuemax={reading.blocks}
        aria-valuenow={shown.tick + 1}
        aria-valuetext={`Block ${shown.tick + 1} of ${reading.blocks}`}
        tabIndex={0}
        style={{ '--ticks': reading.blocks, '--fill': shown.fill } as React.CSSProperties}
        onPointerDown={(event) => {
          if (event.button !== 0) return
          event.currentTarget.setPointerCapture?.(event.pointerId)
          pressed.current = null
          follow(event.clientX)
        }}
        onPointerMove={(event) => {
          if (pressed.current !== null) follow(event.clientX)
        }}
        onPointerUp={(event) => {
          if (pressed.current === null) return
          follow(event.clientX)
          letGo(true)
        }}
        onPointerCancel={() => letGo(false)}
        onLostPointerCapture={() => {
          if (pressed.current !== null) letGo(true)
        }}
      >
        <span className="folio-scrub-fill" aria-hidden="true" />
        {reading.ticks.map((block, i) => (
          <span
            key={`${i}-${block}`}
            className="folio-scrub-tick"
            data-testid="folio-scrub-tick"
            data-played={i < shown.tick ? 'true' : undefined}
            data-current={i === shown.tick ? 'true' : undefined}
            aria-hidden="true"
          />
        ))}
        <span className="folio-scrub-head" data-testid="folio-scrub-head" aria-hidden="true" />
      </div>
    </div>
  )
}

/** The two steps before the voice speaks, as two short rules the pen fills:
 *  the one running lit and being written, the one done filled. */
function Steps({ state }: { state: 'rewriting' | 'creating' }): React.JSX.Element {
  const steps = [
    { id: 'rewriting', label: 'Step 1 of 2: rewriting for the voice' },
    { id: 'creating', label: 'Step 2 of 2: creating the voice' }
  ] as const
  const at = state === 'rewriting' ? 0 : 1
  return (
    <ol className="folio-voice-steps" aria-label="Steps">
      {steps.map((step, i) => (
        <li
          key={step.id}
          className="folio-voice-step"
          data-step={step.id}
          data-lit={i === at ? 'true' : undefined}
          data-done={i < at ? 'true' : undefined}
          aria-label={step.label}
          aria-current={i === at ? 'step' : undefined}
        />
      ))}
    </ol>
  )
}

/** The voice card of a finished page. */
export function VoiceCard({
  page,
  sessionId,
  voice,
  autoRead
}: {
  page: Page
  sessionId: string
  voice: ReturnType<typeof useReadAloud>
  autoRead: boolean
}): React.JSX.Element {
  const reading = voice.reading?.key === page.key ? voice.reading : null
  const state = voiceCardState(reading)
  const machine = ownerOf(sessionId)
  const local = machine === LOCAL_SERVER_ID
  // This Mac's voice, read once per page view: a cheap local read, so the
  // card says which voice will read before a click. A server's is only what
  // its last reading heard (or what the Integrations page last read).
  useEffect(() => {
    if (local) void loadIntegrations(LOCAL_SERVER_ID)
  }, [local, page.key])
  const status = useIntegrationsStore((s) => s.byMachine[machine]?.elevenLabs)
  const source = voiceSource(local, status, voice.heard)
  const prepared = useSpokenState(sessionId, spokenKeyOf(page.spoken)).state === 'ready'

  // The seconds of a step, ticking while it runs.
  const [now, setNow] = useState(() => Date.now())
  const running = state === 'rewriting' || state === 'creating'
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [running])

  const seekTick = (tick: number): void => {
    const block = reading?.ticks[tick]
    if (block !== undefined) voice.seekBlock(block)
  }
  const toggle = (): void => {
    if (!reading || reading.state === 'preparing') return
    if (reading.state === 'paused') voice.resume()
    else voice.pause()
  }
  // The player's keys: Space plays or pauses, the arrows move a block. A run
  // of arrow presses moves the light at once and seeks once, KEY_SEEK_MS
  // after the last press (each seek is a paid call, verifier round 4).
  const [keyTick, setKeyTick] = useState<number | null>(null)
  const keyPending = useRef<number | null>(null)
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const playing = reading !== null && reading.state !== 'preparing'
  // A reading that ends drops the presses not yet sought; the light they
  // moved is shown only while a reading plays, and cleared on the next Listen.
  useEffect(() => {
    if (playing) return
    if (keyTimer.current) clearTimeout(keyTimer.current)
    keyTimer.current = null
    keyPending.current = null
  }, [playing])
  const pending = playing ? keyTick : null
  useEffect(
    () => () => {
      if (keyTimer.current) clearTimeout(keyTimer.current)
    },
    []
  )
  const onKey = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (!reading || reading.state === 'preparing') return
    const onButton = (event.target as HTMLElement).closest('button')
    if (event.key === ' ' && !onButton) {
      event.preventDefault()
      toggle()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const next = keySeekTarget(keyPending.current, reading.tick, event.key, reading.blocks)
      keyPending.current = next
      setKeyTick(next)
      if (keyTimer.current) clearTimeout(keyTimer.current)
      keyTimer.current = setTimeout(() => {
        keyTimer.current = null
        keyPending.current = null
        setKeyTick(null)
        if (next !== reading.tick) seekTick(next)
      }, KEY_SEEK_MS)
    }
  }

  const heardBefore = !!voice.heardPages[page.key]
  const afterNote = voice.fallbacks[page.key]
    ? fallbackLine(voice.fallbacks[page.key])
    : voice.notes[page.key]
  const system = reading?.voice === 'system'
  const shownTick = pending ?? reading?.tick ?? 0

  return (
    <section
      className="folio-voice"
      aria-label="Voice"
      data-testid="folio-voice-card"
      data-voice-state={state}
      data-voice={reading?.voice}
      data-why={system ? reading?.whyKind : undefined}
      onKeyDown={onKey}
    >
      <div className="folio-voice-top">
        <VoiceFigure />
        <h3 className="folio-voice-title">Voice</h3>
      </div>

      {state === 'idle' && (
        <>
          <div className="folio-voice-row">
            <button
              type="button"
              className="folio-voice-listen"
              data-testid="folio-play"
              onClick={() => {
                setKeyTick(null)
                voice.read(page.key, page.spoken)
              }}
            >
              <PlayIcon aria-hidden="true" />
              {heardBefore ? 'Listen again' : 'Listen'}
            </button>
            {prepared && <span className="folio-voice-ready">Ready</span>}
          </div>
          {source && (
            <p className="folio-voice-source" data-testid="folio-voice-source">
              {source.name}
            </p>
          )}
          {afterNote ? (
            <p
              className="folio-voice-why"
              data-testid="folio-voice-why"
              data-tone={afterNote === source?.why ? 'quiet' : undefined}
            >
              {afterNote}
            </p>
          ) : (
            source?.why && (
              <p className="folio-voice-why" data-testid="folio-voice-why" data-tone="quiet">
                {source.why}
              </p>
            )
          )}
          {autoRead && <p className="folio-voice-auto">Reads new answers</p>}
        </>
      )}

      {(state === 'rewriting' || state === 'creating') && reading && (
        <>
          <Steps state={state} />
          <p className="folio-voice-line" data-testid="folio-voice-line" role="status">
            <FolioLoader />
            <span>
              {state === 'rewriting'
                ? 'Rewriting for the voice'
                : source?.voiceName
                  ? `Creating the voice with ${source.voiceName}`
                  : 'Creating the voice'}
            </span>
            <span className="folio-voice-seconds">{stepSeconds(reading.since, now)}</span>
          </p>
          <button
            type="button"
            className="folio-voice-cancel"
            data-testid="folio-voice-cancel"
            onClick={voice.stop}
          >
            Cancel
          </button>
        </>
      )}

      {reading && (state === 'playing' || state === 'paused') && (
        <>
          <div className="folio-voice-row">
            <button
              type="button"
              className="folio-voice-control"
              data-testid="folio-play"
              data-state={reading.state}
              aria-label={reading.state === 'paused' ? 'Play' : 'Pause'}
              onClick={toggle}
            >
              {reading.state === 'paused' ? (
                <PlayIcon aria-hidden="true" />
              ) : (
                <PauseIcon aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              className="folio-voice-control"
              data-testid="folio-stop"
              aria-label="Stop reading"
              title="Stop reading"
              onClick={voice.stop}
            >
              <StopIcon aria-hidden="true" />
            </button>
            <span className="folio-voice-block" data-testid="folio-voice-block">
              Block {Math.min(shownTick, reading.blocks - 1) + 1} of {reading.blocks}
            </span>
          </div>
          <Scrub reading={reading} pending={pending} onSeek={seekTick} />
          {/* The voice's name; the Mac's voice is named by its why line. */}
          {!system && (
            <p className="folio-voice-source" data-testid="folio-voice-source">
              <span>{source?.voiceName ? `${source.voiceName} · ElevenLabs` : 'ElevenLabs'}</span>
              <span className="folio-player-time" data-testid="folio-player-time">
                {clockOf(
                  reading.totalMs === null && reading.elapsedMs === 0 ? null : reading.elapsedMs
                )}
                {' / '}
                {clockOf(reading.totalMs)}
              </span>
            </p>
          )}
          {system && (
            <p className="folio-voice-why" data-testid="folio-voice-why">
              {macVoiceLine(reading.why)}
            </p>
          )}
          {reading.fallback && (
            <p className="folio-voice-why" data-tone="quiet">
              {fallbackLine(reading.fallback)}
            </p>
          )}
        </>
      )}
    </section>
  )
}
