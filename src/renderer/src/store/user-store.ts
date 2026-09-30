import { create } from 'zustand'
import { isPaletteKey, seedFromString, type PaletteKey } from '../lib/brand-field'

export const USER_ICONS = [
  'user',
  'code',
  'terminal',
  'rocket',
  'bolt',
  'fire',
  'heart',
  'star',
  'moon',
  'sun',
  'cube',
  'beaker'
] as const

export type UserIcon = (typeof USER_ICONS)[number]

const DEFAULT_ICON: UserIcon = 'rocket'

/**
 * What a profile used to be: an icon on a flat 20%-alpha wash of one of eight
 * hexes. The wash is gone — the avatar is an Antasphere field now — but a
 * saved hex still has to land somewhere, so each one maps to the palette
 * nearest it in temperature. Read once, at load; nothing writes hexes again.
 */
const LEGACY_COLOR_TO_PALETTE: Record<string, PaletteKey> = {
  '#95979c': 'basalt',
  '#5e6ad2': 'iris',
  '#8b95a8': 'tide',
  '#4cb782': 'reef',
  '#53b7c5': 'glacier',
  '#db8b4e': 'furnace',
  '#d45461': 'dawn',
  '#e8b931': 'solar',
  '#007aff': 'glacier'
}

// Iris: a cool violet, the palette nearest the indigo Clave's accent used to
// be, so a profile nobody has touched keeps the look it always had.
const DEFAULT_PALETTE: PaletteKey = 'iris'

interface UserProfile {
  name: string
  avatarIcon: UserIcon
  /** The generative field behind the icon — an Antasphere palette key. */
  avatarField: PaletteKey
  /** Which draw of that palette. Derived from the name until someone rerolls it. */
  avatarSeed: number
}

interface UserState extends UserProfile {
  setName: (name: string) => void
  setAvatarIcon: (icon: UserIcon) => void
  setAvatarField: (field: PaletteKey) => void
  /** Redraw the field: a new seed, same palette. */
  reseedAvatar: () => void
}

const STORAGE_KEY = 'clave-user-profile'

function loadProfile(): UserProfile {
  const fallback = (name = 'User'): UserProfile => ({
    name,
    avatarIcon: DEFAULT_ICON,
    avatarField: DEFAULT_PALETTE,
    avatarSeed: seedFromString(name)
  })
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback()
    const parsed = JSON.parse(raw)
    const name = typeof parsed.name === 'string' ? parsed.name : 'User'
    const legacy =
      typeof parsed.avatarColor === 'string'
        ? LEGACY_COLOR_TO_PALETTE[parsed.avatarColor.toLowerCase()]
        : undefined
    return {
      name,
      avatarIcon: parsed.avatarIcon ?? DEFAULT_ICON,
      avatarField: isPaletteKey(parsed.avatarField)
        ? parsed.avatarField
        : (legacy ?? DEFAULT_PALETTE),
      avatarSeed:
        typeof parsed.avatarSeed === 'number' && Number.isFinite(parsed.avatarSeed)
          ? parsed.avatarSeed
          : seedFromString(name)
    }
  } catch {
    return fallback()
  }
}

function persist(profile: Partial<UserProfile>): void {
  const current = loadProfile()
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...profile }))
}

export function getInitials(name: string): string {
  if (!name) return 'U'
  return name
    .split(' ')
    .map((w) => w[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

export const useUserStore = create<UserState>((set, get) => ({
  ...loadProfile(),

  setName: (name) => {
    // A field the user has never touched follows the name, so the first thing
    // they see is *their* draw rather than the default one.
    const untouched = get().avatarSeed === seedFromString(get().name)
    const next = untouched ? { name, avatarSeed: seedFromString(name) } : { name }
    persist(next)
    set(next)
  },

  setAvatarIcon: (avatarIcon) => {
    persist({ avatarIcon })
    set({ avatarIcon })
  },

  setAvatarField: (avatarField) => {
    persist({ avatarField })
    set({ avatarField })
  },

  reseedAvatar: () => {
    const avatarSeed = Math.floor(Math.random() * 0x7fffffff)
    persist({ avatarSeed })
    set({ avatarSeed })
  }
}))

// Land the migration rather than re-deriving it on every load: a profile saved
// by an older build carries a hex and no seed, and leaving it that way means the
// user's field would silently change the day LEGACY_COLOR_TO_PALETTE does.
const profile = loadProfile()
persist(profile)

// If no custom name has been saved, resolve the OS username as the default
if (profile.name === 'User' && window.electronAPI?.getUsername) {
  window.electronAPI
    .getUsername()
    .then((osName) => {
      if (osName) {
        useUserStore.getState().setName(osName)
      }
    })
    .catch(() => {})
}
