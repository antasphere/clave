#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS bin, not part of the TypeScript sources */

const args = process.argv.slice(2)
const command = args[0]

async function main() {
  const { install, uninstall } = await import('../dist/install.js')

  switch (command) {
    case 'install': {
      const portArg = args.find((a) => a.startsWith('--port='))
      const port = portArg ? parseInt(portArg.split('=')[1]) : undefined
      install(port)
      break
    }
    case 'uninstall':
      uninstall()
      break
    default:
      console.log('Usage: clave-channel <install|uninstall> [--port=3100]')
      process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
