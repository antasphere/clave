import { useState, useRef, useCallback, useEffect } from 'react'
import { CheckIcon } from '@heroicons/react/24/outline'

// --- Color conversion utilities ---

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0,
    g = 0,
    b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)]
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === r) h = ((g - b) / d + 6) % 6
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  const s = max === 0 ? 0 : d / max
  return [h, s, max]
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('')
  )
}

// --- Multicolor wheel icon ---

function MulticolorWheel({ size = 20 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 20 20">
      <defs>
        <clipPath id="circle-clip">
          <circle cx="10" cy="10" r="9" />
        </clipPath>
      </defs>
      <g clipPath="url(#circle-clip)">
        {[
          { color: '#FF3B30', d: 'M10,10 L10,0 A10,10 0 0,1 18.66,5 Z' },
          { color: '#FF9500', d: 'M10,10 L18.66,5 A10,10 0 0,1 18.66,15 Z' },
          { color: '#FFD60A', d: 'M10,10 L18.66,15 A10,10 0 0,1 10,20 Z' },
          { color: '#34C759', d: 'M10,10 L10,20 A10,10 0 0,1 1.34,15 Z' },
          { color: '#007AFF', d: 'M10,10 L1.34,15 A10,10 0 0,1 1.34,5 Z' },
          { color: '#AF52DE', d: 'M10,10 L1.34,5 A10,10 0 0,1 10,0 Z' }
        ].map((slice, i) => (
          <path key={i} d={slice.d} fill={slice.color} />
        ))}
      </g>
      <circle
        cx="10"
        cy="10"
        r="9"
        fill="none"
        stroke="var(--color-border-subtle)"
        strokeWidth="1"
      />
    </svg>
  )
}

// --- Saturation/Brightness gradient canvas ---

function SatBrightCanvas({
  hue,
  sat,
  bright,
  onChange
}: {
  hue: number
  sat: number
  bright: number
  onChange: (s: number, b: number) => void
}): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const dragging = useRef(false)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width,
      h = canvas.height

    // Base hue
    const [r, g, b] = hsvToRgb(hue, 1, 1)
    ctx.fillStyle = `rgb(${r},${g},${b})`
    ctx.fillRect(0, 0, w, h)

    // White gradient left to right
    const whiteGrad = ctx.createLinearGradient(0, 0, w, 0)
    whiteGrad.addColorStop(0, 'rgba(255,255,255,1)')
    whiteGrad.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = whiteGrad
    ctx.fillRect(0, 0, w, h)

    // Black gradient top to bottom
    const blackGrad = ctx.createLinearGradient(0, 0, 0, h)
    blackGrad.addColorStop(0, 'rgba(0,0,0,0)')
    blackGrad.addColorStop(1, 'rgba(0,0,0,1)')
    ctx.fillStyle = blackGrad
    ctx.fillRect(0, 0, w, h)
  }, [hue])

  useEffect(() => {
    draw()
  }, [draw])

  const handlePointer = useCallback(
    (e: React.PointerEvent | PointerEvent) => {
      const canvas = canvasRef.current
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const x = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
      onChange(x, 1 - y)
    },
    [onChange]
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      handlePointer(e)
    },
    [handlePointer]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragging.current) handlePointer(e)
    },
    [handlePointer]
  )

  const onPointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  // Indicator position
  const indicatorX = sat * 100
  const indicatorY = (1 - bright) * 100

  return (
    <div className="relative rounded-lg overflow-hidden cursor-crosshair" style={{ height: 120 }}>
      <canvas
        ref={canvasRef}
        width={256}
        height={120}
        className="w-full h-full block"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      <div
        className="absolute w-3.5 h-3.5 rounded-full border-2 border-white pointer-events-none"
        style={{
          left: `${indicatorX}%`,
          top: `${indicatorY}%`,
          transform: 'translate(-50%, -50%)',
          boxShadow: '0 0 2px rgba(0,0,0,0.5)'
        }}
      />
    </div>
  )
}

// --- Hue slider ---

function HueSlider({
  hue,
  onChange
}: {
  hue: number
  onChange: (h: number) => void
}): React.JSX.Element {
  const dragging = useRef(false)
  const trackRef = useRef<HTMLDivElement>(null)

  const handlePointer = useCallback(
    (e: React.PointerEvent | PointerEvent) => {
      const track = trackRef.current
      if (!track) return
      const rect = track.getBoundingClientRect()
      const y = Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height))
      onChange(y * 360)
    },
    [onChange]
  )

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      dragging.current = true
      ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
      handlePointer(e)
    },
    [handlePointer]
  )

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (dragging.current) handlePointer(e)
    },
    [handlePointer]
  )

  const onPointerUp = useCallback(() => {
    dragging.current = false
  }, [])

  const thumbY = (hue / 360) * 100

  return (
    <div
      ref={trackRef}
      className="relative rounded-lg cursor-pointer flex-shrink-0"
      style={{
        width: 14,
        height: 120,
        background:
          'linear-gradient(to bottom, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)'
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        className="absolute left-1/2 w-3 h-3 rounded-full border-2 border-white pointer-events-none"
        style={{
          top: `${thumbY}%`,
          transform: 'translate(-50%, -50%)',
          boxShadow: '0 0 2px rgba(0,0,0,0.5)',
          backgroundColor: `hsl(${hue}, 100%, 50%)`
        }}
      />
    </div>
  )
}

// --- Main ColorPicker component ---

export interface ColorPickerProps {
  presetOrder: readonly string[]
  presets: Record<string, string>
  value: string | null | undefined
  onChange: (color: string | null) => void
  showNoColor?: boolean
}

export function ColorPicker({
  value,
  onChange,
  showNoColor = true,
  presets,
  presetOrder
}: ColorPickerProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const [hexInput, setHexInput] = useState('')

  // Determine the resolved hex for the current value
  const currentHex = value
    ? (presets[value] ?? (value.startsWith('#') ? value : undefined))
    : undefined

  // Check if the current value is a preset
  const isPreset = value ? value in presets : false
  const isCustom = value && !isPreset && value.startsWith('#')

  // HSV state for the expanded picker
  const [hsv, setHsv] = useState<[number, number, number]>(() => {
    if (currentHex) {
      const [r, g, b] = hexToRgb(currentHex)
      return rgbToHsv(r, g, b)
    }
    return [0, 1, 1]
  })

  // Update HSV when value changes externally
  useEffect(() => {
    if (currentHex) {
      const [r, g, b] = hexToRgb(currentHex)
      const newHsv = rgbToHsv(r, g, b)
      // Preserve controlled-value synchronization when the parent changes its color.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setHsv(newHsv)
      setHexInput(currentHex)
    }
  }, [currentHex])

  const pickerHex = (() => {
    const [r, g, b] = hsvToRgb(hsv[0], hsv[1], hsv[2])
    return rgbToHex(r, g, b)
  })()

  const handleSatBrightChange = useCallback(
    (s: number, bv: number) => {
      const newHsv: [number, number, number] = [hsv[0], s, bv]
      setHsv(newHsv)
      const [r, g, b] = hsvToRgb(newHsv[0], newHsv[1], newHsv[2])
      const hex = rgbToHex(r, g, b)
      setHexInput(hex)
      onChange(hex)
    },
    [hsv, onChange]
  )

  const handleHueChange = useCallback(
    (h: number) => {
      const newHsv: [number, number, number] = [h, hsv[1], hsv[2]]
      setHsv(newHsv)
      const [r, g, b] = hsvToRgb(newHsv[0], newHsv[1], newHsv[2])
      const hex = rgbToHex(r, g, b)
      setHexInput(hex)
      onChange(hex)
    },
    [hsv, onChange]
  )

  const handleHexSubmit = useCallback(() => {
    let hex = hexInput.trim()
    if (!hex.startsWith('#')) hex = '#' + hex
    if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
      const lower = hex.toLowerCase()
      setHexInput(lower)
      const [r, g, b] = hexToRgb(lower)
      setHsv(rgbToHsv(r, g, b))
      onChange(lower)
    } else {
      // Reset to current
      setHexInput(currentHex ?? '#ff0000')
    }
  }, [hexInput, currentHex, onChange])

  return (
    <div className="flex flex-col gap-2">
      {/* Preset swatches row */}
      <div className="flex items-center gap-1.5">
        {showNoColor && (
          <button
            onClick={(ev) => {
              ev.stopPropagation()
              onChange(null)
              setExpanded(false)
            }}
            className="relative w-5 h-5 rounded-full border border-border-subtle bg-surface-200 hover:scale-110 transition-transform flex items-center justify-center"
            title="No color"
          >
            {value === null || value === undefined ? (
              <CheckIcon className="w-3 h-3 text-text-secondary" />
            ) : null}
          </button>
        )}
        {presetOrder.map((color) => (
          <button
            key={color}
            onClick={(ev) => {
              ev.stopPropagation()
              onChange(color)
              setExpanded(false)
            }}
            className="relative w-5 h-5 rounded-full hover:scale-110 transition-transform flex items-center justify-center"
            style={{ backgroundColor: presets[color] }}
            title={color}
          >
            {value === color && <CheckIcon className="w-3 h-3 text-white" />}
          </button>
        ))}

        {/* Divider + multicolor wheel */}
        <div className="w-px h-5 bg-border-subtle mx-0.5" />
        <button
          onClick={(ev) => {
            ev.stopPropagation()
            setExpanded(!expanded)
            if (!expanded && currentHex) {
              const [r, g, b] = hexToRgb(currentHex)
              setHsv(rgbToHsv(r, g, b))
              setHexInput(currentHex)
            }
          }}
          className={`relative w-5 h-5 rounded-full hover:scale-110 transition-transform flex items-center justify-center ${
            expanded ? 'ring-2 ring-accent ring-offset-1 ring-offset-surface-0' : ''
          }`}
          title="Custom color"
        >
          {isCustom ? (
            <div
              className="w-5 h-5 rounded-full flex items-center justify-center"
              style={{ backgroundColor: currentHex }}
            >
              <CheckIcon className="w-3 h-3 text-white" />
            </div>
          ) : (
            <MulticolorWheel size={20} />
          )}
        </button>
      </div>

      {/* Expanded custom color picker */}
      {expanded && (
        <div className="flex flex-col gap-2 pt-1">
          {/* Hex input row */}
          <div className="flex items-center gap-2">
            <div
              className="w-5 h-5 rounded-full flex-shrink-0 border border-border-subtle"
              style={{ backgroundColor: pickerHex }}
            />
            <span className="text-[11px] text-text-tertiary font-medium uppercase">Hex</span>
            <input
              type="text"
              value={hexInput}
              onChange={(e) => setHexInput(e.target.value)}
              onBlur={handleHexSubmit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleHexSubmit()
              }}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 bg-surface-100 border border-border-subtle rounded px-1.5 py-0.5 text-[11px] text-text-primary font-mono outline-none focus:border-accent"
              maxLength={7}
            />
          </div>

          {/* Sat/Bright gradient + Hue slider */}
          <div className="flex gap-2">
            <div className="flex-1">
              <SatBrightCanvas
                hue={hsv[0]}
                sat={hsv[1]}
                bright={hsv[2]}
                onChange={handleSatBrightChange}
              />
            </div>
            <HueSlider hue={hsv[0]} onChange={handleHueChange} />
          </div>
        </div>
      )}
    </div>
  )
}
