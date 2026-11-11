import XCTest
@testable import ClaveCore

final class ChatApprovalsTests: XCTestCase {
  private func card(answer: String? = nil, state: PermissionCardState? = nil, toolName: String? = "Bash", questions: [AgentQuestion]? = nil) -> PermissionCard {
    PermissionCard(
      request: PermissionRequestEvent(id: "p", description: "Allow?", options: [PermissionOption(id: "allow", label: "Allow"), PermissionOption(id: "deny", label: "Deny")], toolName: toolName, questions: questions),
      state: state ?? (answer.map { .answered(optionId: $0) } ?? .pending))
  }

  func testReadsACodexCommandApprovalInTheReadersWords() {
    let request = PermissionRequestEvent(id: "c", description: "x", options: [], toolName: "item/commandExecution/requestApproval", input: json(["command": .array([.string("npm"), .string("test")])]))
    let described = describeApproval(request)
    XCTAssertEqual(described?.label, "Run a command")
    XCTAssertEqual(described?.target, "npm test")
    let mcp = PermissionRequestEvent(id: "m", description: "x", options: [], toolName: "mcpServer/elicitation/request", input: json(["serverName": .string("clave_0123456789ab"), "message": .string("Allow the probe MCP server to run tool \"ending_tool\"?")]))
    XCTAssertEqual(describeApproval(mcp)?.label, "Use ending_tool")
    XCTAssertEqual(describeApproval(mcp)?.target, "Clave")
    XCTAssertNil(describeApproval(card().request))
  }

  func testSaysADecisionInWordsAndKnowsARefusal() {
    let request = card().request
    XCTAssertEqual(decisionWord(request, "allow"), "Allow")
    XCTAssertEqual(decisionWord(request, "acceptForSession"), "Allowed for the session")
    XCTAssertTrue(refused(request, "deny"))
    XCTAssertFalse(refused(request, "allow"))
    let extra = PermissionRequestEvent(id: "p", description: "x", options: [PermissionOption(id: "{\"permissions\":{}}", label: "Deny extra permissions")])
    XCTAssertTrue(refused(extra, "{\"permissions\":{}}"))
  }

  func testFoldsOnlyAnAllowedAnsweredToolNamedApproval() {
    XCTAssertTrue(settledApproval(card(answer: "allow")))
    XCTAssertFalse(settledApproval(card(answer: "deny")))
    XCTAssertFalse(settledApproval(card()))
    XCTAssertFalse(settledApproval(card(state: .answeredElsewhere)))
    XCTAssertTrue(isQuestion(card(answer: "answer", toolName: nil).request))
    XCTAssertTrue(isQuestion(card(questions: []).request))
  }

  func testSummarisesARunByWhatWasAllowed() {
    let a = card(answer: "allow")
    let summary = approvalRunSummary([a, a])
    XCTAssertEqual(summary.head, "Allowed 2 requests")
    XCTAssertEqual(summary.detail, "Bash ×2")
  }
}
