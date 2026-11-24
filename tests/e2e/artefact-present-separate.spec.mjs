// The presentation checks of artefact-present.spec.mjs with the app's server
// apart from it (`--server=separate`, what a packaged app runs): the tab's
// tools are then the standalone server's MCP, and the ask to present reaches
// the window over the server's push channel.
import { run as present } from './artefact-present.spec.mjs'

export const run = (t) => present(t, 'separate')
