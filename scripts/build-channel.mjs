/* eslint-disable @typescript-eslint/explicit-function-return-type -- Build tooling. */
import { cpSync } from 'node:fs'
cpSync(
  new URL('../packages/clave-channel/dist/', import.meta.url),
  new URL('../apps/channel/dist/', import.meta.url),
  { recursive: true }
)
