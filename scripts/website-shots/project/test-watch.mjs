// What `npm test -- --watch` prints in the shop's "tests" tab: a finished run,
// then the watcher waiting for changes.
const dim = (s) => `\x1b[2m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const bold = (s) => `\x1b[1m${s}\x1b[0m`

const lines = [
  '',
  '> atelier-nord-shop@0.4.0 test',
  '> vitest --watch',
  '',
  ` ${bold('DEV')}  v3.2.4 ${dim('/atelier-nord')}`,
  '',
  ` ${green('✓')} src/lib/validate.test.ts ${dim('(18 tests) 12ms')}`,
  ` ${green('✓')} src/checkout/CheckoutForm.test.tsx ${dim('(14 tests) 48ms')}`,
  ` ${green('✓')} src/cart/cart.test.ts ${dim('(9 tests) 4ms')}`,
  '',
  ` ${dim('Test Files')}  ${green('3 passed')} ${dim('(3)')}`,
  `      ${dim('Tests')}  ${green('41 passed')} ${dim('(41)')}`,
  `   ${dim('Start at')}  10:42:17`,
  `   ${dim('Duration')}  1.84s`,
  '',
  ` ${bold('PASS')}  ${dim('Watching for file changes...')}`,
  `       ${dim('press h to show help, press q to quit')}`
]
for (const line of lines) console.log(line)
setInterval(() => {}, 60_000)
