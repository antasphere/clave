import { describe, expect, it } from 'vitest'
import { savesSomething } from './linked-status'

describe("the linked document panel's Saving status", () => {
  it('is for what is saved: typing, an email field, a hidden or resized panel', () => {
    expect(savesSomething({ content: 'new words' })).toBe(true)
    expect(savesSomething({ hidden: true })).toBe(true)
    expect(savesSomething({ split: 0.4 })).toBe(true)
  })

  it('is not for a read of the file from disk, the one made at open included', () => {
    expect(savesSomething({ reloadExternal: true })).toBe(false)
    expect(savesSomething({ reloadExternal: true, ifChanged: true })).toBe(false)
  })
})
