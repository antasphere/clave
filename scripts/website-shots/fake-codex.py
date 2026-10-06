"""A stand-in for the Codex CLI in the "Verifier" tab: it prints a short,
plausible review and then sets the terminal title Clave reads for Codex's
state, so the tab shows as waiting on the user. Nothing is called."""
import sys
import time

def title(value):
    sys.stdout.write('\x1b]0;' + value + '\x07')
    sys.stdout.flush()

DIM = '\x1b[2m'
BOLD = '\x1b[1m'
GREEN = '\x1b[32m'
CYAN = '\x1b[36m'
RESET = '\x1b[0m'

title('codex | Working')
lines = [
    f'{BOLD}› Review lane/checkout against the brief{RESET}',
    '',
    f'{CYAN}•{RESET} Read src/checkout/CheckoutForm.tsx',
    f'{CYAN}•{RESET} Read src/lib/validate.ts',
    f'{CYAN}•{RESET} Ran npm test -- validate',
    f'  {DIM}└ 18 passed{RESET}',
    '',
    'The address rules match the brief. Two notes:',
    '',
    f'  1. {BOLD}validate.ts:24{RESET} a postal code of only',
    '     spaces passes the length check',
    f'  2. {BOLD}CheckoutForm.tsx:61{RESET} focus does not move',
    '     to the first invalid field on mobile',
    '',
    f'{GREEN}Both are small.{RESET} Patch them on this branch?',
    '',
    f'{DIM}› yes / no{RESET}',
]
for line in lines:
    print(line, flush=True)
    time.sleep(0.03)
title('[ ! ] Action Required | codex')
for line in sys.stdin:
    if line.strip() == 'exit':
        break
