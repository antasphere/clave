/* eslint-disable @typescript-eslint/explicit-function-return-type -- plain JS test utility */
// A failed request must keep the child's evidence and still close both clients.
// This observes a failure; it does not retry the check or stop the server early.
export async function withServerClient(server, client, check) {
  const failures = []
  let result
  try {
    result = await check(client)
  } catch (error) {
    failures.push(error)
  }
  try {
    client.push.close()
  } catch (error) {
    failures.push(error)
  }
  try {
    await client.api.dispose()
  } catch (error) {
    failures.push(error)
  }
  if (failures.length) {
    throw new AggregateError(
      failures,
      `server process check or client cleanup failed: pid ${server.pid}, ${server.url}, ` +
        `${JSON.stringify(server.processState())}\n${server.stderr()}`,
      { cause: failures[0] }
    )
  }
  return result
}
