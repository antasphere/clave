import { useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowDownTrayIcon,
  ArrowPathIcon,
  CodeBracketIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  TrashIcon
} from '@heroicons/react/24/outline'
import {
  KEYMAP_ACTIONS,
  KEYMAP_SEQUENCE_TIMEOUT_MS,
  MAX_BINDINGS_PER_ACTION,
  canonicalizeBinding,
  formatKeyBinding,
  keyEventToChord,
  overridesFromResolved,
  parseKeymapOverrides,
  resolveKeymapConfig,
  type KeymapActionId,
  type ResolvedKeymapConfig
} from '../../../../shared/keymaps'
import { saveKeymapOverrides, useKeymapStore } from '../../store/keymap-store'
import { SettingsCard, SettingsPage, SettingsSection } from './primitives'

type EditorMode = 'actions' | 'json'

interface RecordingTarget {
  actionId?: KeymapActionId
  index?: number
  master?: true
  steps: string[]
}

function cloneConfig(config: ResolvedKeymapConfig): ResolvedKeymapConfig {
  return {
    ...config,
    bindings: Object.fromEntries(
      Object.entries(config.bindings).map(([actionId, bindings]) => [actionId, [...bindings]])
    ) as ResolvedKeymapConfig['bindings']
  }
}

function jsonFor(config: ResolvedKeymapConfig): string {
  return `${JSON.stringify(overridesFromResolved(config), null, 2)}\n`
}

export function KeymapSettings(): React.JSX.Element {
  const loadError = useKeymapStore((state) => state.error)
  const [draft, setDraft] = useState(() => cloneConfig(useKeymapStore.getState().config))
  const [rawJson, setRawJson] = useState(() => jsonFor(useKeymapStore.getState().config))
  const [mode, setMode] = useState<EditorMode>('actions')
  const [query, setQuery] = useState('')
  const [dirty, setDirty] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [recording, setRecording] = useState<RecordingTarget | null>(null)
  const recordingTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return useKeymapStore.subscribe((state, previous) => {
      if (dirty || state.config === previous.config) return
      setDraft(cloneConfig(state.config))
      setRawJson(jsonFor(state.config))
    })
  }, [dirty])

  useEffect(
    () => () => {
      if (recordingTimer.current) clearTimeout(recordingTimer.current)
    },
    []
  )

  const filteredActions = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle
      ? KEYMAP_ACTIONS.filter(
          (action) =>
            action.label.toLowerCase().includes(needle) ||
            action.category.toLowerCase().includes(needle)
        )
      : KEYMAP_ACTIONS
  }, [query])

  const updateDraft = (next: ResolvedKeymapConfig): void => {
    setDraft(next)
    setDirty(true)
    setErrors([])
    setNotice(null)
  }

  const clearRecordingTimer = (): void => {
    if (recordingTimer.current) clearTimeout(recordingTimer.current)
    recordingTimer.current = null
  }

  const finishRecording = (target: RecordingTarget): void => {
    clearRecordingTimer()
    if (target.master) {
      const chord = target.steps[0]
      if (chord) updateDraft({ ...draft, masterKey: chord })
      setRecording(null)
      return
    }
    if (!target.actionId || target.index === undefined || target.steps.length === 0) {
      setRecording(null)
      return
    }
    const binding =
      target.steps[0] === draft.masterKey
        ? ['Master', ...target.steps.slice(1)].join(' ')
        : target.steps.join(' ')
    try {
      const canonical = canonicalizeBinding(binding)
      const next = cloneConfig(draft)
      next.bindings[target.actionId][target.index] = canonical
      updateDraft(next)
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Invalid binding'])
    }
    setRecording(null)
  }

  const recordKey = (event: React.KeyboardEvent, target: RecordingTarget): void => {
    event.preventDefault()
    event.stopPropagation()
    if (event.key === 'Escape') {
      setRecording(null)
      clearRecordingTimer()
      return
    }
    const chord = keyEventToChord(event.nativeEvent)
    if (!chord) return
    if (target.master) {
      finishRecording({ ...target, steps: [chord] })
      return
    }

    const steps = [...target.steps, chord]
    const next = { ...target, steps }
    setRecording(next)
    if (recordingTimer.current) clearTimeout(recordingTimer.current)
    if (steps.length === 1 && chord !== draft.masterKey) {
      finishRecording(next)
      return
    }
    recordingTimer.current = setTimeout(() => finishRecording(next), KEYMAP_SEQUENCE_TIMEOUT_MS)
  }

  const startBinding = (actionId: KeymapActionId, index: number): void => {
    clearRecordingTimer()
    setRecording({ actionId, index, steps: [] })
    setTimeout(() => {
      document.querySelector<HTMLElement>(`[data-recording="${actionId}-${index}"]`)?.focus()
    }, 0)
  }

  const removeBinding = (actionId: KeymapActionId, index: number): void => {
    const next = cloneConfig(draft)
    next.bindings[actionId].splice(index, 1)
    updateDraft(next)
  }

  const resetAction = (actionId: KeymapActionId): void => {
    const defaults = resolveKeymapConfig()
    const next = cloneConfig(draft)
    next.bindings[actionId] = [...defaults.bindings[actionId]]
    updateDraft(next)
  }

  const parseRawDraft = (): ResolvedKeymapConfig | null => {
    try {
      const raw = JSON.parse(rawJson) as unknown
      const parsed = parseKeymapOverrides(raw)
      if (!parsed.ok) {
        setErrors(parsed.errors.map((error) => `${error.path}: ${error.message}`))
        return null
      }
      return resolveKeymapConfig(parsed.value)
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Invalid JSON'])
      return null
    }
  }

  const switchMode = (nextMode: EditorMode): void => {
    if (nextMode === mode) return
    clearRecordingTimer()
    setRecording(null)
    if (nextMode === 'json') {
      setRawJson(jsonFor(draft))
      setMode('json')
      setErrors([])
      return
    }
    const parsed = parseRawDraft()
    if (!parsed) return
    setDraft(parsed)
    setMode('actions')
    setErrors([])
  }

  const save = async (): Promise<void> => {
    const next = mode === 'json' ? parseRawDraft() : draft
    if (!next) return
    const result = await saveKeymapOverrides(overridesFromResolved(next))
    if (!result.ok) {
      setErrors(result.errors.map((error) => `${error.path}: ${error.message}`))
      return
    }
    const accepted = resolveKeymapConfig(result.value)
    setDraft(cloneConfig(accepted))
    setRawJson(jsonFor(accepted))
    setDirty(false)
    setErrors([])
    setNotice('Keymaps saved and active in every window.')
  }

  const importJson = async (): Promise<void> => {
    try {
      const imported = await window.electronAPI.keymapsImport()
      if (imported === null) return
      setRawJson(imported)
      setMode('json')
      setDirty(true)
      setErrors([])
      setNotice('Imported as a draft. Review it, then press Save.')
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Import failed'])
    }
  }

  const exportJson = async (): Promise<void> => {
    const next = mode === 'json' ? parseRawDraft() : draft
    if (!next) return
    try {
      const wrote = await window.electronAPI.keymapsExport(jsonFor(next))
      if (wrote) setNotice('Keymaps exported.')
    } catch (error) {
      setErrors([error instanceof Error ? error.message : 'Export failed'])
    }
  }

  return (
    <SettingsPage
      title="Keymaps"
      description="Changes stay in this draft until Save. Each action accepts at most two bindings."
      actions={
        <>
          <button onClick={() => void importJson()} className="btn-secondary">
            <ArrowDownTrayIcon className="w-3.5 h-3.5" /> Import
          </button>
          <button onClick={() => void exportJson()} className="btn-secondary">
            <ArrowDownTrayIcon className="w-3.5 h-3.5 rotate-180" /> Export
          </button>
        </>
      }
    >
      <SettingsSection
        title="Command mode"
        description={`Press the master key, then a command sequence. Each next key has ${KEYMAP_SEQUENCE_TIMEOUT_MS}ms to match.`}
      >
        <SettingsCard>
          <div className="settings-row">
            <div>
              <p className="settings-row-title">Master key</p>
              <p className="settings-row-description">
                Unset it to disable command mode without changing direct shortcuts.
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                data-keymap-recorder
                data-recording="master"
                onClick={() => {
                  clearRecordingTimer()
                  setRecording({ master: true, steps: [] })
                }}
                onKeyDown={(event) => recording?.master && recordKey(event, recording)}
                className="keymap-binding"
              >
                {recording?.master
                  ? 'Press a chord…'
                  : draft.masterKey
                    ? formatKeyBinding(draft.masterKey, draft.masterKey)
                    : 'Disabled'}
              </button>
              {draft.masterKey && (
                <button
                  onClick={() => updateDraft({ ...draft, masterKey: null })}
                  className="btn-icon btn-icon-sm"
                  title="Disable command mode"
                  aria-label="Disable command mode"
                >
                  <TrashIcon className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Bindings">
        <div className="flex items-center gap-2 mb-2.5">
          <div className="search-field flex-1">
            <MagnifyingGlassIcon className="w-3.5 h-3.5" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search actions"
              aria-label="Search keymap actions"
            />
          </div>
          <div className="launcher-panel">
            <div className="launcher-row">
              <button
                onClick={() => switchMode('actions')}
                className="panel-tab"
                data-selected={mode === 'actions' ? 'true' : undefined}
              >
                Actions
              </button>
              <span className="panel-sep" />
              <button
                onClick={() => switchMode('json')}
                className="panel-tab"
                data-selected={mode === 'json' ? 'true' : undefined}
              >
                <CodeBracketIcon className="w-3.5 h-3.5" /> JSON
              </button>
            </div>
          </div>
        </div>

        {mode === 'actions' ? (
          <SettingsCard>
            {filteredActions.map((action) => {
              const bindings = draft.bindings[action.id]
              const adding =
                recording?.actionId === action.id && recording.index === bindings.length
              return (
                <div className="settings-row keymap-row" key={action.id}>
                  <div className="min-w-0">
                    <p className="settings-row-title">{action.label}</p>
                    <p className="settings-row-description">{action.category}</p>
                  </div>
                  <div className="keymap-bindings">
                    {bindings.map((binding, index) => {
                      const active = recording?.actionId === action.id && recording.index === index
                      return (
                        <div className="flex items-center gap-0.5" key={`${action.id}-${index}`}>
                          <button
                            data-keymap-recorder
                            data-recording={`${action.id}-${index}`}
                            onClick={() => startBinding(action.id, index)}
                            onKeyDown={(event) =>
                              active && recording && recordKey(event, recording)
                            }
                            className="keymap-binding"
                          >
                            {active
                              ? recording.steps.length > 0
                                ? formatKeyBinding(recording.steps.join(' '), draft.masterKey)
                                : 'Press keys…'
                              : formatKeyBinding(binding, draft.masterKey)}
                          </button>
                          <button
                            onClick={() => removeBinding(action.id, index)}
                            className="btn-icon btn-icon-sm"
                            title="Remove binding"
                            aria-label={`Remove binding for ${action.label}`}
                          >
                            <TrashIcon className="w-3 h-3" />
                          </button>
                        </div>
                      )
                    })}
                    {adding && recording && (
                      <button
                        data-keymap-recorder
                        data-recording={`${action.id}-${bindings.length}`}
                        onKeyDown={(event) => recordKey(event, recording)}
                        className="keymap-binding"
                      >
                        {recording.steps.length > 0
                          ? formatKeyBinding(recording.steps.join(' '), draft.masterKey)
                          : 'Press keys…'}
                      </button>
                    )}
                    {bindings.length < MAX_BINDINGS_PER_ACTION && !adding && (
                      <button
                        onClick={() => startBinding(action.id, bindings.length)}
                        className="btn-icon btn-icon-sm"
                        title="Add binding"
                        aria-label={`Add binding for ${action.label}`}
                      >
                        <PlusIcon className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => resetAction(action.id)}
                      className="btn-icon btn-icon-sm"
                      title="Reset action"
                      aria-label={`Reset ${action.label}`}
                    >
                      <ArrowPathIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )
            })}
          </SettingsCard>
        ) : (
          <textarea
            data-keymap-recorder
            value={rawJson}
            onChange={(event) => {
              setRawJson(event.target.value)
              setDirty(true)
              setErrors([])
            }}
            spellCheck={false}
            className="textarea-field keymap-json"
            aria-label="Raw keymap JSON"
          />
        )}
      </SettingsSection>

      {(loadError || errors.length > 0) && (
        <div className="keymap-message" data-tone="error">
          {(errors.length > 0 ? errors : [loadError]).map((error) => (
            <p key={error}>{error}</p>
          ))}
        </div>
      )}
      {notice && <div className="keymap-message">{notice}</div>}

      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => {
            const defaults = resolveKeymapConfig()
            updateDraft(defaults)
            setRawJson(jsonFor(defaults))
          }}
          className="btn-secondary"
        >
          <ArrowPathIcon className="w-3.5 h-3.5" /> Reset all
        </button>
        <button onClick={() => void save()} className="btn-primary" disabled={!dirty}>
          Save keymaps
        </button>
      </div>
    </SettingsPage>
  )
}
