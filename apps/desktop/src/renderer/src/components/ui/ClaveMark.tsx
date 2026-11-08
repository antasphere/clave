import type { ReactNode } from 'react'

/** The Clave "C" brand mark, themed via currentColor + surface/text classes. */
export function ClaveMark({ className }: { className?: string }): ReactNode {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" className={className}>
      <path
        d="M401,86 L191,86 A50,50 0 0 0 141,136 L141,336 A50,50 0 0 0 191,386 L401,386 L401,310 L242,310 A25,25 0 0 1 217,285 L217,187 A25,25 0 0 1 242,162 L401,162 Z"
        fill="currentColor"
        className="text-surface-300"
      />
      <path
        d="M158,119 L374,119 L401,86 L191,86 Z"
        className="text-surface-400"
        fill="currentColor"
      />
      <path
        d="M209,343 L374,343 L401,310 L242,310 Z"
        className="text-surface-400"
        fill="currentColor"
      />
      <path
        d="M368,343 L401,310 L401,386 L368,419 Z"
        className="text-surface-200"
        fill="currentColor"
      />
      <path
        d="M184,220 L217,187 L217,285 L184,318 Z"
        className="text-surface-200"
        fill="currentColor"
      />
      <path
        d="M368,119 L401,86 L401,162 L368,195 Z"
        className="text-surface-200"
        fill="currentColor"
      />
      <path
        d="M371,116 L161,116 A50,50 0 0 0 111,166 L111,366 A50,50 0 0 0 161,416 L371,416 L371,340 L212,340 A25,25 0 0 1 187,315 L187,217 A25,25 0 0 1 212,192 L371,192 Z"
        className="text-text-primary"
        fill="currentColor"
      />
    </svg>
  )
}
