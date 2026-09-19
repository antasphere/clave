import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import postcss from 'postcss'
const root = fileURLToPath(new URL('../', import.meta.url))
const css = postcss.parse(readFileSync(`${root}../ui/src/tokens.css`, 'utf8'))
const excluded = new Set(JSON.parse(readFileSync(`${root}excluded-token-names.json`, 'utf8')))
const names = new Set()
css.walkDecls((d) => {
  if (d.prop.startsWith('--') && !excluded.has(d.prop)) names.add(d.prop)
})
writeFileSync(`${root}token-names.json`, JSON.stringify([...names].sort(), null, 2) + '\n')
const defaults = {}
css.walkAtRules('theme', (rule) =>
  rule.walkDecls((d) => {
    if (names.has(d.prop)) defaults[d.prop] = d.value
  })
)
const themes = {}
css.walkRules((rule) => {
  const id = rule.selector.match(/\[data-theme="(.*?)"\]/)?.[1]
  if (!id) return
  themes[id] = {}
  rule.walkDecls((d) => {
    if (names.has(d.prop)) themes[id][d.prop] = d.value
  })
})
for (const id of ['dark', 'charcoal', 'light', 'coffee']) {
  const dir = `${root}skins/${id}`
  mkdirSync(dir, { recursive: true })
  const tokens = { ...defaults, ...themes.dark, ...themes[id] }
  writeFileSync(`${dir}/skin.json`, JSON.stringify(tokens, null, 2) + '\n')
  writeFileSync(
    `${dir}/clave-plugin.json`,
    JSON.stringify(
      {
        kind: 'skin',
        id,
        name: id[0].toUpperCase() + id.slice(1),
        version: '1.0.0',
        engines: { clave: '>=1.90.2' },
        skin: { tokens: 'skin.json', base: ['light', 'coffee'].includes(id) ? 'light' : 'dark' }
      },
      null,
      2
    ) + '\n'
  )
}
