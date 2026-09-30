# Clave UI conventions — the field guide

Read [the @clave/ui field guide](packages/ui/README.md) before writing UI.
The class reference and the two cascade/token rules now live with the package.

- Tokens: `packages/ui/src/tokens.css`
- Unlayered semantic classes: `packages/ui/src/system.css`
- React primitives: `@clave/ui/components`
- App-only styling: `src/renderer/src/assets/main.css`

Extend the package for shared controls; keep feature-only rules in the app.
