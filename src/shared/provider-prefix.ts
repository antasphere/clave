/**
 * The prefix of a provider Clave declares for a stored connection (PRDCT-4496):
 * `clave-<company>`, written into that connection's own Pi directory only.
 * Pure, so the main process and the renderer read the same word.
 */
export const CLAVE_PROVIDER_PREFIX = 'clave-'
