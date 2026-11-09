import XCTest
@testable import ClaveCore

/// (e) The push channel against an in-memory server and a hand-moved clock: push.test.ts.
final class PushClientTests: XCTestCase {
  private let token = "tok-123"

  private func make(
    _ server: FakePushServer = FakePushServer(), clock: ManualClock = ManualClock(), random: Double = 0
  ) throws -> (PushClient, FakePushServer, ManualClock, EventLog) {
    let client = try PushClient(
      url: "https://relay.example/m/mac-1", bearer: { [token] in token }, transport: server,
      sleep: { try await clock.sleep($0) }, random: { random })
    return (client, server, clock, EventLog(client.events))
  }

  private func opened(_ client: PushClient, _ log: EventLog, count: Int = 1) async {
    await until("welcome \(count)") { log.count { if case .welcome = $0 { return true } else { return false } } >= count }
  }

  func testThePushURLOfABaseOrARelayRoad() {
    XCTAssertEqual(pushURL(of: "http://127.0.0.1:43201"), "ws://127.0.0.1:43201/push")
    XCTAssertEqual(pushURL(of: "https://relay.example/m/abc"), "wss://relay.example/m/abc/push")
    XCTAssertEqual(pushURL(of: "https://relay.example/m/abc/push"), "wss://relay.example/m/abc/push")
    XCTAssertEqual(pushURL(of: "wss://relay.example/m/abc/push"), "wss://relay.example/m/abc/push")
    XCTAssertEqual(pushURL(of: "https://relay.example/m/abc/"), "wss://relay.example/m/abc/push")
  }

  func testSaysHelloWithTheTokenThenIsWelcomedAndNamesTheServer() async throws {
    let (client, server, _, log) = try make()
    await client.start()
    await opened(client, log)
    XCTAssertEqual(server.urls.map(\.absoluteString), ["wss://relay.example/m/mac-1/push"])
    let first = try XCTUnwrap(server.last?.sent.first)
    XCTAssertEqual(json(first), json(#"{"_tag":"hello","token":"tok-123","client":"Clave iOS"}"#))
    let status = await client.status
    let id = await client.serverId
    let version = await client.serverVersion
    XCTAssertEqual(status, .open)
    XCTAssertEqual(id, "srv")
    XCTAssertEqual(version, "2.4.0")
    XCTAssertEqual(log.events.first, .welcome(serverId: "srv", version: "2.4.0"))
    await client.stop()
  }

  func testSubscribeResolvesOnTheSubscribedFrameAndNotBefore() async throws {
    let server = FakePushServer()
    server.set { $0.answerSubscriptions = false }
    let (client, _, _, log) = try make(server)
    await client.start()
    await opened(client, log)
    let waiting = Task { try await client.subscribe("s1") }
    await until("the subscribe frame") { server.last?.sentTags.contains("subscribe") == true }
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertFalse(log.events.contains { if case .subscribed = $0 { return true } else { return false } })
    server.last?.feed(#"{"_tag":"subscribed","sessionId":"s1","session":\#(FakePushServer.sessionJSON)}"#)
    let session = try await waiting.value
    XCTAssertEqual(session.id, "s1")
    let acknowledged = try await client.acknowledged("s1")
    XCTAssertEqual(acknowledged.id, "s1")
    XCTAssertEqual(server.last?.sentTags, ["hello", "subscribe"])
    await client.stop()
  }

  func testAnUnknownSessionRejectsTheSubscriptionWithTheServersWords() async throws {
    let (client, _, _, log) = try make()
    await client.start()
    await opened(client, log)
    do {
      _ = try await client.subscribe("nope")
      XCTFail("subscribed to an unknown session")
    } catch {
      XCTAssertEqual((error as? PushClientError)?.message, "Unknown session")
    }
    await until("the error event") { log.events.contains(.error(sessionId: "nope", message: "Unknown session")) }
    await client.stop()
  }

  func testAStreamFrameWithAPositionIsDeliveredAndTheExitSeen() async throws {
    let (client, server, _, log) = try make()
    await client.start()
    await opened(client, log)
    _ = try await client.subscribe("s1")
    server.last?.feed(
      #"{"_tag":"stream","sessionId":"s1","stream":{"kind":"event","event":{"type":"assistant_text","delta":"hi","final":true},"position":{"generation":"g1","sequence":7}}}"#)
    server.last?.feed(#"{"_tag":"exit","sessionId":"s1","code":0}"#)
    await until("the exit") { log.events.contains(.exit(sessionId: "s1", code: 0)) }
    let streams = log.events.compactMap { event -> SessionStream? in
      if case .stream(_, let stream) = event { return stream }
      return nil
    }
    guard case .event(.assistantText(let delta, let final, _), let position)? = streams.first else { return XCTFail("\(streams)") }
    XCTAssertEqual(delta, "hi")
    XCTAssertTrue(final)
    XCTAssertEqual(position, SessionPosition(generation: "g1", sequence: 7))
    await client.stop()
  }

  func testDeliversServerEventsIgnoresUnknownFramesAndSurvivesJunk() async throws {
    let (client, server, _, log) = try make()
    await client.start()
    await opened(client, log)
    server.last?.feed(#"{"_tag":"request","requestId":"r","windowKey":"w","command":"x","payload":{}}"#)
    server.last?.feed(#"{"_tag":"brand-new-frame","x":1}"#)
    server.last?.feed("not json at all")
    server.last?.feed(.data(Data(#"{"_tag":"event","id":"e1","seq":1,"at":1,"event":{"_tag":"requests.changed","revision":2}}"#.utf8)))
    await until("the event") { log.events.count >= 2 }
    XCTAssertEqual(log.events[1], .event(ServerEventEnvelope(id: "e1", seq: 1, at: 1, event: .requestsChanged(revision: 2))))
    let status = await client.status
    XCTAssertEqual(status, .open)
    XCTAssertEqual(server.connections.count, 1)
    await client.stop()
  }

  func testPingsOnceOpenAndAServerThatAnswersNothingIsClosedAndReopened() async throws {
    let server = FakePushServer()
    let (client, _, clock, log) = try make(server)
    await client.start()
    await opened(client, log)
    await until("the ping timer") { clock.deadlines == [20] }
    clock.advance(20)
    await until("a ping") { server.last?.sentTags.contains("ping") == true }
    // The pong re-arms the next ping twenty seconds from now.
    await until("the next ping timer") { clock.deadlines == [40] }
    server.set { $0.answerPings = false }
    clock.advance(20)
    await until("the pong deadline") { clock.deadlines == [50] }
    let pings = await client.pings
    XCTAssertEqual(pings, 2)
    clock.advance(10)
    await until("the dead socket closed") { server.connections.first?.closedWith == closeLiveness }
    await until("the drop said") { log.events.contains(.disconnected(reason: "The server stopped answering.")) }
    // Backoff with no jitter at its floor: half a second on the first attempt.
    await until("the backoff") { clock.deadlines == [50.5] }
    clock.advance(0.5)
    await opened(client, log, count: 2)
    XCTAssertEqual(server.connections.count, 2)
    let status = await client.status
    let connections = await client.connections
    XCTAssertEqual(status, .open)
    XCTAssertEqual(connections, 2)
    await client.stop()
  }

  func testAServerThatNeverWelcomesIsClosedAtThePongDeadline() async throws {
    let server = FakePushServer()
    server.set { $0.welcome = false }
    let (client, _, clock, log) = try make(server)
    await client.start()
    await until("the welcome deadline") { clock.deadlines == [10] }
    clock.advance(10)
    await until("the silent socket closed") { server.connections.first?.closedWith == closeLiveness }
    await until("the drop said") { log.events == [.disconnected(reason: "The server stopped answering.")] }
    await client.stop()
  }

  func testRevokedCloses4011EndTheClientWithNoReconnect() async throws {
    let (client, server, clock, log) = try make()
    await client.start()
    await opened(client, log)
    let pending = Task { try await client.subscribe("s2") }
    server.last?.serverClose(closeDeviceRevoked, "revoked")
    await until("the stream finished") { log.finished }
    XCTAssertEqual(log.events.last, .revoked)
    let status = await client.status
    XCTAssertEqual(status, .closed)
    clock.advance(120)
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertEqual(server.connections.count, 1)
    XCTAssertEqual(clock.deadlines, [])
    do {
      _ = try await pending.value
      XCTFail("a subscription outlived a revoked client")
    } catch {}
    await client.start()
    XCTAssertEqual(server.connections.count, 1)
  }

  func testARefusedToken4001IsFinal() async throws {
    let server = FakePushServer()
    server.set { $0.welcome = false }
    let (client, _, clock, log) = try make(server)
    await client.start()
    await until("a socket") { server.last != nil }
    server.last?.serverClose(closeUnauthorized, "bad token")
    await until("the stream finished") { log.finished }
    XCTAssertEqual(log.events, [.unauthorized])
    clock.advance(120)
    try? await Task.sleep(nanoseconds: 20_000_000)
    XCTAssertEqual(server.connections.count, 1)
    let status = await client.status
    XCTAssertEqual(status, .closed)
  }

  func testADropReconnectsWithBackoffAndSubscribesEverySessionAgain() async throws {
    let server = FakePushServer()
    let (client, _, clock, log) = try make(server)
    await client.start()
    await opened(client, log)
    _ = try await client.subscribe("s1")
    server.set { $0.welcome = false }
    // Drops before any welcome: each attempt waits twice as long, to the 30 s ceiling.
    var expected: [Double] = []
    for attempt in 1...7 {
      let socket = server.last
      socket?.serverClose(1012, "restart")
      let delay = min(30, pow(2, Double(attempt - 1))) * 0.5
      expected.append(delay)
      let at = clock.now + delay
      await until("backoff \(attempt)") { clock.deadlines.contains(at) }
      clock.advance(delay)
      await until("socket \(attempt + 1)") { server.connections.count == attempt + 1 }
      await until("the welcome deadline \(attempt)") { clock.deadlines.contains(clock.now + 10) }
    }
    XCTAssertEqual(expected, [0.5, 1, 2, 4, 8, 15, 15])
    await until("seven drops said") { log.count { if case .disconnected = $0 { return true } else { return false } } == 7 }
    server.set { $0.welcome = true }
    server.last?.serverClose(1001, "again")
    let ceiling = clock.now + 15
    await until("the eighth backoff at the ceiling") { clock.deadlines.contains(ceiling) }
    clock.advance(15)
    await opened(client, log, count: 2)
    await until("the subscription asked again") { server.last?.sentTags == ["hello", "subscribe"] }
    let again = try await client.acknowledged("s1")
    XCTAssertEqual(again.id, "s1")
    // A welcome resets the backoff: the next drop waits the floor again.
    server.last?.serverClose(1001, "once more")
    let floor = clock.now + 0.5
    await until("the reset backoff") { clock.deadlines.contains(floor) }
    await client.stop()
  }

  func testAWelcomeVoidsThePreviousSocketsAcknowledgement() async throws {
    let server = FakePushServer()
    let (client, _, clock, log) = try make(server)
    await client.start()
    await opened(client, log)
    _ = try await client.subscribe("s1")
    server.set { $0.answerSubscriptions = false }
    server.last?.serverClose(1001, "drop")
    await until("the backoff") { clock.deadlines.contains(0.5) }
    clock.advance(0.5)
    await opened(client, log, count: 2)
    let barrier = Task { try await client.acknowledged("s1") }
    try? await Task.sleep(nanoseconds: 20_000_000)
    server.last?.feed(#"{"_tag":"subscribed","sessionId":"s1","session":\#(FakePushServer.sessionJSON)}"#)
    let session = try await barrier.value
    XCTAssertEqual(session.id, "s1")
    await client.stop()
  }

  func testAMissingAcknowledgementIsBoundedByTheTimeout() async throws {
    let server = FakePushServer()
    server.set { $0.answerSubscriptions = false }
    let (client, _, clock, log) = try make(server)
    await client.start()
    await opened(client, log)
    let waiting = Task { try await client.subscribe("s1") }
    await until("the subscribe timer") { clock.deadlines.contains(10) }
    clock.advance(10)
    do {
      _ = try await waiting.value
      XCTFail("an unacknowledged subscription resolved")
    } catch {
      XCTAssertTrue((error as? PushClientError)?.message.contains("acknowledge") ?? false)
    }
    await client.stop()
  }

  func testStopEndsEverythingAndRejectsTheWaiters() async throws {
    let server = FakePushServer()
    server.set { $0.answerSubscriptions = false }
    let (client, _, _, log) = try make(server)
    await client.start()
    await opened(client, log)
    let waiting = Task { try await client.subscribe("s1") }
    await until("the subscribe frame") { server.last?.sentTags.contains("subscribe") == true }
    await client.stop()
    do {
      _ = try await waiting.value
      XCTFail("a waiter outlived stop")
    } catch {
      XCTAssertTrue((error as? PushClientError)?.message.contains("closed") ?? false)
    }
    await until("the stream finished") { log.finished }
    XCTAssertEqual(server.last?.closedWith, 1000)
    let status = await client.status
    XCTAssertEqual(status, .closed)
    do {
      _ = try await client.subscribe("s1")
      XCTFail("subscribed on a stopped client")
    } catch {}
  }

  func testAnUnreachableServerIsRetriedWithBackoff() async throws {
    let server = FakePushServer()
    server.set { $0.refuseConnect = true }
    let (client, _, clock, log) = try make(server)
    await client.start()
    await until("the backoff") { clock.deadlines == [0.5] }
    server.set { $0.refuseConnect = false }
    clock.advance(0.5)
    await opened(client, log)
    await client.stop()
  }
}
