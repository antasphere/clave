/**
 * The two deadlines of a view request, in a module of their own with no
 * import at all: Electron main reads them at boot (the bridge's default
 * timeout, the client's ceiling), and `views.ts` beside them is built on
 * Effect Schema and the framework, which main must never load before its
 * first server call (`src/main/server/lazy-load.test.ts`). `views.ts`
 * re-exports them, so a reader of the domain sees one surface.
 */

/** How long a request waits for its window when the caller names no deadline. */
export const VIEW_REQUEST_TIMEOUT_MS = 10_000
/** The longest deadline a caller may ask for. */
export const VIEW_REQUEST_MAX_TIMEOUT_MS = 60_000
