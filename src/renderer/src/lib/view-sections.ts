import type { ExtensionsSection, SettingsSection } from '../store/session-types'

/** The name of each Settings page, as its row in the settings sidebar writes it. The sidebar
 *  and the Back and Forward lists (`navigation-place.ts`) both read it from here. */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsSection, string>> = {
  general: 'General',
  appearance: 'Appearance',
  audio: 'Audio',
  keymaps: 'Keymaps',
  agents: 'Harnesses',
  helpers: 'Helpers',
  styles: 'Writing styles',
  integrations: 'Integrations',
  slideless: 'Slideless',
  accounts: 'Connections',
  usage: 'Usage',
  activity: 'Activity',
  servers: 'Servers',
  mobile: 'Mobile',
  plugins: 'Plugins',
  updates: 'Software Update'
}

/** The name of each Extensions page, as the extensions sidebar writes it. */
export const EXTENSIONS_SECTION_LABELS: Readonly<Record<ExtensionsSection, string>> = {
  marketplaces: 'Marketplaces',
  mcp: 'MCP Servers'
}
