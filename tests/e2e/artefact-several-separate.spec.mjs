// The several-artefacts checks of artefact-several.spec.mjs with the app's
// server apart from it (`--server=separate`, what a packaged app runs): the
// tab's tools are the standalone server's MCP, the lists reach the window
// over the server's push channel.
import { run as several } from './artefact-several.spec.mjs'

export const run = (t) => several(t, 'separate')
