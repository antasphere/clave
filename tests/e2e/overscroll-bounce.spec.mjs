// The native macOS rubber-band at the ends of a scroll area (PRDCT-4097).
//
// The bounce is Chromium's own, nothing of ours draws it, but it only shows
// when three things hold at once, and each one alone looks like "nothing
// happens" — which is how two earlier attempts went in circles:
//
//   1. Chromium 152+ (Electron 44+): the first to stretch a NON-root scroller,
//      and every scroller of ours is one. Electron 39 (Chromium 142) could not.
//   2. `scrollBounce: true` on the window: Electron's own patch ties Chromium's
//      elastic overscroll to the `--scroll-bounce` renderer switch, default off.
//   3. `overscroll-behavior: contain` on the pane's scroller: at its end, a
//      chaining (`auto`) scroller hands the gesture up to the root, and the
//      root never scrolls here (`overflow: hidden`), so the gesture latches
//      nowhere. `contain` makes the scroller latch itself and stretch.
//
// The stretch itself is a compositor transform no DOM property shows, and a
// hidden test window composites no frames — so this spec guards the three
// conditions, not the pixels. The pixels were proved by hand and by a
// DevTools-driven gesture on a visible window (6 November 2026).
import { execSync } from 'node:child_process'
import { launchApp, userDataDir } from './harness.mjs'

const DIR = userDataDir('clave-e2e-overscroll-bounce')

export async function run(t) {
  const { app, win } = await launchApp(DIR)
  try {
    const chrome = await app.evaluate(() => process.versions.chrome)
    t.check(
      `Chromium ${chrome} is 152 or later, where a nested scroller can stretch`,
      Number(chrome.split('.')[0]) >= 152,
      chrome
    )

    if (process.platform === 'darwin') {
      const pid = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
      )
      const args = execSync(`ps -o args= -p ${pid}`).toString()
      t.check(
        'the renderer process carries the --scroll-bounce switch the window asked for',
        args.includes('--scroll-bounce')
      )
    }

    const styles = await win.evaluate(() => {
      const read = (el) => getComputedStyle(el).overscrollBehavior
      // Pane scrollers that need no session on screen: the sidebar's own
      // viewport, and the stylesheet rules read off throwaway elements.
      const probe = (className) => {
        const el = document.createElement('div')
        el.className = className
        document.body.appendChild(el)
        const value = read(el)
        el.remove()
        return value
      }
      return {
        html: read(document.documentElement),
        body: read(document.body),
        sidebar: read(document.querySelector('[data-radix-scroll-area-viewport]')),
        transcript: probe('chat-scroll'),
        settings: probe('settings-scroller'),
        panel: probe('flex-1 overflow-y-auto overscroll-contain')
      }
    })
    // `none` on the document would switch the stretch off for every scroller
    // (Chromium reads the root policy for each gesture); `auto` is what it is.
    t.equal('the document keeps overscroll-behavior auto', styles.html, 'auto')
    t.equal('and so does the body', styles.body, 'auto')
    t.equal('the sidebar viewport contains its overscroll', styles.sidebar, 'contain')
    t.equal('the transcript scroller contains its overscroll', styles.transcript, 'contain')
    t.equal('the settings scroller contains its overscroll', styles.settings, 'contain')
    t.equal('a side panel scroller contains its overscroll', styles.panel, 'contain')
  } finally {
    await app.close()
  }
}
