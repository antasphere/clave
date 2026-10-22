import { ThinkingOrb, MODE_FRAMES, type ModeFrame, type OrbState } from 'thinking-orbs'
import { useSessionStore } from '../../../src/renderer/src/store/session-store'
import type { AgentMarkProps, ToolMarkProps } from '../../../src/renderer/src/lib/marks'
import { ORB_STATES, orbThemeFor, toolOrb, useOrbsStore } from './orbs'

/** The rest mark, shared by every orb: the dotted globe at one fixed instant
 *  (`searching` at t=0, before its scan), the same on every tab. `paused`
 *  would freeze on whatever frame the shared clock was at — a different,
 *  arbitrary cut of the animation on each tab, and for `working`,
 *  `connecting` or `composing` never a clean one. A still globe is clean at
 *  every size, and the moment it gives way to the chosen orb is itself the
 *  signal that work began. */
const REST_STATE: OrbState = 'searching'
const restFrame: ModeFrame = (size, _t, opts) => MODE_FRAMES.globe(size, 0, opts)

/** One orb: the library's 20px inline preset (a hand-tuned design, not a
 *  scaled avatar), fitted to its slot by the slot's own CSS. `color` tints
 *  the ink while keeping the orb's depth shading. At rest it is the shared
 *  rest mark; `state` stays on the canvas as the orb's identity. */
function Orb({
  state,
  working,
  color,
  size = 20,
  dotSize,
  restDots,
  label
}: {
  state: OrbState
  working: boolean
  color?: string
  size?: 20 | 32 | 64
  /** Radius multiplier on every dot: a slot smaller than the preset asks for bolder dots. */
  dotSize?: number
  /** Density of the rest globe; fewer dots read as a sphere in a small slot. */
  restDots?: number
  label?: string
}): React.JSX.Element {
  const theme = useSessionStore((s) => s.theme)
  return (
    <ThinkingOrb
      state={working ? state : REST_STATE}
      frame={working ? undefined : restFrame}
      size={size}
      theme={orbThemeFor(theme)}
      paused={!working}
      color={color}
      dotSize={dotSize}
      dots={working ? undefined : restDots}
      data-orb-state={state}
      data-working={working ? 'true' : undefined}
      aria-label={label}
    />
  )
}

/** The weights per slot, measured on the real sizes (2026-10-15): the preset
 *  is tuned for 20px inline text and reads as faint specks in the app's 15px
 *  tab slot, so the tab draws bolder dots and a sparser rest globe. */
const TAB = { dotSize: 1.8, restDots: 0.7 }
const INLINE = { dotSize: 1.4, restDots: 0.85 }

/** The agent: the user's orb, still at rest, moving at work. */
export function OrbsAgent({ working, color, slot }: AgentMarkProps): React.JSX.Element {
  const state = useOrbsStore((s) => s.state)
  const weight = slot === 'tab' ? TAB : INLINE
  return <Orb state={state} working={working} color={color} {...weight} />
}

/** A tool call: its kind's orb while it runs, in the glyph's 16px box. */
export function OrbsTool({ kind, running }: ToolMarkProps): React.JSX.Element {
  return (
    <Orb state={toolOrb(kind)} working={running} label={running ? 'Running' : undefined} {...TAB} />
  )
}

/** The pack's settings, under the Agent mark row: the nine orbs, drawn live,
 *  because the choice is about the motion. */
export function OrbsSettings(): React.JSX.Element {
  const state = useOrbsStore((s) => s.state)
  const setState = useOrbsStore((s) => s.setState)
  return (
    <div className="orb-picker" role="radiogroup" aria-label="Orb">
      {ORB_STATES.map((orb) => (
        <button
          key={orb.id}
          type="button"
          role="radio"
          aria-checked={state === orb.id}
          aria-label={orb.label}
          title={orb.hint}
          className="orb-swatch"
          data-selected={state === orb.id ? 'true' : undefined}
          data-orb-option={orb.id}
          onClick={() => setState(orb.id)}
        >
          <Orb state={orb.id} working size={64} />
          <span className="orb-swatch-label">{orb.label}</span>
        </button>
      ))}
    </div>
  )
}
