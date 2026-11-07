#!/usr/bin/env node

// Writes src/ui/tokens.generated.ts from the desktop's packages/ui/src/tokens.css.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderTokensModule, tokensFromCss } from './tokens-from-css.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const TOKENS_CSS = path.resolve(here, '..', '..', '..', 'packages', 'ui', 'src', 'tokens.css')
export const GENERATED = path.resolve(here, '..', 'src', 'ui', 'tokens.generated.ts')

const source = renderTokensModule(tokensFromCss(readFileSync(TOKENS_CSS, 'utf8')))
writeFileSync(GENERATED, source)
console.log(`wrote ${path.relative(process.cwd(), GENERATED)} (${source.length} bytes)`)
