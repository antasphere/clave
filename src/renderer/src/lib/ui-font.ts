/**
 * Appearance → Font: the face the chrome is set in.
 *
 * Geist ships with the app (@fontsource). Synonym, the website's body face, is
 * under a licence that forbids redistributing the file through a repository,
 * so it is never committed here: scripts/copy-private-fonts.mjs copies it from
 * the private workspace into a git-ignored folder at build time. The glob below
 * finds it when it was copied and finds nothing when it was not (a fork, CI),
 * and a font that is not in the build is simply not offered.
 *
 * Synonym carries the website's three corrections (company/website,
 * src/styles/global.css): size-adjust 104% on the face, and weight 450 with
 * -0.008em tracking on the root — see [data-ui-font='synonym'] in main.css.
 */
const PRIVATE_FONTS = import.meta.glob('../assets/fonts/private/*.woff2', {
  eager: true,
  query: '?url',
  import: 'default'
}) as Record<string, string>

const synonymUrl = Object.entries(PRIVATE_FONTS).find(([file]) =>
  file.endsWith('/Synonym-Variable.woff2')
)?.[1]

export const UI_FONTS = [
  { id: 'geist', label: 'Geist', available: true },
  { id: 'synonym', label: 'Synonym', available: synonymUrl !== undefined }
] as const

export type UiFont = (typeof UI_FONTS)[number]['id']

export const DEFAULT_UI_FONT: UiFont = 'geist'

/** The saved font, checked against the table AND against this build: a font
 *  saved on a build that bundled it falls back to Geist on one that does not. */
export function resolveUiFont(saved: string | null): UiFont {
  const font = UI_FONTS.find((f) => f.id === saved)
  return font && font.available ? font.id : DEFAULT_UI_FONT
}

let synonymLoaded: Promise<void> | null = null

/** Register the face once, the first time it is picked. */
export function loadUiFont(font: UiFont): Promise<void> {
  if (font !== 'synonym' || !synonymUrl) return Promise.resolve()
  if (!synonymLoaded) {
    const face = new FontFace('Synonym', `url(${synonymUrl}) format('woff2')`, {
      weight: '200 700',
      style: 'normal',
      display: 'swap'
    })
    // size-adjust is a descriptor the FontFace constructor does not type yet.
    ;(face as FontFace & { sizeAdjust: string }).sizeAdjust = '104%'
    synonymLoaded = face.load().then((loaded) => {
      document.fonts.add(loaded)
    })
  }
  return synonymLoaded
}
