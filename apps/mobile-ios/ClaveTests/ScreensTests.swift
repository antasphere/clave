import ClaveCore
import SwiftUI
import XCTest
@testable import Clave

/// A machine's server for the Launch screen, in memory: one saved chat profile, one terminal
/// profile and a built-in the phone never offers; a start that is refused or accepted.
nonisolated final class LaunchServer: HTTPTransport, @unchecked Sendable {
  enum StartScript: Sendable { case refuse(String), accept }

  private let lock = NSLock()
  private var script: StartScript
  private var _starts: [[String: Any]] = []

  init(_ script: StartScript) {
    self.script = script
  }

  var starts: [[String: Any]] { lock.withLock { _starts } }

  static let chat = LaunchProfileView(id: "claude-chat", name: "Claude chat", family: .claude, command: ["claude"], additionalArgs: [])
  static let terminal = LaunchProfileView(
    id: "p-codex", name: "Codex review", family: .codex, command: ["codex", "--review"], additionalArgs: [])
  static let builtIn = LaunchProfileView(
    id: "builtin-claude", name: "Claude", family: .claude, command: ["claude"], additionalArgs: [], builtIn: true)

  func perform(_ request: URLRequest) async throws -> HTTPAnswer {
    let path = request.url?.path ?? ""
    switch (request.httpMethod ?? "GET", path) {
    case ("GET", _) where path.hasSuffix("/launch-profiles"):
      return encoded(
        LaunchProfilePreferencesView(customProfiles: [Self.terminal, Self.builtIn, Self.chat], globalDefaults: [:], workspaceOverrides: [:]))
    case ("POST", _) where path.hasSuffix("/sessions/start"):
      let body = (try? JSONSerialization.jsonObject(with: request.httpBody ?? Data())) as? [String: Any] ?? [:]
      let script = lock.withLock { () -> StartScript in
        _starts.append(body)
        return self.script
      }
      switch script {
      case .refuse(let message):
        return json(#"{"_tag":"LaunchRefused","message":"\#(message)"}"#, status: 422)
      case .accept:
        return json(#"{"id":"s_new","cwd":"/w/scratch","folderName":"scratch","alive":true,"claudeSessionId":null,"piSessionId":null}"#)
      }
    case ("GET", _) where path.hasSuffix("/sessions/by-id"):
      return encoded(
        Session(
          id: "s_new", provider: "claude", transport: .events, cwd: "/w/scratch", windowKey: "server", workspaceId: "scratch",
          state: .idle, createdAt: 5, adapterId: "claude-chat", title: ""))
    default:
      return HTTPAnswer(status: 404)
    }
  }

  private func json(_ body: String, status: Int = 200) -> HTTPAnswer {
    HTTPAnswer(status: status, headers: ["Content-Type": "application/json"], body: Data(body.utf8))
  }

  private func encoded<T: Encodable>(_ value: T) -> HTTPAnswer {
    HTTPAnswer(status: 200, headers: ["Content-Type": "application/json"], body: (try? ContractJSON.encode(value)) ?? Data())
  }
}

@MainActor
final class ScreensTests: XCTestCase {
  private let workspace = WorkspaceView(id: "scratch", name: "scratch", rootDir: "/w/scratch", createdAt: 0)

  /// A connection over `transport`, never started: the push channel stays closed.
  private func connection(_ transport: any HTTPTransport, machineId: String = "m1") throws -> MachineConnection {
    let defaults = UserDefaults(suiteName: "clave.screens-tests")!
    let env = AppEnvironment(
      buildKind: .development, issuer: nil, relayOverride: nil, transport: transport,
      webSocketTransport: UITestFakeWebSocketTransport(server: UITestFakeServer()), secureStore: InMemorySecureStore(),
      keyValueStore: InMemoryKeyValueStore(), opener: UITestFakeOpener(), usesRemoteNotifications: false,
      appearanceDefaults: defaults)
    let kv = InMemoryKeyValueStore()
    return try MachineConnection(
      machineId: machineId, credential: Credential(serverUrl: "https://relay.fake/m/\(machineId)", bearer: "token"),
      machine: nil, record: nil, environment: env, credentials: SecureCredentialStore(InMemorySecureStore()),
      records: EnrollmentRecords(store: kv), ownerKeyValueStore: OwnerScopedKeyValueStore(base: kv, namespace: "ns"))
  }

  // MARK: Launch

  func testLaunchOffersTheSavedProfilesChatsFirst() async throws {
    let target = try connection(LaunchServer(.accept))
    let launch = LaunchModel(target: target, source: target, workspace: workspace)
    await launch.load()
    XCTAssertNil(launch.loadError)
    XCTAssertEqual(launch.profiles.map(\.id), ["claude-chat", "p-codex"], "chats first, the built-in terminal never offered")
    XCTAssertFalse(launch.sourceDiffers)
  }

  func testARefusedStartKeepsTheListAndSaysTheServersSentence() async throws {
    let server = LaunchServer(.refuse("Claude is not signed in on this Mac."))
    let target = try connection(server)
    let launch = LaunchModel(target: target, source: target, workspace: workspace)
    await launch.load()
    let session = await launch.start(LaunchServer.chat)
    XCTAssertNil(session)
    XCTAssertEqual(launch.refusal, "Claude is not signed in on this Mac.")
    XCTAssertEqual(launch.profiles.map(\.id), ["claude-chat", "p-codex"], "the list stays")
    XCTAssertNil(launch.starting)
    XCTAssertEqual(server.starts.count, 1, "a refusal is not retried")
    let options = server.starts.first?["options"] as? [String: Any]
    XCTAssertEqual(options?["launchProfileId"] as? String, "claude-chat")
    XCTAssertEqual(options?["workspaceId"] as? String, "scratch")
    XCTAssertEqual(server.starts.first?["cwd"] as? String, "/w/scratch")
  }

  func testAStartedSessionReplacesTheLaunchRoute() async throws {
    let target = try connection(LaunchServer(.accept))
    let source = try connection(LaunchServer(.accept), machineId: "m-main")
    let launch = LaunchModel(target: target, source: source, workspace: workspace)
    XCTAssertTrue(launch.sourceDiffers)
    await launch.load()
    let session = try await XCTUnwrapAsync(await launch.start(LaunchServer.chat))
    XCTAssertEqual(session.id, "s_new")
    XCTAssertNil(launch.refusal)
    XCTAssertTrue(target.sessions.contains { $0.id == "s_new" }, "listed with the others")

    let path: [Route] = [
      .workspaces(machineId: "m1"), .sessions(machineId: "m1", workspaceId: "scratch"),
      .launch(machineId: "m1", workspaceId: "scratch"),
    ]
    XCTAssertEqual(
      LaunchModel.path(afterStarting: session.id, machineId: "m1", from: path),
      [
        .workspaces(machineId: "m1"), .sessions(machineId: "m1", workspaceId: "scratch"),
        .chat(machineId: "m1", sessionId: "s_new"),
      ])
  }

  // MARK: Requests

  func testAPermissionsButtonsPutTheRefusalsLeftAndTheFirstAllowFirst() {
    let request = PendingRequest(
      id: "r1", sessionId: "s1", kind: .permission, description: "Run a command", createdAt: 1,
      options: [
        PermissionOption(id: "allow", label: "Allow"),
        PermissionOption(id: "deny", label: "Deny"),
        PermissionOption(id: "allow_always", label: "Always allow"),
        PermissionOption(id: "x", label: "Skip this one"),
      ], toolName: "Bash")
    let groups = PermissionButtonGroups(request)
    XCTAssertEqual(groups.refusals.map(\.id), ["deny", "x"])
    XCTAssertEqual(groups.allows.map(\.id), ["allow", "allow_always"])
    XCTAssertEqual(groups.primaryId, "allow")
    XCTAssertTrue(answersAsPermission(request))
    XCTAssertEqual(requestKindWord(request.kind), "Permission")
  }

  // MARK: Sessions

  func testTheSessionsListingFollowsTheCoreRule() {
    let stamped = Session(
      id: "a", provider: "claude", transport: .events, cwd: "/w/scratch", windowKey: "server", workspaceId: "scratch",
      state: .working, createdAt: 1, adapterId: "claude-chat", title: "Stamped chat")
    let unstamped = Session(
      id: "b", provider: "codex", transport: .events, cwd: "/w/other/app", windowKey: "server", state: .blocked,
      createdAt: 2, adapterId: "codex-chat", title: "")
    let terminal = Session(
      id: "c", provider: "claude", transport: .pty, cwd: "/w/scratch", windowKey: "server", workspaceId: "scratch",
      state: .idle, createdAt: 3, adapterId: "pty", title: "Shell")
    let elsewhere = Session(
      id: "d", provider: "claude", transport: .events, cwd: "/w/scratch", windowKey: "server", workspaceId: "other",
      state: .idle, createdAt: 4, adapterId: "claude-chat", title: "Elsewhere")
    let rows = SessionListingRow.rows(in: workspace, of: [terminal, stamped, elsewhere, unstamped], workspaces: [workspace])
    XCTAssertEqual(rows.map(\.id), ["b", "a", "c"], "chats first, newest first, then the terminal; another workspace's left out")
    XCTAssertEqual(rows.map(\.title), ["app", "Stamped chat", "Shell"], "an untitled session takes its folder's name")
    XCTAssertEqual(rows.map(\.description), ["codex · app", "claude · scratch", "Terminal · scratch · read-only on the phone"])
    XCTAssertEqual(rows.map(\.state.label), ["Waiting for you", "Working", "Idle"])
    XCTAssertEqual(rows.map(\.isChat), [true, true, false])
    XCTAssertEqual(rows.map { StatusKind($0.status) }, [.waiting, .working, .ready])
  }

  // MARK: the machine's state line

  func testTheMachineStateInWords() {
    XCTAssertEqual(MachineStateLine.describe(.connecting).words, "Connecting")
    XCTAssertEqual(MachineStateLine.describe(.connected).status, .ready)
    let offline = MachineStateLine.describe(.offline(reason: "Fake Mac is offline."))
    XCTAssertEqual(offline.words, "Offline")
    XCTAssertEqual(offline.reason, "Fake Mac is offline.")
    XCTAssertFalse(offline.isError)
    XCTAssertTrue(MachineStateLine.describe(.unpaired(reason: "Pair it again.")).isError)
  }

  /// A tool run's state goes under its summary at every accessibility text size and stays beside
  /// it below them: beside it at the largest size, "1 failed" was cut into "1", "faile" and "d".
  func testAToolRunsStateGoesUnderItsSummaryAtTheAccessibilitySizes() {
    for size in DynamicTypeSize.allCases {
      XCTAssertEqual(ToolRunCard.stateUnderSummary(at: size), size.isAccessibilitySize, "\(size)")
    }
    XCTAssertTrue(ToolRunCard.stateUnderSummary(at: .accessibility1))
    XCTAssertFalse(ToolRunCard.stateUnderSummary(at: .xxxLarge))
  }
}

/// `XCTUnwrap` over an async expression.
func XCTUnwrapAsync<T>(_ value: @autoclosure () async throws -> T?, file: StaticString = #filePath, line: UInt = #line) async throws -> T {
  let resolved = try await value()
  return try XCTUnwrap(resolved, file: file, line: line)
}
