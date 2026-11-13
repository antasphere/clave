/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain Node CI tests. */
import { describe, it, expect } from 'vitest'
import { mergeUnitReports } from './merge-unit-reports.mjs'

const report = (files) => ({
  success: true,
  testResults: files.map((name) => ({
    name,
    status: 'passed',
    assertionResults: [{ status: 'passed' }]
  }))
})

describe('the required Linux check', () => {
  it('counts every inventoried file and assertion across all shards', () => {
    expect(mergeUnitReports(['a', 'b'], [report(['a']), report(['b'])], 2)).toEqual({
      files: 2,
      tests: 2,
      passed: 2,
      skipped: 0
    })
  })

  it('rejects a missing shard', () => {
    expect(() => mergeUnitReports(['a', 'b'], [report(['a'])], 2)).toThrow(/shards/)
  })

  it('rejects an omitted file even when every shard is green', () => {
    expect(() => mergeUnitReports(['a', 'b'], [report(['a']), report([])], 2)).toThrow(/missing/)
  })

  it('rejects a file executed twice', () => {
    expect(() => mergeUnitReports(['a'], [report(['a']), report(['a'])], 2)).toThrow(/Duplicate/)
  })

  it('rejects an unexpected file', () => {
    expect(() => mergeUnitReports(['a'], [report(['a', 'other'])], 1)).toThrow(/Unexpected/)
  })

  it('rejects a failed process, suite or assertion', () => {
    for (const mutate of [
      (r) => {
        r.success = false
      },
      (r) => {
        r.testResults[0].status = 'failed'
      },
      (r) => {
        r.testResults[0].assertionResults[0].status = 'failed'
      }
    ]) {
      const r = report(['a'])
      mutate(r)
      expect(() => mergeUnitReports(['a'], [r], 1)).toThrow(/failed/)
    }
  })

  it('retains declared skipped tests', () => {
    const r = report(['a'])
    r.testResults[0].assertionResults.push({ status: 'pending' }, { status: 'todo' })
    expect(mergeUnitReports(['a'], [r], 1)).toEqual({ files: 1, tests: 3, passed: 1, skipped: 2 })
  })

  it('rejects malformed and empty reports or inventory', () => {
    expect(() => mergeUnitReports([], [], 0)).toThrow()
    expect(() => mergeUnitReports(['a', 'a'], [report(['a'])], 1)).toThrow()
    expect(() => mergeUnitReports(['a'], [{}], 1)).toThrow()
    const r = report(['a'])
    r.testResults[0].assertionResults[0].status = 'unknown'
    expect(() => mergeUnitReports(['a'], [r], 1)).toThrow()
  })
})
