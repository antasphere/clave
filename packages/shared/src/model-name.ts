/**
 * Model references shared by process launches and chat model switches.
 * Allow aliases, provider-qualified ids, and a trailing context size such as
 * `opus[1m]`. Brackets elsewhere, shell syntax, and leading flags stay invalid.
 */
export function isValidModelName(model: string): boolean {
  if (model.length > 200 || model.includes('..')) return false
  return /^[A-Za-z0-9](?:[A-Za-z0-9._/:-]*[A-Za-z0-9])?(?:\[[1-9][0-9]*[km]\])?$/.test(model)
}
