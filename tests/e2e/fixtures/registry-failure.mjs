// Observe the fixture's injected failure before healing it. This never calls
// plugins.list or retries the action under test. A stalled observation is bounded.
export function waitForRegistryFailure(fixture) {
  return new Promise((resolve, reject) => {
    let settled = false
    let poll = null
    const finish = (ok, error) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      clearTimeout(poll)
      if (ok) resolve(true)
      else reject(error)
    }
    const deadline = setTimeout(
      () =>
        finish(
          false,
          new Error('Registry fixture did not observe its injected failure within 10000 ms')
        ),
      10_000
    )
    const read = async () => {
      try {
        const failed = await fixture.evaluate(() => globalThis.__registryFailures > 0)
        if (settled) return
        if (failed === true) finish(true)
        else poll = setTimeout(read, 100)
      } catch (error) {
        finish(false, error)
      }
    }
    void read()
  })
}
