import type { WebviewTag } from 'electron'

/** Enumerate the computed custom properties, including tokens introduced by a skin.
 * No mirrored token inventory: the live app stylesheet is the authority. Each value is
 * `!important`: a sheet inserted into a guest sits BEFORE the page's own in the cascade,
 * so a page that declares the same tokens itself (the analytics pages and the routine
 * decks carry the app's tokens so they also stand alone in a browser) would otherwise
 * win on equal specificity and never follow the app's theme. The density presets and
 * the text size resolve on the app's root too, so a page gets Appearance whole. */
export function themeCSS(): string {
  const style = getComputedStyle(document.documentElement)
  return `:root {${Array.from(style)
    .filter((name) => name.startsWith('--'))
    .map((name) => `${name}: ${style.getPropertyValue(name)} !important;`)
    .join('\n')}}`
}

/** Keep a guest page on the app's theme: the root's tokens inserted at `dom-ready` and
 *  again whenever the app's root or head changes. Returns the detach. */
export function attachGuestTheme(
  guest: WebviewTag,
  onError: (message: string) => void = () => {}
): () => void {
  let disposed = false
  let cssKey: string | undefined
  let ready = false
  let queue = Promise.resolve()
  const inject = (): void => {
    queue = queue
      .then(async () => {
        if (!ready || disposed) return
        const next = await guest.insertCSS(themeCSS())
        if (cssKey) await guest.removeInsertedCSS(cssKey)
        cssKey = next
      })
      .catch((error) => {
        if (!disposed) onError(String(error))
      })
  }
  const loaded = (): void => {
    ready = true
    inject()
  }
  guest.addEventListener('dom-ready', loaded)
  const observer = new MutationObserver(inject)
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme', 'data-density', 'style', 'class']
  })
  observer.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true
  })
  return () => {
    disposed = true
    observer.disconnect()
    guest.removeEventListener('dom-ready', loaded)
  }
}
