/**
 * Every decision Clave declares, in one place (PRDCT-5179), as the helpers'
 * catalog does (`../helpers/catalog.ts`): importing this file declares them
 * all, so `listDecisions()` knows each one whichever entry loads it, and the
 * Settings page lists them with no change of its own. A new decision is one
 * more line here. Pure: the declarations send nothing, so the standalone
 * server's settings graph can load it.
 */
export { tabProjectDecision } from './tab-project'
