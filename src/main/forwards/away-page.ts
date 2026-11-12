/**
 * What a forwarded page shows while the server behind it cannot show it
 * (PRDCT-4473): one self-contained page, no script and nothing fetched, so
 * it renders whatever else is down. It reloads itself every three seconds
 * and the page comes back on its own once the server does; a refused token
 * is the exception, since no number of reloads will mend it.
 */

export type AwayReason = 'unreachable' | 'refused' | 'gone'

const TITLES: Record<AwayReason, string> = {
  unreachable: 'This page is on a server Clave cannot reach right now.',
  refused: "The server refused this Mac's saved token.",
  gone: 'The server stopped showing this page.'
}

const LINES: Record<AwayReason, string> = {
  unreachable: 'Clave is trying again.',
  refused: 'Enter the token again in Settings, under Servers.',
  gone: 'Clave is trying again.'
}

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, '&#39;')

export const awayPage = (reason: AwayReason): string => {
  const refresh = reason === 'refused' ? '' : '<meta http-equiv="refresh" content="3">'
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
${refresh}
<title>${escape(TITLES[reason])}</title>
<style>
  :root { color-scheme: light dark; background: Canvas; color: CanvasText; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 4px; padding: 24px; box-sizing: border-box; text-align: center;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
  }
  h1 { margin: 0; font-size: 15px; font-weight: 400; }
  p { margin: 0; opacity: 0.65; }
</style>
</head>
<body>
<h1>${escape(TITLES[reason])}</h1>
<p>${escape(LINES[reason])}</p>
</body>
</html>
`
}
