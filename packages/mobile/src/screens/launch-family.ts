import type { IconName } from '../ui/Icon'

/** The family's mark on a launch row: the desktop's own vendor marks
 *  (cli-logos.tsx) for the agents it knows, the terminal glyph otherwise. */
export const familyIcon = (family: string): { name: IconName; brand?: 'claude' } =>
  family === 'claude'
    ? { name: 'logo-claude', brand: 'claude' }
    : family === 'codex'
      ? { name: 'logo-codex' }
      : family === 'pi'
        ? { name: 'logo-pi' }
        : family === 'antigravity'
          ? { name: 'logo-antigravity' }
          : { name: 'command-line' }
