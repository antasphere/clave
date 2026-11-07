# Repository layout

Runnable products and process entrypoints live under `apps/`. Code reused by
those programs lives under `packages/`. Start at an app's entrypoint to trace
startup, or at a package to find the implementation shared by clients.

```text
apps/
  desktop/          Electron main entry, preload and React renderer
  mobile/           Expo app, platform adapters and phone screens
  server/           Standalone server bootstrap
  terminals/        Node process that owns terminal PTYs
  plugin-runner/    Isolated plugin process bootstrap
  relay/            Relay bootstrap, Dockerfile and runtime lock projection
  channel/          Published OpenClaw channel and clave-channel command
  plugins/          Bundled plugins, including Analytics and GitHub
  native/           C and Swift helper programs
  pi-state/         Pi session-state extension
packages/
  host/             Host services and integrations used by desktop and server
  shared/           Common models, schemas and pure utilities
  server/           Server API, persistence and services
  contract/         API contracts, wire models and generated protocol types
  client/           API clients and connection routing
  analytics/        Analytics collection, ledger, server and viewer logic
  clave-channel/    Reusable OpenClaw channel implementation
  ui/               Shared design tokens, styles and components
  skins/            Skin definitions and validation
  plugin-sdk/       Plugin authoring contracts
```

`packages/host` includes Electron integrations as well as Node services. Only
the Electron app calls those integrations; a standalone server does not load
them. Keeping a common host package preserves the existing module boundaries
while giving both bootstraps one implementation of sessions and settings.

App-specific code stays with its app. Extract code to a package when another
app needs it. Production package imports must not point into `apps/`. Tests
may import app entrypoints to verify integration. `npm run check:structure`
checks these rules and the required program locations.

The root owns the single npm lockfile and dependency installation, shared
tool configuration, release tooling, integration tests and documentation.
`scripts/` contains repository maintenance commands. `build/`, `assets/` and
`resources/` hold packaging assets; generated native helpers and the Pi
extension are copied into `resources/` during builds. The agent skills in
`plugin/` retain their independently installed marketplace path.

## Commands

Install once from the repository root with `npm ci`. There is no install step
inside an app. Existing root commands remain available.

| Command from the root | Result |
| --- | --- |
| `npm run dev` | Desktop development app |
| `npm run dev:attached` | Desktop connected to a separate local server |
| `npm run dev:server` | Standalone local server |
| `npm start --workspace @clave/mobile` | Mobile Metro development server |
| `npm run build` | Native helpers, typechecks and desktop bundles |
| `npm run build --workspace @codika-io/clave-channel` | Publishable channel output and CLI |
| `npm run check:structure` | App/package placement and dependency direction |
| `npm test` | Structure, style-token audit and desktop/shared unit tests |
| `npm test --workspace @clave/mobile` | Mobile unit tests |
| `npm run typecheck --workspace @clave/mobile` | Mobile TypeScript check |
| `npm run test:e2e` | Electron integration tests |

Electron build configuration stays at the root because it builds several
processes together. Its output remains `out/main/`, `out/preload/` and
`out/renderer/`, including the standalone server and worker bundles. Those
runtime paths are independent of the source layout. Signing, release
promotion, relay deployment and mobile native builds still use their
existing documented procedures.
