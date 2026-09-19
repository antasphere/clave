import { useEffect, useRef, useState } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { AnimatePresence } from 'framer-motion'
import { ModalScrim, ModalPositioner } from '@clave/ui/components'
import { type GroupTerminalColor, type GroupTerminalIcon, GROUP_TERMINAL_ICONS } from '../../store/session-store'
import ColorPicker from './ColorPicker'
import {
  FolderIcon,
  CommandLineIcon,
  FireIcon,
  BoltIcon,
  RocketLaunchIcon,
  EyeIcon,
  GlobeAltIcon,
  CubeIcon,
  HeartIcon,
  StarIcon,
  UserIcon,
  ShieldCheckIcon,
  WrenchIcon,
  BeakerIcon,
  CpuChipIcon,
  SignalIcon,
  BugAntIcon,
  SparklesIcon,
  CloudIcon
} from '@heroicons/react/24/outline'
import { cn } from '@clave/ui/components'

const ICON_COMPONENTS: Record<GroupTerminalIcon, React.ComponentType<React.SVGProps<SVGSVGElement>>> = {
  terminal: CommandLineIcon,
  fire: FireIcon,
  bolt: BoltIcon,
  rocket: RocketLaunchIcon,
  eye: EyeIcon,
  globe: GlobeAltIcon,
  cube: CubeIcon,
  heart: HeartIcon,
  star: StarIcon,
  user: UserIcon,
  shield: ShieldCheckIcon,
  wrench: WrenchIcon,
  beaker: BeakerIcon,
  cpu: CpuChipIcon,
  signal: SignalIcon,
  bug: BugAntIcon,
  sparkles: SparklesIcon,
  cloud: CloudIcon
}

export function getTerminalIconComponent(icon?: GroupTerminalIcon): React.ComponentType<React.SVGProps<SVGSVGElement>> {
  return ICON_COMPONENTS[icon ?? 'terminal'] ?? CommandLineIcon
}

interface GroupCommandDialogProps {
  isOpen: boolean
  onSave: (command: string, mode: 'prefill' | 'auto', color: GroupTerminalColor, cwd: string | null, icon: GroupTerminalIcon) => void
  onCancel: () => void
  onDelete?: () => void
  initialCommand?: string | null
  initialMode?: 'prefill' | 'auto'
  initialColor?: GroupTerminalColor
  initialCwd?: string | null
  initialIcon?: GroupTerminalIcon
}

export function GroupCommandDialog({
  isOpen,
  onSave,
  onCancel,
  onDelete,
  initialCommand,
  initialMode = 'prefill',
  initialColor = 'blue',
  initialCwd = null,
  initialIcon = 'terminal'
}: GroupCommandDialogProps) {
  const [command, setCommand] = useState(initialCommand ?? '')
  const [mode, setMode] = useState<'prefill' | 'auto'>(initialMode)
  const [color, setColor] = useState<GroupTerminalColor>(initialColor)
  const [cwd, setCwd] = useState<string | null>(initialCwd)
  const [icon, setIcon] = useState<GroupTerminalIcon>(initialIcon)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isOpen) {
      setCommand(initialCommand ?? '')
      setMode(initialMode)
      setColor(initialColor)
      setCwd(initialCwd)
      setIcon(initialIcon)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen, initialCommand, initialMode, initialColor, initialCwd, initialIcon])

  const handleSave = () => {
    onSave(command.trim(), mode, color, cwd, icon)
  }

  const handlePickFolder = async () => {
    // Open the native picker at the group root (or the terminal's current cwd
    // when editing) instead of the OS default location.
    const folder = await window.electronAPI.openFolderDialog(cwd ?? undefined)
    if (folder) {
      setCwd(folder)
    }
  }

  const folderName = cwd ? cwd.split('/').pop() || cwd : null

  return (
    <DialogPrimitive.Root open={isOpen} onOpenChange={(open) => { if (!open) onCancel() }}>
      <AnimatePresence>
        {isOpen && (
          <DialogPrimitive.Portal forceMount>
            <DialogPrimitive.Overlay asChild>
              <ModalScrim />
            </DialogPrimitive.Overlay>
            <DialogPrimitive.Content
              asChild
              onOpenAutoFocus={(e) => e.preventDefault()}
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <ModalPositioner className="w-[320px]">
                <div className="modal-card">
                  <div className="px-4 pt-4 pb-3">
                    <DialogPrimitive.Title className="text-[13px] font-semibold text-text-primary">
                      {onDelete ? 'Edit terminal' : 'Add terminal'}
                    </DialogPrimitive.Title>
                    <DialogPrimitive.Description className="mt-1 text-xs text-text-secondary">
                      Configure a terminal for this group.
                    </DialogPrimitive.Description>

                    {/* Folder picker */}
                    <button
                      type="button"
                      onClick={handlePickFolder}
                      className="mt-3 w-full h-8 px-3 rounded-lg bg-surface-100 border border-border-subtle flex items-center gap-2 text-xs hover:bg-surface-200 transition-colors group"
                      title={cwd ?? 'Select folder'}
                    >
                      <FolderIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                      <span className="flex-1 min-w-0 truncate text-left text-text-primary">
                        {folderName ?? 'Select folder...'}
                      </span>
                      <span className="text-[10px] text-text-tertiary group-hover:text-text-secondary flex-shrink-0">
                        Change
                      </span>
                    </button>

                    {/* Command input */}
                    <input
                      ref={inputRef}
                      type="text"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          handleSave()
                        }
                      }}
                      placeholder="e.g., npm run dev (optional)"
                      className="mt-2 w-full h-8 px-3 rounded-lg bg-surface-100 border border-border-subtle text-xs text-text-primary placeholder:text-text-tertiary outline-none focus:ring-1 focus:ring-accent transition-colors"
                    />

                    <div className="mt-3 flex items-center gap-3">
                      <span className="text-xs text-text-secondary">Mode:</span>
                      <div className="flex rounded-lg overflow-hidden border border-border-subtle">
                        <button
                          type="button"
                          onClick={() => setMode('prefill')}
                          className={`px-3 py-1 text-[11px] font-medium transition-colors ${
                            mode === 'prefill'
                              ? 'bg-surface-200 text-text-primary'
                              : 'bg-surface-100 text-text-tertiary hover:text-text-secondary'
                          }`}
                        >
                          Pre-fill
                        </button>
                        <button
                          type="button"
                          onClick={() => setMode('auto')}
                          className={`px-3 py-1 text-[11px] font-medium transition-colors border-l border-border-subtle ${
                            mode === 'auto'
                              ? 'bg-surface-200 text-text-primary'
                              : 'bg-surface-100 text-text-tertiary hover:text-text-secondary'
                          }`}
                        >
                          Auto-execute
                        </button>
                      </div>
                    </div>

                    {/* Icon picker */}
                    <div className="mt-3 flex flex-col gap-2">
                      <span className="text-xs text-text-secondary">Icon:</span>
                      <div className="flex items-center gap-1 flex-wrap">
                        {GROUP_TERMINAL_ICONS.map((iconName) => {
                          const IconComp = ICON_COMPONENTS[iconName]
                          return (
                            <button
                              key={iconName}
                              type="button"
                              onClick={() => setIcon(iconName)}
                              className={cn(
                                'p-1.5 rounded-lg transition-colors',
                                icon === iconName
                                  ? 'bg-surface-200 text-text-primary'
                                  : 'text-text-tertiary hover:text-text-secondary hover:bg-surface-100'
                              )}
                              title={iconName}
                            >
                              <IconComp className="w-4 h-4" />
                            </button>
                          )
                        })}
                      </div>
                    </div>

                    <div className="mt-3 flex flex-col gap-2">
                      <span className="text-xs text-text-secondary">Color:</span>
                      <ColorPicker
                        value={color}
                        onChange={(c) => setColor(c ?? 'blue')}
                        showNoColor={false}
                      />
                    </div>
                  </div>
                  <div className="border-t border-border-subtle flex">
                    {onDelete && (
                      <button
                        type="button"
                        onClick={onDelete}
                        className="btn-dialog text-red-400 hover:text-red-300 border-r border-border-subtle"
                      >
                        Delete
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={onCancel}
                      className="btn-dialog text-text-secondary hover:text-text-primary border-r border-border-subtle"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={handleSave}
                      className="btn-dialog text-accent hover:brightness-110 outline-none"
                    >
                      Save
                    </button>
                  </div>
                </div>
              </ModalPositioner>
            </DialogPrimitive.Content>
          </DialogPrimitive.Portal>
        )}
      </AnimatePresence>
    </DialogPrimitive.Root>
  )
}
