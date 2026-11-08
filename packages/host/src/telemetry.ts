import { app } from 'electron'
import { randomUUID } from 'crypto'
import { preferencesManager } from './preferences-manager'

const PING_URL = 'https://ping.clave.work/api/ping'
const INITIAL_DELAY = 5000
const CHECK_INTERVAL = 60 * 60 * 1000 // 1 hour
const PING_INTERVAL = 24 * 60 * 60 * 1000 // 24 hours
const FETCH_TIMEOUT = 10 * 1000

let initialTimeout: ReturnType<typeof setTimeout> | null = null
let checkInterval: ReturnType<typeof setInterval> | null = null

export interface TelemetryState {
  enabled: boolean
  installId: string | null
  lastPingAt: string | null
  noticeShown: boolean
}

function isPingDue(): boolean {
  const lastPingAt = preferencesManager.get('telemetryLastPingAt')
  if (!lastPingAt) return true
  const last = Date.parse(lastPingAt)
  return !Number.isFinite(last) || Date.now() - last >= PING_INTERVAL
}

/** One check: send the daily ping if due. Never throws, never retries. */
async function check(): Promise<void> {
  try {
    if (!preferencesManager.get('telemetryEnabled') || !isPingDue()) return

    let installId = preferencesManager.get('telemetryInstallId')
    if (!installId) {
      installId = randomUUID()
      preferencesManager.set('telemetryInstallId', installId)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT)
    try {
      const response = await fetch(PING_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: installId,
          appVersion: app.getVersion(),
          platform: `${process.platform}-${process.arch}`
        }),
        signal: controller.signal
      })
      if (response.ok) {
        preferencesManager.set('telemetryLastPingAt', new Date().toISOString())
      }
    } finally {
      clearTimeout(timeout)
    }
  } catch (err) {
    console.log('[telemetry] Ping skipped:', err instanceof Error ? err.message : err)
  }
}

function startTimers(): void {
  stopTimers()
  initialTimeout = setTimeout(() => void check(), INITIAL_DELAY)
  checkInterval = setInterval(() => void check(), CHECK_INTERVAL)
}

function stopTimers(): void {
  if (initialTimeout) {
    clearTimeout(initialTimeout)
    initialTimeout = null
  }
  if (checkInterval) {
    clearInterval(checkInterval)
    checkInterval = null
  }
}

export function initTelemetry(): void {
  if (!app.isPackaged) return
  if (!preferencesManager.get('telemetryEnabled')) return
  startTimers()
}

export function getTelemetryState(): TelemetryState {
  return {
    enabled: preferencesManager.get('telemetryEnabled'),
    installId: preferencesManager.get('telemetryInstallId'),
    lastPingAt: preferencesManager.get('telemetryLastPingAt'),
    noticeShown: preferencesManager.get('telemetryNoticeShown')
  }
}

export function setTelemetryEnabled(enabled: boolean): void {
  try {
    preferencesManager.set('telemetryEnabled', enabled)
    if (!app.isPackaged) return
    if (enabled) startTimers()
    else stopTimers()
  } catch (err) {
    console.log('[telemetry] Failed to update setting:', err instanceof Error ? err.message : err)
  }
}

export function setTelemetryNoticeShown(): void {
  try {
    preferencesManager.set('telemetryNoticeShown', true)
  } catch (err) {
    console.log(
      '[telemetry] Failed to persist notice flag:',
      err instanceof Error ? err.message : err
    )
  }
}

export function cleanupTelemetry(): void {
  stopTimers()
}
