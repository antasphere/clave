import Foundation

// What a run of tool calls says between two messages, ported from the
// prototype's `apps/mobile/src/chat/tools.ts` (itself the desktop's
// `apps/plugins/chat-view/src/tools.ts`, Clave, MIT) with the semantics
// unchanged: the grouping (a message ends a run of tools, a permission card
// does not), the reading of a call, the one-line summaries and the previews.
// Beside it, the provenance header of a message another tab sent
// (`delivery.ts`) and the document card of `clave_open_side_panel`.

// MARK: - Messages from other tabs

/// The header a named tab's message opens with, up to the name.
public let namedProvenancePrefix = "[Message from Clave tab \""
/// The header of a message from an agent that gave no name.
public let anonymousProvenanceHeader = "[Message from a Clave agent]"

/// A message another tab sent through clave_send_to_session, read back.
public struct ParsedDelivery: Sendable, Equatable {
  /// The sending tab (its session id and name); nil for the anonymous header.
  public let senderId: String?
  public let senderName: String?
  /// The message itself, the header and the line under it gone.
  public let body: String
}

// The name runs to the LAST `" — reply with`, so a name holding a quote still reads whole.
private let namedHeader = try! NSRegularExpression(pattern: "^\\[Message from Clave tab \"([^\\n]*)\" — reply with clave_send_to_session sessionId=\"([^\"\\n]*)\"\\]")

/// The sender and body of a message another tab sent, recognised by its provenance header and nothing else.
public func parseDelivery(_ text: String) -> ParsedDelivery? {
  let trimmed = String(text.drop(while: { $0.isWhitespace }))
  let ns = trimmed as NSString
  if let match = namedHeader.firstMatch(in: trimmed, range: NSRange(location: 0, length: ns.length)) {
    let name = ns.substring(with: match.range(at: 1))
    let id = ns.substring(with: match.range(at: 2))
    let rest = ns.substring(from: match.range.location + match.range.length)
    return ParsedDelivery(senderId: id, senderName: name, body: dropOneNewline(rest))
  }
  if trimmed.hasPrefix(anonymousProvenanceHeader) {
    return ParsedDelivery(senderId: nil, senderName: nil, body: dropOneNewline(String(trimmed.dropFirst(anonymousProvenanceHeader.count))))
  }
  return nil
}

private func dropOneNewline(_ text: String) -> String {
  text.hasPrefix("\n") ? String(text.dropFirst()) : text
}

// MARK: - Documents for review

/// The Clave tool that presents a document for review.
public let sidePanelToolName = "clave_open_side_panel"

/// Whether a tool call presents a document for review (any server prefix, as an MCP name carries one).
public func isDocumentTool(_ name: String?) -> Bool {
  name?.hasSuffix(sidePanelToolName) ?? false
}

/// What a document card shows and where its file is read from.
public struct DocumentCard: Sendable, Equatable {
  public let title: String
  /// The file on the Mac; nil when the call named none.
  public let path: String?
  /// The folder the file is read under (`GET /files/read`'s root).
  public let root: String?
  /// The document is an email draft.
  public let isEmail: Bool
  public let emailSubject: String?
  /// What the card says about editing.
  public let editingNote = "Editing is done on the Mac."

  /// The card's kind line: "Email: <subject>", "Email" or "Document".
  public var kindLabel: String {
    isEmail ? (emailSubject.map { "Email: \($0)" } ?? "Email") : "Document"
  }
}

/// The card of a document tool call, read from its input.
public func documentCard(_ tool: ToolCall) -> DocumentCard {
  let input = tool.input?.objectValue ?? [:]
  let path = input["path"]?.stringValue
  let title = input["title"]?.stringValue ?? path.map { $0.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? $0 } ?? "A document"
  let email = input["email"]
  return DocumentCard(
    title: title,
    path: path,
    root: path.map(parentDirectory),
    isEmail: email != nil && email != .null,
    emailSubject: email?["subject"]?.stringValue)
}

/// The folder holding `path`, "/" at the top.
public func parentDirectory(_ path: String) -> String {
  guard let slash = path.lastIndex(of: "/") else { return path.isEmpty ? "/" : path }
  let head = String(path[..<slash])
  return head.isEmpty ? "/" : head
}

/// A value as text for a card, cut at `max` characters with an ellipsis.
public func excerpt(_ value: JSONValue?, max: Int = 6_000) -> String {
  let text = value?.stringValue ?? safeJson(value)
  return text.count > max ? String(text.prefix(max)) + "…" : text
}

// MARK: - Grouping

/// A row of the transcript: an item, or a run folded into one row.
public enum ConversationBlock: Sendable, Equatable {
  case item(ConversationItem)
  /// A run of tool calls, keyed by the first call's id.
  case toolGroup(id: String, tools: [ToolCall])
  /// A run of two or more approvals the reader allowed.
  case approvalGroup([PermissionCard])
  /// A run of consecutive messages from other tabs.
  case deliveryGroup([UserTurn])
}

/// The items that render: an assistant turn that said nothing and a withdrawn message do not.
public func visibleItems(_ items: [ConversationItem]) -> [ConversationItem] {
  items.filter { item in
    switch item {
    case .assistant(let turn): return !turn.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    case .user(let turn): return !turn.withdrawn
    default: return true
    }
  }
}

/// The rows of the transcript: a message ends a run of tools, a permission card or an error does
/// not; allowed approvals fold into one run; messages from other tabs stack in one deck; a document
/// card stands on its own row and ends the run of tools before it.
public func groupItems(_ items: [ConversationItem]) -> [ConversationBlock] {
  var blocks: [ConversationBlock] = []
  var tools: Int?
  var allowed: Int?
  var deliveries: Int?
  for item in items {
    if case .user(let turn) = item, parseDelivery(turn.text) != nil {
      if let index = deliveries, case .deliveryGroup(var messages) = blocks[index] {
        messages.append(turn)
        blocks[index] = .deliveryGroup(messages)
      } else {
        deliveries = blocks.count
        blocks.append(.deliveryGroup([turn]))
      }
      tools = nil
      allowed = nil
      continue
    }
    deliveries = nil
    if case .permission(let card) = item, settledApproval(card) {
      if let index = allowed, case .approvalGroup(var cards) = blocks[index] {
        cards.append(card)
        blocks[index] = .approvalGroup(cards)
      } else {
        allowed = blocks.count
        blocks.append(.approvalGroup([card]))
      }
      continue
    }
    switch item {
    case .tool(let call):
      if let index = tools, case .toolGroup(let id, var calls) = blocks[index] {
        calls.append(call)
        blocks[index] = .toolGroup(id: id, tools: calls)
      } else {
        tools = blocks.count
        blocks.append(.toolGroup(id: call.id, tools: [call]))
      }
    case .document:
      blocks.append(.item(item))
      tools = nil
    case .user, .assistant:
      allowed = nil
      blocks.append(.item(item))
      tools = nil
    default:
      allowed = nil
      blocks.append(.item(item))
    }
  }
  // A run of one is the row it always was.
  return blocks.map { block in
    if case .approvalGroup(let cards) = block, cards.count == 1 { return .item(.permission(cards[0])) }
    return block
  }
}

/// The key a view renders a block under, stable for the block's life: a run of tools by its first
/// call's id, a document by its call's id, every other block by its first item's ordinal (a
/// request's id is Codex's RPC counter, which restarts in every process, so it is not a key).
public func blockKey(_ block: ConversationBlock) -> String {
  switch block {
  case .toolGroup(let id, _): return "tools-\(id)"
  case .approvalGroup(let cards): return "approvals-\(cards.first?.ordinal ?? 0)"
  case .deliveryGroup(let messages): return "deliveries-\(messages.first?.ordinal ?? 0)"
  case .item(.document(let call)): return "document-\(call.id)"
  case .item(let item): return "entry-\(item.ordinal)"
  }
}

// MARK: - Reading a call

/// What kind of external call a tool is.
public enum ToolKind: String, Sendable, CaseIterable {
  case read, search, edit, command, skill, web, agent, other
}

/// One opened section of a tool card.
public struct ToolSection: Sendable, Equatable {
  public let label: String
  public let text: String

  public init(label: String, text: String) {
    self.label = label
    self.text = text
  }
}

/// A tool call as a card reads it.
public struct ToolDescription: Sendable, Equatable {
  public let kind: ToolKind
  public let label: String
  public let target: String
  public let detail: String?
  public let sections: [ToolSection]
}

private let readNames: Set<String> = ["read", "readfile"]
private let searchNames: Set<String> = ["grep", "glob", "search", "searchfiles", "find", "ripgrep"]
private let editNames: Set<String> = ["edit", "write", "writefile", "applypatch", "filechange", "multiedit"]
private let commandNames: Set<String> = ["bash", "shell", "commandexecution", "execcommand", "runcommand"]
private let skillNames: Set<String> = ["skill"]
private let webNames: Set<String> = ["webfetch", "websearch"]
private let agentNames: Set<String> = ["task", "agent"]
private let genericKeys = ["url", "description", "prompt", "title", "name", "id"]

/// An MCP tool's server and tool, from `mcp__<server>__<tool>`.
func mcpParts(_ name: String?) -> (server: String, tool: String)? {
  guard let name, name.hasPrefix("mcp__") else { return nil }
  let rest = Array(name.dropFirst(5))
  var i = 1
  while i + 1 < rest.count {
    if rest[i] == "_" && rest[i + 1] == "_" && i + 2 < rest.count {
      return (String(rest[..<i]), String(rest[(i + 2)...]))
    }
    i += 1
  }
  return nil
}

private func record(_ value: JSONValue?) -> [String: JSONValue] { value?.objectValue ?? [:] }

private func field(_ data: [String: JSONValue], _ keys: String...) -> String { field(data, keys) }

private func field(_ data: [String: JSONValue], _ keys: [String]) -> String {
  for key in keys {
    switch data[key] {
    case .string(let value)? where !value.isEmpty:
      return value
    // argv rather than a command line: Codex sends `command` as an array.
    case .array(let values)? where !values.isEmpty && values.allSatisfy({ $0.stringValue != nil }):
      return values.compactMap(\.stringValue).joined(separator: " ")
    default:
      continue
    }
  }
  return ""
}

private func anyTarget(_ data: [String: JSONValue]) -> String {
  let known = field(data, genericKeys)
  if !known.isEmpty { return known }
  // A dictionary has no insertion order; sorted keys make the fallback the same on every render.
  for key in data.keys.sorted() {
    if case .string(let value)? = data[key], !value.isEmpty { return value }
  }
  return ""
}

private func numberField(_ data: [String: JSONValue], _ keys: String...) -> Double? {
  for key in keys {
    if case .number(let value)? = data[key], value.isFinite { return value }
  }
  return nil
}

/// A number as JavaScript prints it: integers without a fraction.
func jsNumber(_ value: Double) -> String {
  if value.isFinite && value == value.rounded() && abs(value) < 1e21 { return String(Int64(value)) }
  return String(value)
}

/// A value as text: plain text blocks joined, a command's stdout and stderr, anything else readable JSON.
public func content(_ value: JSONValue?) -> String {
  guard let value else { return "" }
  switch value {
  case .string(let text): return text
  case .null: return ""
  case .bool(let flag): return flag ? "true" : "false"
  case .number(let number): return jsNumber(number)
  case .array(let values): return values.map { content($0) }.filter { !$0.isEmpty }.joined(separator: "\n")
  case .object(let data):
    if case .string(let text)? = data["text"] { return text }
    if let inner = data["content"] { return content(inner) }
    let stdout = data["stdout"]?.stringValue
    let stderr = data["stderr"]?.stringValue
    if stdout != nil || stderr != nil {
      return [stdout, stderr].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
    }
    return safeJson(value)
  }
}

/// A value as indented JSON the way `JSON.stringify(value, null, 2)` writes it, keys sorted; "" for nil.
public func safeJson(_ value: JSONValue?, indent: Int = 2) -> String {
  guard let value else { return "" }
  return jsonText(value, indent: indent, depth: 0)
}

private func jsonText(_ value: JSONValue, indent: Int, depth: Int) -> String {
  let pad = String(repeating: " ", count: indent * (depth + 1))
  let close = String(repeating: " ", count: indent * depth)
  switch value {
  case .null: return "null"
  case .bool(let flag): return flag ? "true" : "false"
  case .number(let number): return number.isFinite ? jsNumber(number) : "null"
  case .string(let text): return quoteJSON(text)
  case .array(let values):
    if values.isEmpty { return "[]" }
    return "[\n" + values.map { pad + jsonText($0, indent: indent, depth: depth + 1) }.joined(separator: ",\n") + "\n" + close + "]"
  case .object(let data):
    if data.isEmpty { return "{}" }
    return "{\n" + data.keys.sorted().map { pad + quoteJSON($0) + ": " + jsonText(data[$0]!, indent: indent, depth: depth + 1) }.joined(separator: ",\n") + "\n" + close + "}"
  }
}

private func quoteJSON(_ text: String) -> String {
  var out = "\""
  for scalar in text.unicodeScalars {
    switch scalar {
    case "\"": out += "\\\""
    case "\\": out += "\\\\"
    case "\n": out += "\\n"
    case "\r": out += "\\r"
    case "\t": out += "\\t"
    case "\u{08}": out += "\\b"
    case "\u{0C}": out += "\\f"
    default:
      if scalar.value < 0x20 {
        out += String(format: "\\u%04x", scalar.value)
      } else {
        out.unicodeScalars.append(scalar)
      }
    }
  }
  return out + "\""
}

/// The kind of a tool, from its name however it is spelled.
public func toolKind(_ name: String?) -> ToolKind {
  let normalized = String((name ?? "").lowercased().filter { !$0.isWhitespace && $0 != "_" && $0 != "-" })
  if readNames.contains(normalized) { return .read }
  if searchNames.contains(normalized) { return .search }
  if editNames.contains(normalized) { return .edit }
  if commandNames.contains(normalized) { return .command }
  if skillNames.contains(normalized) { return .skill }
  if webNames.contains(normalized) { return .web }
  if agentNames.contains(normalized) { return .agent }
  return .other
}

/// What the summary line needs and nothing more: no output is turned into text.
public func describeToolHead(_ tool: ToolCall) -> (kind: ToolKind, label: String, target: String) {
  let description = describeTool(tool, withSections: false)
  return (description.kind, description.label, description.target)
}

/// A call as its card reads it: kind, label, target, detail and the sections it opens to.
public func describeTool(_ tool: ToolCall, withSections: Bool = true) -> ToolDescription {
  let kind = toolKind(tool.name)
  let normalized = String((tool.name ?? "").lowercased().filter { !$0.isWhitespace && $0 != "_" && $0 != "-" })
  let label: String
  switch kind {
  case .read: label = "Read"
  case .search: label = "Search"
  case .edit: label = "Edit"
  case .command: label = "Shell"
  case .skill: label = "Skill"
  case .web: label = normalized == "websearch" ? "Web search" : "Fetch"
  case .agent: label = "Agent"
  case .other: label = mcpParts(tool.name)?.tool ?? tool.name ?? "Tool"
  }
  let input = tool.input
  let data = record(input)
  let path = field(data, "file_path", "filePath", "path", "filename")
  let query = field(data, "pattern", "query", "glob")
  let command = field(data, "command", "cmd")
  let literal = input?.stringValue ?? ""
  func or(_ values: String...) -> String { values.first { !$0.isEmpty } ?? "" }
  let byKind: String
  switch kind {
  case .search: byKind = or(query, literal, path)
  case .command: byKind = or(command, literal)
  case .skill: byKind = or(field(data, "skill", "name"), literal)
  case .web: byKind = or(field(data, "url", "query"), literal)
  default: byKind = or(path, literal)
  }
  let target = byKind.isEmpty ? anyTarget(data) : byKind
  var sections: [ToolSection] = []
  if withSections && (target.contains("\n") || target.utf16.count > 200) {
    sections.append(ToolSection(label: kind == .command ? "Command" : "Target", text: target))
  }
  var detail: String?
  if kind == .read {
    let start = numberField(data, "offset", "start_line", "startLine")
    let limit = numberField(data, "limit")
    let end = numberField(data, "end_line", "endLine") ?? (start != nil && limit != nil ? start! + limit! - 1 : nil)
    if let start {
      detail = end.map { "Lines \(jsNumber(start))–\(jsNumber($0))" } ?? "From line \(jsNumber(start))"
    } else if let limit {
      detail = "Up to \(jsNumber(limit)) lines"
    }
  } else if kind == .search {
    if !path.isEmpty && path != target { detail = "In \(path)" }
  } else if kind == .edit && withSections {
    let changes: [[String: JSONValue]]
    if case .array(let values)? = input { changes = values.map { record($0) } } else { changes = [data] }
    for change in changes {
      let diff = field(change, "diff", "patch")
      let before = field(change, "old_string", "oldText", "old_text")
      let after = field(change, "new_string", "newText", "new_text")
      let text: String
      if !diff.isEmpty {
        text = diff
      } else if !before.isEmpty || !after.isEmpty {
        let removed = before.isEmpty ? [] : before.components(separatedBy: "\n").map { "- \($0)" }
        let added = after.isEmpty ? [] : after.components(separatedBy: "\n").map { "+ \($0)" }
        text = (removed + added).joined(separator: "\n")
      } else {
        text = field(change, "content")
      }
      if !text.isEmpty {
        let label = field(change, "path", "file_path")
        sections.append(ToolSection(label: label.isEmpty ? "Changes" : label, text: text))
      }
    }
  }
  if kind == .command, let exit = numberField(record(tool.output), "exit_code", "exitCode") {
    detail = "Exit \(jsNumber(exit))"
  }
  let outputText = withSections && tool.complete ? content(tool.output) : ""
  if !outputText.isEmpty {
    sections.append(ToolSection(label: kind == .read ? "Content" : kind == .search ? "Matches" : "Output", text: outputText))
  }
  if withSections && sections.isEmpty && target.isEmpty && tool.input != nil {
    let inputText = content(input)
    if !inputText.isEmpty { sections.append(ToolSection(label: "Input", text: inputText)) }
  }
  return ToolDescription(kind: kind, label: label, target: target, detail: detail, sections: sections)
}

private func times(_ n: Int) -> String { n == 1 ? "once" : n == 2 ? "twice" : "\(n) times" }

/// The one line a closed run shows: what the agent did, counted by kind; a lone tool names itself.
public func toolGroupSummary(_ tools: [ToolCall]) -> String {
  if tools.isEmpty { return "" }
  if tools.count == 1 {
    let head = describeToolHead(tools[0])
    return head.target.isEmpty ? head.label : "\(head.label) · \(head.target)"
  }
  struct Count { var kind: ToolKind; var label: String; var count: Int; var targets: [String]; var named: Int }
  var order: [String] = []
  var counts: [String: Count] = [:]
  for tool in tools {
    let head = describeToolHead(tool)
    let key = head.kind == .other ? "other:\(head.label)" : head.kind.rawValue
    var entry = counts[key] ?? Count(kind: head.kind, label: head.label, count: 0, targets: [], named: 0)
    if counts[key] == nil { order.append(key) }
    if !head.target.isEmpty && !entry.targets.contains(head.target) { entry.targets.append(head.target) }
    entry.count += 1
    // "Read 2 files" may only be said when every read named a file.
    entry.named += head.target.isEmpty ? 0 : 1
    counts[key] = entry
  }
  return order.map { key -> String in
    let c = counts[key]!
    func files(_ verb: String) -> String {
      !c.targets.isEmpty && c.named == c.count
        ? "\(verb) \(c.targets.count) \(c.targets.count == 1 ? "file" : "files")"
        : "\(verb) \(times(c.count))"
    }
    switch c.kind {
    case .read: return files("Read")
    case .edit: return files("Edited")
    case .command: return "Ran \(c.count) \(c.count == 1 ? "command" : "commands")"
    case .search: return "Searched \(times(c.count))"
    case .skill: return c.count == 1 && c.targets.count == 1 ? "Loaded the \(c.targets[0]) skill" : "Loaded \(c.count) skills"
    case .web: return "Browsed the web \(times(c.count))"
    case .agent: return "Ran \(c.count) \(c.count == 1 ? "subagent" : "subagents")"
    case .other: return "\(c.label) × \(c.count)"
    }
  }.joined(separator: " · ")
}

/// Where a run stands.
public enum GroupStatus: String, Sendable {
  case running, failed, complete
}

/// Running wins over failed: something still in flight must say so, the failures counted beside it.
public func groupStatus(_ tools: [ToolCall]) -> GroupStatus {
  if tools.contains(where: { !$0.complete }) { return .running }
  return tools.contains(where: { $0.failed == true }) ? .failed : .complete
}

/// How many calls the adapter said failed.
public func failureCount(_ tools: [ToolCall]) -> Int {
  tools.filter { $0.failed == true }.count
}

/// The lines an opened tool shows before the reader asks for the rest.
public let previewLines = 8
/// The characters (UTF-16 units, as the desktop counts) an opened tool shows before the rest.
public let previewChars = 2000

/// What an opened tool shows first, and whether there is more.
public func toolPreview(_ text: String) -> (text: String, truncated: Bool) {
  let lines = text.components(separatedBy: "\n").prefix(previewLines).joined(separator: "\n")
  var units = Array(lines.utf16.prefix(previewChars))
  // A cut at the limit can land between the two halves of an astral character.
  if let last = units.last, last >= 0xD800 && last <= 0xDBFF { units.removeLast() }
  return (String(decoding: units, as: UTF16.self), units.count < text.utf16.count)
}

/// The verb a row opens with, the way Codex writes it: "Ran npm test".
public func toolVerb(_ kind: ToolKind, _ label: String) -> String {
  switch kind {
  case .read: return "Read"
  case .search: return "Searched"
  case .edit: return "Edited"
  case .command: return "Ran"
  case .skill: return "Loaded skill"
  case .web: return label == "Web search" ? "Searched the web for" : "Fetched"
  case .agent: return "Ran agent"
  case .other: return label
  }
}

/// The few words a row says about what kind of external call it was.
public func toolHint(_ tool: ToolCall) -> String {
  let kind = describeToolHead(tool).kind
  if kind == .other, let server = mcpParts(tool.name)?.server { return "Tool call · \(server) MCP" }
  switch kind {
  case .read: return "File read"
  case .search: return "Search"
  case .edit: return "File edit"
  case .command: return "Command run"
  case .skill: return "Skill loaded"
  case .web: return "Web request"
  case .agent: return "Subagent run"
  case .other: return "Tool call"
  }
}

/// The kind a whole run shows by: its own when every call shares it, a plain tool call otherwise.
public func groupKind(_ tools: [ToolCall]) -> ToolKind {
  let kinds = Set(tools.map { describeToolHead($0).kind })
  return kinds.count == 1 ? kinds.first! : .other
}

/// What a run is, in a few words: "2 commands run".
public func groupHint(_ tools: [ToolCall]) -> String {
  if tools.count == 1 { return toolHint(tools[0]) }
  let plural: [ToolKind: String] = [
    .read: "file reads", .search: "searches", .edit: "file edits", .command: "commands run",
    .skill: "skills loaded", .web: "web requests", .agent: "subagent runs",
  ]
  return "\(tools.count) \(plural[groupKind(tools)] ?? "external calls")"
}

/// The language a section highlights as: a shell line as shell, a change as a diff, a file by its extension.
public func sectionLanguage(_ kind: ToolKind, _ section: ToolSection, path: String) -> String? {
  switch kind {
  case .command:
    return section.label == "Command" ? "bash" : nil
  case .edit:
    let diff = section.text.components(separatedBy: "\n").contains { $0.hasPrefix("- ") || $0.hasPrefix("+ ") }
    return diff ? "diff" : fileExtension(section.label)
  case .read where section.label == "Content":
    return fileExtension(path)
  default:
    return nil
  }
}

func fileExtension(_ path: String) -> String? {
  guard let dot = path.lastIndex(of: ".") else { return nil }
  let tail = path[path.index(after: dot)...]
  guard !tail.isEmpty, tail.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber) }) else { return nil }
  return tail.lowercased()
}

/// The Terminal view's title for a run, one sentence however long: "Read 2 files, ran 5 commands".
public func runTitle(_ tools: [ToolCall]) -> String {
  struct Count { var kind: ToolKind; var count: Int; var files: Set<String>; var named: Bool }
  var order: [ToolKind] = []
  var counts: [ToolKind: Count] = [:]
  for tool in tools {
    let head = describeToolHead(tool)
    if counts[head.kind] == nil { order.append(head.kind) }
    var entry = counts[head.kind] ?? Count(kind: head.kind, count: 0, files: [], named: true)
    entry.count += 1
    if head.target.isEmpty { entry.named = false } else { entry.files.insert(head.target) }
    counts[head.kind] = entry
  }
  func plural(_ n: Int, _ one: String, _ many: String? = nil) -> String { "\(n) \(n == 1 ? one : many ?? one + "s")" }
  let parts = order.map { kind -> String in
    let c = counts[kind]!
    // A file touched twice is still one file; a call that named none makes the part count calls.
    func onFiles(_ verb: String) -> String { c.named ? "\(verb) \(plural(c.files.count, "file"))" : "\(verb) \(plural(c.count, "time"))" }
    switch kind {
    case .read: return onFiles("read")
    case .edit: return onFiles("edited")
    case .command: return "ran \(plural(c.count, "command"))"
    case .search: return "ran \(plural(c.count, "search", "searches"))"
    case .skill: return "loaded \(plural(c.count, "skill"))"
    case .web: return "made \(plural(c.count, "web request"))"
    case .agent: return "ran \(plural(c.count, "subagent"))"
    case .other: return "used \(plural(c.count, "tool"))"
    }
  }
  let sentence = parts.joined(separator: ", ")
  return sentence.prefix(1).uppercased() + sentence.dropFirst()
}
