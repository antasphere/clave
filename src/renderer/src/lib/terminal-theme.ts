import type { Theme } from '../store/session-types'
import { bundledSkins } from '@clave/skins/bundled'
import { skinToXterm, type SkinTerminalTheme } from '@clave/skins/skin-to-xterm'

let activeTheme: SkinTerminalTheme | undefined

export function setTerminalSkin(tokens: Record<string, string>): void {
  activeTheme = skinToXterm(tokens, (value) => {
    // xterm accepts hex/rgb colors, but skins also accept modern CSS colors.
    // Keep legacy strings intact; resolve other CSS colors through the browser.
    if (
      /^#[\da-f]{3,8}$/i.test(value) ||
      /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|\d?\.\d+)\s*)?\)$/i.test(
        value
      )
    )
      return value
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')!
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
    return `rgba(${r}, ${g}, ${b}, ${a / 255})`
  })
}

export function getXtermTheme(theme: Theme): SkinTerminalTheme {
  return (
    activeTheme ??
    skinToXterm((bundledSkins.find((skin) => skin.id === theme) ?? bundledSkins[0]).tokens)
  )
}
