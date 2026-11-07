/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-require-imports -- plain JS, read by Metro */
// Metro for a package of this monorepo. Expo's default config already watches
// the repository root and resolves from both node_modules folders. One thing
// it cannot know: the root pins React 19.2 for the Electron renderer and this
// package pins the 19.3 React Native 0.88 needs, so npm nests the phone's
// copy under packages/mobile/node_modules. A `react` import from a hoisted
// package (react-native itself, the navigation libraries) would otherwise
// walk up to the root's copy and the bundle would carry two Reacts, which
// breaks every hook. Every `react` and `react/*` request resolves from this
// package, so the bundle holds one.
const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const config = getDefaultConfig(__dirname)
const here = path.join(__dirname, 'index.ts')
const base = config.resolver.resolveRequest
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const pinned = moduleName === 'react' || moduleName.startsWith('react/')
  const ctx = pinned ? { ...context, originModulePath: here } : context
  return base ? base(ctx, moduleName, platform) : context.resolveRequest(ctx, moduleName, platform)
}

module.exports = config
