import XCTest
@testable import ClaveCore

final class SessionsWorkspaceTests: XCTestCase {
  private func session(_ id: String, cwd: String = "/home/v/project", stamp: String? = nil, transport: SessionTransport = .events, createdAt: Double = 1) -> Session {
    Session(id: id, provider: "claude", transport: transport, cwd: cwd, windowKey: "server", workspaceId: stamp, state: .idle, createdAt: createdAt, adapterId: "claude-chat", title: "t")
  }

  private let workspaces = [
    WorkspaceView(id: "home", name: "Home", rootDir: "/home/v", createdAt: 1),
    WorkspaceView(id: "project", name: "Project", rootDir: "/home/v/project", createdAt: 1),
    WorkspaceView(id: "other", name: "Other", rootDir: "/srv/other", createdAt: 1),
  ]

  private func listed(_ id: String, _ all: [Session]) -> [String] {
    let workspace = workspaces.first { $0.id == id } ?? WorkspaceView(id: id, name: id, rootDir: "/gone", createdAt: 1)
    return sessions(in: workspace, of: all, workspaces: workspaces).map(\.id)
  }

  func testUsesAnExplicitStampEvenWhenItsWorkspaceIsMissing() {
    XCTAssertEqual(workspaceOfSession(session("s", stamp: "other")), "other")
    XCTAssertEqual(workspaceOfSession(session("s", stamp: "gone-workspace")), "gone-workspace")
    XCTAssertNil(workspaceOfSession(session("s")))
  }

  func testFiltersOnlyByTheStampNeverByAContradictoryOrNestedCwd() {
    let all = [
      session("a", cwd: "/home/v/project", stamp: "other"),
      session("b", cwd: "/home/v/project/nested"),
      session("c", cwd: "/srv/other/x", stamp: "home"),
      session("deleted", cwd: "/home/v/project", stamp: "gone-workspace"),
    ]
    XCTAssertEqual(listed("project", all), ["b"])
    XCTAssertEqual(Set(listed("home", all)), ["b", "c"])
    XCTAssertEqual(Set(listed("other", all)), ["a", "b"])
    XCTAssertEqual(Set(listed("gone-workspace", all)), ["b", "deleted"])
  }

  func testChatsFirstThenTerminalsEachNewestFirst() {
    let all = [
      session("old-chat", createdAt: 1),
      session("terminal", transport: .pty, createdAt: 9),
      session("new-chat", createdAt: 5),
    ]
    XCTAssertEqual(orderSessions(all).map(\.id), ["new-chat", "old-chat", "terminal"])
  }

  func testTheStatesAndTheirLabels() {
    XCTAssertEqual(PhoneSessionState(.working), .working)
    XCTAssertEqual(PhoneSessionState(.blocked), .waiting)
    XCTAssertEqual(PhoneSessionState(.idle), .idle)
    XCTAssertEqual(PhoneSessionState(.done), .finished)
    XCTAssertEqual(PhoneSessionState(.ended), .finished)
    XCTAssertEqual(PhoneSessionState(.working, fatalError: "limit"), .error)
    XCTAssertEqual(PhoneSessionState.waiting.label, "Waiting for you")
    XCTAssertEqual(SessionStatus(.working), .working)
    XCTAssertEqual(SessionStatus(.idle), .ready)
    XCTAssertEqual(SessionStatus(.blocked), .waiting)
    XCTAssertEqual(SessionStatus(.done), .inactive)
    XCTAssertEqual(SessionStatus(.idle, fatalError: "x"), .inactive)
    XCTAssertEqual(SessionStatus.allCases.map(\.label), ["Working", "Ready", "Waiting for you", "Inactive"])
  }
}
