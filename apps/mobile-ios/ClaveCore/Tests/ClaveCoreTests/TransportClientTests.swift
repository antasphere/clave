import XCTest
@testable import ClaveCore

/// The server client against a scripted transport: client.test.ts, plus the
/// device-session boundary as the phone handles it.
final class TransportClientTests: XCTestCase {
  private let base = "https://relay.example/m/mac-1"
  private let token = "tok-123"
  private let session = FakePushServer.sessionJSON.replacingOccurrences(of: #""title":"Echo""#, with: #""title":"Echo","workspaceId":"ws1""#)

  private func make(_ counter: Counter = Counter()) async throws -> (ClaveServerClient, ScriptedTransport) {
    let transport = ScriptedTransport()
    let client = try ClaveServerClient(baseURL: base + "/", bearer: countingBearer(token, counter), transport: transport)
    return (client, transport)
  }

  private func error(_ run: () async throws -> Void) async -> ServerError? {
    do {
      try await run()
      return nil
    } catch {
      return error as? ServerError
    }
  }

  func testSendsTheBearerOnEveryCallAndDecodesTheAnswer() async throws {
    let (client, transport) = try await make()
    await transport.onJSON("GET", "/m/mac-1/sessions", "[\(session)]")
    let sessions = try await client.sessions.list()
    XCTAssertEqual(sessions.map(\.id), ["s1"])
    let first = await transport.requests.first
    let request = try XCTUnwrap(first)
    XCTAssertEqual(request.httpMethod, "GET")
    XCTAssertEqual(request.url?.absoluteString, "\(base)/sessions")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer \(token)")
    XCTAssertEqual(request.timeoutInterval, 10)
  }

  func testPutsAQueryPayloadInTheQueryStringAndOmitsWhatIsAbsent() async throws {
    let (client, transport) = try await make()
    await transport.onJSON("GET", "/m/mac-1/sessions/history", #"{"items":[],"before":200}"#)
    let page = try await client.sessions.history("s1")
    XCTAssertEqual(page.before, 200)
    _ = try await client.sessions.history("s1", before: 200, limit: 50)
    await transport.onJSON("GET", "/m/mac-1/sessions", "[]")
    _ = try await client.sessions.list(windowKey: "w 1+2")
    let targets = await transport.targets
    XCTAssertEqual(targets, [
      "/m/mac-1/sessions/history?id=s1", "/m/mac-1/sessions/history?id=s1&before=200&limit=50",
      "/m/mac-1/sessions?windowKey=w+1%2B2",
    ])
  }

  func testReadsTheWorkspaceStampFromTheListAndByIdAnswers() async throws {
    let (client, transport) = try await make()
    await transport.onJSON("GET", "/m/mac-1/sessions", "[\(session)]")
    await transport.onJSON("GET", "/m/mac-1/sessions/by-id", session)
    let listed = try await client.sessions.list()
    let one = try await client.sessions.get("s1")
    XCTAssertEqual(listed.first?.workspaceId, "ws1")
    XCTAssertEqual(one.workspaceId, "ws1")
    let targets = await transport.targets
    XCTAssertEqual(targets, ["/m/mac-1/sessions", "/m/mac-1/sessions/by-id?id=s1"])
  }

  func testPostsACommandAsJSONWithTheClientMessageId() async throws {
    let (client, transport) = try await make()
    await transport.onJSON("POST", "/m/mac-1/sessions/write", #"{"status":"accepted"}"#)
    let answer = try await client.sessions.write("s1", .userMessage(UserMessage(clientMessageId: "m-12345678", text: "hi")))
    XCTAssertEqual(answer.status, .accepted)
    let first = await transport.requests.first
    let request = try XCTUnwrap(first)
    XCTAssertEqual(request.httpMethod, "POST")
    XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
    XCTAssertEqual(
      bodyJSON(request), json(#"{"id":"s1","input":{"type":"user_message","text":"hi","clientMessageId":"m-12345678"}}"#))
  }

  func testDecodesAcceptedAndPendingWritesAndRefusesEmptyOrMalformed2xx() async throws {
    let (client, transport) = try await make()
    await transport.on("POST", "/m/mac-1/sessions/write") { request in
      guard case .object(let body)? = bodyJSON(request), case .string(let id)? = body["id"] else { return HTTPAnswer(status: 400) }
      switch id {
      case "empty": return HTTPAnswer(status: 204)
      case "malformed": return HTTPAnswer(status: 200, body: Data("{}".utf8))
      case "pending": return HTTPAnswer(status: 200, body: Data(#"{"status":"pending"}"#.utf8))
      default: return HTTPAnswer(status: 200, body: Data(#"{"status":"accepted"}"#.utf8))
      }
    }
    let input = SessionWriteInput.userMessage(UserMessage(clientMessageId: "message-123", text: "hi"))
    let accepted = try await client.sessions.write("s1", input)
    let pending = try await client.sessions.write("pending", input)
    XCTAssertEqual(accepted.status, .accepted)
    XCTAssertEqual(pending.status, .pending)
    for id in ["empty", "malformed"] {
      let failure = await error { _ = try await client.sessions.write(id, input) }
      XCTAssertEqual(failure?.kind, .protocol, id)
      XCTAssertTrue(failure?.outcomeLost ?? false)
    }
  }

  /// (a) The device-session boundary: a route the scope refuses is said in
  /// the server's words, and the phone asks exactly once.
  func testA403IsForbiddenInTheServersWordsAndNeverRetried() async throws {
    let counter = Counter()
    let (client, transport) = try await make(counter)
    await transport.onJSON("GET", "/m/mac-1/workspaces", status: 403, #"{"error":"Forbidden","message":"A phone may not do this."}"#)
    let failure = await error { _ = try await client.workspaces.load() }
    XCTAssertEqual(failure?.kind, .forbidden)
    XCTAssertEqual(failure?.message, "A phone may not do this.")
    XCTAssertEqual(failure?.status, 403)
    let requests = await transport.requests
    XCTAssertEqual(requests.count, 1)
    XCTAssertEqual(requests.compactMap { $0.value(forHTTPHeaderField: "Authorization") }, ["Bearer \(token)"])
    XCTAssertEqual(counter.count, 1)
    XCTAssertFalse(failure?.outcomeLost ?? true)
  }

  /// (b) A 401: the credential is gone, said once.
  func testA401IsUnauthenticatedWithExactlyOneRequest() async throws {
    let counter = Counter()
    let (client, transport) = try await make(counter)
    await transport.onJSON("GET", "/m/mac-1/sessions", status: 401, #"{"error":"Unauthenticated"}"#)
    let failure = await error { _ = try await client.sessions.list() }
    XCTAssertEqual(failure?.kind, .unauthenticated)
    XCTAssertEqual(failure?.status, 401)
    let count = await transport.requests.count
    XCTAssertEqual(count, 1)
    XCTAssertEqual(counter.count, 1)
  }

  func testA422IsARefusalInTheServersWordsTheFailureKept() async throws {
    let (client, transport) = try await make()
    await transport.onJSON(
      "POST", "/m/mac-1/sessions/start", status: 422,
      #"{"_tag":"SessionStartFailed","message":"Program \"missing-agent\" was not found on this server (launch profile \"Missing\")"}"#)
    let failure = await error { _ = try await client.sessions.start(StartSessionInput(cwd: "/tmp/scratch")) }
    XCTAssertEqual(failure?.kind, .refused)
    XCTAssertEqual(failure?.message, #"Program "missing-agent" was not found on this server (launch profile "Missing")"#)
    XCTAssertEqual(failure?.failure?.tag, "SessionStartFailed")
  }

  func testCapabilityUnavailableIsARefusalTheCallerCanTellApart() async throws {
    let (client, transport) = try await make()
    await transport.onJSON(
      "GET", "/m/mac-1/requests/pending", status: 422,
      #"{"_tag":"CapabilityUnavailable","capability":"requests","message":"This server holds no pending requests."}"#)
    let failure = await error { _ = try await client.requests.pending() }
    XCTAssertEqual(failure?.kind, .refused)
    XCTAssertEqual(failure?.capabilityUnavailable, true)
    XCTAssertEqual(failure?.failure?.capability, "requests")
  }

  func testA422WithoutAMessageStillHasASentence() async throws {
    let (client, transport) = try await make()
    await transport.onJSON("GET", "/m/mac-1/sessions/by-id", status: 422, #"{"_tag":"SessionNotFound","id":"nope"}"#)
    let failure = await error { _ = try await client.sessions.get("nope") }
    XCTAssertEqual(failure?.kind, .refused)
    XCTAssertEqual(failure?.failure?.tag, "SessionNotFound")
    XCTAssertTrue(failure?.message.contains("SessionNotFound") ?? false)
  }

  func testA422WithoutADeclaredFailureIsAProtocolError() async throws {
    let (client, transport) = try await make()
    await transport.onJSON("GET", "/m/mac-1/sessions", status: 422, #"{"error":"no tag"}"#)
    let failure = await error { _ = try await client.sessions.list() }
    XCTAssertEqual(failure?.kind, .protocol)
  }

  func testA404IsNotFoundAndA5xxIsProtocol() async throws {
    let (client, transport) = try await make()
    let missing = await error { _ = try await client.sessions.writeStatus("s1", clientMessageId: "m-12345678") }
    XCTAssertEqual(missing?.kind, .notFound)
    await transport.onJSON("GET", "/m/mac-1/sessions", status: 503, #"{"error":"offline"}"#)
    let offline = await error { _ = try await client.sessions.list() }
    XCTAssertEqual(offline?.kind, .protocol)
    XCTAssertEqual(offline?.status, 503)
  }

  func testAnAnswerOfTheWrongShapeIsAProtocolErrorNamingTheRoute() async throws {
    let (client, transport) = try await make()
    await transport.onJSON("GET", "/m/mac-1/workspaces", #"{"version":1,"workspaces":"not a list"}"#)
    let failure = await error { _ = try await client.workspaces.load() }
    XCTAssertEqual(failure?.kind, .protocol)
    XCTAssertTrue(failure?.message.contains("/workspaces") ?? false, failure?.message ?? "")
  }

  func testATimedOutRequestIsATimeoutAndAnyOtherTransportErrorIsNetwork() async throws {
    let (client, transport) = try await make()
    await transport.on("GET", "/m/mac-1/sessions") { _ in throw URLError(.timedOut) }
    await transport.on("GET", "/m/mac-1/launch-profiles") { _ in throw URLError(.cannotConnectToHost) }
    let slow = await error { _ = try await client.sessions.list() }
    let gone = await error { _ = try await client.launchProfiles.list() }
    XCTAssertEqual(slow?.kind, .timeout)
    XCTAssertEqual(gone?.kind, .network)
  }

  func testAPageOfTheTimelineOrHistoryRunsUnderTheLongDeadline() async throws {
    let (client, transport) = try await make()
    await transport.onJSON(
      "GET", "/m/mac-1/sessions/timeline",
      #"{"items":[{"event":{"type":"user_message","text":"a"},"position":{"generation":"g","sequence":8}}],"before":8,"cursor":{"generation":"g","sequence":12},"truncated":true}"#)
    await transport.onJSON("GET", "/m/mac-1/sessions/history", #"{"items":[],"before":null}"#)
    let page = try await client.sessions.timeline("s1", before: 9, limit: 10)
    _ = try await client.sessions.history("s1")
    XCTAssertEqual(page.cursor, SessionPosition(generation: "g", sequence: 12))
    let requests = await transport.requests
    XCTAssertEqual(requests.map(\.timeoutInterval), [60, 60])
    let targets = await transport.targets
    XCTAssertEqual(targets.first, "/m/mac-1/sessions/timeline?id=s1&before=9&limit=10")
  }

  func testTheDeviceAndFileRoutes() async throws {
    let (client, transport) = try await make()
    await transport.on("POST", "/m/mac-1/devices/me/push-token") { _ in HTTPAnswer(status: 204) }
    await transport.on("POST", "/m/mac-1/devices/me/push-token/clear") { _ in HTTPAnswer(status: 204) }
    await transport.onJSON(
      "GET", "/m/mac-1/devices/me", #"{"id":"dev-1","name":"iPhone","platform":"ios","appVersion":"1.0","createdAt":1,"lastSeenAt":null}"#)
    await transport.onJSON("GET", "/m/mac-1/files/read", ##"{"content":"# Plan","truncated":false,"size":6,"binary":false}"##)
    await transport.onJSON("POST", "/m/mac-1/requests/resolve", #"{"accepted":true}"#)
    try await client.devices.setPushToken("apns-1")
    try await client.devices.clearPushToken()
    let me = try await client.devices.me()
    let text = try await client.files.read(root: "/tmp/a b", path: "plan.md")
    let outcome = try await client.requests.resolve("r-1", .permission(optionId: "allow-once", answers: nil))
    XCTAssertEqual(me.id, "dev-1")
    XCTAssertEqual(text.content, "# Plan")
    XCTAssertTrue(outcome.accepted)
    let requests = await transport.requests
    XCTAssertEqual(bodyJSON(requests[0]), json(#"{"token":"apns-1","platform":"ios"}"#))
    XCTAssertEqual(bodyJSON(requests[1]), json("{}"))
    XCTAssertEqual(requests[3].url?.query, "root=%2Ftmp%2Fa+b&path=plan.md")
    XCTAssertEqual(bodyJSON(requests[4]), json(#"{"requestId":"r-1","response":{"type":"permission","optionId":"allow-once"}}"#))
  }

  func testAReleaseClientRefusesAPlainHttpAddressBeforeAnyRequest() async throws {
    let transport = ScriptedTransport()
    let counter = Counter()
    XCTAssertThrowsError(try ClaveServerClient(baseURL: "http://192.168.1.20:43201", bearer: countingBearer(token, counter), transport: transport)) {
      XCTAssertTrue(($0 as? TransportPolicyError)?.message.contains("never travels over plain http") ?? false)
    }
    XCTAssertThrowsError(try ClaveServerClient(baseURL: "http://127.0.0.1:43201", bearer: countingBearer(token, counter), transport: transport))
    XCTAssertNoThrow(try ClaveServerClient(baseURL: "http://127.0.0.1:43201", bearer: countingBearer(token, counter), transport: transport, build: .development))
    let count = await transport.requests.count
    XCTAssertEqual(count, 0)
    XCTAssertEqual(counter.count, 0)
  }
}
