// src/renderer/src/store/work-tracker-store.ts
import { create } from 'zustand'
import { useEffect, useRef } from 'react'
import { useSessionStore } from './session-store'

interface TrackedSession {
  sessionId: string
  cwd: string
  projectName: string
  dateKey: string // local YYYY-MM-DD when session started
  startedAt: number
  endedAt: number | null
  lastTickAt: number // last time tick() updated this session
  accumulatedMs: number
}

interface ProjectSummary {
  projectPath: string
  projectName: string
  totalMinutes: number
  sessionCount: number
}

type BreakSuggestion = 'none' | 'gentle' | 'strong'

interface WorkTrackerState {
  // Tracked sessions (current app lifecycle)
  trackedSessions: TrackedSession[]

  // Streak
  currentStreakStartedAt: number | null
  lastActivityAt: number | null
  breakSuggestion: BreakSuggestion

  // Aggregated today
  todayProjects: ProjectSummary[]
  todayTotalMinutes: number
  todaySessionCount: number

  // UI
  enabled: boolean

  // Actions
  setEnabled: (enabled: boolean) => void
  trackSession: (sessionId: string, cwd: string) => void
  endSession: (sessionId: string) => void
  tick: () => void
}

const GENTLE_THRESHOLD_MS = 2 * 60 * 60 * 1000 // 2 hours
const STRONG_THRESHOLD_MS = 4 * 60 * 60 * 1000 // 4 hours
const BREAK_GAP_MS = 15 * 60 * 1000 // 15 minutes inactivity = break

function getProjectName(cwd: string): string {
  return cwd.split('/').filter(Boolean).pop() || cwd
}

/** Returns YYYY-MM-DD in local timezone */
function getLocalDateString(date: Date = new Date()): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function computeBreakSuggestion(streakMs: number): BreakSuggestion {
  if (streakMs >= STRONG_THRESHOLD_MS) return 'strong'
  if (streakMs >= GENTLE_THRESHOLD_MS) return 'gentle'
  return 'none'
}

function aggregateProjects(sessions: TrackedSession[]): ProjectSummary[] {
  const map = new Map<string, { totalMs: number; count: number }>()

  for (const s of sessions) {
    const totalMs = s.accumulatedMs
    const existing = map.get(s.cwd)
    if (existing) {
      existing.totalMs += totalMs
      existing.count += 1
    } else {
      map.set(s.cwd, { totalMs, count: 1 })
    }
  }

  return Array.from(map.entries())
    .map(([cwd, { totalMs, count }]) => ({
      projectPath: cwd,
      projectName: getProjectName(cwd),
      totalMinutes: Math.round(totalMs / 60000),
      sessionCount: count
    }))
    .sort((a, b) => b.totalMinutes - a.totalMinutes)
}

export const useWorkTrackerStore = create<WorkTrackerState>((set, get) => ({
  trackedSessions: [],
  currentStreakStartedAt: null,
  lastActivityAt: null,
  breakSuggestion: 'none',
  todayProjects: [],
  todayTotalMinutes: 0,
  todaySessionCount: 0,
  enabled: localStorage.getItem('clave-work-tracker-enabled') === 'true',

  setEnabled: (enabled) => {
    localStorage.setItem('clave-work-tracker-enabled', String(enabled))
    set({ enabled })
  },

  trackSession: (sessionId, cwd) =>
    set((state) => {
      if (state.trackedSessions.some((s) => s.sessionId === sessionId)) return {}
      const now = Date.now()
      return {
        trackedSessions: [
          ...state.trackedSessions,
          {
            sessionId,
            cwd,
            projectName: getProjectName(cwd),
            dateKey: getLocalDateString(),
            startedAt: now,
            endedAt: null,
            lastTickAt: now,
            accumulatedMs: 0
          }
        ],
        currentStreakStartedAt: state.currentStreakStartedAt ?? now,
        lastActivityAt: now
      }
    }),

  endSession: (sessionId) =>
    set((state) => {
      const now = Date.now()
      // Count active tracked sessions to split wall-clock time fairly
      const storeSessions = useSessionStore.getState().sessions
      let activeCount = 0
      for (const s of state.trackedSessions) {
        if (s.endedAt) continue
        const ss = storeSessions.find((x) => x.id === s.sessionId)
        if (ss?.alive && ss.activityStatus === 'active') activeCount++
      }
      if (activeCount < 1) activeCount = 1

      return {
        trackedSessions: state.trackedSessions.map((s) => {
          if (s.sessionId !== sessionId || s.endedAt) return s
          const delta = now - s.lastTickAt
          return {
            ...s,
            endedAt: now,
            lastTickAt: now,
            accumulatedMs: s.accumulatedMs + delta / activeCount
          }
        })
      }
    }),

  tick: () => {
    const state = get()
    const now = Date.now()
    const todayKey = getLocalDateString()
    const storeSessions = useSessionStore.getState().sessions

    // First pass: count concurrently active sessions for fair wall-clock split
    let activeCount = 0
    for (const ts of state.trackedSessions) {
      if (ts.endedAt) continue
      const ss = storeSessions.find((s) => s.id === ts.sessionId)
      if (ss?.alive && ss.activityStatus === 'active') activeCount++
    }

    // Second pass: update accumulated time, dividing by concurrent count
    const updatedTracked = state.trackedSessions.map((ts) => {
      if (ts.endedAt) return ts
      const storeSession = storeSessions.find((s) => s.id === ts.sessionId)
      if (!storeSession || !storeSession.alive) {
        return { ...ts, endedAt: now, lastTickAt: now }
      }
      if (storeSession.activityStatus === 'active' && activeCount > 0) {
        const delta = now - ts.lastTickAt
        // Split wall-clock time among concurrent sessions so totals reflect real time
        return { ...ts, lastTickAt: now, accumulatedMs: ts.accumulatedMs + delta / activeCount }
      }
      return { ...ts, lastTickAt: now }
    })

    const hasActiveSession = activeCount > 0

    // Streak logic
    let { currentStreakStartedAt, lastActivityAt } = state
    if (hasActiveSession) {
      lastActivityAt = now
      if (!currentStreakStartedAt) currentStreakStartedAt = now
    } else if (lastActivityAt && now - lastActivityAt > BREAK_GAP_MS) {
      currentStreakStartedAt = null
      lastActivityAt = null
    }

    const streakMs = currentStreakStartedAt ? now - currentStreakStartedAt : 0
    const breakSuggestion = computeBreakSuggestion(streakMs)

    // Aggregate only today's sessions
    const todaySessions = updatedTracked.filter((s) => s.dateKey === todayKey)
    const todayProjects = aggregateProjects(todaySessions)
    const todayTotalMinutes = todayProjects.reduce((sum, p) => sum + p.totalMinutes, 0)
    const todaySessionCount = todaySessions.length

    set({
      trackedSessions: updatedTracked,
      currentStreakStartedAt,
      lastActivityAt,
      breakSuggestion,
      todayProjects,
      todayTotalMinutes,
      todaySessionCount
    })
  }
}))

/**
 * Mount once in AppShell. Syncs session-store sessions into work tracker
 * and runs a 30s tick for duration/streak updates.
 */
export function useWorkTracker(): void {
  const prevSessionIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    // Sync existing alive sessions on mount
    const sessions = useSessionStore.getState().sessions
    for (const s of sessions) {
      if (s.alive) {
        useWorkTrackerStore.getState().trackSession(s.id, s.cwd)
      }
    }

    // Subscribe to session-store for new/ended sessions
    let prevSessionRef = useSessionStore.getState().sessions
    const unsubscribe = useSessionStore.subscribe((state) => {
      if (state.sessions === prevSessionRef) return
      prevSessionRef = state.sessions

      const currentIds = new Set<string>(state.sessions.filter((s) => s.alive).map((s) => s.id))
      const tracker = useWorkTrackerStore.getState()

      for (const s of state.sessions) {
        if (s.alive && !prevSessionIds.current.has(s.id)) {
          tracker.trackSession(s.id, s.cwd)
        }
      }

      for (const id of prevSessionIds.current) {
        if (!currentIds.has(id)) {
          tracker.endSession(id)
        }
      }

      prevSessionIds.current = currentIds
    })

    const tickInterval = setInterval(() => {
      useWorkTrackerStore.getState().tick()
    }, 30000)

    useWorkTrackerStore.getState().tick()

    return () => {
      unsubscribe()
      clearInterval(tickInterval)
    }
  }, [])
}
