// Attachment insertion moves the caret in a frame after the draft render.
// Wait through that frame before the fixture starts its next keyboard action.
export async function waitForAttachmentCaret(win) {
  let timer
  try {
    await Promise.race([
      win.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve))
          })
      ),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Attachment caret did not settle in 10000 ms')),
          10_000
        )
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}
