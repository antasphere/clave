// src/renderer/src/components/work-tracker/WeeklyChart.tsx
import { cn } from '@clave/ui/components'
import { formatDuration } from './utils'

const DAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']

interface WeeklyChartProps {
  dailyMinutes: number[]
  avgDailyMinutes: number
}

export function WeeklyChart({ dailyMinutes, avgDailyMinutes }: WeeklyChartProps) {
  const max = Math.max(...dailyMinutes, 1)
  const todayIndex = (new Date().getDay() + 6) % 7 // 0=Mon

  return (
    <div>
      <div className="flex items-end gap-1 h-10 mb-0.5">
        {dailyMinutes.map((minutes, i) => (
          <div key={i} className="flex-1 flex flex-col items-center justify-end h-full">
            {minutes >= 60 && (
              <span className="text-[8px] text-text-tertiary mb-0.5">
                {Math.round(minutes / 60)}h
              </span>
            )}
            <div
              className={cn(
                'w-full rounded-sm min-h-[2px] transition-all',
                i === todayIndex ? 'bg-accent' : minutes > 0 ? 'bg-surface-400' : 'bg-surface-200'
              )}
              style={{ height: `${Math.max((minutes / max) * 100, 6)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between">
        {DAY_LABELS.map((label, i) => (
          <span
            key={i}
            className={cn(
              'text-[9px] flex-1 text-center',
              i === todayIndex ? 'text-accent' : 'text-text-tertiary'
            )}
          >
            {label}
          </span>
        ))}
      </div>
      <div className="mt-1 text-[11px] text-text-tertiary">
        Avg {formatDuration(avgDailyMinutes)}/day
      </div>
    </div>
  )
}
