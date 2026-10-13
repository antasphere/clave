import { afterEach, describe, expect, it } from 'vitest'
import { childrenOf, forgetLineage, parentOf, resetLineageForTests, setParent } from './lineage'

afterEach(() => resetLineageForTests())

describe('the parent link', () => {
  it('answers the opener of a tab, and the tabs an opener opened', () => {
    setParent('child', 'parent')
    setParent('other', 'parent')
    expect(parentOf('child')).toBe('parent')
    expect(parentOf('parent')).toBeNull()
    expect(childrenOf('parent').sort()).toEqual(['child', 'other'])
  })
  it('is forgotten with the tab, and never survives a reset', () => {
    setParent('child', 'parent')
    forgetLineage('child')
    expect(parentOf('child')).toBeNull()
    setParent('child', 'parent')
    resetLineageForTests()
    expect(parentOf('child')).toBeNull()
  })
})
