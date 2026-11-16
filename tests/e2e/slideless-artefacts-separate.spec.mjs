// The artefact checks of slideless-artefacts.spec.mjs with the app's server
// apart from it (`--server=separate`, what a packaged app runs).
//
// What this mode adds to the proof: a tab that runs in a terminal says a turn
// ended through its lifecycle hooks, which write under the SERVER's data
// folder. The standalone entry reads them (PRDCT-4472); before it did, such a
// tab never said a turn had ended to a server running on its own, and the
// five checks on the versions a finished turn saves were red here: "a
// finished turn saves version 1", "the next finished turn saves version 2",
// "a turn that changed nothing saves no version", "the panel's version bar
// lists both versions" and "a turn ended while the panel is hidden still
// saves a version, on the server".
import { run as artefacts } from './slideless-artefacts.spec.mjs'

export const run = (t) => artefacts(t, 'separate')
