import XCTest
@testable import ClaveCore

/// A machine's pairing routes played by script: the ticket, then one read
/// answer (or error) per poll, the last repeated.
actor ScriptedPairing: PairingRoutes {
  var ticket: Result<PairingTicket, EnrollmentError>
  var reads: [Result<PairingRead, EnrollmentError>]
  private(set) var requested: [PairingRequestInput] = []
  private(set) var readCount = 0
  /// Runs after each read is answered, before the answer is returned.
  var afterRead: (@Sendable (Int) -> Void)?

  init(ticket: Result<PairingTicket, EnrollmentError> = .success(PairingTicket(pairingId: "p-1", expiresAt: 600_000)), reads: [Result<PairingRead, EnrollmentError>]) {
    self.ticket = ticket
    self.reads = reads
  }

  func setAfterRead(_ run: @escaping @Sendable (Int) -> Void) { afterRead = run }

  func requestPairing(_ input: PairingRequestInput) async throws -> PairingTicket {
    requested.append(input)
    return try ticket.get()
  }

  func readPairing(_ pairingId: String) async throws -> PairingRead {
    readCount += 1
    let answer = reads.count > 1 ? reads.removeFirst() : reads[0]
    afterRead?(readCount)
    return try answer.get()
  }
}

/// A flag a port reads, set from another task.
final class Flag: @unchecked Sendable {
  private let lock = NSLock()
  private var value = false
  func set() { lock.withLock { value = true } }
  var isSet: Bool { lock.withLock { value } }
}

/// The states a pairing emitted, and the sleeps it asked for.
final class PairingLog: @unchecked Sendable {
  private let lock = NSLock()
  private var _states: [PairingState] = []
  private var _sleeps: [TimeInterval] = []
  func state(_ state: PairingState) { lock.withLock { _states.append(state) } }
  func sleep(_ seconds: TimeInterval) { lock.withLock { _sleeps.append(seconds) } }
  var states: [PairingState] { lock.withLock { _states } }
  var sleeps: [TimeInterval] { lock.withLock { _sleeps } }
  var kinds: [String] {
    states.map { state in
      switch state {
      case .requesting: return "requesting"
      case .waiting: return "waiting"
      case .approved: return "approved"
      case .refused: return "refused"
      case .expired: return "expired"
      case .cancelled: return "cancelled"
      case .failed: return "failed"
      }
    }
  }
}

/// (f) The enrollment client and the pairing state machine: enroll.test.ts.
final class PairingTests: XCTestCase {
  private let base = "https://relay.example/m/mac-1"
  private let device = DeviceDescription(name: "iPhone Air", platform: .ios, appVersion: "0.1.0")
  private let session = DeviceSessionView(token: "ds-p-1", deviceId: "dev-p-1", serverId: "srv-1", serverName: "Valentin's Mac")

  private var input: PairingInput {
    PairingInput(machineId: "m-1", machineBaseUrl: base, idToken: "id-1", clientId: "c-1", device: device)
  }

  private func ports(
    _ routes: ScriptedPairing, log: PairingLog, now: Double = 1_000, cancelled: (@Sendable () -> Bool)? = nil,
    persist: (@Sendable (EnrollmentRecord, Credential) async throws -> Bool)? = nil
  ) -> (PairingPorts, SecureCredentialStore, EnrollmentRecords) {
    let credentials = SecureCredentialStore(InMemorySecureStore())
    let records = EnrollmentRecords(store: InMemoryKeyValueStore())
    let ports = PairingPorts(
      client: routes, credentials: credentials, records: records, persist: persist,
      sleep: { log.sleep($0) }, now: { now }, onState: { log.state($0) }, cancelled: cancelled)
    return (ports, credentials, records)
  }

  // MARK: the client

  func testAsksToPairWithTheIdTokenTheClientIdAndTheDeviceAndNoBearer() async throws {
    let transport = ScriptedTransport()
    await transport.onJSON("POST", "/m/mac-1/devices/pair", #"{"pairingId":"p-1","expiresAt":600000}"#)
    let client = try EnrollmentClient(baseURL: base, transport: transport)
    let ticket = try await client.requestPairing(PairingRequestInput(idToken: "id-1", clientId: "c-1", device: device))
    XCTAssertEqual(ticket, PairingTicket(pairingId: "p-1", expiresAt: 600_000))
    let requests = await transport.requests
    XCTAssertEqual(requests.count, 1)
    XCTAssertNil(requests[0].value(forHTTPHeaderField: "Authorization"))
    XCTAssertEqual(
      bodyJSON(requests[0]), json(#"{"idToken":"id-1","clientId":"c-1","device":{"name":"iPhone Air","platform":"ios","appVersion":"0.1.0"}}"#))
  }

  func testATokenTheServerRefusesIsSaidWithTheCheckThatRefusedIt() async throws {
    let transport = ScriptedTransport()
    await transport.onJSON(
      "POST", "/m/mac-1/devices/pair", status: 422, #"{"_tag":"DevicePairingRefused","check":"signature","message":"The sign-in was refused (signature)."}"#)
    let client = try EnrollmentClient(baseURL: base, transport: transport)
    do {
      _ = try await client.requestPairing(PairingRequestInput(idToken: "bad-token", clientId: "c-1", device: device))
      XCTFail("paired with a refused token")
    } catch let error as EnrollmentError {
      XCTAssertEqual(error.kind, .refused(check: "signature"))
      XCTAssertEqual(error.check, "signature")
      XCTAssertFalse(error.message.contains("bad-token"))
    }
  }

  func testAServerNobodyOwnsIsUnavailableAndA403IsForbidden() async throws {
    let transport = ScriptedTransport()
    await transport.onJSON("POST", "/m/mac-1/devices/pair", status: 422, #"{"_tag":"CapabilityUnavailable","capability":"account"}"#)
    await transport.onJSON("GET", "/m/mac-1/devices/pair", status: 403, #"{"error":"Forbidden","message":"A phone may not do this."}"#)
    let client = try EnrollmentClient(baseURL: base, transport: transport)
    do {
      _ = try await client.requestPairing(PairingRequestInput(idToken: "id", clientId: "c", device: device))
      XCTFail("paired with nobody's machine")
    } catch let error as EnrollmentError {
      XCTAssertEqual(error.kind, .unavailable)
    }
    do {
      _ = try await client.readPairing("p-1")
      XCTFail("read a forbidden pairing")
    } catch let error as EnrollmentError {
      XCTAssertEqual(error.kind, .forbidden)
    }
  }

  func testReadsThePairingTheSessionCarriedOnce() async throws {
    let transport = ScriptedTransport()
    await transport.onJSON(
      "GET", "/m/mac-1/devices/pair",
      #"{"status":"approved","deviceSession":{"token":"ds-p 1","deviceId":"dev-p-1","serverId":"srv-1","serverName":"Valentin's Mac"}}"#)
    let client = try EnrollmentClient(baseURL: base, transport: transport)
    let read = try await client.readPairing("p 1/2")
    XCTAssertEqual(read.status, .approved)
    XCTAssertEqual(read.deviceSession?.deviceId, "dev-p-1")
    let targets = await transport.targets
    XCTAssertEqual(targets, ["/m/mac-1/devices/pair?id=p+1%2F2"])
    let requests = await transport.requests
    XCTAssertNil(requests[0].value(forHTTPHeaderField: "Authorization"))
  }

  func testAnUnreachableMachineIsANetworkFailureASilentOneATimeoutAnUnreadableOneProtocol() async throws {
    let transport = ScriptedTransport()
    await transport.on("POST", "/m/mac-1/devices/pair") { _ in throw URLError(.cannotConnectToHost) }
    await transport.on("GET", "/m/mac-1/devices/pair") { _ in throw URLError(.timedOut) }
    let client = try EnrollmentClient(baseURL: base, transport: transport)
    do {
      _ = try await client.requestPairing(PairingRequestInput(idToken: "id", clientId: "c", device: device))
      XCTFail("no network")
    } catch let error as EnrollmentError {
      XCTAssertEqual(error.kind, .network)
    }
    do {
      _ = try await client.readPairing("p-1")
      XCTFail("no answer")
    } catch let error as EnrollmentError {
      XCTAssertEqual(error.kind, .timeout)
    }
    await transport.onJSON("GET", "/m/mac-1/devices/pair", #"{"status":"maybe"}"#)
    do {
      _ = try await client.readPairing("p-1")
      XCTFail("an unknown status")
    } catch let error as EnrollmentError {
      XCTAssertEqual(error.kind, .protocol)
    }
  }

  func testAPairingRequestOverTheServersBoundIsNeverSent() async throws {
    let transport = ScriptedTransport()
    let client = try EnrollmentClient(baseURL: base, transport: transport)
    do {
      _ = try await client.requestPairing(PairingRequestInput(idToken: String(repeating: "x", count: 17_000), clientId: "c", device: device))
      XCTFail("an oversized request")
    } catch let error as EnrollmentError {
      XCTAssertEqual(error.kind, .protocol)
    }
    let count = await transport.requests.count
    XCTAssertEqual(count, 0)
  }

  // MARK: the state machine

  func testWaitsTwoSecondsBetweenReadsThenKeepsTheSessionUnderTheMachineId() async throws {
    let routes = ScriptedPairing(reads: [
      .success(PairingRead(status: .pending)), .success(PairingRead(status: .pending)),
      .success(PairingRead(status: .approved, deviceSession: session)),
    ])
    let log = PairingLog()
    let (ports, credentials, records) = ports(routes, log: log)
    let end = await pair(input, ports: ports)
    let record = EnrollmentRecord(machineId: "m-1", deviceId: "dev-p-1", serverId: "srv-1", serverName: "Valentin's Mac", pairedAt: 1_000)
    XCTAssertEqual(end, .approved(record))
    XCTAssertEqual(log.kinds, ["requesting", "waiting", "waiting", "waiting", "approved"])
    XCTAssertEqual(log.states[3], .waiting(pairingId: "p-1", expiresAt: 600_000, polls: 2))
    XCTAssertEqual(log.sleeps, [2, 2, 2])
    let credential = try await credentials.get("m-1")
    let main = try await credentials.mainMachineId()
    let kept = try await records.get("m-1")
    let byServer = try await records.byServerId("srv-1")
    XCTAssertEqual(credential, Credential(serverUrl: base, bearer: "ds-p-1"))
    XCTAssertEqual(main, "m-1")
    XCTAssertEqual(kept, record)
    XCTAssertEqual(byServer, record)
    let requested = await routes.requested
    XCTAssertEqual(requested, [PairingRequestInput(idToken: "id-1", clientId: "c-1", device: device)])
  }

  func testARefusalOnTheMacIsRefusedHereNothingKept() async throws {
    let log = PairingLog()
    let (ports, credentials, records) = ports(ScriptedPairing(reads: [.success(PairingRead(status: .refused))]), log: log)
    let end = await pair(input, ports: ports)
    XCTAssertEqual(end, .refused)
    let credential = try await credentials.get("m-1")
    let record = try await records.get("m-1")
    XCTAssertNil(credential)
    XCTAssertNil(record)
  }

  func testAPairingTheServerLetLapseIsExpired() async {
    let log = PairingLog()
    let (ports, _, _) = ports(ScriptedPairing(reads: [.success(PairingRead(status: .expired))]), log: log)
    let end = await pair(input, ports: ports)
    XCTAssertEqual(end, .expired)
  }

  func testAPairingStillPendingPastTheDeadlineAndTheGraceIsExpiredHere() async {
    let log = PairingLog()
    let routes = ScriptedPairing(ticket: .success(PairingTicket(pairingId: "p-1", expiresAt: 1_000)), reads: [.success(PairingRead(status: .pending))])
    let (within, _, _) = ports(routes, log: log, now: 61_000)
    let (past, _, _) = ports(routes, log: PairingLog(), now: 61_001)
    // At the deadline plus the grace the pending answer is still believed; one millisecond past it is not.
    var stopping = within
    stopping.cancelled = { log.sleeps.count >= 3 }
    let stillWaiting = await pair(input, ports: stopping)
    XCTAssertEqual(stillWaiting, .cancelled)
    XCTAssertEqual(log.kinds, ["requesting", "waiting", "waiting", "waiting", "cancelled"])
    let lapsed = await pair(input, ports: past)
    XCTAssertEqual(lapsed, .expired)
  }

  func testAnApprovalAlreadyHandedOutIsAFailureThatSaysToPairAgain() async throws {
    let log = PairingLog()
    let (ports, credentials, _) = ports(ScriptedPairing(reads: [.success(PairingRead(status: .approved))]), log: log)
    let end = await pair(input, ports: ports)
    guard case .failed(let error) = end else { return XCTFail("\(end)") }
    XCTAssertEqual(error.kind, .consumed)
    XCTAssertTrue(error.message.contains("Pair again"))
    let credential = try await credentials.get("m-1")
    XCTAssertNil(credential)
  }

  func testAReadTheNetworkLosesKeepsTheWaitAndTheApprovalStillLands() async throws {
    let routes = ScriptedPairing(reads: [
      .failure(EnrollmentError(.network, "lost")), .failure(EnrollmentError(.timeout, "slow")),
      .success(PairingRead(status: .approved, deviceSession: session)),
    ])
    let log = PairingLog()
    let (ports, credentials, _) = ports(routes, log: log)
    let end = await pair(input, ports: ports)
    guard case .approved = end else { return XCTFail("\(end)") }
    XCTAssertEqual(log.kinds, ["requesting", "waiting", "waiting", "waiting", "approved"])
    XCTAssertEqual(log.sleeps.count, 3)
    let credential = try await credentials.get("m-1")
    XCTAssertNotNil(credential)
  }

  func testATransientErrorPastTheDeadlineAndTheGraceFails() async {
    let routes = ScriptedPairing(
      ticket: .success(PairingTicket(pairingId: "p-1", expiresAt: 1_000)), reads: [.failure(EnrollmentError(.network, "lost"))])
    let log = PairingLog()
    let (ports, _, _) = ports(routes, log: log, now: 61_001)
    let end = await pair(input, ports: ports)
    XCTAssertEqual(end, .failed(EnrollmentError(.network, "lost")))
  }

  func testANonTransientErrorWhilePollingFailsAtOnce() async {
    let routes = ScriptedPairing(reads: [.failure(EnrollmentError(.forbidden, "The machine refused this call."))])
    let log = PairingLog()
    let (ports, _, _) = ports(routes, log: log)
    let end = await pair(input, ports: ports)
    XCTAssertEqual(end, .failed(EnrollmentError(.forbidden, "The machine refused this call.")))
    XCTAssertEqual(log.sleeps, [2])
  }

  func testLeavingTheScreenBeforeTheFirstReadStopsThePolling() async {
    let log = PairingLog()
    let routes = ScriptedPairing(reads: [.success(PairingRead(status: .pending))])
    let (ports, _, _) = ports(routes, log: log, cancelled: { log.sleeps.count >= 1 })
    let end = await pair(input, ports: ports)
    XCTAssertEqual(end, .cancelled)
    let reads = await routes.readCount
    XCTAssertEqual(reads, 0)
  }

  func testCancelledBeforeAskingAsksNothing() async {
    let log = PairingLog()
    let routes = ScriptedPairing(reads: [.success(PairingRead(status: .pending))])
    let (ports, _, _) = ports(routes, log: log, cancelled: { true })
    let end = await pair(input, ports: ports)
    XCTAssertEqual(end, .cancelled)
    XCTAssertEqual(log.kinds, ["requesting", "cancelled"])
    let requested = await routes.requested
    XCTAssertEqual(requested, [])
  }

  func testAnApprovalCancelledWhileTheReadWasAwaitedIsDiscarded() async throws {
    let routes = ScriptedPairing(reads: [.success(PairingRead(status: .approved, deviceSession: session))])
    let flag = Flag()
    await routes.setAfterRead { _ in flag.set() }
    let log = PairingLog()
    let (ports, credentials, records) = ports(routes, log: log, cancelled: { flag.isSet })
    let end = await pair(input, ports: ports)
    XCTAssertEqual(end, .cancelled)
    let credential = try await credentials.get("m-1")
    let record = try await records.get("m-1")
    XCTAssertNil(credential)
    XCTAssertNil(record)
  }

  func testThePersistPortCommitsTheApprovalOrCancelsIt() async throws {
    let routes = ScriptedPairing(reads: [.success(PairingRead(status: .approved, deviceSession: session))])
    let committed = Counter()
    let (keeping, credentials, records) = ports(routes, log: PairingLog(), persist: { record, credential in
      XCTAssertEqual(record.machineId, "m-1")
      XCTAssertEqual(credential.bearer, "ds-p-1")
      _ = committed.next()
      return true
    })
    let kept = await pair(input, ports: keeping)
    guard case .approved = kept else { return XCTFail("\(kept)") }
    XCTAssertEqual(committed.count, 1)
    // The port replaces the stores: nothing was written there.
    let credential = try await credentials.get("m-1")
    let record = try await records.get("m-1")
    XCTAssertNil(credential)
    XCTAssertNil(record)
    let (refusing, _, _) = ports(routes, log: PairingLog(), persist: { _, _ in false })
    let refused = await pair(input, ports: refusing)
    XCTAssertEqual(refused, .cancelled)
  }

  func testARefusedTokenFailsWithTheCheckNamedAndNeverPolls() async {
    let routes = ScriptedPairing(
      ticket: .failure(EnrollmentError(.refused(check: "signature"), "The sign-in was refused.")), reads: [.success(PairingRead(status: .pending))])
    let log = PairingLog()
    let (ports, _, _) = ports(routes, log: log)
    let end = await pair(input, ports: ports)
    guard case .failed(let error) = end else { return XCTFail("\(end)") }
    XCTAssertEqual(error.check, "signature")
    XCTAssertEqual(log.sleeps, [])
  }

  func testAThrowingSleepIsACancellation() async {
    let routes = ScriptedPairing(reads: [.success(PairingRead(status: .pending))])
    let credentials = SecureCredentialStore(InMemorySecureStore())
    let ports = PairingPorts(
      client: routes, credentials: credentials, records: EnrollmentRecords(store: InMemoryKeyValueStore()),
      sleep: { _ in throw CancellationError() }, now: { 0 })
    let end = await pair(input, ports: ports)
    XCTAssertEqual(end, .cancelled)
  }

  // MARK: the records

  func testKeepsOneRecordPerMachineFindsTheLatestByServerSurvivesARestart() async throws {
    let kv = InMemoryKeyValueStore()
    let first = EnrollmentRecords(store: kv)
    try await first.set(EnrollmentRecord(machineId: "m-1", deviceId: "d-1", serverId: "s-1", serverName: "A", pairedAt: 1))
    try await first.set(EnrollmentRecord(machineId: "m-2", deviceId: "d-2", serverId: "s-1", serverName: "A", pairedAt: 2))
    try await first.set(EnrollmentRecord(machineId: "m-1", deviceId: "d-3", serverId: "s-1", serverName: "A", pairedAt: 3))
    let second = EnrollmentRecords(store: kv)
    let ids = try await second.list().map(\.machineId)
    XCTAssertEqual(ids, ["m-2", "m-1"])
    let latest = try await second.machineId(forServer: "s-1")
    let unknown = try await second.byServerId("s-9")
    XCTAssertEqual(latest, "m-1")
    XCTAssertNil(unknown)
    try await second.remove("m-1")
    let next = try await second.machineId(forServer: "s-1")
    XCTAssertEqual(next, "m-2")
    try await second.remove("m-2")
    let raw = try await kv.get(EnrollmentRecords.key)
    XCTAssertNil(raw)
  }

  func testConcurrentApprovalsRetainBothRecords() async throws {
    let records = EnrollmentRecords(store: InMemoryKeyValueStore())
    async let one: Void = records.set(EnrollmentRecord(machineId: "m-1", deviceId: "d-1", serverId: "m-1", serverName: "F", pairedAt: 1))
    async let two: Void = records.set(EnrollmentRecord(machineId: "m-2", deviceId: "d-1", serverId: "m-2", serverName: "F", pairedAt: 1))
    _ = try await (one, two)
    let ids = Set(try await records.list().map(\.machineId))
    XCTAssertEqual(ids, ["m-1", "m-2"])
  }

  func testADamagedRecordIsSkippedNotFatal() async throws {
    let kv = InMemoryKeyValueStore([
      EnrollmentRecords.key: #"[{"machineId":"m-1","deviceId":"d","serverId":"s"},{"machineId":3},"junk"]"#
    ])
    let list = try await EnrollmentRecords(store: kv).list()
    XCTAssertEqual(list, [EnrollmentRecord(machineId: "m-1", deviceId: "d", serverId: "s", serverName: "", pairedAt: 0)])
  }
}
