import XCTest
@testable import ClaveCore

private func tool(_ id: String, _ name: String? = "Read", input: JSONValue? = json([:]), output: JSONValue? = nil, complete: Bool = true, failed: Bool? = nil, ordinal: Int = 0) -> ToolCall {
  ToolCall(ordinal: ordinal, id: id, name: name, input: input, output: output, complete: complete, failed: failed)
}

private func user(_ text: String, _ ordinal: Int = 0) -> ConversationItem {
  .user(UserTurn(ordinal: ordinal, text: text, attachments: [], clientMessageId: nil, parent: nil, at: 0, interrupted: false, withdrawn: false))
}

private func assistant(_ text: String) -> ConversationItem {
  .assistant(AssistantTurn(ordinal: 0, text: text, final: true, parent: nil, at: 0))
}

private func permission(_ id: String, answer: String? = nil, toolName: String? = "Bash") -> ConversationItem {
  .permission(PermissionCard(request: PermissionRequestEvent(id: id, description: "Allow?", options: [PermissionOption(id: "allow", label: "Allow")], toolName: toolName), state: answer.map { .answered(optionId: $0) } ?? .pending))
}

private func blockKinds(_ blocks: [ConversationBlock]) -> [String] {
  blocks.map { block in
    switch block {
    case .toolGroup: return "tool-group"
    case .approvalGroup: return "approval-group"
    case .deliveryGroup: return "delivery-group"
    case .item(let item): return kinds([item])[0]
    }
  }
}

final class ChatToolsTests: XCTestCase {
  func testFoldsARunOfConsecutiveToolsIntoOneGroupKeyedByItsFirstTool() {
    let blocks = groupItems([user("go"), .tool(tool("a")), .tool(tool("b")), .tool(tool("c")), assistant("done")])
    XCTAssertEqual(blockKinds(blocks), ["user", "tool-group", "assistant"])
    guard case .toolGroup(let id, let tools) = blocks[1] else { return XCTFail() }
    XCTAssertEqual(id, "a")
    XCTAssertEqual(tools.map(\.id), ["a", "b", "c"])
    XCTAssertEqual(blockKey(blocks[1]), "tools-a")
  }

  func testDoesNotBreakARunOnAPermissionCardOrAnError() {
    let blocks = groupItems([.tool(tool("a")), permission("p1"), .tool(tool("b"))])
    XCTAssertEqual(blockKinds(blocks), ["tool-group", "permission"])
    guard case .toolGroup(_, let tools) = blocks[0] else { return XCTFail() }
    XCTAssertEqual(tools.map(\.id), ["a", "b"])
    let withError = groupItems([.tool(tool("a")), .error(ErrorItem(ordinal: 0, message: "transient", fatal: false, at: 0)), .tool(tool("b"))])
    guard case .toolGroup(_, let both) = withError[0] else { return XCTFail() }
    XCTAssertEqual(both.count, 2)
  }

  func testBreaksARunOnAUserMessageAndOnAnAssistantMessage() {
    for message in [user("next"), assistant("thinking")] {
      let blocks = groupItems([.tool(tool("a")), message, .tool(tool("b"))])
      XCTAssertEqual(blockKinds(blocks), ["tool-group", kinds([message])[0], "tool-group"])
    }
  }

  func testKeepsOtherItemsUntouchedAndInOrderAndNothingForNothing() {
    let items = [user("a"), assistant("b"), permission("p")]
    XCTAssertEqual(groupItems(items), items.map { .item($0) })
    XCTAssertEqual(groupItems([]), [])
  }

  func testFoldsAllowedApprovalsAndLeavesALoneOneItsOwnRow() {
    let blocks = groupItems([permission("a", answer: "allow"), permission("b", answer: "allow"), user("x"), permission("c", answer: "allow")])
    XCTAssertEqual(blockKinds(blocks), ["approval-group", "user", "permission"])
  }

  func testStacksMessagesFromOtherTabsInOneDeck() {
    let header = "[Message from Clave tab \"Lane A\" — reply with clave_send_to_session sessionId=\"abc\"]\nhello"
    let blocks = groupItems([user(header, 3), user("[Message from a Clave agent]\nhi", 4), assistant("reply")])
    XCTAssertEqual(blockKinds(blocks), ["delivery-group", "assistant"])
    XCTAssertEqual(blockKey(blocks[0]), "deliveries-3")
    let parsed = parseDelivery(header)
    XCTAssertEqual(parsed, ParsedDelivery(senderId: "abc", senderName: "Lane A", body: "hello"))
    XCTAssertEqual(parseDelivery("[Message from a Clave agent]\nhi"), ParsedDelivery(senderId: nil, senderName: nil, body: "hi"))
    XCTAssertNil(parseDelivery("an ordinary message"))
  }

  func testADocumentCardStandsOnItsOwnRowAndSaysWhereItsFileIs() {
    let doc = tool("d", "clave_open_side_panel", input: json(["path": .string("/w/notes/plan.md"), "email": json(["subject": .string("Hello")])]))
    let blocks = groupItems([.tool(tool("a")), .document(doc), .tool(tool("b"))])
    XCTAssertEqual(blockKinds(blocks), ["tool-group", "document", "tool-group"])
    XCTAssertEqual(blockKey(blocks[1]), "document-d")
    let card = documentCard(doc)
    XCTAssertEqual(card.title, "plan.md")
    XCTAssertEqual(card.root, "/w/notes")
    XCTAssertEqual(card.kindLabel, "Email: Hello")
    XCTAssertEqual(card.editingNote, "Editing is done on the Mac.")
    XCTAssertEqual(documentCard(tool("e", "clave_open_side_panel", input: json(["title": .string("Brief")]))).title, "Brief")
    XCTAssertEqual(documentCard(tool("f", "clave_open_side_panel", input: nil)).title, "A document")
    XCTAssertEqual(parentDirectory("/top"), "/")
    XCTAssertTrue(isDocumentTool("mcp__clave_0123456789ab__clave_open_side_panel"))
  }

  func testGroupStatusAndFailureCount() {
    let running = [tool("a", failed: true), tool("b", complete: false)]
    XCTAssertEqual(groupStatus(running), .running)
    XCTAssertEqual(failureCount(running), 1)
    XCTAssertEqual(groupStatus([tool("a"), tool("b", failed: true)]), .failed)
    XCTAssertEqual(groupStatus([tool("a"), tool("b")]), .complete)
    let looksBad = tool("a", output: .string("Error: no such file\nError: again"))
    XCTAssertEqual(groupStatus([looksBad]), .complete)
    XCTAssertEqual(failureCount([looksBad]), 0)
  }

  func testDescribeToolNamesTheKindLabelsTargetsAndDetails() {
    XCTAssertEqual(describeTool(tool("a", "Read")).kind, .read)
    XCTAssertEqual(describeTool(tool("a", "file_change")).kind, .edit)
    XCTAssertEqual(describeTool(tool("a", "commandExecution")).kind, .command)
    XCTAssertEqual(describeTool(tool("a", "Grep")).kind, .search)
    XCTAssertEqual(describeTool(tool("a", "Sparkle")).kind, .other)
    XCTAssertEqual(describeTool(tool("a", "Sparkle")).label, "Sparkle")
    XCTAssertEqual(describeTool(tool("a", "Read", input: json(["file_path": .string("/x.ts")]))).target, "/x.ts")
    XCTAssertEqual(describeTool(tool("a", "Bash", input: json(["command": .string("npm test")]))).target, "npm test")
    XCTAssertEqual(describeTool(tool("a", "Grep", input: json(["pattern": .string("TODO"), "path": .string("src")]))).target, "TODO")
    XCTAssertEqual(describeTool(tool("a", "Grep", input: json(["pattern": .string("TODO"), "path": .string("src")]))).detail, "In src")
    XCTAssertEqual(describeTool(tool("a", input: json(["file_path": .string("/x"), "offset": .number(10), "limit": .number(5)]))).detail, "Lines 10–14")
    XCTAssertEqual(describeTool(tool("a", "Bash", input: json(["command": .string("ls")]), output: json(["exitCode": .number(2)]))).detail, "Exit 2")
  }

  func testShowsTheOutputOnceTheCallCompletedAndReadsContentBlocks() {
    XCTAssertEqual(describeTool(tool("a", input: json(["file_path": .string("/x")]), output: .string("early"), complete: false)).sections.count, 0)
    XCTAssertEqual(describeTool(tool("a", input: json(["file_path": .string("/x")]), output: .string("body"))).sections, [ToolSection(label: "Content", text: "body")])
    let blocks = tool("a", input: json(["file_path": .string("/x")]), output: .array([json(["text": .string("one")]), json(["text": .string("two")])]))
    XCTAssertEqual(describeTool(blocks).sections[0].text, "one\ntwo")
    let odd = tool("a", input: json(["file_path": .string("/x")]), output: json(["shape": .array([.number(1), .number(2)])]))
    XCTAssertTrue(describeTool(odd).sections[0].text.contains("\"shape\""))
    XCTAssertEqual(safeJson(json(["a": .number(1)])), "{\n  \"a\": 1\n}")
  }

  func testAnEditShowsItsChangeAsADiff() {
    let edit = tool("a", "Edit", input: json(["file_path": .string("/x.ts"), "old_string": .string("a"), "new_string": .string("b")]))
    XCTAssertEqual(describeTool(edit).sections.first, ToolSection(label: "/x.ts", text: "- a\n+ b"))
    XCTAssertEqual(describeToolHead(edit).kind, .edit)
    XCTAssertEqual(describeToolHead(edit).label, "Edit")
    XCTAssertEqual(describeToolHead(edit).target, "/x.ts")
  }

  func testToolGroupSummary() {
    XCTAssertEqual(toolGroupSummary([tool("a", "Read", input: json(["file_path": .string("/x.ts")]))]), "Read · /x.ts")
    XCTAssertEqual(toolGroupSummary(["/x", "/y", "/x"].enumerated().map { tool("\($0.offset)", "Read", input: json(["file_path": .string($0.element)])) }), "Read 2 files")
    XCTAssertEqual(toolGroupSummary([
      tool("a", "Read", input: json(["file_path": .string("/x")])),
      tool("b", "Read", input: json(["file_path": .string("/y")])),
      tool("c", "Read", input: json(["file_path": .string("/z")])),
      tool("d", "Bash", input: json(["command": .string("npm test")])),
    ]), "Read 3 files · Ran 1 command")
    XCTAssertEqual(toolGroupSummary([tool("a", "Grep", input: json(["pattern": .string("x")])), tool("b", "Grep", input: json(["pattern": .string("y")]))]), "Searched twice")
    XCTAssertEqual(toolGroupSummary([tool("a", "Read", input: json(["file_path": .string("/x")]))] + ["b", "c", "d", "e"].map { tool($0, "Read") }), "Read 5 times")
    XCTAssertEqual(toolGroupSummary([tool("a", "Read"), tool("b", "Read")]), "Read twice")
    XCTAssertEqual(toolGroupSummary([tool("a", "Sparkle"), tool("b", "Sparkle"), tool("c", "Twinkle")]), "Sparkle × 2 · Twinkle × 1")
    XCTAssertEqual(toolGroupSummary([]), "")
  }

  func testATargetForEveryTool() {
    XCTAssertEqual(describeTool(tool("a", "WebFetch", input: json(["url": .string("https://example.com/docs")]))).target, "https://example.com/docs")
    XCTAssertEqual(describeTool(tool("a", "Task", input: json(["description": .string("find the seam")]))).target, "find the seam")
    XCTAssertEqual(describeTool(tool("a", "mcp__linear__list", input: json(["teamId": .string("TEAM-7")]))).target, "TEAM-7")
    XCTAssertEqual(describeTool(tool("a", "commandExecution", input: json(["command": .array([.string("npm"), .string("test")])]))).target, "npm test")
    XCTAssertEqual(describeTool(tool("a", "Read", input: json(["file_path": .string("/x.ts"), "url": .string("http://n")]))).target, "/x.ts")
  }

  func testVisibleItemsDropASilentAssistantTurnSoARunDoesNotBreak() {
    let items: [ConversationItem] = [.tool(tool("a")), assistant("   \n "), .tool(tool("b"))]
    XCTAssertEqual(visibleItems(items).count, 2)
    let blocks = groupItems(visibleItems(items))
    XCTAssertEqual(blocks.count, 1)
    XCTAssertEqual(visibleItems([assistant("a word")]).count, 1)
  }

  func testToolPreview() {
    XCTAssertEqual(previewLines, 8)
    XCTAssertEqual(previewChars, 2000)
    XCTAssertEqual(toolPreview((0..<12).map(String.init).joined(separator: "\n")).text, "0\n1\n2\n3\n4\n5\n6\n7")
    let astral = toolPreview("x" + String(repeating: "\u{1F600}", count: previewChars))
    XCTAssertLessThanOrEqual(astral.text.utf16.count, previewChars)
    XCTAssertTrue(astral.text.allSatisfy { $0 == "x" || $0 == "\u{1F600}" })
    let long = toolPreview((0..<20).map { "line \($0)" }.joined(separator: "\n"))
    XCTAssertEqual(long.text.components(separatedBy: "\n").count, previewLines)
    XCTAssertTrue(long.truncated)
    let wide = toolPreview(String(repeating: "x", count: previewChars + 500))
    XCTAssertEqual(wide.text.count, previewChars)
    XCTAssertTrue(wide.truncated)
    XCTAssertEqual(toolPreview("short").text, "short")
    XCTAssertFalse(toolPreview("short").truncated)
  }

  func testEveryExternalCallSaysWhatKindItWas() {
    let skill = tool("a", "Skill", input: json(["skill": .string("nextjs")]))
    XCTAssertEqual(describeTool(skill).kind, .skill)
    XCTAssertEqual(describeTool(skill).target, "nextjs")
    XCTAssertEqual(toolHint(skill), "Skill loaded")
    XCTAssertEqual(describeTool(tool("b", "WebSearch", input: json(["query": .string("q")]))).kind, .web)
    XCTAssertEqual(describeTool(tool("c", "Task")).kind, .agent)
    XCTAssertEqual(toolHint(tool("d", "Bash", input: json(["command": .string("ls")]))), "Command run")
    let mcp = tool("a", "mcp__linear__list_issues")
    XCTAssertEqual(describeTool(mcp).label, "list_issues")
    XCTAssertEqual(toolHint(mcp), "Tool call · linear MCP")
    let shell = tool("a", "Bash", input: json(["command": .string("ls")]))
    let read = tool("b", "Read", input: json(["file_path": .string("/x")]))
    var other = shell
    other.id = "c"
    XCTAssertEqual(groupKind([shell, other]), .command)
    XCTAssertEqual(groupHint([shell, other]), "2 commands run")
    XCTAssertEqual(groupKind([shell, read]), .other)
    XCTAssertEqual(groupHint([shell, read]), "2 external calls")
    XCTAssertEqual(toolGroupSummary([tool("a", "Skill", input: json(["skill": .string("x")])), read]), "Loaded the x skill · Read 1 file")
    XCTAssertEqual(toolVerb(.command, "Shell"), "Ran")
    XCTAssertEqual(toolVerb(.edit, "Edit"), "Edited")
    XCTAssertEqual(toolVerb(.other, "list_issues"), "list_issues")
    XCTAssertEqual(sectionLanguage(.edit, ToolSection(label: "a.ts", text: "- a\n+ b"), path: ""), "diff")
    XCTAssertEqual(sectionLanguage(.read, ToolSection(label: "Content", text: "x"), path: "/src/a.tsx"), "tsx")
    XCTAssertNil(sectionLanguage(.read, ToolSection(label: "Content", text: "x"), path: "/Makefile"))
  }

  func testRunTitle() {
    XCTAssertEqual(runTitle([tool("a", "Read", input: json(["file_path": .string("/x.ts")]))]), "Read 1 file")
    XCTAssertEqual(runTitle([tool("a", "Edit", input: json(["file_path": .string("/x.ts")]))]), "Edited 1 file")
    XCTAssertEqual(runTitle([tool("a", "Bash", input: json(["command": .string("ls")]))]), "Ran 1 command")
    XCTAssertEqual(runTitle([
      tool("a", "Read", input: json(["file_path": .string("/x.ts")])),
      tool("b", "Bash", input: json(["command": .string("ls")])),
      tool("c", "Read", input: json(["file_path": .string("/y.ts")])),
      tool("d", "Bash", input: json(["command": .string("pwd")])),
      tool("e", "Grep", input: json(["pattern": .string("x")])),
    ]), "Read 2 files, ran 2 commands, ran 1 search")
    XCTAssertEqual(runTitle([tool("a", "Edit", input: json(["file_path": .string("/x.ts")])), tool("b", "Edit", input: json(["file_path": .string("/x.ts")]))]), "Edited 1 file")
    XCTAssertEqual(runTitle([tool("a", "Read", input: json(["file_path": .string("/x.ts")])), tool("b", "Read")]), "Read 2 times")
    XCTAssertEqual(runTitle([tool("a", "mcp__clave__clave_notify"), tool("b", "TodoWrite")]), "Used 2 tools")
  }
}
