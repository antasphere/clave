// Passed directly to page.evaluate: keep it independent of module scope.
export function captureRevealMarkerOnClick(id) {
  const button = document.querySelector(`[data-sidebar-item-id="${id}"] > button`)
  if (!button) throw new Error('The reveal button is missing')
  window.__responsivenessRevealMarker = new Promise((resolve) => {
    button.addEventListener(
      'click',
      () => resolve(window.__responsivenessChunks.at(-1)?.match(/^chunk\d{6}/)?.[0]),
      { once: true, capture: true }
    )
  })
}
