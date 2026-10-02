/**
 * The framework's http package reaches the `Bun` global in its static-asset
 * module (`Bun.file`, `@structure-ai/http/src/static.ts`). Nothing in Clave
 * serves static assets through it, and under Node that line never runs; this
 * declaration only lets the framework's TypeScript source typecheck in a
 * project that has Node's types and not Bun's.
 */
declare const Bun: {
  file(path: string): Blob & { readonly type: string }
}
